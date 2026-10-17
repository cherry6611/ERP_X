import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  finReportTemplate,
  mdTaxEntity,
  sysBrandConfig,
} from '@server/database/schema';
import { toRmbUpperResult } from '@server/common/utils/rmb-upper';
import {
  evaluateFormula,
  parseFormula,
  type FormulaContext,
  type ParsedFormula,
} from './report-formula';
import { fiscalYearStart, LedgersService, previousPeriod } from './ledgers.service';
import { buildReportCheck } from './report-check';
import { round2 } from '@server/common/utils/number';
import type {
  AccountDirection,
  BalanceSheetResult,
  CashFlowResult,
  IncomeStatementResult,
  PrintHeader,
  PrintSignatureSlot,
  ReportCheck,
  ReportPrintPack,
  ReportRow,
  ReportRowDetail,
  ReportSheet,
} from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

interface TemplateRow {
  rowNo: string;
  rowName: string;
  formula: string;
  section: string;
  indent: number;
  bold: boolean;
  sortNo: number;
}

type Rolled = Awaited<ReturnType<LedgersService['rolledBalances']>>;


@Injectable()
export class ReportsService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly ledgers: LedgersService,
  ) {}

  private assertPeriod(period: string): void {
    if (!PERIOD_PATTERN.test(period)) {
      throw new BadRequestException('期间格式必须为 YYYY-MM');
    }
  }

  private async taxEntityName(taxEntityId?: string): Promise<string | null> {
    if (!taxEntityId) return null;
    const rows = await this.db
      .select({ name: mdTaxEntity.name })
      .from(mdTaxEntity)
      .where(eq(mdTaxEntity.id, taxEntityId))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  private async loadTemplate(reportCode: string): Promise<TemplateRow[]> {
    const rows = await this.db
      .select({
        rowNo: finReportTemplate.rowNo,
        rowName: finReportTemplate.rowName,
        formula: finReportTemplate.formula,
        section: finReportTemplate.section,
        indent: finReportTemplate.indent,
        bold: finReportTemplate.bold,
        sortNo: finReportTemplate.sortNo,
      })
      .from(finReportTemplate)
      .where(
        and(
          eq(finReportTemplate.reportCode, reportCode),
          eq(finReportTemplate.enabled, 1)
        )
      )
      .orderBy(asc(finReportTemplate.sortNo), asc(finReportTemplate.rowNo));
    return rows.map((row) => ({
      rowNo: row.rowNo,
      rowName: row.rowName,
      formula: row.formula,
      section: row.section,
      indent: Number(row.indent ?? 0),
      bold: Number(row.bold ?? 0) === 1,
      sortNo: Number(row.sortNo ?? 0),
    }));
  }

  /** 把 rolled 余额表转换为公式求值上下文 */
  private buildContext(rolled: Rolled): FormulaContext {
    const accountValues: FormulaContext['accountValues'] = new Map();
    for (const [code, values] of rolled) {
      accountValues.set(code, {
        openingDebit: values.openingDebit,
        openingCredit: values.openingCredit,
        debitOccur: values.debitOccur,
        creditOccur: values.creditOccur,
        closingDebit: values.closingDebit,
        closingCredit: values.closingCredit,
      });
    }
    return {
      accountValues,
      rowValues: new Map(),
      prevRowValues: new Map(),
    };
  }

  /**
   * 按模板逐行求值。行次求值顺序按 sortNo，模板中只引用"更靠前"的行次，
   * 因此单趟顺序求值即可；若发现悬空引用（引用了不存在或更后的行），抛出 400 便于发现模板错误。
   */
  private evaluateRows(
    template: TemplateRow[],
    accountValues: FormulaContext['accountValues'],
    prevRowValues: Map<string, number>,
    plNet?: number
  ): { rows: ReportRow[]; rowValues: Map<string, number> } {
    const ctx: FormulaContext = {
      accountValues,
      rowValues: new Map(),
      prevRowValues,
      plNet,
    };
    const rows: ReportRow[] = [];
    for (const row of template) {
      const parsed: ParsedFormula = parseFormula(row.formula);
      for (const ref of parsed.rowRefs) {
        const isPrev = parsed.nodes.some(
          (node) =>
            node.type === 'row' && node.ref.kind === 'prev' && node.ref.rowNo === ref
        );
        const known = isPrev
          ? prevRowValues.has(ref)
          : ctx.rowValues.has(ref);
        if (!known && !template.some((item) => item.rowNo === ref)) {
          throw new BadRequestException(
            `报表模板行 ${row.rowNo} 引用了不存在的行次 ${ref}`
          );
        }
      }
      const amount = evaluateFormula(parsed, ctx);
      ctx.rowValues.set(row.rowNo, amount);
      rows.push({
        rowNo: row.rowNo,
        rowName: row.rowName,
        formula: row.formula,
        indent: row.indent,
        bold: row.bold,
        amount,
        ytdAmount: amount,
        previousAmount: 0,
        details: this.buildDetails(parsed, accountValues, 'period'),
      });
    }
    return { rows, rowValues: ctx.rowValues };
  }

  /** 展开公式中的科目引用为明细，供前端下钻 */
  private buildDetails(
    parsed: ParsedFormula,
    accountValues: FormulaContext['accountValues'],
    mode: 'period' | 'opening' | 'ytd',
    ytdValues?: FormulaContext['accountValues']
  ): ReportRowDetail[] {
    const details: ReportRowDetail[] = [];
    const seen = new Set<string>();
    const visit = (nodes: ParsedFormula['nodes']): void => {
      for (const node of nodes) {
        if (node.type === 'group' || node.type === 'abs') {
          visit(node.type === 'group' ? node.nodes : [node.node]);
          continue;
        }
        if (node.type !== 'account') continue;
        const code = node.ref.code;
        if (seen.has(code)) continue;
        seen.add(code);
        const source =
          mode === 'ytd' && ytdValues ? ytdValues : accountValues;
        const values = source.get(code);
        const name =
          (values as { name?: string } | undefined)?.name ??
          (accountValues.get(code) as { name?: string } | undefined)?.name ??
          '';
        details.push({
          accountCode: code,
          accountName: name,
          amount: this.accountAmount(node.ref.kind, node.ref.direction, values),
        });
      }
    };
    visit(parsed.nodes);
    return details;
  }

  private accountAmount(
    kind: 'balance' | 'occurrence' | 'opening' | 'change',
    direction: string,
    values:
      | {
          openingDebit: number;
          openingCredit: number;
          debitOccur: number;
          creditOccur: number;
          closingDebit: number;
          closingCredit: number;
        }
      | undefined
  ): number {
    if (!values) return 0;
    if (kind === 'change') {
      return round2(
        values.closingDebit -
          values.closingCredit -
          (values.openingDebit - values.openingCredit)
      );
    }
    const debit =
      kind === 'occurrence'
        ? values.debitOccur
        : kind === 'opening'
          ? values.openingDebit
          : values.closingDebit;
    const credit =
      kind === 'occurrence'
        ? values.creditOccur
        : kind === 'opening'
          ? values.openingCredit
          : values.closingCredit;
    if (direction === '借' || direction === 'debit') {
      return Math.max(round2(debit - credit), 0);
    }
    if (direction === '贷' || direction === 'credit') {
      return Math.max(round2(credit - debit), 0);
    }
    return round2(debit - credit);
  }

  private findRow(rows: ReportRow[], rowNo: string): number {
    return rows.find((row) => row.rowNo === rowNo)?.amount ?? 0;
  }

  /**
   * 本会计年度至当前期间损益类科目净额合计（净利 = 收入 − 费用）。
   *
   * 为什么需要它：年终结转前 4103（本年利润）为空，资产负债表「未分配利润」
   * 只取已结转数据就会漏掉本期利润，导致月度中途恒等式必然不通过。
   * 年终结转后损益科目已被清零、4103 已承接本期利润，本值自然为 0，不会重复计算。
   *
   * 取数口径：rolledBalances 的期末净额为「建账至本期末」的累计数；损益类科目
   * 年终结转即清零，因此累计数即本年累计。对每个损益类科目取【直接发生额】
   * （自身净额 − 其损益类下级的净额）后跨科目求和：既能纳入末级科目，也能纳入
   * 历史数据中直接记在非末级（汇总）科目上的发生额（如费用记在 6602 而非 660201），
   * 且不会因父级已包含下级而重复计入。
   */
  private ytdProfitLossNet(rolled: Rolled): number {
    let expenseMinusRevenue = 0;
    for (const [code, values] of rolled) {
      if (!ReportsService.isProfitLoss(values.accountType)) continue;
      let direct = values.closingDebit - values.closingCredit;
      for (const child of values.children) {
        const childValues = rolled.get(child);
        if (childValues && ReportsService.isProfitLoss(childValues.accountType)) {
          direct -= childValues.closingDebit - childValues.closingCredit;
        }
      }
      expenseMinusRevenue += round2(direct);
    }
    return round2(-expenseMinusRevenue);
  }

  /* ========== A-01 资产负债表 ========== */

  async balanceSheet(params: {
    period: string;
    taxEntityId?: string;
    includeDraft?: boolean;
  }): Promise<BalanceSheetResult> {
    this.assertPeriod(params.period);
    const template = await this.loadTemplate('balance_sheet');
    if (template.length === 0) {
      throw new NotFoundException('资产负债表模板未初始化，请执行迁移 2026-10-15-upgrade-batch1-report-templates.sql');
    }
    const [rolled, openingRolled, entityName] = await Promise.all([
      this.ledgers.rolledBalances(params.period, {
        taxEntityId: params.taxEntityId,
        includeDraft: params.includeDraft,
      }),
      this.ledgers.rolledBalances(previousPeriod(params.period), {
        taxEntityId: params.taxEntityId,
        includeDraft: params.includeDraft,
      }),
      this.taxEntityName(params.taxEntityId),
    ]);
    const currentValues = this.buildContext(rolled).accountValues;

    // 本年损益净额（资产负债表权益区用）：本会计年度至当前期间损益类科目净额合计。
    // 年终结转前 4103（本年利润）为空，未结转损益必须纳入"未分配利润"才能使恒等式通过。
    const ytdProfitLossNet = this.ytdProfitLossNet(rolled);

    // 年初（上一年 12 月）余额，用于"年初余额"列
    const priorYear = `${Number(params.period.slice(0, 4)) - 1}-12`;
    const yearOpeningRolled = params.period.endsWith('-01')
      ? openingRolled
      : await this.ledgers.rolledBalances(priorYear, {
          taxEntityId: params.taxEntityId,
          includeDraft: params.includeDraft,
        });
    const yearOpeningValues = this.buildContext(yearOpeningRolled).accountValues;

    const { rows } = this.evaluateRows(template, currentValues, new Map(), ytdProfitLossNet);
    // 期末列 = amount；年初列 = 上一会计年度 12 月 31 日余额。
    // 年初列不再加回本期利润：上一会计年度已年终结转，损益科目清零、4103 已承接，
    // 若在此再叠加本期 pLNet 会把本期利润误计入年初列。
    const openingRows = this.evaluateRows(template, yearOpeningValues, new Map(), 0);
    const previous = new Map(openingRows.rows.map((row) => [row.rowNo, row.amount]));
    for (const row of rows) {
      row.previousAmount = previous.get(row.rowNo) ?? 0;
      row.ytdAmount = row.amount;
    }
    const assetsTotal = this.findRow(rows, '10');
    const liabilitiesTotal = this.findRow(rows, '17');
    const equityTotal = this.findRow(rows, '21');
    /*
     * §5.9：自查项改由 `./report-check` 的 `buildReportCheck` 构造 ——
     * `passed` 由 `difference` **推导**，不再各处各写一遍
     * `round2(a) === round2(b)`，于是不可能出现"差异 0 却判不通过"
     * （或更糟的"差异非零却判通过"）。
     * 注意两项刻意比较**不同的行**：`equation` 比 行22（模板合计），
     * `subtotal` 比 17+21 之和 —— 这样"合计算错"与"分项相加错"能分别暴露。
     */
    const row22 = this.findRow(rows, '22');
    const checks: ReportCheck[] = [
      buildReportCheck({
        code: 'balance_sheet_equation',
        label: '资产总计 = 负债和所有者权益总计',
        left: assetsTotal,
        right: row22,
      }),
      buildReportCheck({
        code: 'balance_sheet_subtotal',
        label: '负债和所有者权益总计 = 负债合计 + 所有者权益合计',
        left: row22,
        right: liabilitiesTotal + equityTotal,
      }),
    ];

    return {
      reportCode: 'balance_sheet',
      reportName: '资产负债表',
      period: params.period,
      taxEntityId: params.taxEntityId ?? null,
      taxEntityName: entityName,
      rows,
      checks,
      balanced: checks.every((check) => check.passed),
      generatedAt: new Date().toISOString(),
      assetsTotal,
      liabilitiesTotal,
      equityTotal,
    };
  }

  /* ========== A-02 利润表 ========== */

  async incomeStatement(params: {
    period: string;
    taxEntityId?: string;
    includeDraft?: boolean;
  }): Promise<IncomeStatementResult> {
    this.assertPeriod(params.period);
    const template = await this.loadTemplate('income_statement');
    if (template.length === 0) {
      throw new NotFoundException('利润表模板未初始化，请执行迁移 2026-10-15-upgrade-batch1-report-templates.sql');
    }
    const [currentRolled, prevRolled, entityName] = await Promise.all([
      this.ledgers.rolledBalances(params.period, {
        taxEntityId: params.taxEntityId,
        includeDraft: params.includeDraft,
      }),
      this.ledgers.rolledBalances(previousPeriod(params.period), {
        taxEntityId: params.taxEntityId,
        includeDraft: params.includeDraft,
      }),
      this.taxEntityName(params.taxEntityId),
    ]);
    const currentValues = this.buildContext(currentRolled).accountValues;
    const prevValues = this.buildContext(prevRolled).accountValues;

    const { rows } = this.evaluateRows(template, currentValues, new Map());
    const prevRows = this.evaluateRows(template, prevValues, new Map());
    const prevMap = new Map(prevRows.rows.map((row) => [row.rowNo, row.amount]));

    // 本年累计列：1 月至本期
    const ytdValues = await this.ytdAccountValues(
      fiscalYearStart(params.period),
      params.period,
      params.taxEntityId,
      params.includeDraft
    );
    const ytdRows = this.evaluateRows(template, ytdValues, new Map());
    const ytdMap = new Map(ytdRows.rows.map((row) => [row.rowNo, row.amount]));

    for (const row of rows) {
      row.previousAmount = prevMap.get(row.rowNo) ?? 0;
      row.ytdAmount = ytdMap.get(row.rowNo) ?? 0;
      row.details = this.buildDetails(parseFormula(row.formula), currentValues, 'period');
    }

    const revenueTotal = this.findRow(rows, '1');
    const costTotal = round2(
      this.findRow(rows, '2') +
        this.findRow(rows, '3') +
        this.findRow(rows, '4') +
        this.findRow(rows, '5') +
        this.findRow(rows, '6') +
        this.findRow(rows, '7')
    );
    const operatingProfit = this.findRow(rows, '8');
    const netProfit = this.findRow(rows, '12');

    // 校验①：净利润 = 利润总额 − 所得税费用
    // 校验②：净利润（本期）与本年利润科目发生额一致
    const yearProfitOccur = await this.profitAccountNet(
      params.period,
      params.taxEntityId,
      params.includeDraft
    );
    const checks: ReportCheck[] = [
      buildReportCheck({
        code: 'income_statement_net_profit',
        label: '净利润 = 利润总额 − 所得税费用',
        left: netProfit,
        right: this.findRow(rows, '10') - this.findRow(rows, '11'),
      }),
      buildReportCheck({
        code: 'income_statement_business_profit',
        label: '营业利润 = 营业收入 − 营业成本及费用',
        left: operatingProfit,
        right: revenueTotal - costTotal,
      }),
    ];

    // P2-3：把原先「算了但被 void 掉」的年终结转一致性校验真正落地。
    // 4103（本年利润）平时不动，只在年终结转时被写入；因此仅在 4103 本期有发生额
    // （说明本期做过结转）时才校验：-4103 本期发生额 == 本年累计净利润（第 12 行本年累计列）。
    // 结转只结转部分期间的情况会被如实标红，提示结转不完整。
    const netProfitYtd =
      rows.find((row) => row.rowNo === '12')?.ytdAmount ?? netProfit;
    if (round2(yearProfitOccur) !== 0) {
      checks.push(
        buildReportCheck({
          code: 'income_statement_year_profit',
          label: '本年利润（4103）本期发生额 = 本年累计净利润（年终结转一致性）',
          left: -yearProfitOccur,
          right: netProfitYtd,
        }),
      );
    }

    return {
      reportCode: 'income_statement',
      reportName: '利润表',
      period: params.period,
      taxEntityId: params.taxEntityId ?? null,
      taxEntityName: entityName,
      rows,
      checks,
      balanced: checks.every((check) => check.passed),
      generatedAt: new Date().toISOString(),
      revenueTotal,
      costTotal,
      operatingProfit,
      netProfit,
    };
  }

  /**
   * 1 月至 to 期间的累计科目余额/发生额（用于利润表本年累计列）。
   *
   * 注意：必须用**区间口径**一次取数 —— `rawBalances(period)` 的 `debitOccur` 是
   * **单期发生额**（`ledgers.service.ts` 中 `from = to = period`），把两次单期发生额
   * 相减得到的是「本期发生额 − 上期发生额」而非累计发生额。此处传 `from=年初前一期`
   * 让 rawBalances 直接给出「期初(年初前) / 发生额(年初..期末) / 期末(累计)」。
   */
  private async ytdAccountValues(
    from: string,
    to: string,
    taxEntityId?: string,
    includeDraft?: boolean
  ): Promise<FormulaContext['accountValues']> {
    const rolled = await this.ledgers.rolledBalances(to, {
      taxEntityId,
      includeDraft,
      from: previousPeriod(from),
      to,
    });
    const result: FormulaContext['accountValues'] = new Map();
    for (const [code, values] of rolled) {
      result.set(code, {
        openingDebit: values.openingDebit,
        openingCredit: values.openingCredit,
        debitOccur: values.debitOccur,
        creditOccur: values.creditOccur,
        closingDebit: values.closingDebit,
        closingCredit: values.closingCredit,
        name: values.name,
      });
    }
    return result;
  }

  private async profitAccountNet(
    period: string,
    taxEntityId?: string,
    includeDraft?: boolean
  ): Promise<number> {
    const rolled = await this.ledgers.rolledBalances(period, {
      taxEntityId,
      includeDraft,
    });
    const values = rolled.get('4103');
    if (!values) return 0;
    return round2(
      values.closingDebit - values.closingCredit - (values.openingDebit - values.openingCredit)
    );
  }

  /* ========== A-02 现金流量表（间接法） ========== */

  async cashFlow(params: {
    period: string;
    taxEntityId?: string;
    includeDraft?: boolean;
  }): Promise<CashFlowResult> {
    this.assertPeriod(params.period);
    const template = await this.loadTemplate('cash_flow');
    if (template.length === 0) {
      throw new NotFoundException('现金流量表模板未初始化，请执行迁移 2026-10-15-upgrade-batch1-report-templates.sql');
    }
    const [currentRolled, entityName] = await Promise.all([
      this.ledgers.rolledBalances(params.period, {
        taxEntityId: params.taxEntityId,
        includeDraft: params.includeDraft,
      }),
      this.taxEntityName(params.taxEntityId),
    ]);
    const currentValues = this.buildContext(currentRolled).accountValues;
    const { rows } = this.evaluateRows(template, currentValues, new Map());

    const ytdValues = await this.ytdAccountValues(
      fiscalYearStart(params.period),
      params.period,
      params.taxEntityId,
      params.includeDraft
    );
    const ytdFinal = this.evaluateRows(template, ytdValues, new Map());
    const ytdFinalMap = new Map(ytdFinal.rows.map((row) => [row.rowNo, row.amount]));
    for (const row of rows) {
      row.ytdAmount = ytdFinalMap.get(row.rowNo) ?? row.amount;
      row.previousAmount = 0;
      row.details = this.buildDetails(parseFormula(row.formula), currentValues, 'period');
    }

    const operatingNet = this.findRow(rows, '07');
    const investingNet = this.findRow(rows, '09');
    const financingNet = this.findRow(rows, '11');
    const netIncrease = this.findRow(rows, '12');
    const openingCash = this.findRow(rows, '13');
    const closingCash = this.findRow(rows, '14');
    const cashDifference = round2(openingCash + netIncrease - closingCash);
    /* 资产负债表侧的货币资金期末余额：只取一次，避免 left/right/difference 三处各调一次 */
    const balanceSheetMoneyFunds = this.moneyFunds(currentRolled, 'closing');

    const checks: ReportCheck[] = [
      /*
       * 这一项**特意不用** `buildReportCheck`：它的 `left` 本身就是
       * `round2(期初 + 净增加)`，`passed` 直接看那个已取整的差额是否为零 ——
       * 语义比"两侧各自取整再比"更直接，且是原有行为，不顺手改。
       * （两者在正常数据上等价；差异只可能出现在"取整后恰好跨分"的极端情形。）
       */
      {
        code: 'cash_flow_reconcile',
        label: '期初现金 + 现金净增加额 = 期末现金',
        left: round2(openingCash + netIncrease),
        right: closingCash,
        difference: cashDifference,
        passed: cashDifference === 0,
      },
      buildReportCheck({
        code: 'cash_flow_balance_sheet',
        label: '期末现金 = 资产负债表货币资金期末余额',
        left: closingCash,
        right: balanceSheetMoneyFunds,
      }),
    ];

    return {
      reportCode: 'cash_flow',
      reportName: '现金流量表（间接法）',
      period: params.period,
      taxEntityId: params.taxEntityId ?? null,
      taxEntityName: entityName,
      rows,
      checks,
      balanced: checks.every((check) => check.passed),
      generatedAt: new Date().toISOString(),
      operatingNet,
      investingNet,
      financingNet,
      netIncrease,
      openingCash,
      closingCash,
      cashDifference,
    };
  }

  private moneyFunds(rolled: Rolled, mode: 'closing' | 'opening'): number {
    let total = 0;
    for (const code of ['1001', '1002']) {
      const values = rolled.get(code);
      if (!values) continue;
      total +=
        mode === 'closing'
          ? values.closingDebit - values.closingCredit
          : values.openingDebit - values.openingCredit;
    }
    return round2(total);
  }

  /** 通用报表查询入口（供 Controller 按 reportCode 路由） */
  async getReport(
    reportCode: 'balance_sheet' | 'income_statement' | 'cash_flow',
    params: { period: string; taxEntityId?: string; includeDraft?: boolean }
  ): Promise<ReportSheet> {
    switch (reportCode) {
      case 'balance_sheet':
        return this.balanceSheet(params);
      case 'income_statement':
        return this.incomeStatement(params);
      case 'cash_flow':
        return this.cashFlow(params);
      default:
        throw new BadRequestException(`不支持的报表编码：${reportCode}`);
    }
  }

  /* ========== A-12 / C-06：打印与套打的后端支撑 ========== */

  /**
   * A-12 打印数据包。
   *
   * 需求书 §2.1 A-12 建议打印走**纯前端**（react-to-print + @media print），
   * 因此后端不渲染 PDF，只负责把"前端排版需要的全部数据"一次给全：
   *   - 抬头/Logo 取自 `sys_brand_config`（与 settings.service.ts 的 getBrand 同源规则）；
   *   - 金额大写（验收标准③）用 `server/common/utils/rmb-upper.ts`；
   *   - 签章栏（制单/审核/记账/会计主管）按《会计基础工作规范》的基本要素给出槽位；
   *   - 行明细去掉下钻 details，避免整页排版时字段过重。
   */
  async printPack(
    reportCode: 'balance_sheet' | 'income_statement' | 'cash_flow',
    params: {
      period: string;
      taxEntityId?: string;
      operator?: string | null;
      includeDraft?: boolean;
    }
  ): Promise<ReportPrintPack> {
    const sheet: ReportSheet = await this.getReport(reportCode, params);
    const header: PrintHeader = await this.printHeader(sheet.reportName, sheet.period);

    const total = this.printTotal(reportCode, sheet);
    const signatures: PrintSignatureSlot[] = [
      { slot: 'prepared', label: '制单', signer: params.operator ?? null },
      { slot: 'reviewed', label: '审核', signer: null },
      { slot: 'posted', label: '记账', signer: null },
      { slot: 'chief_accountant', label: '会计主管', signer: null },
    ];
    const footerNote = [
      `打印时间：${new Date().toISOString()}`,
      params.operator ? `操作人：${params.operator}` : '操作人：未记录',
      '本表按企业会计准则口径由系统自动生成，打印件需经签章后方可作为会计档案。',
    ].join('　|　');

    return {
      reportCode,
      reportName: sheet.reportName,
      period: sheet.period,
      taxEntityId: sheet.taxEntityId,
      taxEntityName: sheet.taxEntityName,
      header,
      rows: sheet.rows.map((row) => ({
        rowNo: row.rowNo,
        rowName: row.rowName,
        indent: row.indent,
        bold: row.bold,
        amount: row.amount,
        ytdAmount: row.ytdAmount,
        previousAmount: row.previousAmount,
      })),
      checks: sheet.checks,
      balanced: sheet.balanced,
      totalLabel: total.label,
      totalAmount: total.amount,
      totalInWords: toRmbUpperResult(total.amount),
      signatures,
      footerNote,
      clientPrint: true,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 报表打印的"合计/净额"口径（**需财务确认**）：
   *   资产负债表 → 资产总计（`assetsTotal`）
   *   利润表     → 净利润（`netProfit`）
   *   现金流量表 → 现金净增加额（`netIncrease`）
   * 之所以只用这三个数做大写，是因为打印件只需要一个"金额大写"栏位；
   * 若财务要求"负债和所有者权益总计"也印大写，需要扩成数组而不是单值。
   */
  private printTotal(
    reportCode: 'balance_sheet' | 'income_statement' | 'cash_flow',
    sheet: ReportSheet
  ): { label: string; amount: number } {
    if (reportCode === 'balance_sheet') {
      return {
        label: '资产总计',
        amount: Number((sheet as BalanceSheetResult).assetsTotal ?? 0),
      };
    }
    if (reportCode === 'income_statement') {
      return {
        label: '净利润',
        amount: Number((sheet as IncomeStatementResult).netProfit ?? 0),
      };
    }
    return {
      label: '现金净增加额',
      amount: Number((sheet as CashFlowResult).netIncrease ?? 0),
    };
  }

  /** 抬头与 Logo：与 settings.service.ts 的 getBrand 保持同一套降级规则 */
  private async printHeader(
    reportName: string,
    period: string
  ): Promise<PrintHeader> {
    const rows = await this.db
      .select({
        brandName: sysBrandConfig.brandName,
        logoFileId: sysBrandConfig.logoFileId,
      })
      .from(sysBrandConfig)
      .orderBy(desc(sysBrandConfig.updatedAt))
      .limit(1);
    const brandName = rows[0]?.brandName || '晟笙 ERP';
    const logoFileId = rows[0]?.logoFileId ?? null;
    return {
      brandName,
      logoUrl: logoFileId ? '/api/settings/brand/logo' : null,
      title: reportName,
      subtitle: `会计期间：${period}`,
    };
  }

  /** 报表模板列表（运维/口径评审用） */
  async listTemplates(
    reportCode?: string
  ): Promise<
    Array<{
      reportCode: string;
      rowNo: string;
      rowName: string;
      formula: string;
      section: string;
      indent: number;
      bold: boolean;
      sortNo: number;
    }>
  > {
    const rows = await this.db
      .select({
        reportCode: finReportTemplate.reportCode,
        rowNo: finReportTemplate.rowNo,
        rowName: finReportTemplate.rowName,
        formula: finReportTemplate.formula,
        section: finReportTemplate.section,
        indent: finReportTemplate.indent,
        bold: finReportTemplate.bold,
        sortNo: finReportTemplate.sortNo,
      })
      .from(finReportTemplate)
      .where(
        reportCode ? eq(finReportTemplate.reportCode, reportCode) : undefined
      )
      .orderBy(
        asc(finReportTemplate.reportCode),
        asc(finReportTemplate.sortNo),
        asc(finReportTemplate.rowNo)
      );
    return rows.map((row) => ({
      reportCode: row.reportCode,
      rowNo: row.rowNo,
      rowName: row.rowName,
      formula: row.formula,
      section: row.section,
      indent: Number(row.indent ?? 0),
      bold: Number(row.bold ?? 0) === 1,
      sortNo: Number(row.sortNo ?? 0),
    }));
  }

  /** 科目类型辅助：判断是否损益类（供结转损益与年结复用） */
  static isProfitLoss(accountType: string): boolean {
    return ['income', 'revenue', 'expense', 'cost'].includes(accountType);
  }

  /** 科目方向（供前端展示） */
  static directionOf(accountType: string): AccountDirection {
    return ReportsService.isProfitLoss(accountType) && accountType !== 'expense' && accountType !== 'cost'
      ? 'credit'
      : accountType === 'liability' || accountType === 'equity'
        ? 'credit'
        : 'debit';
  }
}
