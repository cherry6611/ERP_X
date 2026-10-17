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
/** 固定资产清理（D-08 处置过渡科目，借贷双向） */
export const ACCOUNT_FIXED_ASSET_DISPOSAL = '1603';
/** 固定资产减值准备（D-08 资产备抵科目，贷） */
export const ACCOUNT_FIXED_ASSET_IMPAIRMENT = '1604';

/** 应付账款 */
export const ACCOUNT_AP = '2202';
/** 预收账款 */
export const ACCOUNT_ADVANCE_RECEIPT = '2203';
/** 应付职工薪酬（汇总，不可直接做账） */
export const ACCOUNT_PAYROLL_PAYABLE = '2211';
/** 应付职工薪酬-工资（末级，N-1 计提与代扣的枢纽科目） */
export const ACCOUNT_PAYROLL_PAYABLE_SALARY = '221101';
/** 应付职工薪酬-社会保险费（末级，含代扣个人部分） */
export const ACCOUNT_PAYROLL_PAYABLE_SOCIAL_INSURANCE = '221102';
/** 应付职工薪酬-住房公积金（末级，含代扣个人部分） */
export const ACCOUNT_PAYROLL_PAYABLE_HOUSING_FUND = '221103';
/** 应付职工薪酬-其他代扣（末级，企业年金等） */
export const ACCOUNT_PAYROLL_PAYABLE_OTHER_DEDUCTION = '221104';
/** 应交税费（非末级） */
export const ACCOUNT_TAX_PAYABLE = '2221';
/** 应交税费-应交增值税（销项税额） */
export const ACCOUNT_VAT_OUTPUT = '222101';
/** 应交税费-应交增值税（进项税额） */
export const ACCOUNT_VAT_INPUT = '222102';
/**
 * T-S3：应交税费-转出未交增值税（借方科目，月末结转分录的借方）。
 *
 * 月末把"应交增值税"明细的净贷差（应纳税额）转出到"未交增值税"：
 *   借 222103 转出未交增值税 / 贷 222104 未交增值税
 * 没有这一步，2221 的明细余额永远停在"应交增值税"上，账面上的应交数
 * 与申报表的应纳税额、与实际的欠税三者对不上。
 */
export const ACCOUNT_VAT_TRANSFER_OUT = '222103';
/**
 * T-S3：应交税费-未交增值税（贷方科目，月末结转分录的贷方）。
 * 实际缴纳时借 222104 / 贷 1002 银行存款冲减。
 */
export const ACCOUNT_VAT_UNPAID = '222104';
/** 应交税费-城建税（末级，附加税费计提贷方） */
export const ACCOUNT_TAX_PAYABLE_URBAN_MAINT = '222106';
/** 应交税费-教育费附加（末级） */
export const ACCOUNT_TAX_PAYABLE_EDUCATION = '222110';
/** 应交税费-地方教育附加（末级） */
export const ACCOUNT_TAX_PAYABLE_LOCAL_EDUCATION = '222111';
/** 应交税费-应交个人所得税（末级，N-1 工资代扣个税贷方） */
export const ACCOUNT_TAX_PAYABLE_INDIVIDUAL_INCOME_TAX = '222112';
/**
 * 应交税费-印花税（末级）。
 *
 * §4.7(f)：印花税在全仓（ts/tsx/sql/md）原先**零命中** —— 完全未实现。
 * 编码排在 222112 之后，因此不影响 2221 的下钻目标（仍是 222101）。
 */
export const ACCOUNT_TAX_PAYABLE_STAMP_DUTY = '222113';
/**
 * 应交税费-应交企业所得税（末级）。
 *
 * §4.7(e)：`ACCOUNT_INCOME_TAX = '6801'` 此前**全仓无引用** ——
 * 所得税费用科目存在、利润表第 11 行恒为 0。本编码与 6801 配套接线。
 * 排在 222113 之后，同样不影响 2221 下钻目标。
 */
export const ACCOUNT_TAX_PAYABLE_INCOME_TAX = '222114';

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
/** 税金及附加（汇总，不可直接做账） */
export const ACCOUNT_TAX_SURCHARGE = '6403';
/** 税金及附加-城建税（末级） */
export const ACCOUNT_TAX_SURCHARGE_URBAN_MAINT = '640301';
/** 税金及附加-教育费附加（末级） */
export const ACCOUNT_TAX_SURCHARGE_EDUCATION = '640302';
/** 税金及附加-地方教育附加（末级） */
export const ACCOUNT_TAX_SURCHARGE_LOCAL_EDUCATION = '640303';
/**
 * 税金及附加-印花税（末级）。
 *
 * §4.7(f)：印花税计入「税金及附加」（财会〔2016〕22 号），
 * 与城建税/教育费附加同科目家族，因此编码排在 640303 之后。
 */
export const ACCOUNT_TAX_SURCHARGE_STAMP_DUTY = '640304';
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
