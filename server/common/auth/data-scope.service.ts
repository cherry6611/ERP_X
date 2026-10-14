import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
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
export type DataScopeType = 'all' | 'dept' | 'dept_and_child' | 'self' | 'custom';

/** B-02：可配置数据权限的资源类型（与迁移里的 chk_sys_data_scope_resource 一致） */
export const DATA_SCOPE_RESOURCES = [
  'project',
  'customer',
  'finance_ledger',
  'employee',
  'attendance',
] as const;

export type DataScopeResource = (typeof DATA_SCOPE_RESOURCES)[number];

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
};

/** 解析后的范围（已含 custom_ids） */
export interface ResolvedScope {
  /** 命中配置的角色码；未命中为 null */
  roleCode: string | null;
  resourceType: string;
  scope: DataScopeType;
  customIds: string[];
  /** 结论来源：bypass（管理员）/ config（命中配置）/ default（未配置，放行给既有规则） */
  from: 'bypass' | 'config' | 'default';
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
export class DataScopeService {
  private readonly logger = new Logger(DataScopeService.name);
  private departmentCache: DepartmentCache | null = null;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  /* ==================== 配置解析 ==================== */

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
    if (roleList.length === 0) return fallback;

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
    if (rows.length === 0) return fallback;

    const rank: Record<DataScopeType, number> = {
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
