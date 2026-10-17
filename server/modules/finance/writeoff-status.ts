/**
 * 应付核销的**状态重算**（从 `ap.service.ts` 抽出，§5.9 + 覆盖率）。
 *
 * ## 为什么必须能单测
 *
 * `ap.service.ts` 自己的注释就点出了这条公式的危险性：
 *
 * > 核销末尾会按新的 `paidAmount` 重算状态 —— 一旦 `newPaid > 0`，
 * > `'voided'` 就被**覆盖**成 `'paid'`/`'partial'`。而 `voidAp` 作废时已经开具了
 * > 冲回凭证，于是出现：单据状态回到"已付/部分付"、冲回凭证仍在账上 → 重复计数。
 *
 * 也就是说这条公式**不得**作用在已作废单据上。当前靠调用点的守卫保证，
 * 但公式本身没有第二道防线 —— 抽出来后 `voided` 是显式一档，可被断言钉住。
 *
 * ## 抽出来后暴露出的三处不一致（都已保留原行为，但注明）
 *
 * | 项 | 核销 `apWriteoffStatus` | 冲回 `apWriteoffReversalStatus` |
 * |---|---|---|
 * | 归零判据 | `newPaid > 0` 才算部分付（**无**容差） | `newPaid <= 0.001` 才归零（**有**容差） |
 * | 付款状态容差 | `newUsed >= amount`（**无**容差） | `newUsed >= amount - 0.001`（**有**容差） |
 *
 * 容差差异在尾差场景下会让**同一组数**在两条路径上得出不同状态。
 * 本模块先把两者都变成可断言的纯函数，行为逐字保留；
 * 若要统一容差，应当作一次显式的口径变更（涉及存量状态），而不是顺手改。
 */

/** 应付单状态（与 `ApStatus` 契约一致） */
export type ApBillStatus = 'pending' | 'approved' | 'partial' | 'paid' | 'voided';

/** 付款单状态 */
export type PaymentStatus = 'pending' | 'approved' | 'paid' | 'voided';

/** 冲回路径的归零容差（原实现写死 0.001） */
export const REVERSAL_ZERO_TOLERANCE = 0.001;

/**
 * **核销**后的应付状态（对应 `apWriteoff` 尾部，逐字保留原判据）。
 *
 * ⚠️ `currentStatus === 'voided'` 时**原样返回 `voided`**，不参与重算。
 * 原实现没有这一支（`newPaid > 0 ? 'partial' : 原状态`），所以它**依赖调用点的
 * `blockedReasonForWriteAction` 守卫**挡住已作废单据。这里把 `voided` 做成显式一档，
 * 等于给同一规则加第二道防线：即使将来出现绕过守卫的新调用路径，
 * 也不会把已冲回的单据"复活"。
 */
export function apWriteoffStatus(params: {
  currentStatus: ApBillStatus;
  /** 核销后的累计已付 */
  newPaidAmount: number;
  /** 应付总额 */
  totalAmount: number;
}): ApBillStatus {
  const { currentStatus, newPaidAmount, totalAmount } = params;
  /* 第二道防线：已作废单据的状态不参与重算（见文件头） */
  if (currentStatus === 'voided') return 'voided';
  if (newPaidAmount >= totalAmount) return 'paid';
  if (newPaidAmount > 0) return 'partial';
  return currentStatus;
}

/**
 * **冲回核销**后的应付状态（对应 `reverseWriteoff` 尾部，逐字保留原判据）。
 *
 * 与 `apWriteoffStatus` 的差异见文件头表格：本路径用 `<= 0.001` 判归零。
 */
export function apWriteoffReversalStatus(params: {
  newPaidAmount: number;
  totalAmount: number;
}): ApBillStatus {
  const { newPaidAmount, totalAmount } = params;
  if (newPaidAmount <= REVERSAL_ZERO_TOLERANCE) return 'pending';
  if (newPaidAmount >= totalAmount) return 'paid';
  return 'partial';
}

/**
 * 核销后，**付款单**是否应标记为已付（对应 `apWriteoff` 里 `newUsed >= amount`）。
 *
 * ⚠️ 无容差 —— 与 `paymentStatusAfterReversal` 不同（见文件头）。
 */
export function isPaymentFullyUsed(newUsedAmount: number, paymentAmount: number): boolean {
  return newUsedAmount >= paymentAmount;
}

/**
 * 冲回核销后，付款单的状态（对应 `reverseWriteoff` 里
 * `newUsed >= amount - 0.001 ? 'paid' : 'approved'`）。
 *
 * ⚠️ 有 0.001 容差 —— 与 `isPaymentFullyUsed` 不同（见文件头）。
 * 冲回只会把状态在 `paid` / `approved` 之间切换（不会回到 `pending`，
 * 因为付款单本身已审批过）。
 */
export function paymentStatusAfterReversal(
  newUsedAmount: number,
  paymentAmount: number,
): PaymentStatus {
  return newUsedAmount >= paymentAmount - REVERSAL_ZERO_TOLERANCE ? 'paid' : 'approved';
}
