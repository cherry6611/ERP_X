/**
 * §5.9 + 覆盖率：固定资产**直线折旧**的纯计算，从 `asset-depreciation.service.ts` 抽出。
 *
 * ## 为什么这段必须能单测
 *
 * 它决定"每期计提多少钱"，而错法在界面上**几乎看不出来**：
 *   · 少吸收尾差 → 资产到期时净值**差几分钱**永远到不了残值，
 *     或者最后一期多提一点、净值**跌破残值**（违反"不低于残值"的会计约束）；
 *   · 上限判断写反 → 计提额超过可折旧余额，净值变负数；
 *   · 阈值判断用 `<= 0.01` 而不是 `< 0.01` → 恰好 0.01 元的最后一期被**静默跳过**。
 *
 * 这些都不抛异常、不报错，只是账目慢慢偏掉。抽出来即可逐条断言。
 *
 * ## 与 `depreciate()` 的分工
 *
 * 本模块只管**算**：给定资产参数与已提期数，返回本期应提金额（或"本期不提"）。
 * 落库、凭证生成、项目成本/公共分摊的科目归属仍在 service 里。
 */

import { round2 } from '@server/common/utils/number';

/** 默认折旧年限（月）：库里 `useful_months` 为空时按 36 个月 */
export const DEFAULT_USEFUL_MONTHS = 36;

/** 单期计提额小于 1 分钱就不再计提（避免产生 0 元或负数的折旧行） */
export const MIN_DEPRECIATION_AMOUNT = 0.01;

export interface DepreciationInput {
  /** 原值 */
  originalValue: number;
  /** 残值（计提下限，净值不得低于它） */
  residualValue: number;
  /** 当前净值 */
  netValue: number;
  /** 折旧年限（月）；为空按 `DEFAULT_USEFUL_MONTHS` */
  usefulMonths?: number | null;
  /** 该资产**已计提的总期数**（跨期累计，用于判断最后一期） */
  donePeriods: number;
}

export type DepreciationDecision =
  | { kind: 'depreciate'; amount: number; isLastPeriod: boolean }
  | { kind: 'skip'; reason: 'life_exhausted' | 'fully_depreciated' | 'below_minimum' };

/**
 * 计算某资产本期的折旧额。
 *
 * 判据顺序（与 service 中的原始实现逐条对应，顺序本身有含义）：
 *   1. **已提满年限** → 跳过。放在最前，因为已提满的资产净值可能因历史尾差
 *      仍略高于残值，若先判净值就会给它再提一期。
 *   2. **剩余可提额 < 0.01** → 跳过（净值已到残值）。
 *   3. 直线法月额 = `round2((原值 − 残值) / 年限月数)`。
 *   4. **最后一期，或月额超过剩余可提额** → 改提"剩余可提额"。
 *      这一条同时兜住两个场景：
 *        · 正常尾差：月额 × 年限 ≠ 可折旧总额（除不尽），末期把差额补齐；
 *        · 历史数据异常：净值被人为调低过，月额会越过残值 → 钳到剩余额。
 *   5. 钳完仍 **< 0.01** → 跳过。
 *
 * ⚠️ 阈值一律用 `< MIN_DEPRECIATION_AMOUNT`（严格小于）。写成 `<=` 会让
 * 恰好 0.01 元的最后一期被跳过，净值停在残值上方 1 分钱。
 */
export function computeDepreciation(input: DepreciationInput): DepreciationDecision {
  const usefulMonths = input.usefulMonths ?? DEFAULT_USEFUL_MONTHS;
  const { donePeriods } = input;

  /* 1. 年限已满 */
  if (donePeriods >= usefulMonths) return { kind: 'skip', reason: 'life_exhausted' };

  const originalValue = Number(input.originalValue ?? 0);
  const residualValue = Number(input.residualValue ?? 0);
  const netValue = Number(input.netValue ?? 0);

  /* 2. 剩余可提额不足 1 分 */
  const remaining = round2(netValue - residualValue);
  if (remaining < MIN_DEPRECIATION_AMOUNT) {
    return { kind: 'skip', reason: 'fully_depreciated' };
  }

  /* 3. 直线法月额 */
  const depreciableBase = round2(originalValue - residualValue);
  let amount = round2(depreciableBase / usefulMonths);

  /* 4. 末期或超剩余 → 提剩余额 */
  const isLastPeriod = donePeriods + 1 >= usefulMonths;
  if (isLastPeriod || amount > remaining) amount = remaining;

  /* 5. 仍然太小就不提 */
  if (amount < MIN_DEPRECIATION_AMOUNT) {
    return { kind: 'skip', reason: 'below_minimum' };
  }

  return { kind: 'depreciate', amount, isLastPeriod };
}
