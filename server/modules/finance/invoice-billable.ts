import { round2 } from '@server/common/utils/number';

/**
 * 合同「可开金额」口径（纯函数 + 常量，供 service 与 spec 共用）。
 *
 * ## 为什么必须把方向也当成口径的一部分
 *
 * 可开金额 = 合同额 − **该合同已开销项发票**合计。
 * 原实现只按 `contract_id + status='issued'` 求和，**没有 `direction` 过滤**，
 * 于是一张挂到该合同上的**进项**发票会凭空吃掉销项的可开额度。
 *
 * 这条路径是真实可达的，不是理论担忧：
 *   · `createPurchaseInvoice` 自己在插入时忽略 `dto.contractId`（看起来安全）；
 *   · 但 `PATCH /api/finance/invoices/:id` 的 `UpdateInvoiceDto.contractId`
 *     对进项发票同样可写（`invoice.service.ts` 的 `patch.contractId = dto.contractId`）。
 * 结果：进项发票一旦补上合同，该合同后续合法的销项开票会被
 * 「开票金额超过合同可开金额」误拒 —— 方向是**偏严**（不会少缴税），
 * 但用户会看到"明明还有额度却开不出票"，且没有任何提示指向真正的原因。
 *
 * ## 为什么是"只算销项"而不是"排除进项"
 *
 * `erp_invoice.direction` 目前只有 `sales` / `purchase` 两值（库层 CHECK 未约束，
 * 但 `CreateInvoiceDto` 用 `@IsIn` 限死）。若将来新增方向（如 `sales_return`），
 * 白名单 `sales` 会让新方向**不计入**已开票额 —— 这是安全的一侧（可开额度偏大
 * 会被后续的金额校验再挡一次）。黑名单写法则会默默把它算进去。
 * 与 `void-guard.ts` 的"白名单而非黑名单"是同一取舍。
 */
export const CONTRACT_INVOICED_DIRECTION = 'sales';

/**
 * 计算合同可开金额。
 *
 * @param contractAmount         合同金额（含税，`erp_contract.amount`）
 * @param invoicedSalesAmounts   该合同**已开销项发票**的含税金额（`erp_invoice.amount`，
 *                               红字发票为负数，天然冲减）
 * @returns 可开金额（2 位小数；可能为负 —— 说明已超额开票，由调用方决定是否拒绝）
 *
 * 取整一律走 `round2`，与 `shared/tax.ts#splitTax` 同源，避免"分"级漂移
 * 让 `billable + 0.001` 这类容差判断失效。
 */
export function computeBillable(
  contractAmount: number | string | null | undefined,
  invoicedSalesAmounts: readonly (number | string | null | undefined)[]
): number {
  const invoiced = round2(
    invoicedSalesAmounts.reduce<number>(
      (sum, value) => sum + (Number(value) || 0),
      0
    )
  );
  return round2((Number(contractAmount) || 0) - invoiced);
}
