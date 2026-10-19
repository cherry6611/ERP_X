import { ForbiddenException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@server/platform';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  hrDepartment,
  mdEmployee,
  sysDataScope,
  sysUser,
} from '@server/database/schema';
import type { RequestActor } from '@server/common/auth/actor';
import { isProductionRuntime } from '@server/common/utils/runtime-env';

/* ==========================================================================
 * B-02 数据级权限（行级可见范围）
 *
 * 需求书 §2.2 B-02 的**核心约束**：
 *   "在 service 层统一注入过滤条件（**在 SQL 层过滤，不能只在 UI 隐藏**）"。
 *
 * 因此本文件只产出 Drizzle `SQL` 条件，由调用方放进 `.where()`。
 * `applyScope()` 是**纯函数**（不依赖 DI、不查库），可被单测直接断言；
 * `DataScopeService` 负责"角色 → 范围配置"与"actor → 部门/员工上下文"这两件需要 I/O 的事。
 * ========================================================================== */

/** B-02：行级可见范围 */
export type DataScopeType =
  | 'all'
  | 'dept'
  | 'dept_and_child'
  | 'self'
  | 'custom'
  /**
   * 未配置即拒绝（fail-closed）：**只用于运行时计算结果**，不会写入 `sys_data_scope`。
   * 含义：该资源类型已启用行级权限（存在配置行），但当前角色没有命中任何配置行。
   * 为什么不直接把默认值改成这个：没有任何配置行的环境里，一翻转会让所有列表瞬间变空，
   * 看起来像全站故障。因此只在“该资源类型已经在用行级权限”时才收紧。
   */
  | 'none';

/** B-02：可配置数据权限的资源类型（与迁移 chk_sys_data_scope_resource 一致） */
export const DATA_SCOPE_RESOURCES = [
  'project',
  'customer',
  'finance_ledger',
  'employee',
  'attendance',
  /** B-2：凭证（口径 fin_voucher.tax_entity_id，仅支持 all/custom） */
  'voucher',
  /** B-2：账簿（同上；`finance_ledger` 保留给对账单） */
  'ledger',
  /** B-2：法定报表（同上） */
  'report',
  /** B-2：项目成本（口径 erp_project_cost.project_id） */
  'cost',
  /** B-2：项目收入（口径 erp_project_revenue.project_id） */
  'revenue',
  /** 合同（custom = 纳税主体 id，self = owner） */
  'contract',
] as const;

export type DataScopeResource = (typeof DATA_SCOPE_RESOURCES)[number];

/**
 * B-2：以**纳税主体**为维度的会计资料资源。
 *
 * 这三类资源（凭证/账簿/报表）的表里只有 `tax_entity_id`，没有责任人/部门列，
 * 因此只支持 `all` 与 `custom`（custom_ids = 纳税主体 id）。
 * 配成 `self` / `dept` / `dept_and_child` 时只能 fail-closed —— 见 `applyTaxEntityScope`。
 */
export const TAX_ENTITY_RESOURCES = ['voucher', 'ledger', 'report'] as const;

export const DATA_SCOPE_TYPES: readonly DataScopeType[] = [
  'all',
  'dept',
  'dept_and_child',
  'self',
  'custom',
];

export const DATA_SCOPE_TYPE_LABELS: Record<DataScopeType, string> = {
  all: '全部数据',
  dept: '本部门',
  dept_and_child: '本部门及下级',
  self: '仅本人',
  custom: '自定义',
  none: '无（未配置即拒绝）',
};

/** 解析后的范围（已含 custom_ids） */
export interface ResolvedScope {
  /** 命中配置的角色码；未命中为 null */
  roleCode: string | null;
  resourceType: string;
  scope: DataScopeType;
  customIds: string[];
  /**
   * 结论来源：
   * - `bypass`：管理员，直接全量；
   * - `config`：命中 `sys_data_scope` 配置行；
   * - `policy`：未配置时按 `DATA_SCOPE_UNCONFIGURED_POLICY` 判定；
   * - `default`：未配置，放行给既有规则（`scope: 'all'`）；
   * - `unassigned_role`：**登录但未分配任何角色** —— S-3 起一律 fail-closed 返回空集。
   */
  from: 'bypass' | 'config' | 'policy' | 'default' | 'unassigned_role';
}

/** 过滤条件的执行上下文（部门集合已按 scope 需要展开） */
export interface DataScopeContext {
  userId: string;
  resourceType?: string;
  /**
   * `self` 范围的比较值，缺省为 `userId`。
   * 资源以"员工"为主键时（考勤/工时/工资单）传员工 id，因为表里没有 user 列。
   */
  selfValue?: string | null;
  /** `dept` / `dept_and_child` 的部门 id 集合 */
  departmentIds?: string[];
  /** 按部门名称存归属的表（`erp_project.dept_name`）用这个 */
  departmentNames?: string[];
  /** dept 类范围取哪个值集合，默认 `id` */
  departmentValueKind?: 'id' | 'name';
  /** 显式绕过（仅 admin，或系统内部的幂等/对账查询）；`all` 与它等价 */
  bypass?: boolean;
}

/** 参与比较的列：既支持 Drizzle 列，也支持 `sql` 表达式（子查询/复合列） */
export type ScopeColumn = PgColumn | SQL;

/** fail-closed 条件：范围要求收窄但上下文拿不到任何可用值时不放行 */
export const SCOPE_FAIL_CLOSED: SQL = sql`1 = 0`;

/**
 * 类型守卫：区分 Drizzle 列与 `sql` 表达式。
 *
 * 为什么需要：`eq()` / `inArray()` 的第一个参数必须是 `Column`，
 * 而 `ScopeColumn` 允许传 `sql` 表达式（例如"项目归属部门"这种需要
 * 子查询/复合列的场景）。直接用会触发 TS 重载不匹配（本项目实测）。
 * 这里显式分流：列走 `eq/inArray`，表达式走 `sql` 模板，
 * 两条路径语义完全一致。
 */
function isDrizzleColumn(column: ScopeColumn): column is PgColumn {
  return (
    typeof column === 'object' &&
    column !== null &&
    'name' in column &&
    'table' in column
  );
}

/** 等值条件（列 / 表达式两条路径） */
function scopeEq(column: ScopeColumn, value: string): SQL {
  return isDrizzleColumn(column)
    ? eq(column, value)
    : (sql`${column} = ${value}` as SQL);
}

/** IN 条件（列 / 表达式两条路径） */
function scopeIn(column: ScopeColumn, values: string[]): SQL {
  return isDrizzleColumn(column)
    ? inArray(column, values)
    : (sql`${column} IN ${values}` as SQL);
}

/** `applyScope` 的比较列集合：不同 scope 需要比较不同的列 */
export interface ScopeColumns {
  /** `all` / `custom` / 默认使用的列 */
  primary: ScopeColumn;
  /** `self` 使用的列（如 `erp_project.pm_user_id`、`erp_ar.owner_user_id`） */
  self?: ScopeColumn;
  /** `dept` / `dept_and_child` 使用的列（如 `md_employee.department_id`） */
  dept?: ScopeColumn;
}

function uniqueStrings(values: readonly string[] | undefined | null): string[] {
  if (!values || values.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * B-02 核心：把"范围"翻译成 SQL 条件。
 *
 * 语义（单测逐一断言，见 data-scope.service.spec.ts）：
 * - `all`      → `undefined`（**不加任何条件**）
 * - `self`     → `column = ctx.selfValue ?? ctx.userId`（**绑定本人**）
 * - `dept`     → `column IN (本部门)`（**绑定本部门**）
 * - `dept_and_child` → `column IN (本部门及下级)`
 * - `custom`   → `column IN (scope.customIds)`
 * - 需要收窄但值集合为空 → `1 = 0`（fail-closed：返回空集而不是全量）
 * - `ctx.bypass` → `undefined`
 *
 * 注意：`column` 由调用方按资源选择，且必须与 scope 的语义匹配
 * （`self` 传"责任人/所属用户"列，`dept*` 传部门列）。
 */
export function applyScope(
  column: ScopeColumn,
  scope: ResolvedScope,
  ctx: DataScopeContext
): SQL | undefined {
  if (ctx.bypass === true || scope.scope === 'all') return undefined;

  // 未配置即拒绝（fail-closed）：该资源类型已启用行级权限，但当前角色没有配置行。
  // 优先级高于其它分支，且不受 ctx 影响——没有配置就不给数据，而不是默认放开。
  if (scope.scope === 'none') return SCOPE_FAIL_CLOSED;

  if (scope.scope === 'self') {
    const value = (ctx.selfValue ?? ctx.userId ?? '').trim();
    if (!value) return SCOPE_FAIL_CLOSED;
    return scopeEq(column, value);
  }

  if (scope.scope === 'custom') {
    const ids = uniqueStrings(scope.customIds);
    if (ids.length === 0) return SCOPE_FAIL_CLOSED;
    return scopeIn(column, ids);
  }

  // dept / dept_and_child
  const source: readonly string[] | undefined =
    ctx.departmentValueKind === 'name' ? ctx.departmentNames : ctx.departmentIds;
  const values = uniqueStrings(source);
  if (values.length === 0) return SCOPE_FAIL_CLOSED;
  return scopeIn(column, values);
}

/** 按 scope 类型挑比较列（`applyScope` 的前置步骤，避免调用点写三元表达式） */
export function pickScopeColumn(
  columns: ScopeColumns,
  scope: DataScopeType
): ScopeColumn {
  if (scope === 'self') return columns.self ?? columns.primary;
  if (scope === 'dept' || scope === 'dept_and_child') {
    return columns.dept ?? columns.primary;
  }
  return columns.primary;
}

/* ==========================================================================
 * B-2：会计资料（凭证/账簿/报表）的纳税主体可见范围
 * ========================================================================== */

/**
 * 纳税主体维度的可见范围（已从 `ResolvedScope` 翻译出来，与库无关，可直接单测）。
 *
 * 为什么不复用 `applyScope`：`applyScope` 对 `dept` 会回落到 `primary` 列上过滤，
 * 而凭证没有部门列——回落会静默把“按部门隔离”变成“按某个无关列隔离”，
 * 过滤器看起来生效、实际不过滤（或恒空）。会计资料上这种“猜出来”的过滤器比拒绝更危险。
 */
export type TaxEntityFilter =
  | { kind: 'unrestricted' }
  | { kind: 'entities'; taxEntityIds: string[] }
  | { kind: 'denied' };

/**
 * 把已解析的范围翻译为纳税主体可见范围。
 *
 * - `all`   → 不限
 * - `custom`→ 显式列出的纳税主体 id（**空列表 = 拒绝**，不是“全部”）
 * - `none` / `self` / `dept` / `dept_and_child` → 拒绝（会计资料没有这些维度）
 */
export function applyTaxEntityScope(scope: ResolvedScope): TaxEntityFilter {
  if (scope.scope === 'all') return { kind: 'unrestricted' };
  if (scope.scope === 'custom') {
    const ids = uniqueStrings(scope.customIds);
    return ids.length === 0
      ? { kind: 'denied' }
      : { kind: 'entities', taxEntityIds: ids };
  }
  return { kind: 'denied' };
}

/**
 * 把纳税主体可见范围翻译成 SQL 条件（`undefined` = 不加条件；`1 = 0` = 空集）。
 *
 * 列表类接口（凭证列表）用这个；单值接口（账簿/报表的出数主体）用 `narrowTaxEntityId`。
 */
export function taxEntityScopeCondition(
  column: ScopeColumn,
  filter: TaxEntityFilter
): SQL | undefined {
  if (filter.kind === 'unrestricted') return undefined;
  if (filter.kind === 'denied') return SCOPE_FAIL_CLOSED;
  return scopeIn(column, filter.taxEntityIds);
}

/** `narrowTaxEntityId` 的结论 */
export type TaxEntityNarrowResult =
  | { ok: true; taxEntityId: string | undefined }
  | { ok: false; message: string };

/**
 * 把“请求中的纳税主体”收敛到“实际允许的主体”。
 *
 * 报表/账簿接口一次只出一份主体报告（`taxEntityId` 是单值），
 * 所以范围允许多个主体时**不能自己挑一个**（挑错等于给错主体的报表），
 * 而是要求调用方显式指定；只允许一个主体时才替调用方填上。
 */
export function narrowTaxEntityId(
  filter: TaxEntityFilter,
  requested: string | undefined,
  label = '纳税主体'
): TaxEntityNarrowResult {
  if (filter.kind === 'unrestricted') {
    return { ok: true, taxEntityId: requested };
  }
  if (filter.kind === 'denied') {
    return {
      ok: false,
      message: `没有查看该会计资料的数据权限（没有可访问的${label}）`,
    };
  }
  const ids = filter.taxEntityIds;
  if (requested) {
    return ids.includes(requested)
      ? { ok: true, taxEntityId: requested }
      : { ok: false, message: `没有查看${label} ${requested} 的数据权限` };
  }
  if (ids.length === 1) return { ok: true, taxEntityId: ids[0] };
  return {
    ok: false,
    message: `当前数据权限可访问多个${label}，请在筛选条件中显式指定其中一个`,
  };
}

interface DepartmentRow {
  id: string;
  name: string;
  parentId: string | null;
}

interface DepartmentCache {
  rows: DepartmentRow[];
  at: number;
}

interface EmployeeBinding {
  employeeId: string;
  departmentId: string | null;
  departmentName: string | null;
}

interface ScopeValues {
  selfValue: string | null;
  departmentIds: string[];
  departmentNames: string[];
}

const DEPARTMENT_CACHE_MS = 60_000;

/**
 * 角色 × 资源类型 → 行级可见范围；并把 actor 解析成过滤上下文。
 *
 * 未命中配置时 `resolveScope()` 返回 `from: 'default'` 且 `scope = 'all'`，
 * 由调用方决定是否回退到既有规则（例如项目回退到 `ProjectAclService`）。
 * 这样"未配置"与"显式配置为 all"在语义上可区分（审计与排障需要）。
 */
@Injectable()
export class DataScopeService implements OnModuleInit {
  private readonly logger = new Logger(DataScopeService.name);
  private departmentCache: DepartmentCache | null = null;
  /** 已告警过的资源类型（避免每次请求都刷日志） */
  private readonly unconfiguredDenyWarned = new Set<string>();
  /** S-3：无角色用户的 fail-closed 告警只打一次（避免每请求刷日志） */
  private unassignedRoleWarned = false;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  /**
   * 启动期数据权限覆盖核查（S2 收口）。
   *
   * 不强制、不影响已配置资源行为，仅做**告警与可观测**：
   * 1. 只有字面量 `allow` 会放开。空值、`fail_closed`、`deny` 都是拒绝。
   *    生产若设成 `allow`，未配置资源会全量暴露，这里告警。
   * 2. 会计资料类（voucher/ledger/report）一旦未登记任何行级权限配置，在 deny 策略下对非 admin
   *    返回空集——属预期的安全收紧，但需运维先确认配置已就绪，否则列表会变空。故此处列出未配置项。
   */
  async onModuleInit(): Promise<void> {
    // 用 fail-safe 判定（非显式开发即生产）：NODE_ENV 误配成 'prod' 时
    // 只有显式 allow 才会放开。这条告警不能静默，否则运维不知道自己在全量暴露。
    const isProd = isProductionRuntime();
    if (isProd && this.unconfiguredPolicy() !== 'deny') {
      this.logger.warn(
        '生产环境 DATA_SCOPE_UNCONFIGURED_POLICY=allow：未配置行级权限的资源将全量暴露。' +
          '请去掉该值，或改为 fail_closed。除 allow 以外都按拒绝处理。',
      );
    }
    try {
      const rows = await this.db
        .select({ resourceType: sysDataScope.resourceType })
        .from(sysDataScope)
        .where(eq(sysDataScope.enabled, 1));
      const configured = new Set(rows.map((row) => row.resourceType));
      const accountingUnconfigured = TAX_ENTITY_RESOURCES.filter(
        (resource) => !configured.has(resource),
      );
      if (accountingUnconfigured.length > 0) {
        this.logger.warn(
          `会计资料类资源未登记任何行级权限配置：${accountingUnconfigured.join(', ')}。` +
            '在 DATA_SCOPE_UNCONFIGURED_POLICY=deny 下，这些资源对非 admin 角色将返回空集；' +
            '若需授权，请先在 sys_data_scope 登记配置。',
        );
      }
      this.logger.log(
        `数据权限启动校验完成：已启用行级权限的资源 ${[...configured].join(', ') || '（无）'}`,
      );
    } catch (error) {
      this.logger.warn(
        `数据权限启动校验跳过（DB 暂不可用）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /* ==================== 配置解析 ==================== */

  /**
   * 未配置时的策略。默认 `deny`（fail-closed），环境变量 `DATA_SCOPE_UNCONFIGURED_POLICY=allow`
   * 可临时退回放行（排障用；仅接受 'allow' 作为放开值，其它任何值均按 deny 处理）。
   */
  private unconfiguredPolicy(): 'allow' | 'deny' {
    return (process.env.DATA_SCOPE_UNCONFIGURED_POLICY ?? '').toLowerCase() ===
      'allow'
      ? 'allow'
      : 'deny';
  }

  /**
   * 解析 `roles × resourceType` 的可见范围。
   *
   * 多角色合并口径（**需业务确认**）：取**最宽**的范围，优先级
   * `all > dept_and_child > dept > custom > self`；`custom` 时合并各角色的
   * custom_ids 并集。理由是"用户被授予多个角色时不应比其任一角色可见范围更小"，
   * 但这意味着给某人加宽范围角色会抵消窄范围角色。
   */
  async resolveScope(
    roles: string[],
    resourceType: string
  ): Promise<ResolvedScope> {
    const roleList = uniqueStrings(roles);
    if (roleList.includes('admin')) {
      return {
        roleCode: 'admin',
        resourceType,
        scope: 'all',
        customIds: [],
        from: 'bypass',
      };
    }
    const fallback: ResolvedScope = {
      roleCode: null,
      resourceType,
      scope: 'all',
      customIds: [],
      from: 'default',
    };
    // ── S-3（§6.5.1）：**无角色用户必须 fail-closed，而不是拿 `scope: 'all'`** ──
    //
    // 原实现在这里 `return fallback`（`scope: 'all'`）**提前返回**，绕过了下方全部
    // fail-closed 逻辑（`:414-422` 的默认 deny 策略、`:486-531` 对会计资料类
    // "未配置即返回 scope:'none'"）。
    //
    // 触发条件真实存在：`shared/rbac.ts` 对**无角色**用户仍授予 `_default` 能力
    // （`dashboard` / `drive` / `settings_appearance`），因此这样的人**能登录、
    // 能进业务接口**。一旦其访问带数据权限的接口，就会拿到"全量可见"——
    // 比任何有角色但被收窄的用户权限**更宽**，正好与最小权限相反。
    //
    // 修法：无角色 → `scope: 'none'`（空集）。这与 `TAX_ENTITY_RESOURCES`
    // 未配置时的拒绝方向一致，且登录本身不受影响（能力矩阵仍按 `_default` 判定）。
    if (roleList.length === 0) {
      if (!this.unassignedRoleWarned) {
        this.unassignedRoleWarned = true;
        this.logger.warn(
          '检测到无角色用户的资源访问请求：已按 fail-closed 返回空集（scope=none）。' +
            '这类账号仍持有 _default 能力（dashboard/drive/settings_appearance），' +
            '但不应对任何带行级权限的业务数据可见。如需授权请分配角色。'
        );
      }
      return {
        roleCode: null,
        resourceType,
        scope: 'none',
        customIds: [],
        from: 'unassigned_role',
      };
    }

    const rows = await this.db
      .select({
        roleCode: sysDataScope.roleCode,
        scope: sysDataScope.scope,
        customIds: sysDataScope.customIds,
      })
      .from(sysDataScope)
      .where(
        and(
          inArray(sysDataScope.roleCode, roleList),
          eq(sysDataScope.resourceType, resourceType),
          eq(sysDataScope.enabled, 1)
        )
      );
    if (rows.length === 0) {
      // 未命中配置时的默认策略，分两种情况（缺一不可）：
      //
      // (a) **会计资料类（voucher/ledger/report）默认 fail-closed**。
      //     理由：这三类是"按纳税主体隔离"最敏感的资产（凭证、账簿、法定报表）。
      //     原实现的 fail-closed 只在"该资源类型已有配置行"时才生效，等于
      //     **只要没人配置过，就永远不收紧** —— 而 `sys_data_scope` 里
      //     voucher/ledger/report 恰恰**从未种子化**（e01 迁移有意留空），
      //     于是"默认全量可见"成了事实上的永久状态。多主体部署下，
      //     子公司财务能直接看到母公司全部凭证与报表，且没有任何告警。
      //     现在改为：未配置该资源 → 会计资料一律拒绝（空集 / 403），
      //     需要放开的角色必须**显式**登记配置行（当前 access 因此可审计、可撤销）。
      //
      // (b) 其它资源维持"已启用才收紧"，避免新环境/演示库因无配置行而全站列表变空
      //     （那看起来像故障而不是权限生效）。
      //
      // 逃生开关：`DATA_SCOPE_UNCONFIGURED_POLICY=allow` 对 (a)(b) 同时放开（排障用）。
      if (this.unconfiguredPolicy() === 'deny') {
        const isAccounting = (
          TAX_ENTITY_RESOURCES as readonly string[]
        ).includes(resourceType);
        if (isAccounting) {
          if (!this.unconfiguredDenyWarned.has(resourceType)) {
            this.unconfiguredDenyWarned.add(resourceType);
            this.logger.warn(
              `会计资料资源 ${resourceType} 未登记任何行级权限配置 → 按 fail-closed 拒绝（空集/403）。` +
                `如需授权角色访问，请登记 sys_data_scope 配置行；` +
                `临时排障可设 DATA_SCOPE_UNCONFIGURED_POLICY=allow。`
            );
          }
          return {
            roleCode: null,
            resourceType,
            scope: 'none',
            customIds: [],
            from: 'policy',
          };
        }
        const inUse = await this.db
          .select({ roleCode: sysDataScope.roleCode })
          .from(sysDataScope)
          .where(
            and(
              eq(sysDataScope.resourceType, resourceType),
              eq(sysDataScope.enabled, 1)
            )
          )
          .limit(1);
        if (inUse.length > 0) {
          if (!this.unconfiguredDenyWarned.has(resourceType)) {
            this.unconfiguredDenyWarned.add(resourceType);
            this.logger.warn(
              `资源 ${resourceType} 已启用行级权限，角色 [${roleList.join(',')}] 无配置行 → 按 fail-closed 拒绝（可通过 DATA_SCOPE_UNCONFIGURED_POLICY=allow 临时放开）`
            );
          }
          return {
            roleCode: null,
            resourceType,
            scope: 'none',
            customIds: [],
            from: 'policy',
          };
        }
      }
      return fallback;
    }

    const rank: Record<DataScopeType, number> = {
      none: -1,
      self: 0,
      custom: 1,
      dept: 2,
      dept_and_child: 3,
      all: 4,
    };
    let winner = rows[0];
    let winnerScope = this.normalizeScope(winner.scope);
    const customIds: string[] = [];
    for (const row of rows) {
      const scope = this.normalizeScope(row.scope);
      if (scope === 'custom') customIds.push(...this.parseCustomIds(row.customIds));
      if (rank[scope] > rank[winnerScope]) {
        winner = row;
        winnerScope = scope;
      }
    }
    return {
      roleCode: winner.roleCode ?? null,
      resourceType,
      scope: winnerScope,
      customIds: winnerScope === 'custom' ? uniqueStrings(customIds) : [],
      from: 'config',
    };
  }

  /**
   * 推荐的调用入口：解析范围 + 生成 SQL 条件（一步到位）。
   *
   * @param columns 各 scope 需要的比较列
   * @param extra   `selfValue`（资源以员工为主键时传员工 id）/ `departmentValueKind`
   */
  async conditionFor(
    resourceType: DataScopeResource,
    actor: RequestActor,
    columns: ScopeColumns,
    extra?: {
      selfValue?: string | null;
      departmentValueKind?: 'id' | 'name';
      /** 已知范围时可直接传入，避免重复查配置 */
      resolved?: ResolvedScope;
    }
  ): Promise<SQL | undefined> {
    const resolved: ResolvedScope =
      extra?.resolved ??
      (await this.resolveScope(actor.roles ?? [], resourceType));
    if (resolved.from === 'default' || resolved.scope === 'all') return undefined;
    const values = await this.resolveScopeValues(actor);
    const ctx: DataScopeContext = {
      userId: actor.userId,
      resourceType,
      ...values,
      selfValue: extra?.selfValue ?? values.selfValue,
      departmentValueKind: extra?.departmentValueKind ?? 'id',
    };
    const column = pickScopeColumn(columns, resolved.scope);
    const condition = applyScope(column, resolved, ctx);
    if (condition === SCOPE_FAIL_CLOSED) {
      // 配置要求收窄但拿不到部门/本人，不能静默放行：记 warn，并按空集返回。
      this.logger.warn(
        `数据权限无法收敛，已按空集返回 resource=${resourceType} user=${actor.userId} ` +
          `role=${resolved.roleCode ?? '-'} scope=${resolved.scope} ` +
          `dept=${(values.departmentIds ?? []).length} self=${values.selfValue ? 'y' : 'n'}`,
      );
    }
    return condition;
  }

  /**
   * B-2：解析会计资料的纳税主体可见范围。
   *
   * `from === 'default'`（未配置）与 `bypass`（admin）→ 不限，与既有惯例一致：
   * 新资源类型在业务方确认可见主体之前不改变行为（迁移 e01 不种子化配置行）。
   * `from === 'policy'`（该资源已启用行级权限但本角色未配置）→ 由
   * `applyTaxEntityScope` 转成 `denied`（fail-closed）。
   */
  async taxEntityScopeFor(
    resourceType: DataScopeResource,
    actor: RequestActor
  ): Promise<TaxEntityFilter> {
    const resolved = await this.resolveScope(actor.roles ?? [], resourceType);
    if (resolved.from === 'default' || resolved.from === 'bypass') {
      return { kind: 'unrestricted' };
    }
    const filter = applyTaxEntityScope(resolved);
    if (filter.kind === 'denied') {
      this.logger.warn(
        `会计资料数据权限拒绝：resource=${resourceType} user=${actor.userId} ` +
          `role=${resolved.roleCode ?? '-'} scope=${resolved.scope} ` +
          `（voucher/ledger/report 仅支持 all|custom（纳税主体））`
      );
    }
    return filter;
  }

  /**
   * B-2：解析 + 收敛纳税主体，越权或不明确时抛 403。
   *
   * 这是账簿/报表/凭证接口的唯一推荐入口：返回的 id 直接当作 SQL 过滤条件使用。
   */
  async narrowTaxEntityIdFor(
    resourceType: DataScopeResource,
    actor: RequestActor,
    requested?: string,
    label?: string
  ): Promise<string | undefined> {
    const filter = await this.taxEntityScopeFor(resourceType, actor);
    const narrowed = narrowTaxEntityId(filter, requested || undefined, label);
    if (!narrowed.ok) {
      this.logger.warn(
        `越权访问被拦截：resource=${resourceType} user=${actor.userId} requested=${requested ?? '-'} ${narrowed.message}`
      );
      throw new ForbiddenException(narrowed.message);
    }
    return narrowed.taxEntityId;
  }

  /**
   * 单条数据的越权校验：条件为空集 → 记 warn + 抛 403。
   *
   * 需求书验收标准③"越权直连接口（绕过 UI）同样 403 或返回空集"：
   * 列表接口靠 `conditionFor` 返回空集，详情接口靠本方法返回 403。
   */
  async assertVisible(
    resourceType: DataScopeResource,
    actor: RequestActor,
    columns: ScopeColumns,
    extra?: {
      selfValue?: string | null;
      departmentValueKind?: 'id' | 'name';
      /** 资源中文名，用于错误消息 */
      label?: string;
      /** 已知范围时可直接传入 */
      resolved?: ResolvedScope;
    }
  ): Promise<SQL | undefined> {
    const resolved: ResolvedScope =
      extra?.resolved ??
      (await this.resolveScope(actor.roles ?? [], resourceType));
    if (resolved.from === 'default' || resolved.scope === 'all') return undefined;
    const condition = await this.conditionFor(resourceType, actor, columns, extra);
    if (condition === undefined) return undefined;
    const label = extra?.label ?? resourceType;
    this.logger.warn(
      `越权访问被拦截：资源=${label} resource=${resourceType} user=${actor.userId} ` +
        `role=${resolved.roleCode ?? '-'} scope=${resolved.scope}`,
    );
    throw new ForbiddenException(
      `没有访问该${label}的数据权限（可见范围：${DATA_SCOPE_TYPE_LABELS[resolved.scope]}）`
    );
  }

  /* ==================== actor → 上下文 ==================== */

  /** 把 actor 解析成过滤上下文（部门已展开为"本部门及下级"） */
  async resolveContext(
    actor: RequestActor,
    resourceType?: string
  ): Promise<DataScopeContext> {
    const values = await this.resolveScopeValues(actor);
    return { userId: actor.userId, resourceType, ...values };
  }

  /**
   * "本部门及下级"在**从表**上的过滤：把部门集合换成这些部门下的员工 id 集合。
   *
   * 用于 `hr_attendance` / `hr_payroll` 这类只有 `employee_id`、没有部门列的表 ——
   * 需求书 B-02 的 SQL 层过滤要求不能退化成"查出来再在内存里过滤"，
   * 因此这里获取 id 集合后由调用方拼 `employee_id IN (...)`。
   */
  async employeeIdsInDepartments(departmentIds: string[]): Promise<string[]> {
    const ids = uniqueStrings(departmentIds);
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: mdEmployee.id })
      .from(mdEmployee)
      .where(inArray(mdEmployee.departmentId, ids));
    return rows.map((row) => row.id);
  }

  /**
   * 收窄范围但缺少可用值：记 warn 并返回 fail-closed 条件（列表→空集）。
   * 调用方在无法用 `conditionFor` 表达时（如需要额外查员工 id）使用。
   */
  failClosed(
    resourceType: string,
    actor: RequestActor,
    resolved: ResolvedScope,
    reason: string
  ): SQL {
    this.logger.warn(
      `数据权限无法收敛，已按空集返回 resource=${resourceType} user=${actor.userId} ` +
        `role=${resolved.roleCode ?? '-'} scope=${resolved.scope} 原因=${reason}`
    );
    return SCOPE_FAIL_CLOSED;
  }

  private async resolveScopeValues(actor: RequestActor): Promise<ScopeValues> {
    const binding: EmployeeBinding | null = await this.findEmployeeBinding(
      actor.userId
    );
    const sysDept = await this.findSysUserDepartment(actor.userId);
    const departmentId: string | null =
      binding?.departmentId ?? sysDept?.id ?? null;
    const departments = await this.departments();
    const byId = new Map(departments.map((row) => [row.id, row]));
    const names = new Set<string>();
    if (binding?.departmentName) names.add(binding.departmentName);
    if (departmentId && byId.get(departmentId)) {
      names.add((byId.get(departmentId) as DepartmentRow).name);
    }
    if (names.size === 0 && sysDept?.name) names.add(sysDept.name);

    const departmentIds: string[] = [];
    if (departmentId) {
      departmentIds.push(
        departmentId,
        ...this.descendantIds(departments, departmentId)
      );
    }
    const allNames = new Set<string>(names);
    for (const id of departmentIds) {
      const row = byId.get(id);
      if (row) allNames.add(row.name);
    }
    return {
      selfValue: binding?.employeeId ?? actor.userId,
      departmentIds: uniqueStrings(departmentIds),
      departmentNames: uniqueStrings([...allNames]),
    };
  }

  /** 员工档案绑定（`platform_user_id` / `feishu_union_id`） */
  async findEmployeeBinding(userId: string): Promise<{
    employeeId: string;
    departmentId: string | null;
    departmentName: string | null;
  } | null> {
    const rows = await this.db
      .select({
        employeeId: mdEmployee.id,
        departmentId: mdEmployee.departmentId,
        departmentName: hrDepartment.name,
      })
      .from(mdEmployee)
      .leftJoin(hrDepartment, eq(mdEmployee.departmentId, hrDepartment.id))
      .where(
        or(
          eq(mdEmployee.platformUserId, userId),
          eq(mdEmployee.feishuUnionId, userId)
        )
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      employeeId: row.employeeId,
      departmentId: row.departmentId ?? null,
      departmentName: row.departmentName ?? null,
    };
  }

  /** 员工档案未绑定时的兜底：`sys_user.department_id` → `sys_user.department_name` 反查 */
  private async findSysUserDepartment(
    userId: string
  ): Promise<{ id: string; name: string } | null> {
    const rows = await this.db
      .select({
        departmentId: sysUser.departmentId,
        departmentName: sysUser.departmentName,
      })
      .from(sysUser)
      .where(eq(sysUser.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.departmentId) {
      const hit = await this.db
        .select({ id: hrDepartment.id, name: hrDepartment.name })
        .from(hrDepartment)
        .where(eq(hrDepartment.id, row.departmentId))
        .limit(1);
      if (hit[0]) return { id: hit[0].id, name: hit[0].name };
    }
    if (row.departmentName) {
      const hit = await this.db
        .select({ id: hrDepartment.id, name: hrDepartment.name })
        .from(hrDepartment)
        .where(eq(hrDepartment.name, row.departmentName))
        .limit(1);
      if (hit[0]) return { id: hit[0].id, name: hit[0].name };
    }
    return null;
  }

  /** 部门表体量很小（数十行），整表缓存 60s 后在内存里算下级，避免递归 CTE */
  private async departments(): Promise<DepartmentRow[]> {
    const now = Date.now();
    if (
      this.departmentCache &&
      now - this.departmentCache.at < DEPARTMENT_CACHE_MS
    ) {
      return this.departmentCache.rows;
    }
    const rows = await this.db
      .select({
        id: hrDepartment.id,
        name: hrDepartment.name,
        parentId: hrDepartment.parentId,
      })
      .from(hrDepartment);
    const normalized: DepartmentRow[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      parentId: row.parentId ?? null,
    }));
    this.departmentCache = { rows: normalized, at: now };
    return normalized;
  }

  private descendantIds(rows: DepartmentRow[], rootId: string): string[] {
    const childrenOf = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.parentId) continue;
      childrenOf.set(row.parentId, [
        ...(childrenOf.get(row.parentId) ?? []),
        row.id,
      ]);
    }
    const out: string[] = [];
    const stack: string[] = [...(childrenOf.get(rootId) ?? [])];
    const seen = new Set<string>([rootId]);
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      out.push(current);
      stack.push(...(childrenOf.get(current) ?? []));
    }
    return out;
  }

  private normalizeScope(raw: string | null | undefined): DataScopeType {
    const value = (raw ?? 'all').trim() as DataScopeType;
    return DATA_SCOPE_TYPES.includes(value) ? value : 'all';
  }

  private parseCustomIds(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      this.logger.warn(
        `custom_ids 不是合法 JSON 数组，按空集处理：${raw.slice(0, 80)}`
      );
      return [];
    }
  }

  /* ==================== 配置读写（供 system-config 复用） ==================== */

  async listConfigs(): Promise<
    Array<{
      roleCode: string;
      resourceType: string;
      scope: DataScopeType;
      customIds: string[];
      enabled: boolean;
      remark: string | null;
    }>
  > {
    const rows = await this.db
      .select()
      .from(sysDataScope)
      .orderBy(sysDataScope.resourceType, sysDataScope.roleCode);
    return rows.map((row) => ({
      roleCode: row.roleCode,
      resourceType: row.resourceType,
      scope: this.normalizeScope(row.scope),
      customIds: this.parseCustomIds(row.customIds),
      enabled: Number(row.enabled ?? 0) === 1,
      remark: row.remark,
    }));
  }

  async upsertConfig(dto: {
    roleCode: string;
    resourceType: string;
    scope: DataScopeType;
    customIds?: string[];
    enabled?: boolean;
    remark?: string | null;
  }): Promise<{ roleCode: string; resourceType: string; scope: DataScopeType }> {
    const customIds = uniqueStrings(dto.customIds);
    const values = {
      roleCode: dto.roleCode,
      resourceType: dto.resourceType,
      scope: dto.scope,
      customIds: JSON.stringify(customIds),
      enabled: dto.enabled === false ? 0 : 1,
      remark: dto.remark ?? null,
      updatedAt: new Date(),
    };
    await this.db
      .insert(sysDataScope)
      .values(values)
      .onConflictDoUpdate({
        target: [sysDataScope.roleCode, sysDataScope.resourceType],
        set: {
          scope: values.scope,
          customIds: values.customIds,
          enabled: values.enabled,
          remark: values.remark,
          updatedAt: values.updatedAt,
        },
      });
    return {
      roleCode: values.roleCode,
      resourceType: values.resourceType,
      scope: values.scope,
    };
  }

  /** 配置变更后清部门缓存 */
  invalidate(): void {
    this.departmentCache = null;
  }
}
