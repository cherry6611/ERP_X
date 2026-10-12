import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, desc, eq, lte, sql, type SQL } from 'drizzle-orm';
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
import { todayInShanghai } from '@server/common/utils/biz-date';
import { ActorAccessService } from '@server/common/auth/actor-access.service';
import type { RequestActor } from '@server/common/auth/actor';
import type {
  CostAllocation,
  CostDimension,
  CostDimensionSummary,
  CostItem,
  CostType,
  CostTypeSummary,
  CreateAllocationDto,
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
  return new Date().toISOString().slice(0, 7);
}

@Injectable()
export class CostsService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly actorAccess: ActorAccessService
  ) {}

  async listCosts(
    projectId?: string,
    costType?: string
  ): Promise<CostItem[]> {
    const conditions: SQL[] = [];
    if (projectId) conditions.push(eq(erpProjectCost.projectId, projectId));
    if (costType) conditions.push(eq(erpProjectCost.costType, costType));
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

  /** 多维成本汇总：costType / department / contract / period */
  async dimensionSummary(
    dimension: CostDimension,
    projectId?: string
  ): Promise<CostDimensionSummary[]> {
    const where = projectId
      ? eq(erpProjectCost.projectId, projectId)
      : undefined;
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

  async costSummary(projectId?: string): Promise<CostTypeSummary[]> {
    const rows = await this.db
      .select({
        costType: erpProjectCost.costType,
        total: sql<number>`coalesce(sum(${erpProjectCost.amount}), 0)::float8`,
      })
      .from(erpProjectCost)
      .where(projectId ? eq(erpProjectCost.projectId, projectId) : undefined)
      .groupBy(erpProjectCost.costType);
    return rows
      .filter((row) => COST_TYPES.includes((row.costType ?? '') as CostType))
      .map((row) => ({
        costType: (row.costType ?? 'labor') as CostType,
        amount: Number(row.total ?? 0),
      }));
  }

  async createCost(dto: CreateCostDto): Promise<CostItem> {
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
    const occurredDate = dto.occurredDate ?? new Date().toISOString().slice(0, 10);
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
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];
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

  async listTimesheets(projectId?: string): Promise<Timesheet[]> {
    const rows = await this.db
      .select({ sheet: erpTimesheet, projectName: erpProject.name })
      .from(erpTimesheet)
      .leftJoin(erpProject, eq(erpTimesheet.projectId, erpProject.id))
      .where(projectId ? eq(erpTimesheet.projectId, projectId) : undefined)
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
    if (dto.hours <= 0) throw new BadRequestException('工时必须大于 0');
    const employees = await this.db
      .select({
        id: mdEmployee.id,
        name: mdEmployee.name,
        status: mdEmployee.status,
        roleName: hrPosition.roleName,
      })
      .from(mdEmployee)
      .leftJoin(hrPosition, eq(hrPosition.id, mdEmployee.positionId))
      .where(eq(mdEmployee.platformUserId, userId));
    if (employees.length === 0) {
      throw new BadRequestException('当前账号未绑定员工，无法登记工时');
    }
    const employee = employees[0];
    if (employee.status === 'resigned') {
      throw new BadRequestException('离职员工不能登记工时');
    }
    const employeeName: string = employee.name;
    const roleName: string | null = employee.roleName || dto.roleName || null;
    const employeeId: string = employee.id;
    if (!roleName) {
      throw new BadRequestException('缺少角色，无法计算费率');
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
      const costCode = await generateBizCode(
        this.db,
        erpProjectCost,
        erpProjectCost.code,
        'CST'
      );
      const workDate = sheet.workDate ?? new Date().toISOString().slice(0, 10);
      await this.db.transaction(async (tx) => {
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
          remark: `工时折算：${sheet.employeeName} ${sheet.hours}h × 费率 ${rate}`,
        });
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
      .select({ pm: erpProject.pm })
      .from(erpProject)
      .where(eq(erpProject.id, sheet.projectId))
      .limit(1);
    const pm: string = projects[0]?.pm ?? '';
    const me = await this.db
      .select({ name: mdEmployee.name })
      .from(mdEmployee)
      .where(eq(mdEmployee.platformUserId, actor.userId))
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
          dto.effectiveFrom ?? new Date().toISOString().slice(0, 10),
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
        remark: `公共成本分摊：${dto.sourceDesc}`,
      });
      return rows[0];
    });
    return {
      id: row.id,
      code: row.code,
      sourceDesc: row.sourceDesc ?? '',
      costType: (row.costType ?? 'compute') as CostType,
      amount: Number(row.amount ?? 0),
      targetProjectId: row.targetProjectId ?? '',
      targetProjectName: project[0].name,
      period: row.period ?? '',
      sourceRef: row.sourceRef ?? '',
      remark: row.remark,
    };
  }
}
