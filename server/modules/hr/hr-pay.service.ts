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
  count,
  desc,
  eq,
  gte,
  inArray,
  like,
  lt,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  erpCostAllocation,
  erpTimesheet,
  hrAppraisal,
  hrCandidate,
  hrDepartment,
  hrPayroll,
  hrRecruitReq,
  hrTraining,
  hrTrainingRecord,
  mdEmployee,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import type {
  AddTrainingAttendeesDto,
  AppraisalAction,
  AppraisalItem,
  AppraisalStatus,
  Candidate,
  CandidateAction,
  CandidateStage,
  CreateAppraisalDto,
  CreateCandidateDto,
  CreatePayrollDto,
  CreateRecruitReqDto,
  CreateTrainingDto,
  PayrollAction,
  PayrollItem,
  PayrollStatus,
  RecruitReq,
  Training,
  TrainingStatus,
} from '@shared/api.interface';

interface AllocationItem {
  projectId: string;
  amount: number;
}

@Injectable()
export class HrPayService {
  private readonly logger = new Logger(HrPayService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService
  ) {}

  /* ========== 薪酬 ========== */

  async listPayrolls(
    period?: string,
    status?: string,
    employeeId?: string
  ): Promise<PayrollItem[]> {
    const conditions: SQL[] = [];
    if (period) conditions.push(eq(hrPayroll.period, period));
    if (status) conditions.push(eq(hrPayroll.status, status));
    if (employeeId) conditions.push(eq(hrPayroll.employeeId, employeeId));
    const rows = await this.db
      .select({ payroll: hrPayroll, employeeName: mdEmployee.name })
      .from(hrPayroll)
      .leftJoin(mdEmployee, eq(hrPayroll.employeeId, mdEmployee.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(hrPayroll.createdAt));
    return rows.map((row) =>
      this.toPayrollItem(row.payroll, row.employeeName ?? '')
    );
  }

  /** 仅返回当前登录用户绑定员工的工资单 */
  async listMyPayrolls(
    userId: string,
    period?: string,
    status?: string
  ): Promise<PayrollItem[]> {
    const employees = await this.db
      .select({ id: mdEmployee.id })
      .from(mdEmployee)
      .where(eq(mdEmployee.platformUserId, userId))
      .limit(1);
    const employeeId: string | undefined = employees[0]?.id;
    if (!employeeId) return [];
    return this.listPayrolls(period, status, employeeId);
  }

  async createPayroll(dto: CreatePayrollDto): Promise<PayrollItem> {
    const employees = await this.db
      .select({ id: mdEmployee.id, name: mdEmployee.name, status: mdEmployee.status })
      .from(mdEmployee)
      .where(eq(mdEmployee.id, dto.employeeId));
    if (employees.length === 0) throw new NotFoundException('员工不存在');
    if (employees[0].status === 'resigned') {
      throw new BadRequestException('员工已离职，无法创建工资单');
    }
    const dup = await this.db
      .select({ id: hrPayroll.id })
      .from(hrPayroll)
      .where(
        and(
          eq(hrPayroll.employeeId, dto.employeeId),
          eq(hrPayroll.period, dto.period)
        )
      );
    if (dup.length > 0) {
      throw new BadRequestException('该员工此月份工资单已存在');
    }
    const base: number = Number(dto.baseSalary ?? 0);
    const perf: number = Number(dto.perfSalary ?? 0);
    const allowance: number = Number(dto.allowance ?? 0);
    const social: number = Number(dto.socialInsurance ?? 0);
    const fund: number = Number(dto.housingFund ?? 0);
    const tax: number = Number(dto.tax ?? 0);
    const net: number = base + perf + allowance - social - fund - tax;
    const code = await generateBizCode(
      this.db,
      hrPayroll,
      hrPayroll.code,
      'SAL'
    );
    const rows = await this.db
      .insert(hrPayroll)
      .values({
        code,
        employeeId: dto.employeeId,
        period: dto.period,
        baseSalary: String(base),
        perfSalary: String(perf),
        allowance: String(allowance),
        socialInsurance: String(social),
        housingFund: String(fund),
        tax: String(tax),
        netSalary: String(net),
        status: 'draft',
        allocationGenerated: false,
        remark: dto.remark,
      })
      .returning();
    return this.toPayrollItem(rows[0], employees[0].name);
  }

  /** 工资单状态机：draft → submitted → approved | rejected */
  async payrollAction(id: string, action: PayrollAction): Promise<PayrollItem> {
    const rows0 = await this.db
      .select()
      .from(hrPayroll)
      .where(eq(hrPayroll.id, id));
    if (rows0.length === 0) throw new NotFoundException('工资单不存在');
    const payroll = rows0[0];
    const current = (payroll.status ?? 'draft') as PayrollStatus;
    if (action === 'submit') {
      if (current !== 'draft') throw new BadRequestException('仅草稿状态可提交');
      await this.db
        .update(hrPayroll)
        .set({ status: 'submitted', updatedAt: new Date() })
        .where(eq(hrPayroll.id, id));
    } else if (action === 'reject') {
      if (current !== 'submitted') {
        throw new BadRequestException('仅已提交状态可驳回');
      }
      await this.db
        .update(hrPayroll)
        .set({ status: 'rejected', updatedAt: new Date() })
        .where(eq(hrPayroll.id, id));
    } else {
      if (current !== 'submitted') {
        throw new BadRequestException('仅已提交状态可审批');
      }
      if (payroll.allocationGenerated) {
        throw new BadRequestException('该工资单已生成分摊，不可重复审批');
      }
      await this.approvePayroll(payroll);

      /* 工资单审批通过 → 生成凭证草稿：借 管理费用(6602) / 贷 应付职工薪酬(2211) */
      try {
        const netAmount = Number(payroll.netSalary ?? 0);
        const periodMatch = /^(\d{4})-(\d{2})$/.exec(payroll.period ?? '');
        const voucherDate = periodMatch
          ? `${payroll.period}-${String(
              new Date(
                Date.UTC(Number(periodMatch[1]), Number(periodMatch[2]), 0)
              ).getUTCDate()
            ).padStart(2, '0')}`
          : new Date().toISOString().slice(0, 10);
        await this.voucherHookService.generateVoucherDraft({
          sourceType: 'payroll',
          sourceRef: `payroll:${payroll.code}`,
          voucherDate,
          summary: `工资单审批 ${payroll.code}`,
          lines: [
            { accountCode: '6602', debit: netAmount },
            { accountCode: '2211', credit: netAmount },
          ],
        });
      } catch (error) {
        this.logger.error(
          `工资凭证草稿生成失败：payroll:${payroll.code}`,
          error instanceof Error ? error.stack : String(error)
        );
      }
    }
    return this.getPayrollItem(id);
  }

  /**
   * 审批通过：净工资 > 0 时按当月已确认工时的项目占比
   * 生成分摊记录（erp_cost_allocation），并置 allocation_generated。
   */
  private async approvePayroll(
    payroll: typeof hrPayroll.$inferSelect
  ): Promise<void> {
    const net: number = Number(payroll.netSalary ?? 0);
    const items: AllocationItem[] =
      net > 0 ? await this.collectAllocationItems(payroll) : [];
    const monthKey = this.currentMonthKey('CAL');
    await this.db.transaction(async (tx) => {
      if (items.length > 0) {
        const countRows: Array<{ total: number }> = await tx
          .select({ total: count() })
          .from(erpCostAllocation)
          .where(like(erpCostAllocation.code, `${monthKey}%`));
        let seq: number = Number(countRows[0]?.total ?? 0);
        for (const item of items) {
          seq += 1;
          const allocCode = `${monthKey}${String(seq).padStart(4, '0')}`;
          await tx.insert(erpCostAllocation).values({
            code: allocCode,
            sourceDesc: `工资单 ${payroll.code} 分摊`,
            costType: 'labor',
            amount: String(item.amount),
            targetProjectId: item.projectId,
            period: payroll.period ?? '',
            sourceRef: `payroll:${payroll.code}`,
          });
        }
      }
      await tx
        .update(hrPayroll)
        .set({
          status: 'approved',
          allocationGenerated: items.length > 0,
          updatedAt: new Date(),
        })
        .where(eq(hrPayroll.id, payroll.id));
    });
  }

  /** 按项目汇总该员工该月份的已确认工时，折算分摊金额 */
  private async collectAllocationItems(
    payroll: typeof hrPayroll.$inferSelect
  ): Promise<AllocationItem[]> {
    const employeeId = payroll.employeeId;
    const period = payroll.period ?? '';
    if (!employeeId || period.length < 7) return [];
    const periodStart = `${period}-01`;
    const periodYear: number = Number(period.slice(0, 4));
    const periodMonth: number = Number(period.slice(5, 7));
    const next = new Date(Date.UTC(periodYear, periodMonth, 1));
    const periodEnd =
      `${next.getUTCFullYear()}-` +
      `${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const rows = await this.db
      .select({
        projectId: erpTimesheet.projectId,
        totalHours: sql<number>`coalesce(sum(${erpTimesheet.hours}), 0)::float8`,
      })
      .from(erpTimesheet)
      .where(
        and(
          eq(erpTimesheet.employeeId, employeeId),
          eq(erpTimesheet.status, 'confirmed'),
          gte(erpTimesheet.workDate, periodStart),
          lt(erpTimesheet.workDate, periodEnd)
        )
      )
      .groupBy(erpTimesheet.projectId);
    const valid = rows.filter(
      (row) => row.projectId !== null && Number(row.totalHours) > 0
    );
    const totalHours: number = valid.reduce(
      (acc: number, row) => acc + Number(row.totalHours),
      0
    );
    if (totalHours <= 0) return [];
    const net: number = Number(payroll.netSalary ?? 0);
    return valid.map((row) => ({
      projectId: row.projectId as string,
      amount:
        Math.round(net * (Number(row.totalHours) / totalHours) * 100) / 100,
    }));
  }

  private async getPayrollItem(id: string): Promise<PayrollItem> {
    const rows = await this.db
      .select({ payroll: hrPayroll, employeeName: mdEmployee.name })
      .from(hrPayroll)
      .leftJoin(mdEmployee, eq(hrPayroll.employeeId, mdEmployee.id))
      .where(eq(hrPayroll.id, id));
    if (rows.length === 0) throw new NotFoundException('工资单不存在');
    return this.toPayrollItem(rows[0].payroll, rows[0].employeeName ?? '');
  }

  private toPayrollItem(
    row: typeof hrPayroll.$inferSelect,
    employeeName: string
  ): PayrollItem {
    return {
      id: row.id,
      code: row.code,
      employeeId: row.employeeId ?? '',
      employeeName,
      period: row.period ?? '',
      baseSalary: Number(row.baseSalary ?? 0),
      perfSalary: Number(row.perfSalary ?? 0),
      allowance: Number(row.allowance ?? 0),
      socialInsurance: Number(row.socialInsurance ?? 0),
      housingFund: Number(row.housingFund ?? 0),
      tax: Number(row.tax ?? 0),
      netSalary: Number(row.netSalary ?? 0),
      status: (row.status ?? 'draft') as PayrollStatus,
      allocationGenerated: row.allocationGenerated ?? false,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private currentMonthKey(prefix: string): string {
    const now = new Date();
    return (
      `${prefix}${now.getFullYear()}` +
      `${String(now.getMonth() + 1).padStart(2, '0')}`
    );
  }

  /* ========== 招聘需求 ========== */

  async listRecruitReqs(): Promise<RecruitReq[]> {
    const rows = await this.db
      .select({ req: hrRecruitReq, departmentName: hrDepartment.name })
      .from(hrRecruitReq)
      .leftJoin(hrDepartment, eq(hrRecruitReq.departmentId, hrDepartment.id))
      .orderBy(desc(hrRecruitReq.createdAt));
    const hiredRows = await this.db
      .select({ reqId: hrCandidate.recruitReqId, total: count() })
      .from(hrCandidate)
      .where(eq(hrCandidate.stage, 'hired'))
      .groupBy(hrCandidate.recruitReqId);
    const hiredMap = new Map<string, number>();
    for (const row of hiredRows) {
      hiredMap.set(row.reqId ?? '', Number(row.total ?? 0));
    }
    return rows.map((row) => ({
      id: row.req.id,
      code: row.req.code,
      departmentId: row.req.departmentId,
      departmentName: row.departmentName ?? null,
      title: row.req.title,
      headcount: row.req.headcount ?? 1,
      hiredCount: hiredMap.get(row.req.id) ?? 0,
      status: row.req.status ?? 'open',
      remark: row.req.remark,
      createdAt: row.req.createdAt.toISOString(),
    }));
  }

  async createRecruitReq(dto: CreateRecruitReqDto): Promise<RecruitReq> {
    const code = await generateBizCode(
      this.db,
      hrRecruitReq,
      hrRecruitReq.code,
      'REC'
    );
    const rows = await this.db
      .insert(hrRecruitReq)
      .values({
        code,
        departmentId: dto.departmentId,
        title: dto.title,
        headcount: dto.headcount ?? 1,
        status: 'open',
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];
    let departmentName: string | null = null;
    if (row.departmentId) {
      const dept = await this.db
        .select({ name: hrDepartment.name })
        .from(hrDepartment)
        .where(eq(hrDepartment.id, row.departmentId));
      departmentName = dept[0]?.name ?? null;
    }
    return {
      id: row.id,
      code: row.code,
      departmentId: row.departmentId,
      departmentName,
      title: row.title,
      headcount: row.headcount ?? 1,
      hiredCount: 0,
      status: row.status ?? 'open',
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /* ========== 候选人 ========== */

  async listCandidates(reqId?: string): Promise<Candidate[]> {
    const rows = await this.db
      .select({ c: hrCandidate, title: hrRecruitReq.title })
      .from(hrCandidate)
      .leftJoin(hrRecruitReq, eq(hrCandidate.recruitReqId, hrRecruitReq.id))
      .where(reqId ? eq(hrCandidate.recruitReqId, reqId) : undefined)
      .orderBy(desc(hrCandidate.createdAt));
    return rows.map((row) => this.toCandidateItem(row.c, row.title ?? null));
  }

  async createCandidate(dto: CreateCandidateDto): Promise<Candidate> {
    const reqs = await this.db
      .select({ id: hrRecruitReq.id, title: hrRecruitReq.title, status: hrRecruitReq.status })
      .from(hrRecruitReq)
      .where(eq(hrRecruitReq.id, dto.recruitReqId));
    if (reqs.length === 0 || reqs[0].status !== 'open') {
      throw new BadRequestException('招聘需求不存在或已关闭');
    }
    const code = await generateBizCode(
      this.db,
      hrCandidate,
      hrCandidate.code,
      'CND'
    );
    const rows = await this.db
      .insert(hrCandidate)
      .values({
        code,
        recruitReqId: dto.recruitReqId,
        name: dto.name,
        phone: dto.phone,
        stage: 'pending',
        remark: dto.remark,
      })
      .returning();
    return this.toCandidateItem(rows[0], reqs[0].title);
  }

  /** 候选人单向流转：pending → interview → offer → hired | rejected */
  async candidateAction(id: string, action: CandidateAction): Promise<Candidate> {
    const rows0 = await this.db
      .select()
      .from(hrCandidate)
      .where(eq(hrCandidate.id, id));
    if (rows0.length === 0) throw new NotFoundException('候选人不存在');
    const candidate = rows0[0];
    const current = (candidate.stage ?? 'pending') as CandidateStage;
    if (action === 'interview' && current !== 'pending') {
      throw new BadRequestException('仅待筛选状态可安排面试');
    }
    if (action === 'offer' && current !== 'interview') {
      throw new BadRequestException('仅面试阶段可发放 offer');
    }
    if (
      (action === 'hired' || action === 'rejected') &&
      current !== 'offer'
    ) {
      throw new BadRequestException('仅 offer 阶段可录用或拒绝');
    }
    if (action === 'hired') {
      const empCode = await generateBizCode(
        this.db,
        mdEmployee,
        mdEmployee.code,
        'EMP'
      );
      const today = new Date(Date.now() + 8 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      await this.db.transaction(async (tx) => {
        await tx
          .update(hrCandidate)
          .set({ stage: 'hired', updatedAt: new Date() })
          .where(eq(hrCandidate.id, id));
        await tx.insert(mdEmployee).values({
          code: empCode,
          name: candidate.name,
          status: 'probation',
          hireDate: today,
          employmentType: 'full_time',
          phone: candidate.phone,
        });
      });
    } else {
      const nextStage: CandidateStage =
        action === 'rejected' ? 'rejected' : action;
      await this.db
        .update(hrCandidate)
        .set({ stage: nextStage, updatedAt: new Date() })
        .where(eq(hrCandidate.id, id));
    }
    return this.getCandidateItem(id);
  }

  private async getCandidateItem(id: string): Promise<Candidate> {
    const rows = await this.db
      .select({ c: hrCandidate, title: hrRecruitReq.title })
      .from(hrCandidate)
      .leftJoin(hrRecruitReq, eq(hrCandidate.recruitReqId, hrRecruitReq.id))
      .where(eq(hrCandidate.id, id));
    if (rows.length === 0) throw new NotFoundException('候选人不存在');
    return this.toCandidateItem(rows[0].c, rows[0].title ?? null);
  }

  private toCandidateItem(
    row: typeof hrCandidate.$inferSelect,
    title: string | null
  ): Candidate {
    return {
      id: row.id,
      code: row.code,
      recruitReqId: row.recruitReqId ?? '',
      recruitReqTitle: title,
      name: row.name,
      phone: row.phone,
      stage: (row.stage ?? 'pending') as CandidateStage,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /* ========== 绩效 ========== */

  async listAppraisals(period?: string): Promise<AppraisalItem[]> {
    const rows = await this.db
      .select({ item: hrAppraisal, employeeName: mdEmployee.name })
      .from(hrAppraisal)
      .leftJoin(mdEmployee, eq(hrAppraisal.employeeId, mdEmployee.id))
      .where(period ? eq(hrAppraisal.period, period) : undefined)
      .orderBy(desc(hrAppraisal.createdAt));
    return rows.map((row) =>
      this.toAppraisalItem(row.item, row.employeeName ?? '')
    );
  }

  async createAppraisal(dto: CreateAppraisalDto): Promise<AppraisalItem> {
    const employees = await this.db
      .select({ id: mdEmployee.id, name: mdEmployee.name })
      .from(mdEmployee)
      .where(eq(mdEmployee.id, dto.employeeId));
    if (employees.length === 0) throw new NotFoundException('员工不存在');
    const code = await generateBizCode(
      this.db,
      hrAppraisal,
      hrAppraisal.code,
      'PRF'
    );
    const rows = await this.db
      .insert(hrAppraisal)
      .values({
        code,
        employeeId: dto.employeeId,
        period: dto.period,
        score: String(dto.score),
        grade: dto.grade,
        status: 'draft',
        remark: dto.remark,
      })
      .returning();
    return this.toAppraisalItem(rows[0], employees[0].name);
  }

  /** 绩效确认：draft → confirmed，确认时等级必填 */
  async appraisalAction(
    id: string,
    action: AppraisalAction
  ): Promise<AppraisalItem> {
    const rows0 = await this.db
      .select()
      .from(hrAppraisal)
      .where(eq(hrAppraisal.id, id));
    if (rows0.length === 0) throw new NotFoundException('绩效记录不存在');
    const appraisal = rows0[0];
    const current = (appraisal.status ?? 'draft') as AppraisalStatus;
    if (current !== 'draft') {
      throw new BadRequestException('仅草稿状态可确认');
    }
    if ((appraisal.grade ?? '').trim() === '') {
      throw new BadRequestException('绩效等级为空，无法确认');
    }
    await this.db
      .update(hrAppraisal)
      .set({ status: 'confirmed', updatedAt: new Date() })
      .where(eq(hrAppraisal.id, id));
    return this.getAppraisalItem(id);
  }

  private async getAppraisalItem(id: string): Promise<AppraisalItem> {
    const rows = await this.db
      .select({ item: hrAppraisal, employeeName: mdEmployee.name })
      .from(hrAppraisal)
      .leftJoin(mdEmployee, eq(hrAppraisal.employeeId, mdEmployee.id))
      .where(eq(hrAppraisal.id, id));
    if (rows.length === 0) throw new NotFoundException('绩效记录不存在');
    return this.toAppraisalItem(rows[0].item, rows[0].employeeName ?? '');
  }

  private toAppraisalItem(
    row: typeof hrAppraisal.$inferSelect,
    employeeName: string
  ): AppraisalItem {
    return {
      id: row.id,
      code: row.code,
      employeeId: row.employeeId ?? '',
      employeeName,
      period: row.period ?? '',
      score: Number(row.score ?? 0),
      grade: row.grade,
      status: (row.status ?? 'draft') as AppraisalStatus,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /* ========== 培训 ========== */

  async listTrainings(): Promise<Training[]> {
    const rows = await this.db
      .select()
      .from(hrTraining)
      .orderBy(desc(hrTraining.createdAt));
    const countRows = await this.db
      .select({ trainingId: hrTrainingRecord.trainingId, total: count() })
      .from(hrTrainingRecord)
      .groupBy(hrTrainingRecord.trainingId);
    const countMap = new Map<string, number>();
    for (const row of countRows) {
      countMap.set(row.trainingId ?? '', Number(row.total ?? 0));
    }
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      trainer: row.trainer,
      hours: Number(row.hours ?? 0),
      startDate: row.startDate,
      endDate: row.endDate,
      status: (row.status ?? 'planned') as TrainingStatus,
      attendeeCount: countMap.get(row.id) ?? 0,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async createTraining(dto: CreateTrainingDto): Promise<Training> {
    const code = await generateBizCode(
      this.db,
      hrTraining,
      hrTraining.code,
      'TRN'
    );
    const rows = await this.db
      .insert(hrTraining)
      .values({
        code,
        name: dto.name,
        trainer: dto.trainer,
        hours: String(dto.hours ?? 0),
        startDate: dto.startDate,
        endDate: dto.endDate,
        status: 'planned',
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      trainer: row.trainer,
      hours: Number(row.hours ?? 0),
      startDate: row.startDate,
      endDate: row.endDate,
      status: (row.status ?? 'planned') as TrainingStatus,
      attendeeCount: 0,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 批量添加培训学员：员工不存在的跳过，重复参与静默忽略 */
  async addTrainingAttendees(
    id: string,
    dto: AddTrainingAttendeesDto
  ): Promise<Training> {
    const rows0 = await this.db
      .select({ id: hrTraining.id })
      .from(hrTraining)
      .where(eq(hrTraining.id, id));
    if (rows0.length === 0) throw new NotFoundException('培训不存在');
    const uniqueIds: string[] = [...new Set(dto.employeeIds)];
    if (uniqueIds.length > 0) {
      const empRows = await this.db
        .select({ id: mdEmployee.id })
        .from(mdEmployee)
        .where(inArray(mdEmployee.id, uniqueIds));
      const validIds: string[] = empRows.map((row) => row.id);
      if (validIds.length > 0) {
        await this.db
          .insert(hrTrainingRecord)
          .values(
            validIds.map((empId: string) => ({
              trainingId: id,
              employeeId: empId,
              status: 'attended',
            }))
          )
          .onConflictDoNothing({
            target: [hrTrainingRecord.trainingId, hrTrainingRecord.employeeId],
          });
      }
    }
    return this.getTrainingItem(id);
  }

  /** 培训完成：planned → done */
  async trainingAction(
    id: string,
    action: 'finish'
  ): Promise<Training> {
    const rows0 = await this.db
      .select()
      .from(hrTraining)
      .where(eq(hrTraining.id, id));
    if (rows0.length === 0) throw new NotFoundException('培训不存在');
    const current = (rows0[0].status ?? 'planned') as TrainingStatus;
    if (action === 'finish' && current !== 'planned') {
      throw new BadRequestException('仅计划中状态可完成');
    }
    await this.db
      .update(hrTraining)
      .set({ status: 'done', updatedAt: new Date() })
      .where(eq(hrTraining.id, id));
    return this.getTrainingItem(id);
  }

  private async getTrainingItem(id: string): Promise<Training> {
    const rows = await this.db
      .select()
      .from(hrTraining)
      .where(eq(hrTraining.id, id));
    if (rows.length === 0) throw new NotFoundException('培训不存在');
    const countRows = await this.db
      .select({ total: count() })
      .from(hrTrainingRecord)
      .where(eq(hrTrainingRecord.trainingId, id));
    const row = rows[0];
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      trainer: row.trainer,
      hours: Number(row.hours ?? 0),
      startDate: row.startDate,
      endDate: row.endDate,
      status: (row.status ?? 'planned') as TrainingStatus,
      attendeeCount: Number(countRows[0]?.total ?? 0),
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
