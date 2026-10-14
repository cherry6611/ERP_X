/**
 * D-06：税务风险扫描的规则引擎。
 *
 * ## 设计立场
 *
 * 税负率是否"异常"高度依赖行业与纳税主体特性，系统**无法自己判断**
 * 一家数据服务公司的合理增值税税负率是 2% 还是 5%。因此本引擎不做"合规判定"，
 * 只做**偏差检测与线索归纳**：把需要人工复核的点挑出来，标出严重程度，
 * 并给出"为什么会被标出来"的可读依据。最终判断权在税务会计。
 *
 * 因此每条风险项都带：
 *   - `severity`：high / medium / low（按对申报准确性的影响排序）
 *   - `evidence`：触发该判定的具体数字（可复核，而不是"系统觉得有问题"）
 *   - `suggestion`：建议的下一步动作
 *
 * ## 三类扫描（对应需求书 D-06 的三个方向）
 *
 * | 方向 | 具体检查 |
 * |---|---|
 * | 税负率异常 | 本期增值税税负率落在参考区间之外；税负率为负（留抵）；环比波动过大 |
 * | 进销项匹配异常 | A-06 底稿的发票口径与总账口径差异；有销项无进项；进项远大于销项 |
 * | 发票异常 | 票号跳号/重号；作废率过高；已开票未关联应收；跨期开票 |
 *
 * ## 币种与单位
 *
 * 所有金额单位为元，百分数为百分数（`3.5` 表示 3.5%），与全仓一致。
 */

export const TAX_RISK_SEVERITIES = ['high', 'medium', 'low'] as const;
export type TaxRiskSeverity = (typeof TAX_RISK_SEVERITIES)[number];

export const TAX_RISK_SEVERITY_LABELS: Record<TaxRiskSeverity, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

/** 风险类别（对应三个扫描方向） */
export const TAX_RISK_CATEGORIES = [
  'burden_rate',
  'invoice_ledger_mismatch',
  'invoice_anomaly',
] as const;
export type TaxRiskCategory = (typeof TAX_RISK_CATEGORIES)[number];

export const TAX_RISK_CATEGORY_LABELS: Record<TaxRiskCategory, string> = {
  burden_rate: '税负率异常',
  invoice_ledger_mismatch: '进销项匹配异常',
  invoice_anomaly: '发票异常',
};

export interface TaxRiskFinding {
  /** 稳定标识（前端 key、去重、忽略清单都用它） */
  code: string;
  category: TaxRiskCategory;
  severity: TaxRiskSeverity;
  title: string;
  /** 可读依据：必须包含具体数字，便于人工复核 */
  evidence: string;
  /** 建议动作 */
  suggestion: string;
  /** 涉及的金额（无则为 null），用于排序与汇总 */
  amount: number | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNumber(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number.isFinite(value) ? value : 0;
}

/* ==================== ① 税负率异常 ==================== */

/**
 * 参考区间（**需财务/税务确认**）。
 *
 * 默认 1%~6% 覆盖一般纳税人数据服务业常见区间；小规模纳税人应显著更低。
 * 该区间建议做成 `sys_param` 可配置（`tax.burden_rate_min` / `_max`），
 * 由税务会计按自身行业与所在地口径维护，而不是写死在代码里。
 */
export const DEFAULT_BURDEN_RATE_MIN = 1;
export const DEFAULT_BURDEN_RATE_MAX = 6;
/** 环比波动超过该百分点数即提示（默认 3 个百分点） */
export const DEFAULT_BURDEN_RATE_FLUCTUATION = 3;

export interface BurdenRateInput {
  period: string;
  /** 本期不含税收入（增值税计税依据） */
  revenue: number;
  /** 本期销项税额 */
  outputTax: number;
  /** 本期实际抵扣的进项税额 */
  inputTax: number;
  /** 上期税负率（%）；无上期数据传 null */
  previousBurdenRate?: number | null;
  /** 参考区间下限（%） */
  minRate?: number;
  /** 参考区间上限（%） */
  maxRate?: number;
  /** 环比波动阈值（百分点） */
  fluctuationThreshold?: number;
}

export interface BurdenRateResult {
  period: string;
  revenue: number;
  outputTax: number;
  inputTax: number;
  /** 应交增值税 = 销项 − 进项（可为负，表示留抵） */
  payableTax: number;
  /** 增值税税负率（%）= 应交增值税 / 不含税收入 × 100 */
  burdenRate: number;
  minRate: number;
  maxRate: number;
  withinRange: boolean;
  findings: TaxRiskFinding[];
}

/**
 * 计算增值税税负率并给出租样。
 *
 * 边界处理：
 * - 收入为 0 时税负率无意义，返回 0 **且不产出"偏低"告警**
 *   （否则没有收入的月份会天天报风险，把真问题淹没）；
 * - 应交增值税为负（留抵）时税负率为负，单独给一条说明，
 *   因为"负数"与"偏低"是两件事：留抵是正常的，税负率偏低才需要解释。
 */
export function assessBurdenRate(input: BurdenRateInput): BurdenRateResult {
  const revenue = round2(Math.max(toNumber(input.revenue), 0));
  const outputTax = round2(Math.max(toNumber(input.outputTax), 0));
  const inputTax = round2(Math.max(toNumber(input.inputTax), 0));
  const payableTax = round2(outputTax - inputTax);
  const minRate = input.minRate ?? DEFAULT_BURDEN_RATE_MIN;
  const maxRate = input.maxRate ?? DEFAULT_BURDEN_RATE_MAX;
  const fluctuation =
    input.fluctuationThreshold ?? DEFAULT_BURDEN_RATE_FLUCTUATION;
  const burdenRate = revenue > 0 ? round2((payableTax / revenue) * 100) : 0;
  const findings: TaxRiskFinding[] = [];

  if (revenue <= 0) {
    // 无收入期间不做税负率判定（避免噪音），但仍核对是否存在只有进项的情况
    if (inputTax > 0) {
      findings.push({
        code: 'burden.no_revenue_with_input',
        category: 'burden_rate',
        severity: 'low',
        title: '本期无收入但有进项税额',
        evidence: `本期不含税收入 0.00，进项税额 ${inputTax.toFixed(2)}`,
        suggestion:
          '确认这些进项对应的采购是否应在本期抵扣；若属于在建项目或备货，考虑是否需要分期抵扣。',
        amount: inputTax,
      });
    }
    return {
      period: input.period,
      revenue,
      outputTax,
      inputTax,
      payableTax,
      burdenRate: 0,
      minRate,
      maxRate,
      withinRange: true,
      findings,
    };
  }

  if (burdenRate < 0) {
    findings.push({
      code: 'burden.negative',
      category: 'burden_rate',
      severity: 'medium',
      title: '本期形成留抵税额（税负率为负）',
      evidence: `销项 ${outputTax.toFixed(2)} − 进项 ${inputTax.toFixed(2)} = ${payableTax.toFixed(2)}，税负率 ${burdenRate.toFixed(2)}%`,
      suggestion:
        '留抵本身正常，但需确认进项是否集中在少数大额采购；若长期留抵，评估是否符合留抵退税条件。',
      amount: Math.abs(payableTax),
    });
  } else if (burdenRate < minRate) {
    findings.push({
      code: 'burden.below_range',
      category: 'burden_rate',
      severity: 'high',
      title: '增值税税负率低于参考区间',
      evidence: `本期税负率 ${burdenRate.toFixed(2)}%，参考区间 ${minRate}%~${maxRate}%`,
      suggestion:
        '排查是否存在：① 应确认收入未确认（收入跨期）；② 不得抵扣的进项被错误抵扣；③ 适用税率用错。',
      amount: payableTax,
    });
  } else if (burdenRate > maxRate) {
    findings.push({
      code: 'burden.above_range',
      category: 'burden_rate',
      severity: 'medium',
      title: '增值税税负率高于参考区间',
      evidence: `本期税负率 ${burdenRate.toFixed(2)}%，参考区间 ${minRate}%~${maxRate}%`,
      suggestion:
        '排查是否存在：① 应抵扣的进项未取得合规发票；② 进项被误计入成本未抵扣；③ 收入确认提前。',
      amount: payableTax,
    });
  }

  const previous = input.previousBurdenRate;
  if (previous !== null && previous !== undefined && Number.isFinite(previous)) {
    const delta = round2(burdenRate - previous);
    if (Math.abs(delta) > fluctuation) {
      findings.push({
        code: 'burden.fluctuation',
        category: 'burden_rate',
        severity: 'medium',
        title: '税负率环比波动较大',
        evidence: `上期 ${previous.toFixed(2)}% → 本期 ${burdenRate.toFixed(2)}%，变动 ${delta > 0 ? '+' : ''}${delta.toFixed(2)} 个百分点（阈值 ±${fluctuation}）`,
        suggestion:
          '定位波动来源是收入侧还是进项侧；单月波动常见于大额采购或大额开票，确认是否有跨期。',
        amount: null,
      });
    }
  }

  return {
    period: input.period,
    revenue,
    outputTax,
    inputTax,
    payableTax,
    burdenRate,
    minRate,
    maxRate,
    withinRange: burdenRate >= minRate && burdenRate <= maxRate,
    findings,
  };
}

/* ==================== ② 进销项匹配异常 ==================== */

export interface InvoiceLedgerMismatchInput {
  period: string;
  /** 发票口径（A-06 底稿） */
  outputTaxFromInvoices: number;
  inputTaxFromInvoices: number;
  /** 总账口径（凭证 222101/222102） */
  outputTaxFromLedger: number;
  inputTaxFromLedger: number;
  /** A-06 底稿已给出的差异明细 */
  differences: Array<{ code: string; label: string; amount: number }>;
  /** 容差（元）：发票与总账的小额差异不告警 */
  tolerance?: number;
}

/** 默认容差 1 元（分位取整差异不应报风险） */
export const DEFAULT_MISMATCH_TOLERANCE = 1;

/**
 * 发票口径与总账口径比对。
 *
 * 与 A-06 底稿的 `reconciled` 字段的关系：底稿已经算过一遍差异，
 * 本函数**不重复计算**，而是把差异翻译成带严重程度与建议的风险项 ——
 * 底稿回答"差多少"，风险扫描回答"这个差异要紧吗、该去查什么"。
 */
export function assessInvoiceLedgerMismatch(
  input: InvoiceLedgerMismatchInput
): { findings: TaxRiskFinding[]; maxDifference: number } {
  const tolerance = input.tolerance ?? DEFAULT_MISMATCH_TOLERANCE;
  const outputDiff = round2(
    toNumber(input.outputTaxFromInvoices) - toNumber(input.outputTaxFromLedger)
  );
  const inputDiff = round2(
    toNumber(input.inputTaxFromInvoices) - toNumber(input.inputTaxFromLedger)
  );
  const findings: TaxRiskFinding[] = [];

  if (Math.abs(outputDiff) > tolerance) {
    findings.push({
      code: 'mismatch.output_tax',
      category: 'invoice_ledger_mismatch',
      severity: Math.abs(outputDiff) > 10_000 ? 'high' : 'medium',
      title: '销项税额：发票口径与总账口径不一致',
      evidence: `发票 ${toNumber(input.outputTaxFromInvoices).toFixed(2)} vs 总账 ${toNumber(input.outputTaxFromLedger).toFixed(2)}，差异 ${outputDiff.toFixed(2)}`,
      suggestion:
        '核对：① 已开票未做收入确认；② 已确认收入未开票；③ 作废发票是否已红冲总账。申报以发票口径为准，差异需有台账解释。',
      amount: Math.abs(outputDiff),
    });
  }

  if (Math.abs(inputDiff) > tolerance) {
    findings.push({
      code: 'mismatch.input_tax',
      category: 'invoice_ledger_mismatch',
      severity: Math.abs(inputDiff) > 10_000 ? 'high' : 'medium',
      title: '进项税额：发票口径与总账口径不一致',
      evidence: `发票 ${toNumber(input.inputTaxFromInvoices).toFixed(2)} vs 总账 ${toNumber(input.inputTaxFromLedger).toFixed(2)}，差异 ${inputDiff.toFixed(2)}`,
      suggestion:
        '核对：① 取得发票未认证抵扣；② 认证抵扣但发票未入账；③ 不得抵扣项目是否误抵。未认证的进项不得在本期申报。',
      amount: Math.abs(inputDiff),
    });
  }

  // 有销项无进项：常见于纯服务企业，但差额过大值得确认
  const outputTax = toNumber(input.outputTaxFromInvoices);
  const inputTax = toNumber(input.inputTaxFromInvoices);
  if (outputTax > 0 && inputTax === 0) {
    findings.push({
      code: 'mismatch.no_input',
      category: 'invoice_ledger_mismatch',
      severity: 'medium',
      title: '本期有销项税额但无进项税额',
      evidence: `销项 ${outputTax.toFixed(2)}，进项 0.00`,
      suggestion:
        '确认本期是否真的没有可抵扣采购；若有采购未取得发票，属于取得合规票据不及时，会造成多缴税。',
      amount: outputTax,
    });
  } else if (inputTax > outputTax && outputTax > 0 && inputTax > outputTax * 3) {
    findings.push({
      code: 'mismatch.input_far_exceeds_output',
      category: 'invoice_ledger_mismatch',
      severity: 'low',
      title: '进项税额显著大于销项税额',
      evidence: `进项 ${inputTax.toFixed(2)}，销项 ${outputTax.toFixed(2)}，倍数 ${(inputTax / outputTax).toFixed(2)}`,
      suggestion:
        '若属于集中采购期（备货、资本性支出）属正常；否则确认是否存在收入未及时确认。',
      amount: round2(inputTax - outputTax),
    });
  }

  for (const difference of input.differences ?? []) {
    if (Math.abs(toNumber(difference.amount)) <= tolerance) continue;
    findings.push({
      code: `mismatch.detail.${difference.code}`,
      category: 'invoice_ledger_mismatch',
      severity: 'medium',
      title: `底稿差异项：${difference.label}`,
      evidence: `差异金额 ${toNumber(difference.amount).toFixed(2)}`,
      suggestion: '按 A-06 增值税底稿的差异说明逐项核对后再确认申报。',
      amount: Math.abs(toNumber(difference.amount)),
    });
  }

  return {
    findings,
    maxDifference: round2(Math.max(Math.abs(outputDiff), Math.abs(inputDiff))),
  };
}

/* ==================== ③ 发票异常 ==================== */

export interface InvoiceRowForRisk {
  id: string;
  code: string;
  /** 发票号码（真实票号）；为空表示系统编号占位 */
  invoiceNo: string | null;
  direction: string;
  amount: number;
  status: string;
  /** 关联的应收/应付单据 id */
  linkedId: string | null;
  /** 开票日期 YYYY-MM-DD */
  invoiceDate: string | null;
}

export interface InvoiceAnomalyOptions {
  /** 扫描期间 YYYY-MM */
  period: string;
  /** 作废率告警阈值（%），默认 10 */
  voidRateThreshold?: number;
}

export const DEFAULT_VOID_RATE_THRESHOLD = 10;

/** 票号中的数字部分（用于跳号检测） */
function invoiceNoDigits(invoiceNo: string | null): number | null {
  if (!invoiceNo) return null;
  const digits = invoiceNo.replace(/\D/g, '');
  if (digits.length === 0) return null;
  // 只取后 8 位，避免前缀差异导致数值过大
  const tail = digits.slice(-8);
  const parsed = Number(tail);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 发票异常扫描。
 *
 * 检查项与理由：
 * - **重号**：同一票号出现在多张单据上，必然有一张是错的（可能重复入账）；
 *   数据库有 `uq_erp_note_no` 但发票号目前无唯一约束，因此这里检出。
 * - **跳号**：连续的票号中出现空缺，可能是漏登记/漏入账（也可能只是作废后未入账，
 *   因此只给 low，供人工确认）。
 * - **作废率过高**：作废率异常是税务关注点（可能涉及"作废重开"调节申报）。
 * - **已开票未关联单据**：无法追溯回款/付款，核对链条断裂。
 * - **跨期开票**：发票日期不属于扫描期间（提示口径归属）。
 */
export function scanInvoiceAnomalies(
  invoices: InvoiceRowForRisk[],
  options: InvoiceAnomalyOptions
): TaxRiskFinding[] {
  const findings: TaxRiskFinding[] = [];
  const voidRateThreshold =
    options.voidRateThreshold ?? DEFAULT_VOID_RATE_THRESHOLD;

  if (invoices.length === 0) return findings;

  /* --- 重号 --- */
  const byNo = new Map<string, InvoiceRowForRisk[]>();
  for (const invoice of invoices) {
    const no = (invoice.invoiceNo ?? '').trim();
    if (!no) continue;
    const list = byNo.get(no) ?? [];
    list.push(invoice);
    byNo.set(no, list);
  }
  for (const [no, list] of byNo) {
    if (list.length <= 1) continue;
    findings.push({
      code: `anomaly.duplicate_no.${no}`,
      category: 'invoice_anomaly',
      severity: 'high',
      title: `发票号重复：${no}`,
      evidence: `票号 ${no} 出现在 ${list.length} 张单据上（${list.map((i) => i.code).join('、')}），合计金额 ${round2(list.reduce((s, i) => s + toNumber(i.amount), 0)).toFixed(2)}`,
      suggestion:
        '确认是否为重复入账；同一张发票只能抵扣/申报一次，重复会导致重复抵扣。',
      amount: round2(list.reduce((s, i) => s + toNumber(i.amount), 0)),
    });
  }

  /* --- 跳号（按方向分别检测，销项与进项的票号体系不同） --- */
  for (const direction of ['sales', 'purchase']) {
    const digits = invoices
      .filter((i) => i.direction === direction && (i.invoiceNo ?? '').trim())
      .map((i) => ({ invoice: i, value: invoiceNoDigits(i.invoiceNo) }))
      .filter((item): item is { invoice: InvoiceRowForRisk; value: number } =>
        item.value !== null
      )
      .sort((a, b) => a.value - b.value);
    if (digits.length < 3) continue;
    for (let index = 1; index < digits.length; index += 1) {
      const gap = digits[index].value - digits[index - 1].value;
      // 只报 2~1000 的缺口：差 1 是连续，差太大说明票号体系不同（不是跳号）
      if (gap > 1 && gap <= 1000) {
        findings.push({
          code: `anomaly.number_gap.${direction}.${digits[index - 1].invoice.invoiceNo}`,
          category: 'invoice_anomaly',
          severity: 'low',
          title: `发票号存在跳号（${gap - 1} 个空缺）`,
          evidence: `${digits[index - 1].invoice.invoiceNo} → ${digits[index].invoice.invoiceNo}`,
          suggestion:
            '确认缺失票号对应的发票是否作废、退回或尚未入账。作废票不参与申报，但需保留备查。',
          amount: null,
        });
        break; // 每次只报第一处，避免一张表刷出几十条
      }
    }
  }

  /* --- 作废率 --- */
  const voided = invoices.filter((i) => i.status === 'voided');
  const voidRate = round2((voided.length / invoices.length) * 100);
  if (voidRate > voidRateThreshold) {
    findings.push({
      code: 'anomaly.high_void_rate',
      category: 'invoice_anomaly',
      severity: voidRate > voidRateThreshold * 2 ? 'high' : 'medium',
      title: '发票作废率偏高',
      evidence: `作废 ${voided.length} / 共 ${invoices.length} 张，作废率 ${voidRate}%（阈值 ${voidRateThreshold}%）`,
      suggestion:
        '作废率异常是税务关注点。确认作废原因（开票信息错误、退货、重开），并保留作废原因说明备查。',
      amount: round2(voided.reduce((s, i) => s + toNumber(i.amount), 0)),
    });
  }

  /* --- 已开票未关联单据 --- */
  const unlinked = invoices.filter(
    (i) => i.status !== 'voided' && !i.linkedId
  );
  if (unlinked.length > 0) {
    findings.push({
      code: 'anomaly.unlinked',
      category: 'invoice_anomaly',
      severity: unlinked.length > 5 ? 'medium' : 'low',
      title: '已开票但未关联应收/应付单据',
      evidence: `${unlinked.length} 张（${unlinked.slice(0, 5).map((i) => i.invoiceNo ?? i.code).join('、')}${unlinked.length > 5 ? ' 等' : ''}）`,
      suggestion:
        '在发票台账补充关联（`PATCH /api/finance/invoices/:id`），否则无法追溯回款/付款，对账链条断裂。',
      amount: round2(unlinked.reduce((s, i) => s + toNumber(i.amount), 0)),
    });
  }

  /* --- 跨期开票 --- */
  const crossPeriod = invoices.filter((i) => {
    const date = i.invoiceDate;
    return Boolean(date) && date!.slice(0, 7) !== options.period;
  });
  if (crossPeriod.length > 0) {
    findings.push({
      code: 'anomaly.cross_period',
      category: 'invoice_anomaly',
      severity: 'low',
      title: '存在不属于本期间的发票',
      evidence: `${crossPeriod.length} 张发票的开票日期不在 ${options.period}`,
      suggestion:
        '确认这些发票是否被正确归入了对应期间的申报数据；跨期开票需按开票日期所属期申报。',
      amount: round2(crossPeriod.reduce((s, i) => s + toNumber(i.amount), 0)),
    });
  }

  return findings;
}

/* ==================== 汇总 ==================== */

export interface TaxRiskSummaryResult {
  period: string;
  findings: TaxRiskFinding[];
  bySeverity: Record<TaxRiskSeverity, number>;
  byCategory: Array<{ category: TaxRiskCategory; label: string; count: number }>;
  /** 风险等级排序用：high 数量 > 0 即为需处理 */
  totalFindings: number;
  highestSeverity: TaxRiskSeverity | null;
  /** 涉及金额合计（按 code 去重，避免同一金额被多条计入） */
  totalAmountInvolved: number;
}

const SEVERITY_ORDER: Record<TaxRiskSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** 汇总并排序：严重程度优先，其次金额从大到小 */
export function summarizeTaxRisks(
  findings: TaxRiskFinding[],
  period: string
): TaxRiskSummaryResult {
  const sorted = [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return toNumber(b.amount) - toNumber(a.amount);
  });

  const bySeverity: Record<TaxRiskSeverity, number> = {
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const finding of findings) bySeverity[finding.severity] += 1;

  const byCategory = TAX_RISK_CATEGORIES.map((category) => ({
    category,
    label: TAX_RISK_CATEGORY_LABELS[category],
    count: findings.filter((f) => f.category === category).length,
  }));

  const highestSeverity: TaxRiskSeverity | null =
    bySeverity.high > 0 ? 'high' : bySeverity.medium > 0 ? 'medium' : bySeverity.low > 0 ? 'low' : null;

  return {
    period,
    findings: sorted,
    bySeverity,
    byCategory,
    totalFindings: findings.length,
    highestSeverity,
    // 按 code 去重金额：同一笔差异被多个检查命中时只计一次
    totalAmountInvolved: round2(
      [...new Map(findings.map((f) => [f.code, f])).values()].reduce(
        (sum, f) => sum + toNumber(f.amount),
        0
      )
    ),
  };
}
