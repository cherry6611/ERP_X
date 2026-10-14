/**
 * 工资试算引擎：社保按城市比例 + 个税**累计预扣预缴法**（A-07）。
 *
 * 法律依据（《国家税务总局公告 2018 年第 61 号》）：
 *   本期应预扣预缴税额 =
 *     （累计预扣预缴应纳税所得额 × 预扣率 − 速算扣除数） − 累计减免税额 − 累计已预扣预缴税额
 *   累计预扣预缴应纳税所得额 =
 *     累计收入 − 累计免税收入 − 累计减除费用(5000 × 月份数)
 *     − 累计专项扣除（三险一金个人部分）− 累计专项附加扣除 − 累计依法确定的其他扣除
 *
 * 注意事项：
 * - `本期应预扣` 允许为负（累计多扣），此时按 0 处理并在结果里给出 `refundable` 供人工复核；
 * - 全年 12 个月连续发放时，累计已预扣税额必须等于全年应纳税额（见 payroll-engine.spec.ts）。
 */

export interface CitySsRule {
  pensionEmp: number;
  medicalEmp: number;
  unemploymentEmp: number;
  housingEmp: number;
  baseMin: number;
  baseMax: number;
  /** 补充公积金/企业年金等企业侧额外个人扣款比例（可选），单位 % */
  otherEmp?: number;
}

/** A-07：专项附加扣除类型 */
export type TaxDeductionType =
  | 'child_education'
  | 'continuing_education'
  | 'medical'
  | 'housing_loan'
  | 'housing_rent'
  | 'elderly_support'
  | 'infant_care';

export const TAX_DEDUCTION_TYPES: readonly TaxDeductionType[] = [
  'child_education',
  'continuing_education',
  'medical',
  'housing_loan',
  'housing_rent',
  'elderly_support',
  'infant_care',
];

export const TAX_DEDUCTION_LABELS: Record<TaxDeductionType, string> = {
  child_education: '子女教育',
  continuing_education: '继续教育',
  medical: '大病医疗',
  housing_loan: '住房贷款利息',
  housing_rent: '住房租金',
  elderly_support: '赡养老人',
  infant_care: '3 岁以下婴幼儿照护',
};

/** 一条专项附加扣除登记（按月定额） */
export interface TaxDeductionEntry {
  deductionType: TaxDeductionType;
  monthlyAmount: number;
  startMonth: number;
  endMonth: number | null;
}

export interface PayrollPreviewInput {
  baseSalary: number;
  perfSalary: number;
  allowance: number;
  /** 缴费基数，缺省取应发 */
  ssBase?: number;
  rule: CitySsRule;
  /** 本月第几个月（1-12），用于累计减除费用 5000×月数 */
  monthIndex?: number;
  /** 本年累计应发（不含本月） */
  ytdGross?: number;
  /** 本年累计免税收入（不含本月） */
  ytdTaxFreeIncome?: number;
  /** 本年累计专项扣除：社保+公积金个人部分（不含本月） */
  ytdSpecialDeduction?: number;
  /** 本年累计已预扣个税（不含本月） */
  ytdTaxPaid?: number;
  /** 本年累计其他扣除（不含本月），如企业年金、商业健康险 */
  ytdOtherDeduction?: number;
  /** 专项附加扣除（本月），默认 0 */
  additionalDeduction?: number;
  /** 本年累计专项附加扣除（不含本月） */
  ytdAdditionalDeduction?: number;
  /** 免税收入（本月），如符合免税条件的差旅补贴 */
  taxFreeIncome?: number;
  /** 其他扣除（本月），如企业年金 */
  otherDeduction?: number;
}

export interface PayrollPreviewResult {
  gross: number;
  ssBase: number;
  socialInsurance: number;
  housingFund: number;
  /** 累计预扣预缴应纳税所得额 */
  taxable: number;
  tax: number;
  /** 累计多扣、本期无需再扣时为正数的可退金额（供人工复核，不自动退款） */
  refundable: number;
  netSalary: number;
  /** 累计口径快照，便于落库/审计 */
  cumulative: {
    monthIndex: number;
    ytdIncome: number;
    ytdTaxFreeIncome: number;
    ytdBasicDeduction: number;
    ytdDeduction: number;
    ytdAdditionalDeduction: number;
    ytdOtherDeduction: number;
    /** 累计预扣预缴应纳税所得额 */
    cumulativeTaxable: number;
    /** 累计应预扣预缴税额 */
    cumulativeTax: number;
    /** 本期之前累计已预扣 */
    ytdTaxPaidBefore: number;
    /** 本期应预扣 */
    currentTax: number;
    /** 累计已预扣（含本期） */
    ytdTaxWithheld: number;
    /** 本期适用预扣率 */
    taxRate: number;
    /** 本期速算扣除数 */
    quickDeduction: number;
    /** 累计应发（= 累计收入） */
    ytdGross: number;
  };
  breakdown: {
    pensionEmp: number;
    medicalEmp: number;
    unemploymentEmp: number;
    housingEmp: number;
    otherEmp: number;
  };
}

/** 月度基本减除费用标准（元/月） */
export const BASIC_DEDUCTION_PER_MONTH = 5000;

/** 累计预扣法预扣率表（综合所得） */
export interface TaxBracket {
  /** 累计预扣预缴应纳税所得额上限 */
  upTo: number;
  rate: number;
  quickDeduction: number;
}

export const CUMULATIVE_TAX_BRACKETS: readonly TaxBracket[] = [
  { upTo: 36000, rate: 0.03, quickDeduction: 0 },
  { upTo: 144000, rate: 0.1, quickDeduction: 2520 },
  { upTo: 300000, rate: 0.2, quickDeduction: 16920 },
  { upTo: 420000, rate: 0.25, quickDeduction: 31920 },
  { upTo: 660000, rate: 0.3, quickDeduction: 52920 },
  { upTo: 960000, rate: 0.35, quickDeduction: 85920 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.45, quickDeduction: 181920 },
];

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 定位累计应纳税所得额适用的预扣率与速算扣除数 */
export function resolveTaxBracket(cumulativeTaxable: number): TaxBracket {
  for (const bracket of CUMULATIVE_TAX_BRACKETS) {
    if (cumulativeTaxable <= bracket.upTo) return bracket;
  }
  return CUMULATIVE_TAX_BRACKETS[CUMULATIVE_TAX_BRACKETS.length - 1];
}

/** 累计应预扣预缴税额（不超过 0 时返回 0） */
export function calcCumulativeTax(cumulativeTaxable: number): number {
  if (cumulativeTaxable <= 0) return 0;
  const bracket = resolveTaxBracket(cumulativeTaxable);
  return Math.max(0, r2(cumulativeTaxable * bracket.rate - bracket.quickDeduction));
}

/**
 * 计算某月应享受的专项附加扣除合计。
 * 登记项按 startMonth/endMonth 过滤后再按月定额求和。
 */
export function monthlyAdditionalDeduction(
  entries: readonly TaxDeductionEntry[],
  monthIndex: number
): number {
  let total = 0;
  for (const entry of entries) {
    if (monthIndex < entry.startMonth) continue;
    if (entry.endMonth != null && monthIndex > entry.endMonth) continue;
    total += Number(entry.monthlyAmount ?? 0);
  }
  return r2(total);
}

/** 累计专项附加扣除（1 月至 monthIndex，含当月） */
export function cumulativeAdditionalDeduction(
  entries: readonly TaxDeductionEntry[],
  monthIndex: number
): number {
  let total = 0;
  for (let month = 1; month <= monthIndex; month += 1) {
    total += monthlyAdditionalDeduction(entries, month);
  }
  return r2(total);
}

/** 五险一金个人部分（按城市比例与基数上下限） */
export function calcEmployeeSocialInsurance(
  gross: number,
  ssBaseInput: number | undefined,
  rule: CitySsRule
): {
  ssBase: number;
  pensionEmp: number;
  medicalEmp: number;
  unemploymentEmp: number;
  housingEmp: number;
  otherEmp: number;
  socialInsurance: number;
  housingFund: number;
} {
  const rawBase = ssBaseInput != null && ssBaseInput > 0 ? ssBaseInput : gross;
  const ssBase = r2(Math.min(rule.baseMax, Math.max(rule.baseMin, rawBase)));
  const pensionEmp = r2((ssBase * rule.pensionEmp) / 100);
  const medicalEmp = r2((ssBase * rule.medicalEmp) / 100);
  const unemploymentEmp = r2((ssBase * rule.unemploymentEmp) / 100);
  const housingEmp = r2((ssBase * rule.housingEmp) / 100);
  const otherEmp = r2((ssBase * (rule.otherEmp ?? 0)) / 100);
  return {
    ssBase,
    pensionEmp,
    medicalEmp,
    unemploymentEmp,
    housingEmp,
    otherEmp,
    socialInsurance: r2(pensionEmp + medicalEmp + unemploymentEmp),
    housingFund: housingEmp,
  };
}

export function previewPayroll(input: PayrollPreviewInput): PayrollPreviewResult {
  const gross = r2(input.baseSalary + input.perfSalary + input.allowance);
  const social = calcEmployeeSocialInsurance(gross, input.ssBase, input.rule);
  const {
    ssBase,
    pensionEmp,
    medicalEmp,
    unemploymentEmp,
    housingEmp,
    otherEmp,
    socialInsurance,
    housingFund,
  } = social;

  const monthIndex = Math.min(12, Math.max(1, Number(input.monthIndex ?? 1)));
  const ytdGrossBefore = Number(input.ytdGross ?? 0);
  const ytdTaxFreeBefore = Number(input.ytdTaxFreeIncome ?? 0);
  const ytdSpecialBefore = Number(input.ytdSpecialDeduction ?? 0);
  const ytdAdditionalBefore = Number(input.ytdAdditionalDeduction ?? 0);
  const ytdOtherBefore = Number(input.ytdOtherDeduction ?? 0);
  const ytdTaxPaidBefore = Number(input.ytdTaxPaid ?? 0);
  const additionalThisMonth = Number(input.additionalDeduction ?? 0);
  const taxFreeThisMonth = Number(input.taxFreeIncome ?? 0);
  const otherThisMonth = Number(input.otherDeduction ?? 0);

  const specialThisMonth = r2(socialInsurance + housingFund + otherEmp);
  const ytdIncome = r2(ytdGrossBefore + gross);
  const ytdTaxFreeIncome = r2(ytdTaxFreeBefore + taxFreeThisMonth);
  const ytdDeduction = r2(ytdSpecialBefore + specialThisMonth);
  const ytdAdditional = r2(ytdAdditionalBefore + additionalThisMonth);
  const ytdOther = r2(ytdOtherBefore + otherThisMonth);
  const ytdBasicDeduction = r2(BASIC_DEDUCTION_PER_MONTH * monthIndex);

  const cumulativeTaxable = Math.max(
    0,
    r2(
      ytdIncome -
        ytdTaxFreeIncome -
        ytdBasicDeduction -
        ytdDeduction -
        ytdAdditional -
        ytdOther
    )
  );
  const cumulativeTax = calcCumulativeTax(cumulativeTaxable);
  const bracket = resolveTaxBracket(cumulativeTaxable);
  const rawCurrent = r2(cumulativeTax - ytdTaxPaidBefore);
  const tax = Math.max(0, rawCurrent);
  const refundable = rawCurrent < 0 ? Math.abs(rawCurrent) : 0;
  const netSalary = r2(gross - socialInsurance - housingFund - otherEmp - tax);

  return {
    gross,
    ssBase,
    socialInsurance,
    housingFund,
    taxable: cumulativeTaxable,
    tax,
    refundable,
    netSalary,
    cumulative: {
      monthIndex,
      ytdIncome,
      ytdTaxFreeIncome,
      ytdBasicDeduction,
      ytdDeduction,
      ytdAdditionalDeduction: ytdAdditional,
      ytdOtherDeduction: ytdOther,
      cumulativeTaxable,
      cumulativeTax,
      ytdTaxPaidBefore,
      currentTax: tax,
      ytdTaxWithheld: r2(ytdTaxPaidBefore + tax),
      taxRate: bracket.rate,
      quickDeduction: bracket.quickDeduction,
      ytdGross: ytdIncome,
    },
    breakdown: {
      pensionEmp,
      medicalEmp,
      unemploymentEmp,
      housingEmp,
      otherEmp,
    },
  };
}
