import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, desc, eq, inArray, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  erpContract,
  erpCostAllocation,
  erpLaborRate,
  erpProject,
  erpProjectCost,
  erpTimesheet,
  hrDepartment,
  hrPosition,
  mdEmployee,
  mdSupplier,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { extractPostgresErrorCode } from '@server/common/utils/postgres-error';
// D-07：复用 D-03 的最大余数法分摊引擎（保证 Σ share === amount）
import { allocateAmount } from '@server/modules/finance-reports/aux-combination-rules';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { costConfirmLines } from '@server/common/tax/posting';
import { todayInShanghai, monthInShanghai } from '@server/common/utils/biz-date';
import { assertPeriodOpen } from '@server/common/utils/period-guard';
import { ActorAccessService } from '@server/common/auth/actor-access.service';
import { DataScopeService } from '@server/common/auth/data-scope.service';
import { ProjectAclService } from '@server/modules/projects/project-acl.service';
import type { RequestActor } from '@server/common/auth/actor';
import { round2 } from '@server/common/utils/number';
import {
  buildRedflushSourceRef,
  isRedflushSourceRef,
} from './redflush-ref';
import type {
  CostAllocation,
  CostAllocationBatchResult,
  CostDimension,
  CostDimensionSummary,
  CostItem,
  CostType,
  CostTypeSummary,
  CreateAllocationDto,
  CreateCostAllocationBatchDto,
  CreateCostDto,
  CreateLaborRateDto,
  CreateTimesheetDto,
  LaborRate,
  Timesheet,
  TimesheetAction,
  TimesheetStatus,
} from '@shared/api.interface';

const COST_TYPES: CostType[] = [
  'labor',
  'outsource',
  'compute',
  'storage',
  'tool',
  'travel',
  'flex_labor',
];

const FLEX_EMPLOYMENT_TYPES = ['part_time', 'flex'];

/** 金额四舍五入到分（与本仓其他地方口径一致） */

const COST_TYPE_LABELS: Record<string, string> = {
  labor: '人力成本',
  outsource: '外包成本',
  compute: '算力成本',
  storage: '存储成本',
  tool: '工具成本',
  travel: '差旅成本',
  flex_labor: '灵活用工',
};

function currentPeriod(): string {
  return monthInShanghai();
}

@Injectable()
export class CostsService {
  private readonly logger = new Logger(CostsService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly actorAccess: ActorAccessService,
    private readonly voucherHookService: VoucherHookService,
    private readonly dataScope: DataScopeService,
    private readonly projectAcl: ProjectAclService
  ) {}

  /**
   * B-2：项目成本的可见范围（口径 = 项目）。
   *
   * 不传 `actor` 表示**系统内部调用**（如红冲后的回读），不注入过滤；
   * HTTP 边界（`costs.controller`）必须传，否则项目级隔离对这个列表就不生效。
   */
  async listCosts(
    projectId?: string,
    costType?: string,
    actor?: RequestActor
  ): Promise<CostItem[]> {
    const conditions: SQL[] = [];
    if (projectId) conditions.push(eq(erpProjectCost.projectId, projectId));
    if (costType) conditions.push(eq(erpProjectCost.costType, costType));
    if (actor) {
      const scope = await this.dataScope.conditionFor('cost', actor, {
        primary: erpProjectCost.projectId,
      });
      // `undefined` = 未配置/全量；`1 = 0` = 空集（fail-closed），两者语义不同不能混用
      if (scope) {
        conditions.push(scope);
      } else {
        // cost 未配置 sys_data_scope 时不能默认全放行：回退到 ProjectAcl
        // 的项目可见集（PM 只看到自己/本部门/参与的项目）。
        const visibleIds = await this.projectAcl.visibleProjectIds(actor);
        if (visibleIds) {
          conditions.push(
            visibleIds.length > 0
              ? inArray(erpProjectCost.projectId, visibleIds)
              : sql`1 = 0`,
          );
        }
      }
    }
    const rows = await this.db
      .select({
        cost: erpProjectCost,
        projectName: erpProject.name,
        supplierName: mdSupplier.name,
        departmentName: hrDepartment.name,
        contractName: erpContract.name,
      })
      .from(erpProjectCost)
      .leftJoin(erpProject, eq(erpProjectCost.projectId, erpProject.id))
      .leftJoin(mdSupplier, eq(erpProjectCost.supplierId, mdSupplier.id))
      .leftJoin(hrDepartment, eq(erpProjectCost.departmentId, hrDepartment.id))
      .leftJoin(erpContract, eq(erpProjectCost.contractId, erpContract.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(erpProjectCost.createdAt));
    return rows.map((row) => ({
      id: row.cost.id,
      code: row.cost.code,
      projectId: row.cost.projectId ?? '',
      projectName: row.projectName ?? '',
      costType: (row.cost.costType ?? 'labor') as CostType,
      amount: Number(row.cost.amount ?? 0),
      period: row.cost.period ?? '',
      occurredDate: row.cost.occurredDate,
      sourceRef: row.cost.sourceRef ?? '',
      supplierName: row.supplierName ?? null,
      departmentId: row.cost.departmentId ?? null,
      departmentName: row.departmentName ?? null,
      contractId: row.cost.contractId ?? null,
      contractName: row.contractName ?? null,
      remark: row.cost.remark,
      createdAt: row.cost.createdAt.toISOString(),
    }));
  }

  /**
   * B10（§6.5.2）：成本聚合的**行级可见范围**。
   *
   * `listCosts` 早已正确注入 `conditionFor('cost', actor, ...)`，但
   * `costSummary` / `dimensionSummary` / `listTimesheets` 的**签名里根本没有
   * actor 参数**（三个接口在 controller 里也没传）—— 于是当 `sys_data_scope`
   * 为 `cost` 资源配置了 `self`/`dept`/`custom` 收窄时：
   *
   *   · **明细列表被过滤**（员工只看到自己的成本）；
   *   · **汇总金额与工时仍返回全量**。
   *
   * 这既可越权读取，又直接暴露了被隐藏明细的金额 —— 正是 `AGENTS.md:47`
   * 禁止的"只在 UI 隐藏"。
   *
   * ⚠️ 触发条件是"配置了 cost 的行级权限"，因此当前若未配置该资源，三者行为
   * 一致、无实际差异 —— 属**"配置即踩坑"**的形态。但正因为它在配置那天才爆发，
   * 更不能靠"现在没问题"来搪塞。
   *
   * 抽成共用方法的原因：三个入口必须**同一口径**，分别内联就是下一次分叉的起点
   * （B5 期初现金那处遗漏正是这么来的）。
   */
  private async costScopeCondition(
    actor?: RequestActor,
    projectColumn: PgColumn = erpProjectCost.projectId,
  ): Promise<SQL | undefined> {
    if (!actor) return undefined;
    const scope = await this.dataScope.conditionFor('cost', actor, {
      primary: projectColumn,
    });
    if (scope) return scope;
    // 未配置 cost 行级权限时，按项目可见集收窄（不能默认 all）。
    const visibleIds = await this.projectAcl.visibleProjectIds(actor);
    if (!visibleIds) return undefined;
    return visibleIds.length > 0
      ? inArray(projectColumn, visibleIds)
      : sql`1 = 0`;
  }

  /** 多维成本汇总：costType / department / contract / period */
  async dimensionSummary(
    dimension: CostDimension,
    projectId?: string,
    actor?: RequestActor
  ): Promise<CostDimensionSummary[]> {
    const conditions: SQL[] = [];
    if (projectId) conditions.push(eq(erpProjectCost.projectId, projectId));
    const scope = await this.costScopeCondition(actor);
    // `undefined` = 未配置/全量；`1 = 0` = 空集（fail-closed），两者语义不同不能混用
    if (scope) conditions.push(scope);
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    if (dimension === 'costType') {
      const rows = await this.db
        .select({
          key: erpProjectCost.costType,
          total: sql<number>`coalesce(sum(${erpProjectCost.amount}), 0)::float8`,
        })
        .from(erpProjectCost)
        .where(where)
        .groupBy(erpProjectCost.costType);
      return rows
        .filter((row) => COST_TYPES.includes((row.key ?? '') as CostType))
        .map((row) => ({
          dimension,
          key: row.key ?? 'labor',
          label: COST_TYPE_LABELS[row.key ?? ''] ?? row.key ?? '',
          amount: Number(row.total ?? 0),
        }));
    }
    if (dimension === 'period') {
      const rows = await this.db
        .select({
          key: erpProjectCost.period,
          total: sql<number>`coalesce(sum(${erpProjectCost.amount}), 0)::float8`,
        })
        .from(erpProjectCost)
        .where(where)
        .groupBy(erpProjectCost.period)
        .orderBy(asc(erpProjectCost.period));
      return rows
        .filter((row) => (row.key ?? '') !== '')
        .map((row) => ({
          dimension,
          key: row.key ?? '',
          label: row.key ?? '',
          amount: Number(row.total ?? 0),
        }));
    }
    if (dimension === 'department') {
      const rows = await this.db
        .select({
          key: erpProjectCost.departmentId,
          name: hrDepartment.name,
          total: sql<number>`coalesce(sum(${erpProjectCost.amount}), 0)::float8`,
        })
        .from(erpProjectCost)
        .leftJoin(
          hrDepartment,
          eq(erpProjectCost.departmentId, hrDepartment.id)
        )
        .where(where)
        .groupBy(erpProjectCost.departmentId, hrDepartment.name);
      return rows.map((row) => ({
        dimension,
        key: row.key ?? '',
        label: row.name ?? '未分配部门',
        amount: Number(row.total ?? 0),
      }));
    }
    const rows = await this.db
      .select({
        key: erpProjectCost.contractId,
        name: erpContract.name,
        total: sql<number>`coalesce(sum(${erpProjectCost.amount}), 0)::float8`,
      })
      .from(erpProjectCost)
      .leftJoin(erpContract, eq(erpProjectCost.contractId, erpContract.id))
      .where(where)
      .groupBy(erpProjectCost.contractId, erpContract.name);
    return rows.map((row) => ({
      dimension,
      key: row.key ?? '',
      label: row.name ?? '未关联合同',
      amount: Number(row.total ?? 0),
    }));
  }

  async costSummary(
    projectId?: string,
    actor?: RequestActor
  ): Promise<CostTypeSummary[]> {
    const conditions: SQL[] = [];
    if (projectId) conditions.push(eq(erpProjectCost.projectId, projectId));
    const scope = await this.costScopeCondition(actor);
    if (scope) conditions.push(scope);
    const rows = await this.db
      .select({
        costType: erpProjectCost.costType,
        total: sql<number>`coalesce(sum(${erpProjectCost.amount}), 0)::float8`,
      })
      .from(erpProjectCost)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(erpProjectCost.costType);
    return rows
      .filter((row) => COST_TYPES.includes((row.costType ?? '') as CostType))
      .map((row) => ({
        costType: (row.costType ?? 'labor') as CostType,
        amount: Number(row.total ?? 0),
      }));
  }

  async createCost(dto: CreateCostDto): Promise<CostItem> {
    if (dto.amount <= 0) {
      throw new BadRequestException('成本金额必须大于 0');
    }
    const project = await this.db
      .select({
        id: erpProject.id,
        name: erpProject.name,
        contractId: erpProject.contractId,
        deptName: erpProject.deptName,
      })
      .from(erpProject)
      .where(eq(erpProject.id, dto.projectId));
    if (project.length === 0) throw new NotFoundException('项目不存在');
    if (!COST_TYPES.includes(dto.costType)) {
      throw new BadRequestException('非法的成本类型');
    }
    let departmentId: string | null = dto.departmentId ?? null;
    if (!departmentId && project[0].deptName) {
      const dept = await this.db
        .select({ id: hrDepartment.id })
        .from(hrDepartment)
        .where(eq(hrDepartment.name, project[0].deptName))
        .limit(1);
      departmentId = dept[0]?.id ?? null;
    }
    const code = await generateBizCode(
      this.db,
      erpProjectCost,
      erpProjectCost.code,
      'CST'
    );
    const occurredDate = dto.occurredDate ?? todayInShanghai();
    // B4 / D-27：**成本登记的期间闸门**。
    //
    // 原实现整体缺这道校验（全仓 `assertPeriodOpen` 的 18 处引用里，成本模块 0 处），
    // 于是产生**永久死信**：
    //   ① 3 月已关账。6 月补录 3 月 20 日的成本 → 闸门缺失 → `erp_project_cost`
    //      以 `period = '2026-03'` **成功落库**（已关账月份的账里凭空多出成本）；
    //   ② 随后调 `generateVoucherDraft` → 凭证钩子期间已结账 → 返回 `failed`；
    //   ③ 失败写入 `comp_voucher_job` 补偿队列；
    //   ④ **重试每次撞同一道门** —— 期间永远是关的，最多 8 次后置 `dead`。
    //      **凭证永远不会生成**，队列里留下永久 dead 记录，运维看到的是
    //      "有业务无凭证"的悬空账。
    //
    // 修法：与 ar/ap/revenues 一致，**在业务写入之前**拒绝，而不是
    // "先落库、后失败、进死信"。
    await assertPeriodOpen(this.db, occurredDate, '登记成本');
    const rows = await this.db
      .insert(erpProjectCost)
      .values({
        code,
        projectId: dto.projectId,
        costType: dto.costType,
        amount: String(dto.amount),
        period: occurredDate.slice(0, 7),
        occurredDate,
        sourceRef: dto.sourceRef,
        supplierId: dto.supplierId,
        departmentId,
        contractId: project[0].contractId ?? null,
        isAccrual: 0,
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];
    if (dto.amount !== 0) {
      await this.voucherHookService.generateVoucherDraft({
        sourceType: 'cost',
        sourceRef: `cost:${code}`,
        voucherDate: occurredDate,
        summary: `成本确认 ${code}`,
        lines: costConfirmLines(dto.amount),
      });
    }
    let supplierName: string | null = null;
    if (row.supplierId) {
      const supplier = await this.db
        .select({ name: mdSupplier.name })
        .from(mdSupplier)
        .where(eq(mdSupplier.id, row.supplierId));
      supplierName = supplier[0]?.name ?? null;
    }
    let departmentName: string | null = null;
    if (row.departmentId) {
      const dept = await this.db
        .select({ name: hrDepartment.name })
        .from(hrDepartment)
        .where(eq(hrDepartment.id, row.departmentId));
      departmentName = dept[0]?.name ?? null;
    }
    let contractName: string | null = null;
    if (row.contractId) {
      const contract = await this.db
        .select({ name: erpContract.name })
        .from(erpContract)
        .where(eq(erpContract.id, row.contractId));
      contractName = contract[0]?.name ?? null;
    }
    return {
      id: row.id,
      code: row.code,
      projectId: row.projectId ?? '',
      projectName: project[0].name,
      costType: (row.costType ?? 'labor') as CostType,
      amount: Number(row.amount ?? 0),
      period: row.period ?? '',
      occurredDate: row.occurredDate,
      sourceRef: row.sourceRef ?? '',
      supplierName,
      departmentId: row.departmentId ?? null,
      departmentName,
      contractId: row.contractId ?? null,
      contractName,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listTimesheets(
    projectId?: string,
    actor?: RequestActor
  ): Promise<Timesheet[]> {
    const conditions: SQL[] = [];
    if (projectId) conditions.push(eq(erpTimesheet.projectId, projectId));
    // B10：工时同样按项目归属过滤（与成本同一资源口径）；
    // 列必须是 erpTimesheet.projectId，否则生成的 SQL 会引用不存在的 erp_project_cost。
    const scope = await this.costScopeCondition(actor, erpTimesheet.projectId);
    if (scope) conditions.push(scope);
    const rows = await this.db
      .select({ sheet: erpTimesheet, projectName: erpProject.name })
      .from(erpTimesheet)
      .leftJoin(erpProject, eq(erpTimesheet.projectId, erpProject.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(erpTimesheet.createdAt));
    return rows.map((row) => ({
      id: row.sheet.id,
      code: row.sheet.code,
      projectId: row.sheet.projectId ?? '',
      projectName: row.projectName ?? '',
      employeeName: row.sheet.employeeName ?? '',
      employeeId: row.sheet.employeeId ?? null,
      roleName: row.sheet.roleName,
      workDate: row.sheet.workDate,
      hours: Number(row.sheet.hours ?? 0),
      status: (row.sheet.status ?? 'draft') as TimesheetStatus,
      costGenerated: row.sheet.costGenerated ?? false,
      remark: row.sheet.remark,
      createdAt: row.sheet.createdAt.toISOString(),
    }));
  }

  async createTimesheet(
    dto: CreateTimesheetDto,
    userId: string
  ): Promise<Timesheet> {
    const project = await this.db
      .select({ id: erpProject.id, name: erpProject.name })
      .from(erpProject)
      .where(eq(erpProject.id, dto.projectId));
    if (project.length === 0) throw new NotFoundException('项目不存在');
    /*
     * 工时上下界。> 24 显然是录入错误（把 8 输成 80），而它会直接让成本放大 10 倍；
     * 库层有 `chk_timesheet_hours_range` 兜底，这里给可读提示。
     */
    if (dto.hours <= 0) throw new BadRequestException('工时必须大于 0');
    if (dto.hours > 24) {
      throw new BadRequestException(
        `一条工时不能超过 24 小时（当前 ${dto.hours}）—— 请确认是否把小时数填错了`
      );
    }

    const employeeSelect = {
      id: mdEmployee.id,
      name: mdEmployee.name,
      status: mdEmployee.status,
      roleName: hrPosition.roleName,
    };
    let employees = await this.db
      .select(employeeSelect)
      .from(mdEmployee)
      .leftJoin(hrPosition, eq(hrPosition.id, mdEmployee.positionId))
      .where(or(eq(mdEmployee.feishuUnionId, userId), eq(mdEmployee.platformUserId, userId)));

    // 管理员可指定员工代登（本人未绑定时）
    if (employees.length === 0 && dto.employeeId) {
      const isAdmin = await this.actorAccess.hasAnyRole(userId, ['admin']);
      if (!isAdmin) {
        throw new ForbiddenException('仅管理员可为其他员工代登记工时');
      }
      employees = await this.db
        .select(employeeSelect)
        .from(mdEmployee)
        .leftJoin(hrPosition, eq(hrPosition.id, mdEmployee.positionId))
        .where(eq(mdEmployee.id, dto.employeeId));
      if (employees.length === 0) {
        throw new NotFoundException('指定的员工不存在');
      }
    }

    if (employees.length === 0) {
      throw new BadRequestException(
        '当前账号未绑定员工，无法登记工时。请到「人力资源 → 员工档案」将平台账号关联到员工；管理员可在登记时指定员工代登',
      );
    }
    const employee = employees[0];
    if (employee.status === 'resigned') {
      throw new BadRequestException('离职员工不能登记工时');
    }
    const employeeName: string = employee.name;
    const roleName: string | null = employee.roleName || dto.roleName || null;
    const employeeId: string = employee.id;
    if (!roleName) {
      throw new BadRequestException('缺少角色，无法计算费率（请为员工配置岗位角色，或在登记时填写角色）');
    }
    // B4：登记工时同样受期间闸门约束。
    //
    // 工时**确认**时才落成本，但工作日期在**登记**时就确定了：
    // 允许往已关账期间登记工时，等于为后面的"确认即死信"埋好了引信。
    // 因此这里按 `workDate` 校验 —— 与成本落库时的 `period` 同源。
    await assertPeriodOpen(this.db, dto.workDate, '登记工时');
    /*
     * B8：**同人 + 同项目 + 同日查重**。
     *
     * 原先完全没有查重，也没有库层唯一约束，于是"连点两次提交"或"网络重试"
     * 会产生两条完全相同的工时，两条都会被确认，**各生成一笔成本与一张凭证**
     * —— 成本翻倍，而事后从 `erp_project_cost` 看不出来（两条的 source_ref
     * 不同，看起来就是两次真实工作）。
     *
     * 库层已加部分唯一索引（`uq_erp_timesheet_employee_project_date`，
     * 排除 confirmed），这里先查一次是为了给出**可理解的中文提示**并指出
     * 那条已有记录的单号 —— 直接吃库层的 23505 只会得到一句
     * "记录已存在，请勿重复提交"，使用者不知道该怎么办。
     *
     * 为什么也拦 `submitted`：已提交但未确认的工时同样没算过钱，
     * 允许它重复就只是把问题推迟到确认那一步。
     */
    const duplicated = await this.db
      .select({ code: erpTimesheet.code, status: erpTimesheet.status })
      .from(erpTimesheet)
      .where(
        and(
          eq(erpTimesheet.employeeId, employeeId),
          eq(erpTimesheet.projectId, dto.projectId),
          eq(erpTimesheet.workDate, dto.workDate),
          ne(erpTimesheet.status, 'confirmed')
        )
      )
      .limit(1);
    if (duplicated.length > 0) {
      throw new ConflictException(
        `${employeeName} 在 ${dto.workDate} 已对该项目登记过工时` +
          `（${duplicated[0].code}，状态 ${duplicated[0].status ?? 'draft'}）。` +
          `同一天同一项目的多条工时会在「确认」时各自生成一笔成本与凭证，导致成本翻倍；` +
          `请改为修改已有记录的工时数，或先将其驳回/确认后再登记`
      );
    }
    const code = await generateBizCode(
      this.db,
      erpTimesheet,
      erpTimesheet.code,
      'TS'
    );
    const rows = await this.db
      .insert(erpTimesheet)
      .values({
        code,
        projectId: dto.projectId,
        employeeName,
        roleName,
        employeeId,
        workDate: dto.workDate,
        hours: String(dto.hours),
        status: 'draft',
        costGenerated: false,
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];
    return {
      id: row.id,
      code: row.code,
      projectId: row.projectId ?? '',
      projectName: project[0].name,
      employeeName: row.employeeName ?? '',
      employeeId: row.employeeId ?? null,
      roleName: row.roleName,
      workDate: row.workDate,
      hours: Number(row.hours ?? 0),
      status: (row.status ?? 'draft') as TimesheetStatus,
      costGenerated: row.costGenerated ?? false,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 工时确认时按角色费率折算生成人力成本 */
  async timesheetAction(
    id: string,
    action: TimesheetAction,
    actor: RequestActor
  ): Promise<Timesheet> {
    const existing = await this.db
      .select()
      .from(erpTimesheet)
      .where(eq(erpTimesheet.id, id));
    if (existing.length === 0) throw new NotFoundException('工时记录不存在');
    const sheet = existing[0];
    await this.assertTimesheetActor(sheet, action, actor);
    const current = (sheet.status ?? 'draft') as TimesheetStatus;
    if (action === 'submit' && current !== 'draft') {
      throw new BadRequestException('仅草稿状态可提交');
    }
    if (action === 'confirm' && current !== 'submitted') {
      throw new BadRequestException('仅已提交状态可确认');
    }
    if (action === 'reject' && current !== 'submitted') {
      throw new BadRequestException('仅已提交状态可驳回');
    }
    let postedCost: { code: string; amount: number; date: string } | null = null;
    if (action === 'submit') {
      await this.db
        .update(erpTimesheet)
        .set({ status: 'submitted', updatedAt: new Date() })
        .where(eq(erpTimesheet.id, id));
    } else if (action === 'reject') {
      await this.db
        .update(erpTimesheet)
        .set({ status: 'draft', updatedAt: new Date() })
        .where(eq(erpTimesheet.id, id));
    } else {
      // B4：**确认工时**是成本真正落库的那一步，期间闸门必须在这里。
      //
      // 历史数据里可能存在"在闸门缺失时期登记进已关账期间"的待确认工时，
      // 因此在确认入口再拦一次（登记侧已拦，但旧数据绕过不了这一步）。
      // 拦在业务写入之前 —— 否则成本落库成功、凭证永久失败，补偿队列堆死信。
      const workDateForGuard = sheet.workDate ?? todayInShanghai();
      await assertPeriodOpen(this.db, workDateForGuard, '确认工时生成成本');
      const costCode = await generateBizCode(
        this.db,
        erpProjectCost,
        erpProjectCost.code,
        'CST'
      );
      const workDate = sheet.workDate ?? todayInShanghai();
      postedCost = await this.db.transaction(async (tx) => {
        const claimed = await tx
          .update(erpTimesheet)
          .set({ status: 'confirmed', costGenerated: true, updatedAt: new Date() })
          .where(
            and(eq(erpTimesheet.id, id), eq(erpTimesheet.status, 'submitted'))
          )
          .returning({ id: erpTimesheet.id });
        if (claimed.length === 0) {
          throw new BadRequestException('仅已提交状态可确认');
        }
        const rates = await tx
          .select({ rate: erpLaborRate.rate })
          .from(erpLaborRate)
          .where(
            and(
              eq(erpLaborRate.roleName, sheet.roleName ?? ''),
              lte(erpLaborRate.effectiveFrom, workDate)
            )
          )
          .orderBy(desc(erpLaborRate.effectiveFrom))
          .limit(1);
        const rate = Number(rates[0]?.rate ?? 0);
        if (rates.length === 0 || rate <= 0) {
          throw new BadRequestException(
            `角色「${sheet.roleName ?? ''}」未配置生效费率，无法确认工时生成成本`
          );
        }
        const amount = Number(sheet.hours ?? 0) * rate;
        const employeeRows: {
          employmentType: string | null;
          departmentId: string | null;
          supplierId: string | null;
        }[] =
          sheet.employeeId
            ? await tx
                .select({
                  employmentType: mdEmployee.employmentType,
                  departmentId: mdEmployee.departmentId,
                  supplierId: mdEmployee.supplierId,
                })
                .from(mdEmployee)
                .where(eq(mdEmployee.id, sheet.employeeId))
                .limit(1)
            : [];
        const employmentType = employeeRows[0]?.employmentType ?? null;
        const departmentId = employeeRows[0]?.departmentId ?? null;
        const costType: CostType = FLEX_EMPLOYMENT_TYPES.includes(employmentType ?? '')
          ? 'flex_labor'
          : 'labor';
        const projectRows = sheet.projectId
          ? await tx
              .select({ contractId: erpProject.contractId })
              .from(erpProject)
              .where(eq(erpProject.id, sheet.projectId))
              .limit(1)
          : [];
        await tx.insert(erpProjectCost).values({
          code: costCode,
          projectId: sheet.projectId,
          costType,
          amount: String(amount),
          period: workDate.slice(0, 7),
          occurredDate: workDate,
          sourceRef: `timesheet:${sheet.code}`,
          departmentId,
          supplierId: employeeRows[0]?.supplierId ?? null,
          contractId: projectRows[0]?.contractId ?? null,
          isAccrual: 1,
          remark: `工时折算（预提）：${sheet.employeeName} ${sheet.hours}h × 费率 ${rate}`,
        });
        return { code: costCode, amount, date: workDate };
      });
    }
    if (postedCost !== null && postedCost.amount > 0) {
      await this.voucherHookService.generateVoucherDraft({
        sourceType: 'cost',
        sourceRef: `cost:${postedCost.code}`,
        voucherDate: postedCost.date,
        summary: `成本确认 ${postedCost.code}`,
        lines: costConfirmLines(postedCost.amount),
      });
    }
    const updated = await this.db
      .select({ sheet: erpTimesheet, projectName: erpProject.name })
      .from(erpTimesheet)
      .leftJoin(erpProject, eq(erpTimesheet.projectId, erpProject.id))
      .where(eq(erpTimesheet.id, id));
    const row = updated[0];
    return {
      id: row.sheet.id,
      code: row.sheet.code,
      projectId: row.sheet.projectId ?? '',
      projectName: row.projectName ?? '',
      employeeName: row.sheet.employeeName ?? '',
      employeeId: row.sheet.employeeId ?? null,
      roleName: row.sheet.roleName,
      workDate: row.sheet.workDate,
      hours: Number(row.sheet.hours ?? 0),
      status: (row.sheet.status ?? 'draft') as TimesheetStatus,
      costGenerated: row.sheet.costGenerated ?? false,
      remark: row.sheet.remark,
      createdAt: row.sheet.createdAt.toISOString(),
    };
  }

  private async assertTimesheetActor(
    sheet: typeof erpTimesheet.$inferSelect,
    action: TimesheetAction,
    actor: RequestActor
  ): Promise<void> {
    const ownerRows: unknown = await this.db.execute(sql`
      SELECT (t._created_by).user_id AS uid
      FROM erp_timesheet t
      WHERE t.id = ${sheet.id}
      LIMIT 1
    `);
    const ownerList = Array.isArray(ownerRows)
      ? (ownerRows as { uid: string | null }[])
      : ((ownerRows as { rows?: { uid: string | null }[] }).rows ?? []);
    const createdBy: string = ownerList[0]?.uid ?? '';
    let employeeUserId = '';
    if (sheet.employeeId) {
      const employees = await this.db
        .select({ platformUserId: mdEmployee.platformUserId })
        .from(mdEmployee)
        .where(eq(mdEmployee.id, sheet.employeeId))
        .limit(1);
      employeeUserId = employees[0]?.platformUserId ?? '';
    }
    const submitterIds: string[] = [createdBy, employeeUserId].filter(
      (id: string) => id.length > 0
    );
    const isSubmitter: boolean = submitterIds.includes(actor.userId);
    if (action === 'submit') {
      if (!isSubmitter) {
        throw new ForbiddenException('只能提交本人的工时');
      }
      return;
    }
    if (isSubmitter) {
      throw new ForbiddenException('不能确认或驳回自己提交的工时');
    }
    const isAdmin: boolean = await this.actorAccess.hasAnyRole(actor.userId, [
      'admin',
    ]);
    if (isAdmin) return;
    if (!sheet.projectId) {
      throw new ForbiddenException('仅管理员或项目经理可确认工时');
    }
    const projects = await this.db
      .select({ pm: erpProject.pm, pmUserId: erpProject.pmUserId })
      .from(erpProject)
      .where(eq(erpProject.id, sheet.projectId))
      .limit(1);
    const pmUserId: string = projects[0]?.pmUserId ?? '';
    // F7：优先按 pmUserId 授权，杜绝同名互获确认权
    if (pmUserId.length > 0) {
      if (pmUserId !== actor.userId) {
        throw new ForbiddenException('仅管理员或项目经理可确认工时');
      }
      return;
    }
    const pm: string = projects[0]?.pm ?? '';
    const me = await this.db
      .select({ name: mdEmployee.name })
      .from(mdEmployee)
      .where(or(eq(mdEmployee.feishuUnionId, actor.userId), eq(mdEmployee.platformUserId, actor.userId)))
      .limit(1);
    const myName: string = me[0]?.name ?? actor.userName;
    if (pm.length === 0 || (pm !== myName && pm !== actor.userName)) {
      throw new ForbiddenException('仅管理员或项目经理可确认工时');
    }
  }

  async listLaborRates(): Promise<LaborRate[]> {
    const rows = await this.db
      .select()
      .from(erpLaborRate)
      .orderBy(erpLaborRate.roleName, desc(erpLaborRate.effectiveFrom));
    return rows.map((row) => ({
      id: row.id,
      roleName: row.roleName,
      rate: Number(row.rate ?? 0),
      effectiveFrom: row.effectiveFrom,
    }));
  }

  async createLaborRate(dto: CreateLaborRateDto): Promise<LaborRate> {
    const rows = await this.db
      .insert(erpLaborRate)
      .values({
        roleName: dto.roleName,
        rate: String(dto.rate),
        effectiveFrom:
          dto.effectiveFrom ?? todayInShanghai(),
      })
      .returning();
    const row = rows[0];
    return {
      id: row.id,
      roleName: row.roleName,
      rate: Number(row.rate ?? 0),
      effectiveFrom: row.effectiveFrom,
    };
  }

  /** 公共成本分摊：生成分摊记录并落到目标项目成本 */
  async createAllocation(dto: CreateAllocationDto): Promise<CostAllocation> {
    if (dto.amount <= 0) {
      throw new BadRequestException('分摊金额必须大于 0');
    }
    const project = await this.db
      .select({
        id: erpProject.id,
        name: erpProject.name,
        contractId: erpProject.contractId,
        deptName: erpProject.deptName,
      })
      .from(erpProject)
      .where(eq(erpProject.id, dto.targetProjectId));
    if (project.length === 0) throw new NotFoundException('目标项目不存在');
    if (!COST_TYPES.includes(dto.costType)) {
      throw new BadRequestException('非法的成本类型');
    }
    // B4：分摊落库写入 `period = dto.period`，因此按该期间校验期间闸门。
    // 与成本登记同因：闸门缺失会让分摊落进已关账期间、凭证永久失败进死信。
    await assertPeriodOpen(this.db, dto.period, '成本分摊');
    let departmentId: string | null = null;
    if (project[0].deptName) {
      const dept = await this.db
        .select({ id: hrDepartment.id })
        .from(hrDepartment)
        .where(eq(hrDepartment.name, project[0].deptName))
        .limit(1);
      departmentId = dept[0]?.id ?? null;
    }
    const row = await this.db.transaction(async (tx) => {
      const code = await generateBizCode(
        tx as unknown as PostgresJsDatabase,
        erpCostAllocation,
        erpCostAllocation.code,
        'ALC'
      );
      const rows = await tx
        .insert(erpCostAllocation)
        .values({
          code,
          sourceDesc: dto.sourceDesc,
          costType: dto.costType,
          amount: String(dto.amount),
          targetProjectId: dto.targetProjectId,
          period: dto.period,
          sourceRef: dto.sourceRef,
          remark: dto.remark,
        })
        .returning();
      const costCode = await generateBizCode(
        tx as unknown as PostgresJsDatabase,
        erpProjectCost,
        erpProjectCost.code,
        'CST'
      );
      await tx.insert(erpProjectCost).values({
        code: costCode,
        projectId: dto.targetProjectId,
        costType: dto.costType,
        amount: String(dto.amount),
        period: dto.period,
        occurredDate: todayInShanghai(),
        sourceRef: `allocation:${code}`,
        departmentId,
        contractId: project[0].contractId ?? null,
        isAccrual: 0,
        remark: `公共成本分摊：${dto.sourceDesc}`,
      });
      return { allocation: rows[0], costCode };
    });
    if (dto.amount !== 0) {
      await this.voucherHookService.generateVoucherDraft({
        sourceType: 'cost',
        sourceRef: `cost:${row.costCode}`,
        voucherDate: todayInShanghai(),
        summary: `公共成本分摊 ${row.allocation.code}`,
        lines: costConfirmLines(dto.amount),
      });
    }
    return {
      id: row.allocation.id,
      code: row.allocation.code,
      sourceDesc: row.allocation.sourceDesc ?? '',
      costType: (row.allocation.costType ?? 'compute') as CostType,
      amount: Number(row.allocation.amount ?? 0),
      targetProjectId: row.allocation.targetProjectId ?? '',
      targetProjectName: project[0].name,
      period: row.allocation.period ?? '',
      sourceRef: row.allocation.sourceRef ?? '',
      remark: row.allocation.remark,
    };
  }

  /**
   * D-07：把一笔公共成本按**权重**分摊到多个项目（作业成本法 ABC 的核心动作）。
   *
   * ## 为什么需要它
   *
   * 原 `createAllocation` 一次只能指定一个 `targetProjectId` + 一个 `amount`。
   * 把一笔公共成本拆到 N 个项目就要**手工算 N 次金额、发 N 次请求**。
   * 而分摊额之和必须严格等于被分摊总额（差 1 分凭证就不平）——
   * **这种人工算术正是最容易出错的地方**，且出错后很难发现
   * （每个项目的成本都"看起来合理"，只有合计对不上）。
   *
   * 本方法复用 D-03 已实现的**最大余数法**分摊引擎
   * （`allocateAmount`，见 `finance-reports/aux-combination-rules.ts`），
   * 逐项补齐分位以保证 `Σ share === amount`。
   *
   * ## 事务与凭证
   *
   * - 分摊计算是**纯函数、不碰数据库**，放在事务外先算完；
   * - 全部插入放在**一个事务**内：要么整批成功、要么都不落库 ——
   *   部分成功会让"被分摊总额"与"已分摊合计"永久对不上，比整批失败难处理得多；
   * - 凭证按项目**逐张生成**（与单目标模式一致：每个项目各自归集成本；
   *   合并成一张凭证会让项目维度无法下钻）。
   */
  async createAllocationBatch(
    dto: CreateCostAllocationBatchDto
  ): Promise<CostAllocationBatchResult> {
    if (!Array.isArray(dto.targets) || dto.targets.length === 0) {
      throw new BadRequestException('分摊目标至少 1 项');
    }
    if (dto.amount <= 0) {
      throw new BadRequestException('分摊金额必须大于 0');
    }
    if (!COST_TYPES.includes(dto.costType)) {
      throw new BadRequestException('非法的成本类型');
    }
    const projectIds = dto.targets.map((t) => t.projectId);
    if (new Set(projectIds).size !== projectIds.length) {
      // 同一项目出现两次会生成两笔独立分摊记录，使用者几乎肯定不是这个意思
      throw new BadRequestException(
        '分摊目标中存在重复项目；请将同一项目的权重合并后只传一次'
      );
    }
    for (const target of dto.targets) {
      if (!Number.isFinite(target.weight) || target.weight <= 0) {
        throw new BadRequestException(
          `项目 ${target.projectId} 的分摊权重必须大于 0`
        );
      }
    }
    // B4：批量分摊与单目标分摊同因，期间闸门按 `dto.period` 校验。
    await assertPeriodOpen(this.db, dto.period, '成本分摊');

    // ① 分摊计算（纯函数，事务外）
    const allocation = allocateAmount({
      amount: dto.amount,
      weights: dto.targets.map((t) => t.weight),
      // 权重都 > 0，不会走兜底；用 reject 以免掩盖调用方传参错误
      fallback: 'reject',
    });
    const sharesSum = round2(
      allocation.shares.reduce((sum, value) => sum + value, 0)
    );
    if (sharesSum !== allocation.amount) {
      // 自检：最大余数法保证这一点，违反说明有回归
      this.logger.error(
        `分摊自检失败：shares 合计 ${sharesSum} ≠ amount ${allocation.amount}`
      );
      throw new BadRequestException(
        `分摊结果自检失败（合计 ${sharesSum} ≠ 总额 ${allocation.amount}）`
      );
    }

    // ② 预取项目信息（事务外读，缩短事务持有时间）
    const projects = await this.db
      .select({
        id: erpProject.id,
        name: erpProject.name,
        contractId: erpProject.contractId,
        deptName: erpProject.deptName,
      })
      .from(erpProject)
      .where(inArray(erpProject.id, projectIds));
    if (projects.length !== projectIds.length) {
      const found = new Set(projects.map((p) => p.id));
      const missing = projectIds.filter((id) => !found.has(id));
      throw new NotFoundException(`目标项目不存在：${missing.join('、')}`);
    }
    const projectById = new Map(projects.map((p) => [p.id, p]));

    const deptNames = [
      ...new Set(projects.map((p) => p.deptName).filter(Boolean) as string[]),
    ];
    const deptRows =
      deptNames.length > 0
        ? await this.db
            .select({ id: hrDepartment.id, name: hrDepartment.name })
            .from(hrDepartment)
            .where(inArray(hrDepartment.name, deptNames))
        : [];
    const deptIdByName = new Map(deptRows.map((d) => [d.name, d.id]));

    // ③ 整批落库（单事务）
    const created = await this.db.transaction(async (tx) => {
      const out: Array<{
        allocation: typeof erpCostAllocation.$inferSelect;
        costCode: string;
        share: number;
        projectId: string;
      }> = [];
      for (let i = 0; i < dto.targets.length; i += 1) {
        const target = dto.targets[i];
        const share = allocation.shares[i];
        const project = projectById.get(target.projectId);
        const code = await generateBizCode(
          tx as unknown as PostgresJsDatabase,
          erpCostAllocation,
          erpCostAllocation.code,
          'ALC'
        );
        const rows = await tx
          .insert(erpCostAllocation)
          .values({
            code,
            sourceDesc: dto.sourceDesc,
            costType: dto.costType,
            amount: String(share),
            targetProjectId: target.projectId,
            period: dto.period,
            sourceRef: dto.sourceRef,
            remark: dto.remark,
          })
          .returning();
        const costCode = await generateBizCode(
          tx as unknown as PostgresJsDatabase,
          erpProjectCost,
          erpProjectCost.code,
          'CST'
        );
        await tx.insert(erpProjectCost).values({
          code: costCode,
          projectId: target.projectId,
          costType: dto.costType,
          amount: String(share),
          period: dto.period,
          occurredDate: todayInShanghai(),
          sourceRef: `allocation:${code}`,
          departmentId: project?.deptName
            ? (deptIdByName.get(project.deptName) ?? null)
            : null,
          contractId: project?.contractId ?? null,
          isAccrual: 0,
          remark: `公共成本分摊：${dto.sourceDesc}`,
        });
        out.push({
          allocation: rows[0],
          costCode,
          share,
          projectId: target.projectId,
        });
      }
      return out;
    });

    // ④ 凭证逐项生成（事务外；与仓库既有约定一致）
    for (const row of created) {
      if (row.share !== 0) {
        await this.voucherHookService.generateVoucherDraft({
          sourceType: 'cost',
          sourceRef: `cost:${row.costCode}`,
          voucherDate: todayInShanghai(),
          summary: `公共成本分摊 ${row.allocation.code}`,
          lines: costConfirmLines(row.share),
        });
      }
    }

    return {
      allocations: created.map((row) => ({
        id: row.allocation.id,
        code: row.allocation.code,
        sourceDesc: row.allocation.sourceDesc ?? '',
        costType: (row.allocation.costType ?? 'compute') as CostType,
        amount: Number(row.allocation.amount ?? 0),
        targetProjectId: row.allocation.targetProjectId ?? '',
        targetProjectName: projectById.get(row.projectId)?.name ?? '',
        period: row.allocation.period ?? '',
        sourceRef: row.allocation.sourceRef ?? '',
        remark: row.allocation.remark,
      })),
      totalAmount: allocation.amount,
      allocatedAmount: sharesSum,
      adjustedCount: allocation.adjustedCount,
      equalFallback: allocation.equalFallback,
    };
  }

  /** 成本红冲：写入一笔负数成本，并生成相反分录。 */
  async redFlush(id: string): Promise<CostItem> {
    const existing = await this.db
      .select()
      .from(erpProjectCost)
      .where(eq(erpProjectCost.id, id));
    if (existing.length === 0) throw new NotFoundException('成本记录不存在');
    const source = existing[0];
    if (isRedflushSourceRef(source.sourceRef)) {
      throw new BadRequestException('红冲记录不能再次红冲');
    }
    // 修复 P1-14：红冲此前不幂等 —— 前端连点两次（或重试）就会生成两笔负数成本
    // 与两张凭证，项目成本被重复冲减、总账直接对不上。
    // sourceRef 形如 `redflush:<原成本单号>`，先查一次即可挡住重复提交。
    const redflushRef = buildRedflushSourceRef(source.code);
    const duplicated = await this.db
      .select({ id: erpProjectCost.id })
      .from(erpProjectCost)
      .where(eq(erpProjectCost.sourceRef, redflushRef))
      .limit(1);
    if (duplicated.length > 0) {
      throw new BadRequestException(`成本 ${source.code} 已红冲，请勿重复操作`);
    }
    const code = await generateBizCode(
      this.db,
      erpProjectCost,
      erpProjectCost.code,
      'CST'
    );
    const amount = -Number(source.amount ?? 0);
    // D-18：红冲行与原行 offset_of、凭证同事务意图——先落库再出凭证；期间跟随原成本
    const voucherDate =
      source.occurredDate ??
      (source.period ? `${source.period}-01` : todayInShanghai());
    // B4：**成本红冲也必须有期间闸门**。
    //
    // 红冲跟随原成本的期间（`source.period`），而不是"今天" —— 这一点本身是对的
    // （红冲要冲在同一个期间才能抵掉原分录），但正因为如此，一旦原成本落在
    // 已关账期间，红冲就会写进那个期间且凭证必然失败：错误无法被纠正，
    // 只能先把期间反结账。这里在写入前明确拒绝并给出可执行的指引。
    await assertPeriodOpen(this.db, voucherDate, '成本红冲');
    let insertedId = '';
    try {
      await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(erpProjectCost)
          .values({
            code,
            projectId: source.projectId,
            costType: source.costType,
            amount: String(amount),
            period: source.period,
            occurredDate: voucherDate.slice(0, 10),
            sourceRef: redflushRef,
            offsetOf: source.id,
            supplierId: source.supplierId,
            departmentId: source.departmentId,
            contractId: source.contractId,
            remark: `红冲 ${source.code}`,
          })
          .returning({ id: erpProjectCost.id });
        insertedId = inserted[0].id;
        await tx
          .update(erpProjectCost)
          .set({ offsetOf: insertedId, updatedAt: new Date() })
          .where(eq(erpProjectCost.id, source.id));
      });
    } catch (error) {
      if (extractPostgresErrorCode(error) === '23505') {
        throw new BadRequestException(
          `成本 ${source.code} 已红冲，请勿重复操作`
        );
      }
      throw error;
    }
    if (amount !== 0) {
      const lines = [
        { accountCode: '2202', debit: Math.abs(amount) },
        { accountCode: '6401', credit: Math.abs(amount) },
      ];
      const result = await this.voucherHookService.generateVoucherDraft({
        sourceType: 'cost',
        sourceRef: `cost-void:${code}`,
        voucherDate: voucherDate.slice(0, 10),
        summary: `成本红冲 ${code}`,
        lines,
      });
      if (result === 'failed') {
        await this.voucherHookService.recordCompensation(
          'cost',
          `cost-void:${code}`,
          '成本红冲凭证生成失败',
          lines,
          voucherDate.slice(0, 10),
        );
      }
    }
    const items = await this.listCosts();
    const found = items.find((item) => item.id === insertedId);
    if (!found) throw new NotFoundException('红冲记录写入后未能读回');
    return found;
  }

}
