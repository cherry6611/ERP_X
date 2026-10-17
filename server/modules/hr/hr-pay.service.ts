import {
  BadRequestException,
  ConflictException,
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
  ne,
  or,
  lt,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  erpCostAllocation,
  erpProjectCost,
  erpTimesheet,
  finVoucher,
  hrAppraisal,
  hrCandidate,
  hrDepartment,
  hrPayroll,
  hrRecruitReq,
  hrSsCityRule,
  hrTraining,
  hrTrainingRecord,
  mdEmployee,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { round2 } from '@server/common/utils/number';
import { allocateByHours } from './payroll-allocation';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { todayInShanghai } from '@server/common/utils/biz-date';
import { previewPayroll, cumulativeAdditionalDeduction, monthlyAdditionalDeduction } from './payroll-engine';
import { payrollAccrualLines } from '@server/common/tax/payroll-posting';
import { PayrollTaxService } from './payroll-tax.service';
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
    private readonly voucherHookService: VoucherHookService,
    private readonly payrollTaxService: PayrollTaxService,
  ) {}

  /**
   * N-1：取「应发工资」（代扣前）。
   *
   * 优先用引擎快照里的 `gross`（引擎算的就是应发口径）；手工录入（无快照）时
   * 回落到「基本 + 绩效 + 津贴」—— 这正是手工口径下 `net` 的计算基础
   * （见 createPayroll 里 `engineNet ?? base + perf + allowance - social - fund - tax`），
   * 两者一致，不会出现应发与实发对不上的情况。
   */
  private resolvePayrollGross(payroll: {
    engineSnapshot?: string | null;
    baseSalary?: string | number | null;
    perfSalary?: string | number | null;
    allowance?: string | number | null;
  }): number {
    if (payroll.engineSnapshot) {
      try {
        const parsed = JSON.parse(payroll.engineSnapshot) as { gross?: unknown };
        if (typeof parsed.gross === 'number' && Number.isFinite(parsed.gross)) {
          return parsed.gross;
        }
      } catch {
        this.logger.warn(
          '工资单引擎快照解析失败，应发工资回落到「基本+绩效+津贴」口径，请核对工资单数据'
        );
      }
    }
    return (
      Number(payroll.baseSalary ?? 0) +
      Number(payroll.perfSalary ?? 0) +
      Number(payroll.allowance ?? 0)
    );
  }

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
      .where(or(eq(mdEmployee.feishuUnionId, userId), eq(mdEmployee.platformUserId, userId)))
      .limit(1);
    const employeeId: string | undefined = employees[0]?.id;
    if (!employeeId) return [];
    return this.listPayrolls(period, status, employeeId);
  }

  /** 按城市规则试算三金个税（可覆盖后落库） */
  async previewPayrollEngine(dto: {
    employeeId: string;
    period: string;
    baseSalary: number;
    perfSalary?: number;
    allowance?: number;
    taxFreeIncome?: number;
    otherDeduction?: number;
  }) {
    const employees = await this.db
      .select()
      .from(mdEmployee)
      .where(eq(mdEmployee.id, dto.employeeId))
      .limit(1);
    if (employees.length === 0) throw new NotFoundException('员工不存在');
    const emp = employees[0];
    const cityCode = emp.ssCityCode;
    if (!cityCode) {
      throw new BadRequestException('员工未绑定参保城市，请先维护 ssCityCode');
    }
    const rules = await this.db
      .select()
      .from(hrSsCityRule)
      .where(eq(hrSsCityRule.cityCode, cityCode))
      .orderBy(desc(hrSsCityRule.effectiveFrom));
    // D-13：无匹配期间必须报错，禁止静默回退 rules[0]
    const rule = rules.find(
      (r) =>
        r.effectiveFrom <= dto.period &&
        (!r.effectiveTo || r.effectiveTo >= dto.period),
    );
    if (!rule) {
      throw new BadRequestException(
        `城市 ${cityCode} 在期间 ${dto.period} 无匹配的社保规则`,
      );
    }
    const year = dto.period.slice(0, 4);
    const monthIndex = Number(dto.period.slice(5, 7));
    // D-04'：汇总本年前置已批/已提交工资单，按累计预扣法算本期个税
    const prior = await this.db
      .select({
        baseSalary: hrPayroll.baseSalary,
        perfSalary: hrPayroll.perfSalary,
        allowance: hrPayroll.allowance,
        socialInsurance: hrPayroll.socialInsurance,
        housingFund: hrPayroll.housingFund,
        tax: hrPayroll.tax,
      })
      .from(hrPayroll)
      .where(
        and(
          eq(hrPayroll.employeeId, dto.employeeId),
          sql`${hrPayroll.period} like ${`${year}-%`}`,
          sql`${hrPayroll.period} < ${dto.period}`,
          inArray(hrPayroll.status, ['approved', 'submitted']),
        ),
      );
    let ytdGross = 0;
    let ytdSpecial = 0;
    let ytdTaxPaid = 0;
    for (const row of prior) {
      ytdGross +=
        Number(row.baseSalary ?? 0) +
        Number(row.perfSalary ?? 0) +
        Number(row.allowance ?? 0);
      ytdSpecial +=
        Number(row.socialInsurance ?? 0) + Number(row.housingFund ?? 0);
      ytdTaxPaid += Number(row.tax ?? 0);
    }
    // A-07：专项附加扣除按员工 × 年度登记，按月定额计入累计口径
    const taxYear = Number(year);
    const deductionEntries = await this.payrollTaxService.entriesFor(
      dto.employeeId,
      taxYear
    );
    const additionalThisMonth = monthlyAdditionalDeduction(
      deductionEntries,
      Number.isFinite(monthIndex) ? monthIndex : 1
    );
    // 已发放月份的累计专项附加扣除（不含本月）
    const additionalBefore = cumulativeAdditionalDeduction(
      deductionEntries,
      Math.max(0, (Number.isFinite(monthIndex) ? monthIndex : 1) - 1)
    );
    const result = previewPayroll({
      baseSalary: Number(dto.baseSalary ?? 0),
      perfSalary: Number(dto.perfSalary ?? 0),
      allowance: Number(dto.allowance ?? 0),
      ssBase: emp.ssBase != null ? Number(emp.ssBase) : undefined,
      monthIndex: Number.isFinite(monthIndex) ? monthIndex : 1,
      ytdGross,
      ytdSpecialDeduction: ytdSpecial,
      ytdTaxPaid,
      additionalDeduction: additionalThisMonth,
      ytdAdditionalDeduction: additionalBefore,
      taxFreeIncome: Number(dto.taxFreeIncome ?? 0),
      otherDeduction: Number(dto.otherDeduction ?? 0),
      rule: {
        pensionEmp: Number(rule.pensionEmp),
        medicalEmp: Number(rule.medicalEmp),
        unemploymentEmp: Number(rule.unemploymentEmp),
        housingEmp: Number(rule.housingEmp),
        baseMin: Number(rule.baseMin),
        baseMax: Number(rule.baseMax),
      },
    });
    return {
      employeeId: dto.employeeId,
      employeeName: emp.name,
      period: dto.period,
      cityCode,
      cityName: rule.cityName,
      ...result,
      taxDeduction: {
        entries: deductionEntries,
        monthlyAmount: additionalThisMonth,
        cumulativeBefore: additionalBefore,
      },
    };
  }

  async listCityRules() {
    const rows = await this.db
      .select()
      .from(hrSsCityRule)
      .orderBy(hrSsCityRule.cityCode, desc(hrSsCityRule.effectiveFrom));
    return rows.map((r) => ({
      id: r.id,
      cityCode: r.cityCode,
      cityName: r.cityName,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      pensionEmp: Number(r.pensionEmp),
      pensionCo: Number(r.pensionCo),
      medicalEmp: Number(r.medicalEmp),
      medicalCo: Number(r.medicalCo),
      unemploymentEmp: Number(r.unemploymentEmp),
      unemploymentCo: Number(r.unemploymentCo),
      housingEmp: Number(r.housingEmp),
      housingCo: Number(r.housingCo),
      baseMin: Number(r.baseMin),
      baseMax: Number(r.baseMax),
    }));
  }

  async upsertCityRule(dto: {
    cityCode: string;
    cityName: string;
    effectiveFrom: string;
    effectiveTo?: string;
    pensionEmp?: number;
    pensionCo?: number;
    medicalEmp?: number;
    medicalCo?: number;
    unemploymentEmp?: number;
    unemploymentCo?: number;
    housingEmp?: number;
    housingCo?: number;
    baseMin?: number;
    baseMax?: number;
  }) {
    const existing = await this.db
      .select({ id: hrSsCityRule.id })
      .from(hrSsCityRule)
      .where(
        and(
          eq(hrSsCityRule.cityCode, dto.cityCode),
          eq(hrSsCityRule.effectiveFrom, dto.effectiveFrom),
        ),
      )
      .limit(1);
    const values = {
      cityCode: dto.cityCode,
      cityName: dto.cityName,
      effectiveFrom: dto.effectiveFrom,
      effectiveTo: dto.effectiveTo ?? null,
      pensionEmp: String(dto.pensionEmp ?? 8),
      pensionCo: String(dto.pensionCo ?? 16),
      medicalEmp: String(dto.medicalEmp ?? 2),
      medicalCo: String(dto.medicalCo ?? 8),
      unemploymentEmp: String(dto.unemploymentEmp ?? 0.5),
      unemploymentCo: String(dto.unemploymentCo ?? 0.5),
      housingEmp: String(dto.housingEmp ?? 12),
      housingCo: String(dto.housingCo ?? 12),
      baseMin: String(dto.baseMin ?? 0),
      baseMax: String(dto.baseMax ?? 999999),
      updatedAt: new Date(),
    };
    if (existing[0]) {
      await this.db
        .update(hrSsCityRule)
        .set(values)
        .where(eq(hrSsCityRule.id, existing[0].id));
      return { id: existing[0].id, ...dto };
    }
    const inserted = await this.db
      .insert(hrSsCityRule)
      .values(values)
      .returning({ id: hrSsCityRule.id });
    return { id: inserted[0].id, ...dto };
  }

  async createPayroll(dto: CreatePayrollDto): Promise<PayrollItem> {
    const employees = await this.db
      .select({
        id: mdEmployee.id,
        name: mdEmployee.name,
        status: mdEmployee.status,
        ssCityCode: mdEmployee.ssCityCode,
        ssBase: mdEmployee.ssBase,
      })
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
    let social: number = Number(dto.socialInsurance ?? 0);
    let fund: number = Number(dto.housingFund ?? 0);
    let tax: number = Number(dto.tax ?? 0);
    let engineSnapshot: string | null = null;
    let manualOverride = 1;
    /** P2-9：引擎口径的实发（已扣其他扣除）。手工口径回退到简单相减。 */
    let engineNet: number | null = null;
    // A-07：累计预扣预缴口径字段（引擎计算时落库，便于逐月递推与审计复核）
    const ytdFields: {
      ytdIncome?: string;
      ytdTaxFreeIncome?: string;
      ytdBasicDeduction?: string;
      ytdDeduction?: string;
      ytdAdditionalDeduction?: string;
      ytdTaxWithheld?: string;
      ytdTaxableIncome?: string;
      taxRate?: string;
      quickDeduction?: string;
      ytdNet?: string;
    } = {};
    // F4X-5：默认走引擎；未绑定参保城市时显式 400，禁止静默取 0
    const useEngine = dto.useEngine !== false;
    if (useEngine) {
      if (!employees[0].ssCityCode) {
        throw new BadRequestException(
          `员工 ${employees[0].name} 未绑定参保城市，无法计算社保与个税；请先在员工档案中设置`,
        );
      }
      const preview = await this.previewPayrollEngine({
        employeeId: dto.employeeId,
        period: dto.period,
        baseSalary: base,
        perfSalary: perf,
        allowance,
        // P2-9：其他扣除（企业年金/商业健康险等）必须传入引擎，否则个税按含
        // 其他扣除的口径计算、实发却按不含的口径发放，两边对不上。
        otherDeduction: dto.otherDeduction,
      });
      social = preview.socialInsurance;
      fund = preview.housingFund;
      tax = preview.tax;
      engineNet = preview.netSalary;
      engineSnapshot = JSON.stringify(preview);
      manualOverride = 0;
      const cumulative = preview.cumulative;
      // 累计实发 = 上期累计实发（由上一张工资单的 ytdNet 带入）+ 本期实发
      const priorNetRows = await this.db
        .select({ ytdNet: hrPayroll.ytdNet })
        .from(hrPayroll)
        .where(
          and(
            eq(hrPayroll.employeeId, dto.employeeId),
            sql`${hrPayroll.period} like ${`${dto.period.slice(0, 4)}-%`}`,
            sql`${hrPayroll.period} < ${dto.period}`
          )
        )
        .orderBy(desc(hrPayroll.period))
        .limit(1);
      const priorNet = Number(priorNetRows[0]?.ytdNet ?? 0);
      Object.assign(ytdFields, {
        ytdIncome: String(cumulative.ytdIncome),
        ytdTaxFreeIncome: String(cumulative.ytdTaxFreeIncome),
        ytdBasicDeduction: String(cumulative.ytdBasicDeduction),
        ytdDeduction: String(cumulative.ytdDeduction),
        ytdAdditionalDeduction: String(cumulative.ytdAdditionalDeduction),
        ytdTaxWithheld: String(cumulative.ytdTaxWithheld),
        ytdTaxableIncome: String(cumulative.cumulativeTaxable),
        taxRate: String(cumulative.taxRate),
        quickDeduction: String(cumulative.quickDeduction),
        ytdNet: String(round2(priorNet + preview.netSalary)),
      });
    }
    // P2-9：走引擎时以引擎实发为准（含其他扣除）；手工录入时按字段简单相减。
    const net: number = round2(
      engineNet ?? base + perf + allowance - social - fund - tax
    );
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
        manualOverride,
        engineSnapshot,
        ...ytdFields,
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
      // D-14：允许 rejected → submitted 重开，避免该月永久死锁
      if (current !== 'draft' && current !== 'rejected') {
        throw new BadRequestException('仅草稿或已驳回状态可提交');
      }
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
    } else if (action === 'pay') {
      /*
       * B12（§7.2）：标记已发放。
       *
       * 前置条件 `approved` —— 只有批准过的工资单才谈得上"发出去"。
       * 为什么需要这个独立动作：`approved` 表示"同意发"，不表示"已发"。
       * 出纳原先只能靠线下表格区分，于是"这个月到底打款了没有"
       * 在系统里查不到 —— 而这是月度结账必须回答的问题。
       *
       * 有意**不做**"标记已发放时自动生成付款凭证"：付款凭证应当由
       * 银行流水/付款单驱动（本仓的现金流预测也按实际付款取数），
       * 在这里顺带生成会让"凭证有、银行没这笔"的错账无法被发现。
       */
      if (current !== 'approved') {
        throw new BadRequestException(
          `仅已批准的工资单可标记发放（当前状态 ${current}）`
        );
      }
      await this.db
        .update(hrPayroll)
        .set({ status: 'paid', updatedAt: new Date() })
        .where(and(eq(hrPayroll.id, id), eq(hrPayroll.status, 'approved')));
    } else if (action === 'void') {
      /*
       * B12：作废已批准的工资单。
       *
       * ## 前置条件（不是形式校验）
       *
       * · 状态必须是 `approved`（`submitted` 应先 reject 而不是 void；
       *   `paid` 已实际发钱，作废涉及资金追回，由线下处理）。
       * · `allocationGenerated` 必须为 false —— 该标记表示**成本分摊已生成**，
       *   也就是 `erp_project_cost` 里已经落了这笔人工成本、并可能已进项目毛利。
       *   直接作废会让"工资单不存在、成本还在" —— 项目毛利虚高且无从追溯。
       *   正确做法是先红冲分摊（本仓有专门的分摊红冲入口），再作废。
       * · 凭证同理：`approvePayroll` 生成的计提凭证需要先红冲。
       *
       * 这里**不自动红冲**：红冲是会计动作，需要会计期间未关账、需要填红冲原因，
       * 由人在对应入口做才留得下审计痕迹。本方法只保证"不会静默产生不一致"。
       */
      if (current !== 'approved') {
        throw new BadRequestException(
          `仅已批准的工资单可作废（当前状态 ${current}）` +
            (current === 'paid'
              ? '；已发放的工资单作废涉及资金追回，请线下处理并走红冲流程'
              : '')
        );
      }
      if (payroll.allocationGenerated) {
        throw new BadRequestException(
          '该工资单已生成成本分摊，不能直接作废：项目成本里已经落了这笔人工，' +
            '直接作废会出现"工资单不存在、成本还在"。请先在成本分摊处红冲，再作废工资单'
        );
      }
      await this.db.transaction(async (tx) => {
        const updated = await tx
          .update(hrPayroll)
          .set({ status: 'voided', updatedAt: new Date() })
          .where(and(eq(hrPayroll.id, id), eq(hrPayroll.status, 'approved')))
          .returning({ id: hrPayroll.id });
        if (updated.length === 0) {
          throw new ConflictException('该工资单状态已变更，请刷新后重试');
        }
        /*
         * 已计提的凭证一并作废，避免"凭证还在、单据已作废"。
         *
         * 按 `(source_type, source_ref)` 反查 —— 这是凭证钩子写入时用的关联键
         * （`sourceType: 'payroll'`、`sourceRef: 'payroll:<单号>'`），
         * 也是唯一能确定"这张凭证确实是本工资单产生的"的依据。
         * 不按金额或摘要匹配：那种匹配会在同月多张工资单时误伤。
         *
         * 只作废 `draft` / `posted` 状态的凭证；已是 `voided` 的跳过（幂等）。
         */
        await tx
          .update(finVoucher)
          .set({ status: 'voided', updatedAt: new Date() })
          .where(
            and(
              eq(finVoucher.sourceType, 'payroll'),
              eq(finVoucher.sourceRef, `payroll:${payroll.code}`),
              ne(finVoucher.status, 'voided')
            )
          );
      });
    } else {
      if (current !== 'submitted') {
        throw new BadRequestException('仅已提交状态可审批');
      }
      if (payroll.allocationGenerated) {
        throw new BadRequestException('该工资单已生成分摊，不可重复审批');
      }
      await this.approvePayroll(payroll);

      /* N-1：按**应发**计提（借 成本费用 应发 / 贷 2211-工资 应发，代扣部分转入应付个税/社保/公积金）；
        预提红冲凭证在 approvePayroll 内按项目发出 */
      let payrollVoucherLines: { accountCode: string; debit?: number; credit?: number }[] | undefined;
      let payrollVoucherDate: string | undefined;
      try {
        const gross = this.resolvePayrollGross(payroll);
        const netAmount = Number(payroll.netSalary ?? 0);
        // 代扣合计取“应发 - 实发”的**差额**，而不是把 tax/社保/公积金相加：
        // 引擎口径下还存在“其他扣除”（企业年金等，P2-9），它未单独落库；
        // 用差额才能保证无论引擎内部怎么拆，2211-工资 余额都恰好落在实发上。
        /*
         * ⚠️ 这里必须用共享 `round2`，不要写 `Math.round((gross - netAmount) * 100) / 100`。
         *
         * 本处原先是内联的 `Math.round(x*100)/100` —— 正是 `shared/number.ts` 明令
         * 不要再写的那种写法（全仓另 5 处已统一迁移，此处是遗漏）。它的两处问题实测：
         *
         * | 输入 | `Math.round(x*100)/100` | `round2(x)` |
         * |---|---|---|
         * | `-0.125` | `-0.12` | `-0.13` |
         * | `-2.675` | `-2.67` | `-2.68` |
         * | `x + (-x)`（红冲对称） | **+0.01 不平** | **0 平** |
         *
         * `Math.round` 是「向 +∞ 取整」而不是会计要求的「远离零取整」，
         * 于是同一笔金额在**计提**与**红冲**两个方向上取整不一致，
         * "原凭证 + 红冲凭证"合计差 1 分 —— 且不会抛错。
         * `withheldTotal` 直接参与本方法的计提/预提红冲凭证行，所以这条必须成立。
         */
        const withheldTotal = round2(gross - netAmount);
        const taxWithheld = Number(payroll.tax ?? 0);
        /* 残差 = 其他代扣（社保/公积金/个税之外的部分）。同样统一走 round2，理由见上。 */
        const otherWithheld = Math.max(
          0,
          round2(
            withheldTotal -
              taxWithheld -
              Number(payroll.socialInsurance ?? 0) -
              Number(payroll.housingFund ?? 0)
          )
        );
        const periodMatch = /^(\d{4})-(\d{2})$/.exec(payroll.period ?? '');
        const voucherDate = periodMatch
          ? `${payroll.period}-${String(
              new Date(
                Date.UTC(Number(periodMatch[1]), Number(periodMatch[2]), 0)
              ).getUTCDate()
            ).padStart(2, '0')}`
          : todayInShanghai();
        // 修复 P1-8：应发为 0 或负数时不生成凭证（否则会出现借方为负数的凭证）；
        // N-1：门禁由“净额”改为“应发” —— 应发为正、实发为负（超额代扣）属数据异常，同样跳过。
        if (gross > 0 && netAmount >= 0) {
          // P1-9：分录提到 try 外层做常量，补偿登记时才能带上可重放的分录
          payrollVoucherDate = voucherDate;
          // P2-11：借方科目不再写死。工资归集到哪个科目是业务决策（生产成本/管理费用/
          // 主营业务成本都可能），6401 又是一级末级科目、走不了下钻配置，因此按场景取。
          const payrollExpenseAccount =
            await this.voucherHookService.resolveSceneAccount(
              'payroll_accrual',
              '6401'
            );
          // B-3：未配置时必须留痕。静默回落 6401 会让“工资全进了主营业务成本”
          // 这件事在报表上完全看不出来（成本虚高、管理费用为零）。
          if (!payrollExpenseAccount) {
            this.logger.warn(
              `工资归集科目未配置（场景 payroll_accrual），工资单 ${payroll.code} 已回落 6401 主营业务成本；` +
                `如实际应为生产成本/管理费用，请配置科目场景映射后重新审批`
            );
          }
          payrollVoucherLines = payrollAccrualLines({
            gross,
            expenseAccountCode: payrollExpenseAccount?.code ?? '6401',
            individualIncomeTax: taxWithheld,
            socialInsurance: Number(payroll.socialInsurance ?? 0),
            housingFund: Number(payroll.housingFund ?? 0),
            otherDeduction: otherWithheld,
          });
          await this.voucherHookService.generateVoucherDraft({
            sourceType: 'payroll',
            sourceRef: `payroll:${payroll.code}`,
            voucherDate,
            summary: `工资单审批 ${payroll.code}`,
            lines: payrollVoucherLines,
          });
        } else {
          this.logger.warn(
            `工资单 ${payroll.code} 应发 ${gross} / 实发 ${netAmount} 非正数或异常，跳过凭证生成`
          );
        }
      } catch (error) {
        // 修复 P1-7：凭证失败要登记补偿队列，否则总账永久缺凭证
        this.logger.error(
          `工资凭证草稿生成失败：payroll:${payroll.code}`,
          error instanceof Error ? error.stack : String(error)
        );
        try {
          await this.voucherHookService.recordCompensation(
            'payroll',
            `payroll:${payroll.code}`,
            '工资单审批凭证生成失败',
            payrollVoucherLines,
            payrollVoucherDate
          );
        } catch (compError) {
          this.logger.error(
            `工资凭证补偿登记失败：payroll:${payroll.code}`,
            compError instanceof Error ? compError.stack : String(compError)
          );
        }
      }
    }
    return this.getPayrollItem(id);
  }

  /**
   * 审批通过：按当月已确认工时找项目，始终红冲该员工预提；
   * 仅净工资 > 0 时生成正向分摊（erp_cost_allocation）与 6401/2211 凭证。
   */
  private async approvePayroll(
    payroll: typeof hrPayroll.$inferSelect
  ): Promise<void> {
    const net: number = Number(payroll.netSalary ?? 0);
    const employeeId = payroll.employeeId;
    // T13：净额 <= 0 时仍须收集项目以便红冲预提；正向分摊在循环内按 net>0 跳过
    const allocated: AllocationItem[] =
      await this.collectAllocationItems(payroll);
    const period = payroll.period ?? '';
    const accruedProjectRows =
      employeeId && period.length >= 7
        ? await this.db
            .selectDistinct({ projectId: erpProjectCost.projectId })
            .from(erpProjectCost)
            .innerJoin(
              erpTimesheet,
              sql`${erpProjectCost.sourceRef} = ${sql.raw("'timesheet:'")} || ${erpTimesheet.code}`
            )
            .where(
              and(
                eq(erpProjectCost.period, period),
                eq(erpProjectCost.isAccrual, 1),
                like(erpProjectCost.sourceRef, 'timesheet:%'),
                eq(erpTimesheet.employeeId, employeeId)
              )
            )
        : [];
    const amountByProject = new Map(
      allocated.map((item) => [item.projectId, item.amount])
    );
    for (const row of accruedProjectRows) {
      if (row.projectId && !amountByProject.has(row.projectId)) {
        amountByProject.set(row.projectId, 0);
      }
    }
    const items: AllocationItem[] = [...amountByProject.entries()].map(
      ([projectId, amount]) => ({ projectId, amount })
    );
    const reverseVouchers: { projectId: string; amount: number }[] = [];
    await this.db.transaction(async (tx) => {
      if (items.length > 0) {
        for (const item of items) {
          const reverseRef = `accrual-reverse:${payroll.code}:${item.projectId}`;
          const existingReverse = await tx
            .select({ id: erpProjectCost.id })
            .from(erpProjectCost)
            .where(eq(erpProjectCost.sourceRef, reverseRef))
            .limit(1);
          if (existingReverse.length === 0) {
            // 修复 F-02-A：预提必须按【员工】红冲。
            // erp_project_cost 没有 employeeId 列，用 sourceRef（'timesheet:<工时单号>'）
            // 回连工时表来限定本人；否则审批 A 的工资单会把整个项目当期所有人的
            // 预提一次性冲掉，且 B、C 的工资单仍能重复命中同一批预提行。
            const accruedRows = await tx
              .select({
                id: erpProjectCost.id,
                amount: erpProjectCost.amount,
              })
              .from(erpProjectCost)
              .innerJoin(
                erpTimesheet,
                sql`${erpProjectCost.sourceRef} = ${sql.raw("'timesheet:'")} || ${erpTimesheet.code}`
              )
              .where(
                and(
                  eq(erpProjectCost.projectId, item.projectId),
                  eq(erpProjectCost.period, period),
                  eq(erpProjectCost.isAccrual, 1),
                  like(erpProjectCost.sourceRef, 'timesheet:%'),
                  employeeId
                    ? eq(erpTimesheet.employeeId, employeeId)
                    : sql`false`
                )
              );
            const accrued = accruedRows.reduce(
              (sum, row) => sum + Number(row.amount ?? 0),
              0
            );
            if (accrued > 0) {
              const reverseCode = await generateBizCode(
                tx as unknown as PostgresJsDatabase,
                erpProjectCost,
                erpProjectCost.code,
                'CST'
              );
              await tx.insert(erpProjectCost).values({
                code: reverseCode,
                projectId: item.projectId,
                costType: 'labor',
                amount: String(-accrued),
                period,
                occurredDate: todayInShanghai(),
                sourceRef: reverseRef,
                isAccrual: 0,
                offsetOf: accruedRows[0]?.id ?? null,
                remark: `红冲工时预提 ${payroll.code}`,
              });
              // 修复 F-02-A：把已冲减的预提行标记为 2（已红冲），
              // 否则 is_accrual 恒为 1，下次红冲仍会命中同一批行 → 重复冲减。
              if (accruedRows.length > 0) {
                await tx
                  .update(erpProjectCost)
                  .set({ isAccrual: 2, updatedAt: new Date() })
                  .where(
                    inArray(
                      erpProjectCost.id,
                      accruedRows.map((row) => row.id)
                    )
                  );
              }
              reverseVouchers.push({
                projectId: item.projectId,
                amount: accrued,
              });
            }
          }

          // 净额非正：跳过正向分摊与项目实际成本（仍已做预提红冲）
          if (!(net > 0 && item.amount > 0)) {
            continue;
          }

          const allocCode = await generateBizCode(
            tx as unknown as PostgresJsDatabase,
            erpCostAllocation,
            erpCostAllocation.code,
            'CAL'
          );
          const sourceRef = `payroll:${payroll.code}:${item.projectId}`;
          await tx.insert(erpCostAllocation).values({
            code: allocCode,
            sourceDesc: `工资单 ${payroll.code} 分摊`,
            costType: 'labor',
            amount: String(item.amount),
            targetProjectId: item.projectId,
            period,
            sourceRef,
          });
          const costCode = await generateBizCode(
            tx as unknown as PostgresJsDatabase,
            erpProjectCost,
            erpProjectCost.code,
            'CST'
          );
          await tx.insert(erpProjectCost).values({
            code: costCode,
            projectId: item.projectId,
            costType: 'labor',
            amount: String(item.amount),
            period,
            occurredDate: todayInShanghai(),
            sourceRef,
            isAccrual: 0,
            remark: `工资分摊（实际） ${payroll.code}`,
          });
        }
      }
      // 修复 P1-6：加 CAS，防止并发审批产生两份红冲/分摊。
      // （allocationGenerated 属「先读后写」，两个并发请求可同时通过 payrollAction 的检查）
      const approved = await tx
        .update(hrPayroll)
        .set({
          status: 'approved',
          allocationGenerated: items.length > 0,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(hrPayroll.id, payroll.id),
            eq(hrPayroll.status, 'submitted')
          )
        )
        .returning({ id: hrPayroll.id });
      if (approved.length === 0) {
        throw new BadRequestException('该工资单已被审批，请勿重复操作');
      }
    });
    for (const reverse of reverseVouchers) {
      await this.voucherHookService.generateVoucherDraft({
        sourceType: 'payroll',
        sourceRef: `accrual-reverse:${payroll.code}:${reverse.projectId}`,
        voucherDate: todayInShanghai(),
        summary: `红冲工时预提 ${payroll.code}`,
        lines: [
          { accountCode: '2202', debit: reverse.amount },
          { accountCode: '6401', credit: reverse.amount },
        ],
      });
    }
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
    /*
     * 分摊逻辑已抽到 `./payroll-allocation`（纯函数 + 15 条断言），
     * 那里钉住了三条"界面上看不出来"的错法：
     *   ① 忘找平 → Σ分摊额 ≠ 净额（每行都看起来对，差几分）；
     *   ② 找平用非对称取整 → `-x.xx5` 上差 1 分，找平不再精确；
     *   ③ **红冲不对称** → 原分摊 + 红冲分摊 ≠ 0，账上留残值而借贷仍平。
     * 本方法只负责查工时聚合（SQL），算术全部在纯函数里。
     */
    return allocateByHours(Number(payroll.netSalary ?? 0), rows);
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
