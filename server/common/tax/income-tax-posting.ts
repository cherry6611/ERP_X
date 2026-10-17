import type { PostingLine } from './posting';
import type { CitResult } from './income-tax';
import {
  ACCOUNT_INCOME_TAX,
  ACCOUNT_TAX_PAYABLE_INCOME_TAX,
} from './account-codes';

/**
 * 企业所得税计提分录模板。
 *
 * ```
 * 借 6801  所得税费用
 *   贷 222114 应交税费-应交企业所得税
 * ```
 *
 * ## 为什么用「所得税费用」而不是「税金及附加」
 *
 * 这是会计科目归属的硬性区分，不是风格问题：
 *   · 印花税 / 城建税 / 教育费附加 → **税金及附加**（6403，营业利润之内）；
 *   · **企业所得税 → 所得税费用**（6801，营业利润**之外**，
 *     在利润表上单独位于"利润总额"与"净利润"之间）。
 *
 * 把所得税记进 6403 会让「营业利润」虚减、且利润表第 11/12 行仍为 0 ——
 * 表面上看净利润对了，但营业利润与所得税费用两行都错。
 * 本仓 `report-templates` 的校验①「净利润 = 利润总额 − 所得税费用」
 * 正是为了钉住这个结构。
 *
 * ## 退税（balanceDue < 0）不出分录
 *
 * `tax` 为负意味着本期应退。汇算清缴退税的账务处理是**冲减当期所得税费用**
 * 还是**调整以前年度损益**，取决于退税所属期间与是否属于资产负债表日后事项 ——
 * 那是会计政策，不能在模板里拍一个方向。
 * 因此本模板只处理"计提为正"的情形；退税由调用方按政策决定后单独处理。
 *
 * ## 金额为 0 不出行
 *
 * 亏损年度（`tax = 0`）不产生分录。出 0 元分录会让凭证行数虚增，
 * 且与"本年度无需缴纳企业所得税"的事实不符。
 */
export function incomeTaxAccrualLines(result: CitResult): PostingLine[] {
  if (!(result.taxPayable > 0)) return [];
  return [
    { accountCode: ACCOUNT_INCOME_TAX, debit: result.taxPayable },
    { accountCode: ACCOUNT_TAX_PAYABLE_INCOME_TAX, credit: result.taxPayable },
  ];
}
