/**
 * D-03：辅助核算深化的规则内核（多维度组合账 / 跨维度分析 / 分摊）。
 *
 * ## 这个文件解决的两个真实问题
 *
 * ### 1. 跨维度组合必须做"差额归因"，不能只并列展示
 *
 * 单维度余额表回答"研发部花了多少"，但业务真正要问的是
 * "研发部在 A 项目上、按人力成本口径花了多少"。把两个维度的余额表并排看
 * 是回答不了的 —— 必须按 `(维度A取值, 维度B取值)` 组合求余额。
 *
 * 更关键的是：**组合余额之和应当等于总量**。如果不等，说明有些分录只挂了
 * 一个维度（A-05 的必填校验只覆盖 `aux_required` 声明的维度），
 * 那就必须把差额单独暴露出来，而不是让使用者以为"加起来就是全部"。
 * 因此 `assessCombinationCoverage` 会显式给出 `uncovered`（未挂全维度的部分）。
 *
 * ### 2. 成本分摊的四舍五入必须"补齐尾差"
 *
 * 按比例分摊时，`100 / 3` 三份各 `33.33` 会丢 `0.01`。财务上这是**不能接受**的：
 * 分摊结果之和必须严格等于被分摊总额，否则总账与明细账永远对不上。
 * 因此 `allocateAmount` 用**最大余数法**（largest remainder）逐个补齐分位，
 * 而不是简单 `round2`。这是本文件最值得单测的部分。
 */

import { FALLBACK_RATE } from '@shared/tax';

/** 分摊/组合分析里允许的最大小数位（金额到分） */
const SCALE = 100;

function round2(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}

function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/* ==================== 跨维度组合 ==================== */

/** 单个维度的取值（id 可为空，表示该维度未指定具体值） */
export interface DimensionValue {
  dimensionCode: string;
  dimensionId: string | null;
  dimensionValue: string | null;
}

/** 一条分录行及其挂的多个辅助维度 */
export interface AuxLineForCombination {
  lineId: string;
  accountCode: string;
  debit: number;
  credit: number;
  /** 该行挂的维度（可能少于查询的维度集合 —— 这正是"未覆盖"的来源） */
  dimensions: DimensionValue[];
}

/** 组合键：按维度编码排序后拼接，保证同一组合得到同一个 key */
export function combinationKey(
  dimensions: DimensionValue[],
  dimensionCodes: string[]
): string {
  const byCode = new Map(dimensions.map((d) => [d.dimensionCode, d]));
  return dimensionCodes
    .map((code) => {
      const value = byCode.get(code);
      if (!value) return `${code}:<缺>`;
      return `${code}:${value.dimensionId ?? value.dimensionValue ?? '<空>'}`;
    })
    .join('|');
}

export interface CombinationCell {
  key: string;
  /** 各维度取值，顺序与 `dimensionCodes` 一致 */
  values: Array<{
    dimensionCode: string;
    dimensionId: string | null;
    dimensionValue: string | null;
    /** 该维度在本行是否缺失 */
    missing: boolean;
  }>;
  debit: number;
  credit: number;
  /** 净额 = 借 − 贷 */
  balance: number;
  lineCount: number;
}

export interface CombinationResult {
  dimensionCodes: string[];
  cells: CombinationCell[];
  /** 挂全了所有查询维度的行合计（借/贷/净额） */
  covered: { debit: number; credit: number; balance: number };
  /** 只挂了部分维度的行合计 —— 必须显式暴露，否则"加起来不等于总量" */
  uncovered: { debit: number; credit: number; balance: number; lineCount: number };
  /** 全部行合计 */
  total: { debit: number; credit: number; balance: number };
}

/**
 * 按多个维度组合汇总分录。
 *
 * `uncovered` 的口径：**只要缺少任一查询维度**就计入未覆盖。
 * 为什么用"缺任一"而不是"全缺"：组合表的使用者要的是"这个组合下的金额"，
 * 一行只挂了部门没挂项目时，它无法被归入任何 `(部门, 项目)` 组合，
 * 因此对组合表而言它就是未覆盖的。若把它塞进 `(部门, <缺>)` 单元格，
 * 使用者按组合求和时会得到与总量一致的结果，但**每个具体项目的数字都是错的**。
 * 宁可让总数对不上并显式告警，也不要给出看似完整实则错配的表。
 */
export function buildCombinations(
  lines: AuxLineForCombination[],
  dimensionCodes: string[]
): CombinationResult {
  const cells = new Map<string, CombinationCell>();
  const covered = { debit: 0, credit: 0, balance: 0 };
  const uncovered = { debit: 0, credit: 0, balance: 0, lineCount: 0 };
  const total = { debit: 0, credit: 0, balance: 0 };

  const codes = [...dimensionCodes];
  const codeSet = new Set(codes);

  for (const line of lines) {
    const debit = round2(toNumber(line.debit));
    const credit = round2(toNumber(line.credit));
    total.debit = round2(total.debit + debit);
    total.credit = round2(total.credit + credit);
    total.balance = round2(total.balance + debit - credit);

    // 只看本次查询涉及的维度
    const relevant = line.dimensions.filter((d) => codeSet.has(d.dimensionCode));
    const present = new Set(relevant.map((d) => d.dimensionCode));
    const missing = codes.filter((code) => !present.has(code));

    if (missing.length > 0) {
      uncovered.debit = round2(uncovered.debit + debit);
      uncovered.credit = round2(uncovered.credit + credit);
      uncovered.balance = round2(uncovered.balance + debit - credit);
      uncovered.lineCount += 1;
      continue;
    }

    const key = combinationKey(relevant, codes);
    const existing = cells.get(key);
    if (existing) {
      existing.debit = round2(existing.debit + debit);
      existing.credit = round2(existing.credit + credit);
      existing.balance = round2(existing.balance + debit - credit);
      existing.lineCount += 1;
    } else {
      const byCode = new Map(relevant.map((d) => [d.dimensionCode, d]));
      cells.set(key, {
        key,
        values: codes.map((code) => {
          const value = byCode.get(code);
          return {
            dimensionCode: code,
            dimensionId: value?.dimensionId ?? null,
            dimensionValue: value?.dimensionValue ?? null,
            missing: !value,
          };
        }),
        debit,
        credit,
        balance: round2(debit - credit),
        lineCount: 1,
      });
    }
  }

  covered.debit = round2(total.debit - uncovered.debit);
  covered.credit = round2(total.credit - uncovered.credit);
  covered.balance = round2(total.balance - uncovered.balance);

  return {
    dimensionCodes: codes,
    cells: [...cells.values()].sort((a, b) => b.balance - a.balance),
    covered,
    uncovered,
    total,
  };
}

/**
 * 覆盖度评估：组合表能不能代表全部账？
 *
 * `rate < 100` 时前端必须给出显式提示 —— 否则使用者会拿一份不完整的表
 * 去支撑决策。这里返回**可读中文原因**而不只是数字。
 */
export function assessCombinationCoverage(result: CombinationResult): {
  coverageRate: number;
  complete: boolean;
  message: string;
} {
  const totalAbs = result.total.debit + result.total.credit;
  const coverageRate =
    totalAbs === 0
      ? 100
      : round2(
          ((result.covered.debit + result.covered.credit) / totalAbs) * 100
        );
  if (coverageRate >= 100) {
    return {
      coverageRate,
      complete: true,
      message: '全部发生额均已挂全所选维度，组合金额可直接采信',
    };
  }
  return {
    coverageRate,
    complete: false,
    message:
      `仅 ${coverageRate}% 的发生额挂全了所选维度；` +
      `未覆盖部分合计 ${result.uncovered.balance.toFixed(2)} 元（${result.uncovered.lineCount} 行）。` +
      `组合金额只能代表已挂全的部分，不能直接当作科目总额使用。`,
  };
}

/* ==================== 成本分摊（最大余数法） ==================== */

export interface AllocationInput {
  /** 待分摊总额（可为负，表示冲回） */
  amount: number;
  /** 分摊权重（如各部门工时、各项目收入占比） */
  weights: number[];
  /** 权重之和为 0 时的兜底策略 */
  fallback?: 'equal' | 'reject';
}

export interface AllocationResult {
  amount: number;
  /** 与 `weights` 一一对应的分摊额；**之和严格等于 amount** */
  shares: number[];
  /** 权重之和（0 表示走了兜底或拒绝） */
  totalWeight: number;
  /** 是否为平均分摊（权重全为 0 时的兜底） */
  equalFallback: boolean;
  /** 因四舍五入被调整的项数（用于向使用者解释尾差去向） */
  adjustedCount: number;
}

/**
 * 按权重分摊金额，**保证 `sum(shares) === amount`**（到分）。
 *
 * 算法：最大余数法（largest remainder / Hare quota）
 *   1. 先按精确比例算出各项的"应有份额"（不取整）；
 *   2. 各项向下取整到分；
 *   3. 计算取整后与总额的差额（以分为单位，可能是正或负）；
 *   4. 按小数部分从大到小（负额时从小到大）依次 ±1 分，直到补齐。
 *
 * 为什么不能简单 `round2(amount * w / totalW)`：三项各 33.33 时合计 99.99，
 * 差的 1 分在凭证上就是借贷不平 —— 总账与明细账永远对不上。
 *
 * 负数金额（冲回）用同一套逻辑：先按绝对值算，再整体取负，
 * 这样"冲回的分摊"与"原分摊"逐项互为相反数，不会出现
 * 「原分摊 33.34/33.33/33.33，冲回 33.33/33.33/33.34」这种对不平的情况。
 */
export function allocateAmount(input: AllocationInput): AllocationResult {
  const weights = (input.weights ?? []).map((w) => {
    const value = toNumber(w);
    // 负权重无业务含义，按 0 处理（等价于不分摊给该项）
    return value > 0 ? value : 0;
  });
  if (weights.length === 0) {
    return {
      amount: 0,
      shares: [],
      totalWeight: 0,
      equalFallback: false,
      adjustedCount: 0,
    };
  }

  const amount = round2(toNumber(input.amount));
  const totalWeight = round2(weights.reduce((sum, w) => sum + w, 0));
  const fallback = input.fallback ?? 'equal';

  if (totalWeight <= 0) {
    if (fallback === 'reject') {
      throw new Error('全部权重为 0，无法分摊；请提供权重或允许平均分摊');
    }
    // 平均分摊：用同一套最大余数逻辑，权重视为 1
    const equal = allocateByWeights(
      amount,
      weights.map(() => 1)
    );
    return {
      amount,
      shares: equal.shares,
      totalWeight: 0,
      equalFallback: true,
      adjustedCount: equal.adjustedCount,
    };
  }

  const result = allocateByWeights(amount, weights);
  return {
    amount,
    shares: result.shares,
    totalWeight,
    equalFallback: false,
    adjustedCount: result.adjustedCount,
  };
}

/** 最大余数法主体（权重已保证均为正且和 > 0） */
function allocateByWeights(
  amount: number,
  weights: number[]
): { shares: number[]; adjustedCount: number } {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  // 以"分"为单位计算，避免浮点累积误差
  const totalCents = Math.round(amount * SCALE);
  const sign = totalCents < 0 ? -1 : 1;
  const absCents = Math.abs(totalCents);

  const exact = weights.map((w) => (absCents * w) / totalWeight);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = absCents - floors.reduce((sum, value) => sum + value, 0);

  // 按小数部分降序补齐（相同的余数按原顺序，保证结果确定）
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) =>
      b.fraction === a.fraction ? a.index - b.index : b.fraction - a.fraction
    );

  const cents = [...floors];
  let adjustedCount = 0;
  let cursor = 0;
  while (remainder > 0 && order.length > 0) {
    cents[order[cursor % order.length].index] += 1;
    adjustedCount += 1;
    remainder -= 1;
    cursor += 1;
  }

  return {
    shares: cents.map((value) => round2((sign * value) / SCALE)),
    adjustedCount,
  };
}

/* ==================== 维度组合校验 ==================== */

/** 可做组合分析的维度来源类型（`custom` 也可，但需要人工保证取值口径一致） */
export const COMBINABLE_SOURCE_TYPES = [
  'department',
  'project',
  'customer',
  'supplier',
  'employee',
  'custom',
] as const;

/** 单次组合分析允许的最大维度数（超过后组合数指数增长，页面无法使用） */
export const MAX_COMBINATION_DIMENSIONS = 3;

export interface DimensionForCombination {
  code: string;
  name: string;
  enabled: boolean;
}

/**
 * 校验组合分析请求。
 *
 * 为什么限制维度数：`3` 个维度已经是可用上限 —— 每个维度 50 个取值时
 * 组合数就是 12.5 万，页面渲染与查询都会崩。这是**产品约束**，
 * 不是技术偷懒，因此错误消息要讲清楚原因，而不是简单说"参数非法"。
 */
export function validateCombinationRequest(
  requested: string[],
  available: DimensionForCombination[]
): string[] {
  const errors: string[] = [];
  const unique = [...new Set(requested)];
  if (unique.length === 0) {
    errors.push('至少选择 1 个辅助核算维度');
  }
  if (unique.length > MAX_COMBINATION_DIMENSIONS) {
    errors.push(
      `最多同时分析 ${MAX_COMBINATION_DIMENSIONS} 个维度（组合数按维度数指数增长；` +
        `每维度 50 个取值时，4 个维度就是 625 万种组合，页面无法承载）`
    );
  }
  const availableCodes = new Map(available.map((d) => [d.code, d]));
  for (const code of unique) {
    const dimension = availableCodes.get(code);
    if (!dimension) {
      errors.push(`辅助核算维度 ${code} 不存在`);
      continue;
    }
    if (!dimension.enabled) {
      errors.push(`辅助核算维度 ${dimension.name}（${code}）已停用，不能参与组合分析`);
    }
  }
  return errors;
}

/**
 * 跨维度对比：把两个维度各自的余额并列，并给出"结构占比"。
 *
 * 用途：回答"研发部的成本里，人力占多少、外协占多少"这类结构问题。
 * 占比以**本维度合计**为分母（不是全公司合计），否则小部门占比永远接近 0，
 * 看不出结构。
 */
export interface CrossDimensionRow {
  dimensionCode: string;
  dimensionValue: string;
  balance: number;
  /** 占该维度合计的百分比 */
  shareOfDimension: number;
}

export function buildCrossDimensionRows(
  rows: Array<{
    dimensionCode: string;
    dimensionValue: string;
    balance: number;
  }>
): {
  rows: CrossDimensionRow[];
  totalsByDimension: Array<{
    dimensionCode: string;
    total: number;
    valueCount: number;
  }>;
} {
  const totals = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const row of rows) {
    const balance = round2(toNumber(row.balance));
    totals.set(row.dimensionCode, round2((totals.get(row.dimensionCode) ?? 0) + balance));
    counts.set(row.dimensionCode, (counts.get(row.dimensionCode) ?? 0) + 1);
  }
  const enriched: CrossDimensionRow[] = rows.map((row) => {
    const total = totals.get(row.dimensionCode) ?? 0;
    const balance = round2(toNumber(row.balance));
    return {
      dimensionCode: row.dimensionCode,
      dimensionValue: row.dimensionValue,
      balance,
      // 分母为 0 时占比记 0，不产生 NaN/Infinity
      shareOfDimension: total === 0 ? 0 : round2((balance / total) * 100),
    };
  });
  return {
    rows: enriched.sort((a, b) => b.balance - a.balance),
    totalsByDimension: [...totals.entries()]
      .map(([dimensionCode, total]) => ({
        dimensionCode,
        total,
        valueCount: counts.get(dimensionCode) ?? 0,
      }))
      .sort((a, b) => a.dimensionCode.localeCompare(b.dimensionCode)),
  };
}

/** 分摊场景下的税额还原（复用 shared/tax 口径，避免各处自己写公式） */
export function netOfTax(gross: number, taxRate?: number | null): number {
  const rate = toNumber(taxRate ?? FALLBACK_RATE);
  return round2((toNumber(gross) * 100) / (100 + rate));
}
