/**
 * 报价单与合同明细的**取整口径**（从 `quotation.service.ts` 抽出，§5.9）。
 *
 * ## 这份文件的唯一职责：把「取整顺序」钉死
 *
 * 同一笔钱在"报价 → 合同"链路上算两次，两边必须在**同一个位置**取整，
 * 否则会出现"表头 89.99 / 明细合计 90.00"这类合同落库，而后续
 * 开票、收入确认、增值税底稿取明细口径 → **账表从第一天起就对不上**。
 *
 * 原实现在**不同位置**取整（实测复现，非推测）：
 *
 * ```
 * 报价（旧）：round2( Σ未取整行金额 × (1 − 整单折扣) )   → 先加、再乘折扣、再取整
 * 合同（旧）：Σ round2( 未取整行金额 × (1 − 整单折扣) )   → 先乘折扣、逐行取整、再求和
 * ```
 *
 * 3 行 × 33.33 元、整单 9 折、税率 6% 时：报价 **89.99**、合同明细合计 **90.00**。
 * 而 `convert()` 的校验是 `Math.abs(itemSum - amount) > 0.01`，
 * 89.99 与 90.00 的差**恰好等于 0.01** → `>` 不成立 → **静默放行**。
 *
 * ## 收敛方向：逐行取整后求和（报价向合同靠）
 *
 * | 方案 | 问题 |
 * |---|---|
 * | 逐行乘折扣 → 逐行取整 → 求和（**采用**） | 合同明细逐行落库，"先取整再加"是唯一能让「表头 = Σ行」在**数据库层面**成立的方式 |
 * | 先求和 → 再乘折扣 → 取整 | 需把分位差塞进某一行，那会让"哪一行被调整"变成隐藏状态，每次重算可能落到不同行 —— 更糟 |
 *
 * **诚实声明**：这让**多行报价单的总额最多变动 1 分**。
 * 这是把"两个数不一致"换成"一个自洽的数"的必要代价，用户已确认采用本口径
 * （见 `docs/上线就绪度与阻断项清单-2026-10-17.md` §21.1，结论为"保留现行 111.42"）。
 */

import { round2 } from '@server/common/utils/number';

export interface QuotationItemLike {
  quantity: number;
  unitPrice: number;
  /** 行折扣率（%） */
  discountPct?: number | null;
  /** 预估单位成本（用于毛利） */
  estUnitCost?: number | null;
}

/** 行金额**不取整**（`数量 × 单价 × (1 − 行折扣%)`）。取整时机由调用方口径决定 */
export function rawLineAmount(item: QuotationItemLike): number {
  const qty = Number(item.quantity) || 0;
  const price = Number(item.unitPrice) || 0;
  const pct = Number(item.discountPct ?? 0) || 0;
  return qty * price * (1 - pct / 100);
}

/**
 * 报价单三金额（行金额合计、总额、预估成本）。
 *
 * ⚠️ 取整顺序是本函数的核心：`round2(逐行金额 × 整单折扣)` **再累加**。
 * 换成"累加后一次性取整"会与合同侧差 1 分（见文件头）。
 */
export function quotationTotals(
  items: readonly QuotationItemLike[],
  headerDiscountPct: number | null | undefined,
): { grossAmount: number; totalAmount: number; estimatedCost: number } {
  const pct = Number(headerDiscountPct ?? 0) || 0;
  const headerFactor = 1 - pct / 100;
  let gross = 0;
  let total = 0;
  let cost = 0;
  for (const item of items) {
    const line = rawLineAmount(item);
    /* 行金额逐行取整（报价单行金额本身落库，必须自洽） */
    gross += round2(line);
    /* 整单折扣逐行施加并取整 —— 与 `contractLineAmount` 完全同口径 */
    total += round2(line * headerFactor);
    cost += (Number(item.quantity) || 0) * (Number(item.estUnitCost ?? 0) || 0);
  }
  return {
    grossAmount: round2(gross),
    totalAmount: round2(total),
    estimatedCost: round2(cost),
  };
}

/** 转合同明细行金额：行折扣后再乘整单折扣，与 `quotationTotals` 同口径 */
export function contractLineAmount(
  item: QuotationItemLike,
  headerDiscountPct: number | null | undefined,
): number {
  const pct = Number(headerDiscountPct ?? 0) || 0;
  return round2(rawLineAmount(item) * (1 - pct / 100));
}

/**
 * 毛利%（`(总额 − 预估成本) / 总额 × 100`）。
 *
 * 总额为 0 时返回 **0**（而不是 NaN/Infinity）——
 * 界面上 NaN 会渲染成 "NaN%"，比 0 更难解释。
 */
export function marginPct(totalAmount: number, estimatedCost: number): number {
  const total = Number(totalAmount) || 0;
  const cost = Number(estimatedCost) || 0;
  if (total === 0) return 0;
  return round2(((total - cost) / total) * 100);
}
