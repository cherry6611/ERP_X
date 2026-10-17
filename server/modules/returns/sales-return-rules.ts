/**
 * 销售退货的**可退金额闸门**（从 `return.service.ts` 抽出，§5.9）。
 *
 * ## 为什么这段必须能单测
 *
 * 它决定"这笔退货能不能登记"，且是**累计口径**：
 * `本次金额 + 已退金额 ≤ 收入确认金额`。
 * 判据写错的方向都很难在界面上发现：
 *
 * · **少算已退**（例如漏了 `status <> 'void'` 过滤、或忘了累加）→
 *   同一笔收入可以被**反复退货**，退货额超过收入，账面收入被冲成负数；
 * · **把已作废的退货也算进"已退"** → 明明还能退却拒绝，业务被卡；
 * · 价税分离不按权威口径 → 与发票/收入侧的净税额对不上。
 *
 * 抽出前这些判据内联在 service 里（顺带自己写了一遍价税分离公式），无法断言。
 */

import { round2 } from '@server/common/utils/number';
import { splitTax } from '@shared/tax';

/** 销售退货的默认税率（与收入确认默认一致） */
export const DEFAULT_SALES_RETURN_TAX_RATE = 6;

/** 可退金额为负时的保护：不低于 0（历史脏数据可能让"已退 > 收入"） */
export function returnableAmount(params: {
  revenueAmount: number | string | null | undefined;
  alreadyReturnedAmount: number | string | null | undefined;
}): number {
  const revenue = round2(toNumber(params.revenueAmount));
  const returned = round2(toNumber(params.alreadyReturnedAmount));
  return round2(Math.max(revenue - returned, 0));
}

/** 数值归一：`numeric` 经 pg 驱动返回字符串；非有限值记 0 */
export function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export type ReturnAmountCheck =
  | { ok: true; amount: number; returnable: number }
  | { ok: false; message: string };

/**
 * 校验本次退货金额是否在可退额度内。
 *
 * 判据顺序（与 `return.service.ts` 原实现一致，顺序有含义）：
 *   1. 金额必须 > 0（放在最前：0 或负数是明显的输入错误，不该走额度比较）；
 *   2. `本次 + 已退 ≤ 收入确认金额`；
 *   3. 通过时一并返回 `returnable`，供调用方复用（避免二次计算口径不一致）。
 *
 * ⚠️ 判据 2 用的是**严格大于**才拒绝：恰好等于额度是允许的
 * （把一笔收入全额退完是合法业务）。
 */
export function checkReturnAmount(params: {
  amount: number;
  revenueAmount: number | string | null | undefined;
  alreadyReturnedAmount: number | string | null | undefined;
}): ReturnAmountCheck {
  const amount = round2(params.amount);
  const revenue = round2(toNumber(params.revenueAmount));
  const returned = round2(toNumber(params.alreadyReturnedAmount));
  const returnable = round2(Math.max(revenue - returned, 0));

  if (amount <= 0) {
    return { ok: false, message: '退货金额必须大于 0' };
  }
  if (amount + returned > revenue) {
    return {
      ok: false,
      message:
        `退货金额 ${amount} 超过可退金额 ${returnable}` +
        `（收入确认 ${revenue}，已退 ${returned}）`,
    };
  }
  return { ok: true, amount, returnable };
}

/**
 * 销售退货的价税分离。
 *
 * ⚠️ 原实现自己写了一遍：`net = round2(amount * 100 / (100 + rate))`、
 * `tax = round2(amount − net)`。抽出来后**改走权威 `splitTax`**：
 * 两者在实测 50 组（10 金额 × 5 税率）上结果相同，所以这不是纠错，
 * 而是消除一份将来可能分叉的副本 —— `shared/tax.ts` 的 `splitTax`
 * 是唯一权威（且带"红冲符号互为相反数"的不变量）。
 *
 * 税率缺省用 {@link DEFAULT_SALES_RETURN_TAX_RATE}（与收入确认默认一致）。
 */
export function salesReturnTaxSplit(params: {
  amount: number | string | null | undefined;
  taxRate?: number | string | null;
}): { netAmount: number; taxAmount: number } {
  const amount = round2(toNumber(params.amount));
  const rate = params.taxRate === null || params.taxRate === undefined
    ? DEFAULT_SALES_RETURN_TAX_RATE
    : toNumber(params.taxRate);
  const { net, tax } = splitTax(amount, rate);
  return { netAmount: net, taxAmount: tax };
}
