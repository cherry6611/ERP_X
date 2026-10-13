import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  like,
  ne,
  not,
  or,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm';
import {
  crmQuotation,
  erpApBill,
  erpAr,
  erpContract,
  erpDeliverable,
  erpCostAllocation,
  erpInvoice,
  erpProject,
  erpProjectChange,
  erpProjectCost,
  erpProjectMilestone,
  erpProjectRevenue,
  erpRevenueAdjust,
  erpTimesheet,
  mdCustomer,
  mdSupplier,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { outputIssueLines } from '@server/common/tax/posting';
import { splitTax } from '@shared/tax';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { toProject } from './projects.transform';
import { ProjectAclService } from './project-acl.service';
import type { RequestActor } from '@server/common/auth/actor';
import type {
  CreateProjectChangeDto,
  CreateProjectDto,
  CreateProjectMilestoneDto,
  CreateProjectRevenueDto,
  ChainMilestoneItem,
  ChainQuotationItem,
  DeliverableItem,
  Project,
  ProjectAccounting,
  ProjectChange,
  ProjectDetail,
  ProjectMilestone,
  ProjectChainOverview,
  ProjectRevenueItem,
  ProjectStatus,
  QuotationStatus,
  UpdateProjectDto,
  UpdateProjectMilestoneDto,
} from '@shared/api.interface';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly projectAcl: ProjectAclService,
    private readonly voucherHook: VoucherHookService,
    private readonly taxResolver: TaxResolverService
  ) {}


  private toMilestone(row: typeof erpProjectMilestone.$inferSelect): ProjectMilestone {
    return {
      id: row.id,
      projectId: row.projectId ?? '',
      name: row.name,
      planDate: row.planDate,
      actualDate: row.actualDate,
      status: (row.status ?? 'pending') as ProjectMilestone['status'],
      baselineDate: row.baselineDate,
      forecastDate: row.forecastDate,
      weightPct: Number(row.weightPct ?? 0),
      remark: row.remark,
    };
  }

  private toDeliverable(row: typeof erpDeliverable.$inferSelect): DeliverableItem {
    return {
      id: row.id,
      code: row.code,
      projectId: row.projectId,
      name: row.name,
      deliverableType: row.deliverableType,
      acceptanceCriteria: row.acceptanceCriteria,
      dueDate: row.dueDate,
      status: (row.status ?? 'pending') as DeliverableItem['status'],
      reviewer: row.reviewer,
      submittedAt: row.submittedAt,
      acceptedAt: row.acceptedAt,
      acceptConclusion: row.acceptConclusion,
      returnedReason: row.returnedReason,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async getAccounting(projectId: string): Promise<ProjectAccounting> {
    const projects = await this.db
      .select({ budget: erpProject.budget })
      .from(erpProject)
      .where(eq(erpProject.id, projectId));
    if (projects.length === 0) throw new NotFoundException('项目不存在');
    // T2：核算毛利按不含税净收入（关联合同税率拆税）
    const revenueRows = await this.db
      .select({
        total: sql<string>`coalesce(sum(
          coalesce(${erpProjectRevenue.amount}, 0) * 100.0
          / (100.0 + coalesce(${erpContract.taxRate}, 6))
        ), 0)`,
      })
      .from(erpProjectRevenue)
      .leftJoin(erpContract, eq(erpProjectRevenue.contractId, erpContract.id))
      .where(
        and(
          eq(erpProjectRevenue.projectId, projectId),
          eq(erpProjectRevenue.status, 'recognized')
        )
      );
    const adjustRows = await this.db
      .select({
        total: sql<string>`coalesce(sum(
          coalesce(${erpRevenueAdjust.amount}, 0) * 100.0
          / (100.0 + coalesce(${erpContract.taxRate}, 6))
        ), 0)`,
      })
      .from(erpRevenueAdjust)
      .innerJoin(
        erpProjectRevenue,
        eq(erpRevenueAdjust.revenueId, erpProjectRevenue.id)
      )
      .leftJoin(erpContract, eq(erpProjectRevenue.contractId, erpContract.id))
      .where(
        and(
          eq(erpProjectRevenue.projectId, projectId),
          eq(erpRevenueAdjust.status, 'applied')
        )
      );
    const costRows = await this.db
      .select({ total: sum(erpProjectCost.amount) })
      .from(erpProjectCost)
      .where(eq(erpProjectCost.projectId, projectId));
    const recognizedRevenue =
      Number(revenueRows[0]?.total ?? 0) - Number(adjustRows[0]?.total ?? 0);
    const totalCost = Number(costRows[0]?.total ?? 0);
    const grossMargin = recognizedRevenue - totalCost;
    const marginRate =
      recognizedRevenue > 0
        ? Math.round((grossMargin / recognizedRevenue) * 10000) / 100
        : 0;
    return {
      budget: Number(projects[0].budget ?? 0),
      recognizedRevenue,
      totalCost,
      grossMargin,
      marginRate,
    };
  }

  async listProjects(
    status?: string,
    keyword?: string,
    actor?: RequestActor
  ): Promise<Project[]> {
    const conditions: SQL[] = [not(like(erpProject.name, '[API_TEST]%'))];
    if (status) conditions.push(eq(erpProject.status, status));
    if (actor) {
      const visibility: SQL | undefined = await this.projectAcl.visibilitySql(actor);
      if (visibility) conditions.push(visibility);
    }
    const rows = await this.db
      .select({ project: erpProject, contractName: erpContract.name })
      .from(erpProject)
      .leftJoin(erpContract, eq(erpProject.contractId, erpContract.id))
      .where(and(...conditions))
      .orderBy(desc(erpProject.createdAt));
    return rows
      .filter(
        (row) =>
          !keyword ||
          row.project.name.includes(keyword) ||
          row.project.code.includes(keyword)
      )
      .map((row) => toProject(row.project, row.contractName ?? ''));
  }

  async getProject(id: string): Promise<ProjectDetail> {
    const rows = await this.db
      .select({ project: erpProject, contractName: erpContract.name })
      .from(erpProject)
      .leftJoin(erpContract, eq(erpProject.contractId, erpContract.id))
      .where(eq(erpProject.id, id));
    if (rows.length === 0) throw new NotFoundException('项目不存在');
    const base = toProject(rows[0].project, rows[0].contractName ?? '');
    const milestoneRows = await this.db
      .select()
      .from(erpProjectMilestone)
      .where(eq(erpProjectMilestone.projectId, id))
      .orderBy(erpProjectMilestone.planDate);
    const changeRows = await this.db
      .select()
      .from(erpProjectChange)
      .where(eq(erpProjectChange.projectId, id))
      .orderBy(desc(erpProjectChange.createdAt));
    const deliverableRows = await this.db
      .select()
      .from(erpDeliverable)
      .where(eq(erpDeliverable.projectId, id));
    const milestones: ProjectMilestone[] = milestoneRows.map((row) =>
      this.toMilestone(row)
    );
    const deliverables: DeliverableItem[] = deliverableRows.map((row) =>
      this.toDeliverable(row)
    );
    const changes: ProjectChange[] = changeRows.map((row) => ({
      id: row.id,
      code: row.code,
      projectId: row.projectId ?? '',
      changeType: (row.changeType ?? 'scope') as ProjectChange['changeType'],
      content: row.content ?? '',
      beforeValue: row.beforeValue,
      afterValue: row.afterValue,
      status: (row.status ?? 'pending') as ProjectChange['status'],
      applicant: row.applicant,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    }));
    return {
      ...base,
      milestones,
      changes,
      deliverables,
      accounting: await this.getAccounting(id),
    };
  }

  /** 项目全链路概览：客户/合同/收入/成本/发票/应收/应付/工时 */
  async getChainOverview(projectId: string): Promise<ProjectChainOverview> {
    const projectRows = await this.db
      .select({
        id: erpProject.id,
        contractId: erpProject.contractId,
      })
      .from(erpProject)
      .where(eq(erpProject.id, projectId));
    if (projectRows.length === 0) throw new NotFoundException('项目不存在');

    let contract: ProjectChainOverview['contract'] = null;
    let customer: ProjectChainOverview['customer'] = null;
    const contractId = projectRows[0].contractId;
    if (contractId) {
      const contractRows = await this.db
        .select()
        .from(erpContract)
        .where(eq(erpContract.id, contractId));
      const c = contractRows[0];
      if (c) {
        contract = {
          id: c.id,
          code: c.code,
          name: c.name,
          billingModel: c.billingModel,
          amount: Number(c.amount ?? 0),
          taxRate: Number(c.taxRate ?? 0),
          // 前端开票表单要按「合同所属纳税主体」过滤税率下拉，必须与后端
          // invoice.service.ts 用的 taxEntityId 同源，否则下拉与校验口径不一致 → 400
          taxEntityId: c.taxEntityId ?? null,
          status: c.status,
          signDate: c.signDate,
          startDate: c.startDate,
          endDate: c.endDate,
          owner: c.owner,
          paymentTerms: c.paymentTerms,
        };
        if (c.customerId) {
          const customerRows = await this.db
            .select()
            .from(mdCustomer)
            .where(eq(mdCustomer.id, c.customerId));
          const cu = customerRows[0];
          if (cu) {
            customer = {
              id: cu.id,
              code: cu.code,
              name: cu.name,
              industry: cu.industry,
              creditLevel: cu.creditLevel,
              creditLimit: Number(cu.creditLimit ?? 0),
              termsDays: cu.termsDays ?? 30,
            };
          }
        }
      }
    }

    const linkedQuotationRows = contractId
      ? await this.db
          .select({ opportunityId: crmQuotation.opportunityId })
          .from(crmQuotation)
          .where(eq(crmQuotation.contractId, contractId))
      : [];
    const projectOpportunityIds = [
      ...new Set(
        linkedQuotationRows
          .map((row) => row.opportunityId)
          .filter((oppId): oppId is string => oppId !== null)
      ),
    ];
    const quotationConditions: SQL[] = [];
    if (projectOpportunityIds.length > 0) {
      quotationConditions.push(
        inArray(crmQuotation.opportunityId, projectOpportunityIds)
      );
    }
    if (contractId) {
      quotationConditions.push(eq(crmQuotation.contractId, contractId));
    }
    const quotationRows =
      quotationConditions.length > 0
        ? await this.db
            .select()
            .from(crmQuotation)
            .where(or(...quotationConditions))
            .orderBy(
              sql`${crmQuotation.quoteDate} desc nulls last`,
              desc(crmQuotation.createdAt)
            )
        : [];
    const quotations: ChainQuotationItem[] = quotationRows.map((row) => {
      const totalAmount = Number(row.totalAmount ?? 0);
      const estimatedCost = Number(row.estimatedCost ?? 0);
      return {
        id: row.id,
        code: row.code,
        title: row.title,
        quoteDate: row.quoteDate,
        status: (row.status ?? 'draft') as QuotationStatus,
        totalAmount,
        estimatedCost,
        marginPct:
          totalAmount > 0
            ? Math.round(((totalAmount - estimatedCost) / totalAmount) * 10000) /
              100
            : 0,
      };
    });

    const milestoneRows = await this.db
      .select()
      .from(erpProjectMilestone)
      .where(eq(erpProjectMilestone.projectId, projectId))
      .orderBy(asc(erpProjectMilestone.planDate));
    const milestones: ChainMilestoneItem[] = milestoneRows.map((row) => ({
      id: row.id,
      name: row.name,
      status: (row.status ?? 'pending') as ChainMilestoneItem['status'],
      planDate: row.planDate,
      baselineDate: row.baselineDate,
      forecastDate: row.forecastDate,
      weightPct: Number(row.weightPct ?? 0),
    }));

    const revenueRows = await this.db
      .select({
        period: erpProjectRevenue.period,
        total: sum(erpProjectRevenue.amount),
      })
      .from(erpProjectRevenue)
      .where(
        and(
          eq(erpProjectRevenue.projectId, projectId),
          eq(erpProjectRevenue.status, 'recognized')
        )
      )
      .groupBy(erpProjectRevenue.period);
    const revenueByPeriod = revenueRows
      .filter((row) => (row.period ?? '') !== '')
      .map((row) => ({
        period: row.period as string,
        amount: Number(row.total ?? 0),
      }))
      .sort((a, b) => a.period.localeCompare(b.period));

    const costRows = await this.db
      .select({
        costType: erpProjectCost.costType,
        total: sum(erpProjectCost.amount),
      })
      .from(erpProjectCost)
      .where(eq(erpProjectCost.projectId, projectId))
      .groupBy(erpProjectCost.costType);
    const costByType = costRows.map((row) => ({
      costType: row.costType ?? 'labor',
      amount: Number(row.total ?? 0),
    }));

    const periodExpenseRows = await this.db
      .select({ total: sum(erpCostAllocation.amount) })
      .from(erpCostAllocation)
      .where(
        and(
          eq(erpCostAllocation.targetProjectId, projectId),
          or(
            like(erpCostAllocation.sourceRef, 'payroll:%'),
            like(erpCostAllocation.sourceRef, 'asset:%')
          )
        )
      );
    const periodExpense = Number(periodExpenseRows[0]?.total ?? 0);

    const invoiceRows = await this.db
      .select()
      .from(erpInvoice)
      .where(eq(erpInvoice.projectId, projectId))
      .orderBy(desc(erpInvoice.invoiceDate));
    const invoices = invoiceRows.map((row) => ({
      id: row.id,
      code: row.code,
      invoiceNo: row.invoiceNo,
      invoiceType: row.invoiceType,
      amount: Number(row.amount ?? 0),
      taxRate: Number(row.taxRate ?? 0),
      taxAmount: Number(row.taxAmount ?? 0),
      invoiceDate: row.invoiceDate,
      status: row.status,
    }));
    const invoiceTotalAmount = invoices.reduce(
      (acc: number, item) => acc + item.amount,
      0
    );

    const arRows = await this.db
      .select()
      .from(erpAr)
      .where(eq(erpAr.projectId, projectId))
      .orderBy(desc(erpAr.dueDate));
    const arItems = arRows.map((row) => ({
      id: row.id,
      code: row.code,
      amount: Number(row.amount ?? 0),
      settledAmount: Number(row.settledAmount ?? 0),
      dueDate: row.dueDate,
      status: row.status,
      ownerUserId: row.ownerUserId,
    }));
    const arTotalAmount = arItems.reduce(
      (acc: number, item) => acc + item.amount,
      0
    );
    const arOpenAmount = arItems.reduce(
      (acc: number, item) => acc + (item.amount - item.settledAmount),
      0
    );

    const apRows = await this.db
      .select({ ap: erpApBill, supplierName: mdSupplier.name })
      .from(erpApBill)
      .leftJoin(mdSupplier, eq(erpApBill.supplierId, mdSupplier.id))
      .where(eq(erpApBill.projectId, projectId))
      .orderBy(desc(erpApBill.dueDate));
    const apItems = apRows.map((row) => ({
      id: row.ap.id,
      code: row.ap.code,
      supplierName: row.supplierName,
      amount: Number(row.ap.amount ?? 0),
      paidAmount: Number(row.ap.paidAmount ?? 0),
      dueDate: row.ap.dueDate,
      status: row.ap.status,
    }));
    const apTotalAmount = apItems.reduce(
      (acc: number, item) => acc + item.amount,
      0
    );
    const apOpenAmount = apItems.reduce(
      (acc: number, item) => acc + (item.amount - item.paidAmount),
      0
    );

    const timesheetRows = await this.db
      .select({
        employeeName: erpTimesheet.employeeName,
        confirmedHours: sql<number>`coalesce(sum(${erpTimesheet.hours}) filter (where ${erpTimesheet.status} = 'confirmed'), 0)::float8`,
        totalHours: sql<number>`coalesce(sum(${erpTimesheet.hours}), 0)::float8`,
      })
      .from(erpTimesheet)
      .where(eq(erpTimesheet.projectId, projectId))
      .groupBy(erpTimesheet.employeeName);
    const timesheetByEmployee = timesheetRows
      .map((row) => ({
        employeeName: row.employeeName ?? '未填写',
        confirmedHours: Number(row.confirmedHours ?? 0),
        totalHours: Number(row.totalHours ?? 0),
      }))
      .sort((a, b) => b.totalHours - a.totalHours);
    const totalHours = timesheetByEmployee.reduce(
      (acc: number, item) => acc + item.totalHours,
      0
    );

    return {
      customer,
      contract,
      quotations,
      milestones,
      revenueByPeriod,
      costByType,
      periodExpense,
      invoices,
      invoiceTotalAmount,
      arItems,
      arTotalAmount,
      arOpenAmount,
      apItems,
      apTotalAmount,
      apOpenAmount,
      timesheetByEmployee,
      totalHours,
    };
  }

  /** 项目收入确认：向 erp_project_revenue 写一条已确认记录 */
  async createProjectRevenue(
    projectId: string,
    dto: CreateProjectRevenueDto
  ): Promise<ProjectRevenueItem> {
    if (!/^\d{4}-\d{2}$/u.test(dto.period)) {
      throw new BadRequestException('期间格式须为 YYYY-MM');
    }
    if (!Number.isFinite(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException('确认金额必须大于 0');
    }
    const projects = await this.db
      .select({ id: erpProject.id, contractId: erpProject.contractId })
      .from(erpProject)
      .where(eq(erpProject.id, projectId));
    if (projects.length === 0) throw new NotFoundException('项目不存在');
    const code = await generateBizCode(
      this.db,
      erpProjectRevenue,
      erpProjectRevenue.code,
      'REV'
    );
    const rows = await this.db
      .insert(erpProjectRevenue)
      .values({
        code,
        projectId,
        contractId: projects[0].contractId,
        period: dto.period,
        amount: String(dto.amount),
        status: 'recognized',
        remark: dto.note,
      })
      .returning();
    const row = rows[0];

    // 修复 P0-3：本项目详情页的「确认收入」曾是一条绕过 RevenuesService 的旁路，
    // 不生成凭证、不生成应收，但 BI/未开票台账都会把它算成已确认收入 → 三口径不一致。
    // 方案 A 规定「收入确认是唯一收入入口」，此处补齐凭证与应收，且与
    // RevenuesService 使用同源 sourceRef 前缀，命中 uq_fin_voucher_source 幂等。
    await this.postRevenueVoucherAndAr(row, dto.period);
    return {
      id: row.id,
      code: row.code,
      projectId: row.projectId ?? '',
      contractId: row.contractId,
      period: row.period ?? '',
      amount: Number(row.amount ?? 0),
      status: row.status ?? 'recognized',
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * 修复 P0-3：项目详情页「确认收入」的业财打通。
   * 收入确认必须同时产生：①应收（含税）②凭证（借1122／贷6001／贷222101）。
   * 任一步失败只记录补偿，不回滚已确认的收入（与 RevenuesService 行为一致），
   * 避免出现「BI 有收入、总账无凭证、无应收可收」的三口径分裂。
   */
  private async postRevenueVoucherAndAr(
    row: typeof erpProjectRevenue.$inferSelect,
    period: string
  ): Promise<void> {
    const amount = Number(row.amount ?? 0);
    if (amount <= 0) return;

    let rate = 6;
    const contractRows = row.contractId
      ? await this.db
          .select({
            taxRate: erpContract.taxRate,
            customerId: erpContract.customerId,
            taxEntityId: erpContract.taxEntityId,
          })
          .from(erpContract)
          .where(eq(erpContract.id, row.contractId))
      : [];
    const contract = contractRows[0];
    try {
      // 修复 P1-11：税率改走 TaxResolverService，与开票口径一致（不再硬编码 6）
      const resolved = await this.taxResolver.resolve({
        upstream: contract?.taxRate != null ? Number(contract.taxRate) : null,
        customerId: contract?.customerId ?? undefined,
        taxEntityId: contract?.taxEntityId ?? undefined,
        side: 'output',
      });
      rate = resolved.rate;
    } catch (error) {
      this.logger.warn(
        `项目收入税率解析失败，按 6% 兜底：${row.code} ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const periodMatch = /^(\d{4})-(\d{2})$/u.exec(period);
    const voucherDate = periodMatch
      ? `${period}-01`
      : new Date().toISOString().slice(0, 10);

    if (row.contractId) {
      try {
        const arCode = await generateBizCode(
          this.db,
          erpAr,
          erpAr.code,
          'AR'
        );
        await this.db.insert(erpAr).values({
          code: arCode,
          contractId: row.contractId,
          projectId: row.projectId ?? undefined,
          customerId: contract?.customerId ?? undefined,
          amount: String(amount),
          settledAmount: '0',
          status: 'open',
          source: 'revenue',
          remark: `项目收入确认 ${row.code}`,
        });
      } catch (error) {
        this.logger.error(
          `项目收入确认生成应收失败：${row.code}`,
          error instanceof Error ? error.stack : String(error)
        );
        try {
          await this.voucherHook.recordCompensation(
            'revenue-ar',
            `revenue-ar:${row.code}`,
            '项目收入确认生成应收失败'
          );
        } catch {
          /* 补偿登记失败不阻断主流程 */
        }
      }
    }

    try {
      await this.voucherHook.generateVoucherDraft({
        sourceType: 'revenue',
        sourceRef: `revenue:${row.code}`,
        voucherDate,
        summary: `收入确认 ${row.code}`,
        lines: outputIssueLines(amount, rate),
      });
    } catch (error) {
      this.logger.error(
        `项目收入确认凭证生成失败：${row.code}`,
        error instanceof Error ? error.stack : String(error)
      );
      try {
        await this.voucherHook.recordCompensation(
          'revenue-voucher',
          `revenue:${row.code}`,
          '项目收入确认凭证生成失败'
        );
      } catch {
        /* 补偿登记失败不阻断主流程 */
      }
    }

    // 供日志排查：net/tax 由 splitTax 得出，确认拆分口径与开票一致
    const split = splitTax(amount, rate);
    this.logger.log(
      `收入确认 ${row.code} 含税 ${amount} 税率 ${rate}% → 不含税 ${split.net} / 税额 ${split.tax}`
    );
  }

  async createProject(dto: CreateProjectDto): Promise<ProjectDetail> {
    const contracts = await this.db
      .select({
        id: erpContract.id,
        status: erpContract.status,
        netAmount: erpContract.netAmount,
      })
      .from(erpContract)
      .where(eq(erpContract.id, dto.contractId));
    if (contracts.length === 0) throw new NotFoundException('合同不存在');
    const contractStatus = contracts[0].status ?? 'draft';
    if (!['active', 'performing', 'completed'].includes(contractStatus)) {
      throw new BadRequestException(
        `合同 ${contractStatus} 状态不允许立项，须先生效`
      );
    }
    const code = await generateBizCode(
      this.db,
      erpProject,
      erpProject.code,
      'PRJ'
    );
    const rows = await this.db
      .insert(erpProject)
      .values({
        code,
        name: dto.name,
        contractId: dto.contractId,
        pm: dto.pm,
        deptName: dto.deptName,
        budget: String(dto.budget ?? Number(contracts[0].netAmount ?? 0)),
        estimatedTotalCost: String(dto.estimatedTotalCost ?? 0),
        startDate: dto.startDate,
        endDate: dto.endDate,
        progress: 0,
        status: 'initiating',
        remark: dto.remark,
      })
      .returning();
    return this.getProject(rows[0].id);
  }

  async updateProject(id: string, dto: UpdateProjectDto): Promise<Project> {
    const existing = await this.db
      .select()
      .from(erpProject)
      .where(eq(erpProject.id, id));
    if (existing.length === 0) throw new NotFoundException('项目不存在');
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.progress !== undefined) {
      if (dto.progress < 0 || dto.progress > 100) {
        throw new BadRequestException('进度须在 0-100 之间');
      }
      patch.progress = dto.progress;
    }
    if (dto.pm !== undefined) patch.pm = dto.pm;
    if (dto.budget !== undefined) patch.budget = String(dto.budget);
    if (dto.estimatedTotalCost !== undefined) {
      patch.estimatedTotalCost = String(dto.estimatedTotalCost);
    }
    if (dto.endDate !== undefined) patch.endDate = dto.endDate;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    const rows = await this.db
      .update(erpProject)
      .set(patch)
      .where(eq(erpProject.id, id))
      .returning();
    const row = rows[0];
    const contract = await this.db
      .select({ name: erpContract.name })
      .from(erpContract)
      .where(eq(erpContract.id, row.contractId ?? ''));
    return toProject(row, contract[0]?.name ?? '');
  }

  async addMilestone(
    projectId: string,
    dto: CreateProjectMilestoneDto
  ): Promise<ProjectMilestone> {
    const project = await this.db
      .select({ id: erpProject.id })
      .from(erpProject)
      .where(eq(erpProject.id, projectId));
    if (project.length === 0) throw new NotFoundException('项目不存在');
    const rows = await this.db
      .insert(erpProjectMilestone)
      .values({
        projectId,
        name: dto.name,
        planDate: dto.planDate,
        baselineDate: dto.planDate,
        forecastDate: dto.planDate,
        weightPct: String(dto.weightPct ?? 0),
        status: 'pending',
        remark: dto.remark,
      })
      .returning();
    return this.toMilestone(rows[0]);
  }

  async updateMilestone(
    milestoneId: string,
    dto: UpdateProjectMilestoneDto & { status?: 'reached'; actualDate?: string }
  ): Promise<ProjectMilestone> {
    const existing = await this.db
      .select()
      .from(erpProjectMilestone)
      .where(eq(erpProjectMilestone.id, milestoneId));
    if (existing.length === 0) throw new NotFoundException('里程碑不存在');
    const isReached = (existing[0].status ?? 'pending') === 'reached';
    const patch: Partial<typeof erpProjectMilestone.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (dto.status === 'reached') {
      patch.status = 'reached';
      patch.actualDate = dto.actualDate ?? new Date().toISOString().slice(0, 10);
    } else {
      if (isReached) {
        throw new BadRequestException('已达成里程碑不可编辑预测日期/权重');
      }
      if (dto.forecastDate !== undefined) patch.forecastDate = dto.forecastDate;
      if (dto.weightPct !== undefined) {
        if (dto.weightPct < 0 || dto.weightPct > 100) {
          throw new BadRequestException('里程碑权重须在 0-100 之间');
        }
        patch.weightPct = String(dto.weightPct);
      }
    }
    if (dto.remark !== undefined) patch.remark = dto.remark;
    const rows = await this.db
      .update(erpProjectMilestone)
      .set(patch)
      .where(eq(erpProjectMilestone.id, milestoneId))
      .returning();
    const row = rows[0];
    if (dto.status === 'reached') {
      await this.recalcProgress(row.projectId ?? '');
    }
    return this.toMilestone(row);
  }

  /** 有加权里程碑的项目按达成权重自动重算进度 */
  private async recalcProgress(projectId: string): Promise<void> {
    if (!projectId) return;
    const milestones = await this.db
      .select({
        status: erpProjectMilestone.status,
        weightPct: erpProjectMilestone.weightPct,
      })
      .from(erpProjectMilestone)
      .where(eq(erpProjectMilestone.projectId, projectId));
    let total = 0;
    let reached = 0;
    for (const m of milestones) {
      const weight: number = Number(m.weightPct ?? 0);
      if (weight <= 0) continue;
      total += weight;
      if ((m.status ?? 'pending') === 'reached') reached += weight;
    }
    if (total <= 0) return;
    const progress = Math.round((reached / total) * 100);
    await this.db
      .update(erpProject)
      .set({ progress, updatedAt: new Date() })
      .where(eq(erpProject.id, projectId));
  }

  async createChange(
    projectId: string,
    dto: CreateProjectChangeDto
  ): Promise<ProjectChange> {
    const project = await this.db
      .select({ id: erpProject.id })
      .from(erpProject)
      .where(eq(erpProject.id, projectId));
    if (project.length === 0) throw new NotFoundException('项目不存在');
    const code = await generateBizCode(
      this.db,
      erpProjectChange,
      erpProjectChange.code,
      'PCH'
    );
    const rows = await this.db
      .insert(erpProjectChange)
      .values({
        code,
        projectId,
        changeType: dto.changeType,
        content: dto.content,
        beforeValue: dto.beforeValue,
        afterValue: dto.afterValue,
        status: 'pending',
        applicant: dto.applicant,
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];
    return {
      id: row.id,
      code: row.code,
      projectId: row.projectId ?? '',
      changeType: (row.changeType ?? 'scope') as ProjectChange['changeType'],
      content: row.content ?? '',
      beforeValue: row.beforeValue,
      afterValue: row.afterValue,
      status: (row.status ?? 'pending') as ProjectChange['status'],
      applicant: row.applicant,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async approveChange(
    changeId: string,
    action: 'approve' | 'reject'
  ): Promise<ProjectChange> {
    const existing = await this.db
      .select()
      .from(erpProjectChange)
      .where(eq(erpProjectChange.id, changeId));
    if (existing.length === 0) throw new NotFoundException('变更不存在');
    if ((existing[0].status ?? 'pending') !== 'pending') {
      throw new BadRequestException('该变更已审批');
    }
    const row0 = existing[0];
    if (action === 'approve') {
      if (
        row0.changeType === 'budget' &&
        row0.projectId &&
        row0.afterValue &&
        !Number.isNaN(Number(row0.afterValue))
      ) {
        await this.db
          .update(erpProject)
          .set({ budget: String(Number(row0.afterValue)), updatedAt: new Date() })
          .where(eq(erpProject.id, row0.projectId));
      }
      if (
        row0.changeType === 'schedule' &&
        row0.projectId &&
        row0.afterValue &&
        /^\d{4}-\d{2}-\d{2}$/.test(row0.afterValue)
      ) {
        await this.db
          .update(erpProject)
          .set({ endDate: row0.afterValue, updatedAt: new Date() })
          .where(eq(erpProject.id, row0.projectId));
      }
    }
    const rows = await this.db
      .update(erpProjectChange)
      .set({ status: action === 'approve' ? 'approved' : 'rejected', updatedAt: new Date() })
      .where(eq(erpProjectChange.id, changeId))
      .returning();
    const row = rows[0];
    return {
      id: row.id,
      code: row.code,
      projectId: row.projectId ?? '',
      changeType: (row.changeType ?? 'scope') as ProjectChange['changeType'],
      content: row.content ?? '',
      beforeValue: row.beforeValue,
      afterValue: row.afterValue,
      status: (row.status ?? 'pending') as ProjectChange['status'],
      applicant: row.applicant,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
