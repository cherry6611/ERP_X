import {
  ACCOUNT_VAT_TRANSFER_OUT,
  ACCOUNT_VAT_UNPAID,
} from './account-codes';
import type { PostingLine } from './posting';

/**
 * T-S3：月末转出未交增值税分录模板。
 *
 * 标准分录（一般纳税人月末结转）：
 * ```
 * 借 222103 应交税费-转出未交增值税  应纳税额
 * 贷 222104 应交税费-未交增值税      应纳税额
 * ```
 *
 * 为什么必须单独记账而不是只在申报表里算个数：申报表的"应纳税额"是
 * **算出来的数**，账上的 2221 明细是**记出来的数**。两者之间若无结转分录
 * 衔接，账面永远停留在"销项 − 进项"的中间态，与实际欠税（缴纳时冲
 * 222104）对不上——这类差异在账面上完全看不出来，只在纳税申报或审计
 * 询证时才暴露。
 *
 * 金额为 0（期末留抵 / 免税）时返回空数组：留抵月份无税可转，
 * 调用方保持"不生成凭证"（与 `vatSurchargeAccrualLines` 同策略）。
 */
export function vatTransferOutLines(payableTax: number): PostingLine[] {
  if (!(payableTax > 0)) return [];
  return [
    { accountCode: ACCOUNT_VAT_TRANSFER_OUT, debit: payableTax },
    { accountCode: ACCOUNT_VAT_UNPAID, credit: payableTax },
  ];
}
