import { round2 } from '@server/common/utils/number';

/**
 * 增值税底稿「未开票收入」不含税额（纯函数，供 service 与 spec 共用）。
 *
 * ## 口径
 *
 *   未开票收入不含税额 = max(本期已确认收入净额 − 本期已开销项发票净额, 0)
 *
 * ## 为什么负数要截为 0 而不是"冲减销项"
 *
 * 负差通常意味着"以前期间确认的收入在本期开票"——那部分销售额**已在上期申报过**，
 * 本期再冲减会直接**少缴**增值税。因此负值一律截为 0，并在差异区提示
 * （见 `vat-declaration.service.ts` 的 `unbilled_revenue_tax_pending`）。
 * 方向选择与 `shared/tax.ts`、`void-guard.ts` 的"宁可多缴/宁可拒绝"一致。
 *
 * 取整走 `round2`，与 `splitTax` 同源：两侧都是 2 位小数的含税/不含税金额，
 * 不先取整会在 0.005 级尾差上出现"差 1 分却显示为 0"的抖动。
 */
export function unbilledRevenueNet(
  revenueGross: number | string | null | undefined,
  invoicedNet: number | string | null | undefined
): number {
  const revenue = round2(Number(revenueGross) || 0);
  const invoiced = round2(Number(invoicedNet) || 0);
  return round2(Math.max(revenue - invoiced, 0));
}
