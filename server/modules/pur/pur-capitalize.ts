/**
 * 设备类采购验收的**资本化金额累计**（纯函数，供 `PurService.acceptOrder` 使用）。
 *
 * ## 为什么需要这个模块
 *
 * 采购订单可以**分批验收**（`acceptOrder` 每次累加 `acceptedQuantity`，收满才置
 * `accepted`）。设备类订单在验收时会资本化生成一张固定资产卡片，而
 * `ast_asset.purchase_order_id` 上有**部分唯一索引**
 * `uq_ast_asset_purchase_order`（`WHERE purchase_order_id IS NOT NULL`）——
 * 语义是**一张采购订单只能对应一张卡片**。
 *
 * 原实现每次验收都无条件 `INSERT ast_asset`，于是：
 *   · 第 1 次验收（1/3 件）→ 建卡成功，原值 = 本次验收金额；
 *   · 第 2 次验收（再 1 件）→ 插入撞唯一索引 → 全局异常过滤器把它翻译成
 *     409「该采购订单已生成固定资产卡片，一张采购订单只能生成一张卡片」。
 * 后果不是少一张卡，而是**订单永远收不完**：剩余数量每次都被这条约束挡回，
 * 订单卡在 `pending`，剩余应付/进项凭证也永远生不成（实测复现见走查报告）。
 *
 * 正确语义是「**同一张卡片的原值随每次验收累计**」，因此把金额计算抽成纯函数，
 * 与数据库写入解耦后即可单测（原值/净值必须是两位小数，`numeric(18,2)`）。
 */

import { round2 } from '@server/common/utils/number';

/** 一张资产卡片在本次验收后的原值与净值 */
export interface CapitalizedAssetValue {
  originalValue: number;
  netValue: number;
}

/** 已有卡片的最小信息（`null` 表示本订单还没有卡片） */
export interface ExistingCapitalizedAsset {
  originalValue: number | string | null;
  netValue: number | string | null;
}

/**
 * 计算本次验收后资产卡片应有的原值与净值。
 *
 * - `existing` 为 `null` → 用本次验收金额建卡（原值 = 净值 = 本次金额）；
 * - 已存在 → 在已有金额上**累加**（分批验收累计资本化）。
 *
 * 一律走 `round2`（全仓唯一取整实现），保证落库值不出现浮点尾差：
 * 例如三次各 0.33 的累加在浮点下是 `0.99` 但中间态可能出现 `0.6600000000000001`。
 */
export function accumulateCapitalizedValue(
  existing: ExistingCapitalizedAsset | null,
  trancheAmount: number
): CapitalizedAssetValue {
  const tranche = round2(trancheAmount);
  if (!existing) {
    return { originalValue: tranche, netValue: tranche };
  }
  return {
    originalValue: round2(Number(existing.originalValue ?? 0) + tranche),
    netValue: round2(Number(existing.netValue ?? 0) + tranche),
  };
}
