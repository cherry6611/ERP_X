/** 应收 / 回款核销的纯函数（供单测与服务复用，无 DB）。 */

export function openAmount(total: number, used: number): number {
  return Number(total) - Number(used);
}

export function arSettleStatus(
  settled: number,
  arAmount: number
): 'settled' | 'partial' {
  return settled >= arAmount ? 'settled' : 'partial';
}

export function receiptMatchStatus(
  used: number,
  receiptAmount: number
): 'matched' | 'partial' {
  return used >= receiptAmount ? 'matched' : 'partial';
}

/** 凭证分录借贷是否平衡（分比较）。 */
export function isVoucherBalanced(
  lines: Array<{ debit?: number; credit?: number }>
): boolean {
  const debit = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
  const credit = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
  return Math.round(debit * 100) === Math.round(credit * 100);
}
