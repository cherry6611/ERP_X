/**
 * 固定资产**账面净值**的唯一实现（从 `asset-lifecycle.service.ts` 抽出，§5.9）。
 *
 * ## 为什么必须唯一
 *
 * 该文件自己就写明了这条恒等式（`asset-lifecycle.service.ts` 文件头）：
 *
 * > 金额恒等式（单测断言）：`gainLoss = 处置收入 − 销项税 − 净值`，
 * > 其中 `净值 = 原值 − 累计折旧 − 已计提减值准备`
 *
 * 而抽出前这条公式在**三个地方各写了一遍**（减值测试基准、处置预览、生命周期时间线）。
 * 三份副本的风险不是"代码重复"这种风格问题，而是**口径分叉**：
 * 只要有人改了其中一处（例如把 clamp 下限从 0 改成允许负数，或漏减减值准备），
 * 就会出现「减值测试算出的账面价值」与「处置时用的净值」不一致 ——
 * 同一张资产卡片在两个页面上显示两个净值，而**两边都不报错**。
 *
 * ## 为什么 clamp 到 0 而不是抛错
 *
 * 累计折旧 + 减值 **不可能**超过原值；超出说明历史数据有误。
 * 这里选择 clamp（记 0）而不是抛错，理由写在原实现里：
 * 避免因历史脏数据导致整个减值/处置流程不可用。
 * 这是**有意的容错**，不是"忘了校验"—— 改的人不要顺手改成抛错。
 *
 * ## 三个入参都过 `Number()`
 *
 * `numeric` 列经 pg 驱动返回的是**字符串**。漏掉 `Number()` 会让 `original - accumulated`
 * 变成 `NaN`（字符串相减），再经 `Math.max(NaN, 0)` 得 `NaN` ——
 * 于是净值是 `NaN`，且会一路写进凭证金额（PostgreSQL 对 `NaN::numeric` 的行为
 * 与直觉不同，排查成本很高）。
 */

import { round2 } from '@server/common/utils/number';

/** 契约层面允许传入的原始值形态（`numeric` 经驱动出来是 string） */
export type NumericLike = number | string | null | undefined;

/** 把可能为字符串/空的金额转成数字；非有限值一律记 0 */
export function toNumber(value: NumericLike): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 账面净值 = `max(原值 − 累计折旧 − 已计提减值准备, 0)`。
 *
 * 结果保留 2 位（走共享 `round2`，对负数对称，红冲可平）。
 * 下限为 0 是**有意的容错**，见文件头。
 */
export function netBookValueOf(params: {
  originalValue: NumericLike;
  accumulatedDepreciation: NumericLike;
  accumulatedImpairment: NumericLike;
}): number {
  const original = toNumber(params.originalValue);
  const accumulated = toNumber(params.accumulatedDepreciation);
  const impairment = toNumber(params.accumulatedImpairment);
  return round2(Math.max(original - accumulated - impairment, 0));
}

/**
 * 处置的销项税 = 不含税处置收入 × 税率 / 100。
 *
 * ⚠️ 口径要点（原实现注释里写明了，勿改）：
 *   · 传入/落库的 `disposalIncome` 是**不含税净额**；
 *   · 销项税按净额**正算**（不在含税总额内部倒算，否则会少提税）；
 *   · 银行实收（价税合计）= 净额 + 销项税。
 *
 * 收入 ≤ 0 或税率 ≤ 0 时不产生税额（报废/捐赠无收入）。
 */
export function outputTaxOfDisposal(params: {
  netDisposalIncome: NumericLike;
  taxRate: NumericLike;
}): number {
  const netIncome = round2(Math.max(toNumber(params.netDisposalIncome), 0));
  const rate = toNumber(params.taxRate);
  return netIncome > 0 && rate > 0 ? round2((netIncome * rate) / 100) : 0;
}

/**
 * 减值损失 = `max(账面价值 − 可收回金额, 0)`。
 *
 * 可收回金额由调用方按评估结果传入（本系统不做估值模型）。
 * 可收回金额**高于**账面价值时不确认减值（返回 0），不是"确认负损失"。
 */
export function impairmentLossOf(params: {
  bookValue: NumericLike;
  recoverableAmount: NumericLike;
}): number {
  return round2(Math.max(toNumber(params.bookValue) - toNumber(params.recoverableAmount), 0));
}
