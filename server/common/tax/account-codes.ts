/**
 * 会计科目编码常量（企业会计准则 2006 科目表口径）。
 *
 * 约定：
 * - 这里是"语义编码"，即分录模板里写的那个编码；
 * - `@AnalyticCode` 标注的是**非末级（汇总）科目**，只能在报表/账簿中汇总，
 *   不允许直接做账；`VoucherHookService` 与 `VoucherService` 会自动下钻到
 *   该科目下第一个启用的末级科目（见 resolveLeafAccountCodes）；
 * - 新增分录模板时一律引用本文件常量，禁止再散落字符串字面量，
 *   否则科目表调整（A-10）会漏改。
 */

/** 库存现金 */
export const ACCOUNT_CASH = '1001';
/** 银行存款（非末级，做账时自动下钻到 100201 基本户） */
export const ACCOUNT_BANK_DEPOSIT = '1002';
/** 银行存款-基本户 */
export const ACCOUNT_BANK_PRIMARY = '100201';
/** 银行存款-一般户 */
export const ACCOUNT_BANK_GENERAL = '100202';
/** 应收账款 */
export const ACCOUNT_AR = '1122';
/** 预付账款 */
export const ACCOUNT_PREPAID = '1123';
/** 原材料 */
export const ACCOUNT_INVENTORY = '1403';
/** 固定资产 */
export const ACCOUNT_FIXED_ASSET = '1601';
/** 累计折旧 */
export const ACCOUNT_ACCUM_DEPRECIATION = '1602';

/** 应付账款 */
export const ACCOUNT_AP = '2202';
/** 预收账款 */
export const ACCOUNT_ADVANCE_RECEIPT = '2203';
/** 应付职工薪酬 */
export const ACCOUNT_PAYROLL_PAYABLE = '2211';
/** 应交税费（非末级） */
export const ACCOUNT_TAX_PAYABLE = '2221';
/** 应交税费-应交增值税（销项税额） */
export const ACCOUNT_VAT_OUTPUT = '222101';
/** 应交税费-应交增值税（进项税额） */
export const ACCOUNT_VAT_INPUT = '222102';

/** 实收资本 */
export const ACCOUNT_PAID_IN_CAPITAL = '4001';
/** 本年利润 */
export const ACCOUNT_CURRENT_YEAR_PROFIT = '4103';
/** 利润分配（非末级） */
export const ACCOUNT_PROFIT_DISTRIBUTION = '4104';
/** 利润分配-未分配利润 */
export const ACCOUNT_RETAINED_EARNINGS = '410401';
/** 利润分配-提取盈余公积 */
export const ACCOUNT_SURPLUS_RESERVE = '410415';

/** 主营业务收入 */
export const ACCOUNT_REVENUE_MAIN = '6001';
/** 其他业务收入 */
export const ACCOUNT_REVENUE_OTHER = '6051';
/** 营业外收入 */
export const ACCOUNT_NON_OPERATING_INCOME = '6301';

/** 主营业务成本 */
export const ACCOUNT_COST_MAIN = '6401';
/** 其他业务成本 */
export const ACCOUNT_COST_OTHER = '6402';
/** 税金及附加 */
export const ACCOUNT_TAX_SURCHARGE = '6403';
/** 销售费用 */
export const ACCOUNT_SELLING_EXPENSE = '6601';
/** 管理费用（非末级） */
export const ACCOUNT_ADMIN_EXPENSE = '6602';
/** 管理费用-办公费 */
export const ACCOUNT_ADMIN_OFFICE = '660201';
/** 管理费用-差旅费 */
export const ACCOUNT_ADMIN_TRAVEL = '660202';
/** 管理费用-咨询费 */
export const ACCOUNT_ADMIN_CONSULTING = '660203';
/** 管理费用-折旧费 */
export const ACCOUNT_ADMIN_DEPRECIATION = '660204';
/** 管理费用-房租水电 */
export const ACCOUNT_ADMIN_RENT = '660205';
/** 财务费用 */
export const ACCOUNT_FINANCE_EXPENSE = '6603';
/** 资产减值损失 */
export const ACCOUNT_ASSET_IMPAIRMENT = '6701';
/** 营业外支出 */
export const ACCOUNT_NON_OPERATING_EXPENSE = '6711';
/** 所得税费用 */
export const ACCOUNT_INCOME_TAX = '6801';

/** 明确为"非末级汇总科目"的编码集合，禁止直接做账 */
export const SUMMARY_ACCOUNT_CODES: readonly string[] = [
  ACCOUNT_BANK_DEPOSIT,
  ACCOUNT_TAX_PAYABLE,
  ACCOUNT_PROFIT_DISTRIBUTION,
  ACCOUNT_ADMIN_EXPENSE,
];

export function isSummaryAccountCode(code: string): boolean {
  return SUMMARY_ACCOUNT_CODES.includes(code);
}
