/**
 * D-05：全面预算的规则内核（收入预算 / 资本预算 / 滚动预测 / 差异分析）。
 *
 * ## 从"费用预算"扩展到"全面预算"意味着什么
 *
 * C-09 的预算只覆盖**费用**（`expense_category` + `period`）。全面预算要多两类：
 * - **收入预算**：费用预算是"花多少"，收入预算是"挣多少"；没有收入预算就无法
 *   判断费用率是否合理（同样的费用，收入翻倍时是节省、收入腰斩时是失控）；
 * - **资本预算**（CAPEX）：一次性大额支出（设备、装修、软件许可）与按月费用
 *   性质完全不同 —— 它不按月消耗，而应在**特定期间**整笔占用额度。
 *   混进费用预算会让月度执行率变得毫无意义。
 *
 * ## 滚动预测（rolling forecast）的立场
 *
 * 需求书要"滚动预测"。这里**不做统计学意义上的预测**（不引入回归/时间序列库），
 * 而是做财务上最常用也最可解释的口径：
 *
 * ```
 * 全年预测 = 已确认期间的实际数 + 剩余期间的预算数
 * ```
 *
 * 为什么是这个口径而不是线性外推实际数：**预算本身就是管理层对未来最好的判断**，
 * 用历史斜率去覆盖它，等于用一个更差的估计替掉一个更好的估计。只有在
 * **实际显著偏离预算**（超过阈值）时才提示"按当前趋势全年会超/欠"，并且
 * 明确告诉使用者这是**趋势提示**而非常预测值。这样既不越权替管理层做判断，
 * 又能及时暴露偏差。
 *
 * 因此本模块同时输出两个数：
 * - `baselineForecast`（基线预测 = 实际 + 剩余预算）：**这是权威数字**；
 * - `trendForecast`（趋势外推）：仅当偏差超阈值时给出，**仅作提示**。
 */

import { TAX_RATE_DICTIONARY } from '@shared/tax';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/* ==================== 预算类型 ==================== */

export const BUDGET_TYPES = ['expense', 'revenue', 'capital'] as const;
export type BudgetType = (typeof BUDGET_TYPES)[number];

export const BUDGET_TYPE_LABELS: Record<BudgetType, string> = {
  expense: '费用预算',
  revenue: '收入预算',
  capital: '资本预算（CAPEX）',
};

/**
 * 预算类型的执行口径差异（**这是本模块最重要的设计点**）。
 *
 * | 类型 | 执行方向 | 说明 |
 * |---|---|---|
 * | expense | 越少越好 | 实际 < 预算 = 有利差异 |
 * | revenue | 越多越好 | 实际 > 预算 = 有利差异 |
 * | capital | 越少越好，但**不按月摊** | 一次性支出，只在发生期间占用额度 |
 *
 * 把"方向"显式建模而不是让调用方自己判断正负：费用与收入的有利差异方向
 * **相反**，如果差异分析只算 `实际 − 预算`，收入欠收会显示为"负差异"
 * 却被标成有利 —— 这是预算分析里最常见的错误。
 */
export const BUDGET_TYPE_DIRECTION: Record<BudgetType, 'lower_is_better' | 'higher_is_better'> = {
  expense: 'lower_is_better',
  revenue: 'higher_is_better',
  capital: 'lower_is_better',
};

/* ==================== 差异分析 ==================== */

export interface VarianceInput {
  budgetType: BudgetType;
  label: string;
  budgetAmount: number;
  actualAmount: number;
}

export interface VarianceResult {
  label: string;
  budgetType: BudgetType;
  budgetAmount: number;
  actualAmount: number;
  /** 差异 = 实际 − 预算（正数表示实际更多） */
  variance: number;
  /** 差异率（%）= 差异 / 预算 × 100；预算为 0 时为 null（避免除零得出无意义的大数） */
  varianceRate: number | null;
  /**
   * 是否有利差异。
   * - 费用/资本：实际少于预算 → favorable
   * - 收入：实际多于预算 → favorable
   */
  favorable: boolean;
  /** 可读中文结论，含具体数字 */
  conclusion: string;
  /** 偏差是否超过阈值（默认 10%），超阈值才需要解释 */
  requiresExplanation: boolean;
}

/** 差异率超过该百分比即要求解释（默认 10%） */
export const DEFAULT_VARIANCE_THRESHOLD = 10;

/**
 * 单维度差异分析。
 *
 * `varianceRate` 在预算为 0 时返回 `null` 而非 `Infinity`：预算为 0 而有实际数
 * 是"无预算支出/收入"，这是**性质不同**的问题（应由"孤儿预算"检查覆盖），
 * 乘以 100 得到一个巨大的百分比只会误导使用者。
 */
export function analyzeVariance(
  input: VarianceInput,
  threshold = DEFAULT_VARIANCE_THRESHOLD
): VarianceResult {
  const budgetAmount = round2(toNumber(input.budgetAmount));
  const actualAmount = round2(toNumber(input.actualAmount));
  const variance = round2(actualAmount - budgetAmount);
  const varianceRate =
    budgetAmount === 0 ? null : round2((variance / budgetAmount) * 100);

  const direction = BUDGET_TYPE_DIRECTION[input.budgetType];
  // 差异为 0 视为有利（不构成风险）
  const favorable =
    variance === 0
      ? true
      : direction === 'lower_is_better'
        ? variance < 0
        : variance > 0;

  const requiresExplanation =
    varianceRate === null
      ? actualAmount !== 0 // 无预算但有发生额 → 必须解释
      : Math.abs(varianceRate) > threshold;

  const directionText =
    direction === 'lower_is_better' ? '少于' : '多于';
  const conclusion =
    variance === 0
      ? `${input.label}：实际与预算一致（${budgetAmount.toFixed(2)}）`
      : `${input.label}：实际 ${actualAmount.toFixed(2)} ${variance > 0 ? '多' : '少'}于预算 ${Math.abs(variance).toFixed(2)}` +
        `（${directionText}预算为${favorable ? '有利' : '不利'}差异${varianceRate === null ? '，且本期无预算' : `，差异率 ${varianceRate.toFixed(2)}%`}）`;

  return {
    label: input.label,
    budgetType: input.budgetType,
    budgetAmount,
    actualAmount,
    variance,
    varianceRate,
    favorable,
    conclusion,
    requiresExplanation,
  };
}

/* ==================== 滚动预测 ==================== */

export interface ForecastPeriodInput {
  period: string;
  /** 该期间的预算额 */
  budget: number;
  /**
   * 该期间的实际发生额。
   * `null` 表示期间尚未结束/尚无数据（未来期间）—— 与 `0` 有本质区别：
   * `0` 是"确实是 0"，`null` 是"还不知道"。
   */
  actual: number | null;
}

export interface ForecastResult {
  budgetType: BudgetType;
  /** 已确认（有实际数）的期间 */
  confirmedPeriods: string[];
  /** 未确认（无实际数）的期间 */
  remainingPeriods: string[];
  /** 全年预算合计 */
  budgetTotal: number;
  /** 已发生实际合计 */
  actualToDate: number;
  /** 剩余期间预算合计 */
  remainingBudget: number;
  /**
   * **基线预测 = 实际 + 剩余预算**。这是权威数字。
   */
  baselineForecast: number;
  /** 基线预测 vs 全年预算的差异 */
  baselineVariance: number;
  /**
   * 趋势外推预测：把已确认期间的"实际/预算"比率外推到剩余期间。
   * 仅在偏差超阈值时非 null（否则与基线预测同值就没有意义）。
   */
  trendForecast: number | null;
  /** 趋势预测与基线预测的差（= 按当前趋势会多花/少收多少） */
  trendGap: number | null;
  /** 已确认期间的执行率（%）= 实际 / 预算 */
  executionRate: number | null;
  /** 是否需要关注（偏差超阈值或有未纳入预测的期间） */
  needsAttention: boolean;
  /** 可读中文提示 */
  message: string;
}

/** 偏差超过该百分比才给出趋势预测（默认 10%） */
export const DEFAULT_FORECAST_THRESHOLD = 10;

/**
 * 滚动预测。
 *
 * 关键判断：
 * 1. **没有任何已确认期间** → 基线预测就是全年预算，且**不给趋势预测**
 *    （没有数据支撑任何外推）。此时 `executionRate` 为 null。
 * 2. **已确认期间的偏差在阈值内** → 趋势预测返回 null，`message` 说明
 *    "执行符合预算，按预算口径预测"。给出一个几乎相同的数字只会制造噪音。
 * 3. **偏差超阈值** → 给出趋势预测并**明确标注这是趋势提示而非预测值**，
 *    让使用者知道最终判断权在管理层。
 *
 * 除零保护：`budgetTotal` 为 0 时所有比率返回 null，不产生 Infinity。
 */
export function forecastBudget(
  periods: ForecastPeriodInput[],
  budgetType: BudgetType,
  threshold = DEFAULT_FORECAST_THRESHOLD
): ForecastResult {
  const sorted = [...periods].sort((a, b) => (a.period < b.period ? -1 : 1));
  const confirmed = sorted.filter((item) => item.actual !== null);
  const remaining = sorted.filter((item) => item.actual === null);

  const budgetTotal = round2(
    sorted.reduce((sum, item) => sum + toNumber(item.budget), 0)
  );
  const actualToDate = round2(
    confirmed.reduce((sum, item) => sum + toNumber(item.actual), 0)
  );
  const confirmedBudget = round2(
    confirmed.reduce((sum, item) => sum + toNumber(item.budget), 0)
  );
  const remainingBudget = round2(
    remaining.reduce((sum, item) => sum + toNumber(item.budget), 0)
  );
  const baselineForecast = round2(actualToDate + remainingBudget);
  const baselineVariance = round2(baselineForecast - budgetTotal);

  const executionRate =
    confirmedBudget === 0 ? null : round2((actualToDate / confirmedBudget) * 100);

  let trendForecast: number | null = null;
  let trendGap: number | null = null;
  let message: string;

  if (confirmed.length === 0) {
    message =
      `尚无已确认期间的实际数，基线预测即全年预算 ${budgetTotal.toFixed(2)}；` +
      `因无数据支撑，不提供趋势外推。`;
  } else if (executionRate === null) {
    message =
      `已确认期间没有预算（实际 ${actualToDate.toFixed(2)}），无法计算执行率；` +
      `基线预测 ${baselineForecast.toFixed(2)}（实际 + 剩余预算 ${remainingBudget.toFixed(2)}）。`;
  } else {
    const deviation = round2(executionRate - 100);
    if (Math.abs(deviation) > threshold && remainingBudget !== 0) {
      // 把"实际/预算"比率外推到剩余预算
      const ratio = actualToDate / confirmedBudget;
      trendForecast = round2(actualToDate + remainingBudget * ratio);
      trendGap = round2(trendForecast - baselineForecast);
      message =
        `已确认期间执行率 ${executionRate.toFixed(2)}%（偏离预算 ${deviation > 0 ? '+' : ''}${deviation.toFixed(2)} 个百分点）。` +
        `基线预测 ${baselineForecast.toFixed(2)}（实际 + 剩余预算）；` +
        `**若按当前趋势**全年约 ${trendForecast.toFixed(2)}，` +
        `与基线相差 ${trendGap > 0 ? '+' : ''}${trendGap.toFixed(2)} —— 趋势值仅为提示，请管理层判断是否需要调整预算。`;
    } else {
      message =
        `已确认期间执行率 ${executionRate.toFixed(2)}%，在 ±${threshold}% 阈值内，按预算口径预测全年 ${baselineForecast.toFixed(2)}。`;
    }
  }

  const needsAttention =
    executionRate !== null &&
    Math.abs(round2(executionRate - 100)) > threshold;

  return {
    budgetType,
    confirmedPeriods: confirmed.map((item) => item.period),
    remainingPeriods: remaining.map((item) => item.period),
    budgetTotal,
    actualToDate,
    remainingBudget,
    baselineForecast,
    baselineVariance,
    trendForecast,
    trendGap,
    executionRate,
    needsAttention,
    message,
  };
}

/* ==================== 收入预算与费用率联动 ==================== */

export interface ExpenseRatioInput {
  revenueBudget: number;
  revenueActual: number;
  expenseBudget: number;
  expenseActual: number;
}

export interface ExpenseRatioResult {
  budgetRatio: number | null;
  actualRatio: number | null;
  /** 实际费用率 − 预算费用率（百分点） */
  ratioDelta: number | null;
  /** 可读结论 */
  conclusion: string;
  /** 是否需要关注（实际费用率高于预算费用率且超出容差） */
  needsAttention: boolean;
}

/** 费用率偏离容差（百分点，默认 2） */
export const DEFAULT_RATIO_TOLERANCE = 2;

/**
 * 收入与费用的联动分析（费用率）。
 *
 * 为什么全面预算必须包含收入预算：只看费用绝对值无法判断控费是否有效 ——
 * 费用涨了 10% 而收入涨了 30%，其实是**效率提升**；
 * 费用持平而收入腰斩，其实是**严重失控**。费用率（费用/收入）才是可比口径。
 *
 * 全部比率在收入为 0 时返回 null 并给出可读原因，不产生 Infinity。
 */
export function analyzeExpenseRatio(
  input: ExpenseRatioInput,
  tolerance = DEFAULT_RATIO_TOLERANCE
): ExpenseRatioResult {
  const revenueBudget = round2(Math.max(toNumber(input.revenueBudget), 0));
  const revenueActual = round2(Math.max(toNumber(input.revenueActual), 0));
  const expenseBudget = round2(Math.max(toNumber(input.expenseBudget), 0));
  const expenseActual = round2(Math.max(toNumber(input.expenseActual), 0));

  const budgetRatio =
    revenueBudget === 0 ? null : round2((expenseBudget / revenueBudget) * 100);
  const actualRatio =
    revenueActual === 0 ? null : round2((expenseActual / revenueActual) * 100);

  if (budgetRatio === null || actualRatio === null) {
    const missing =
      revenueBudget === 0 && revenueActual === 0
        ? '收入预算与实际均为 0'
        : revenueBudget === 0
          ? '无收入预算'
          : '本期无收入实际数';
    return {
      budgetRatio,
      actualRatio,
      ratioDelta: null,
      conclusion: `${missing}，无法计算费用率。请先维护收入预算或确认收入数据。`,
      needsAttention: false,
    };
  }

  const ratioDelta = round2(actualRatio - budgetRatio);
  const needsAttention = ratioDelta > tolerance;
  return {
    budgetRatio,
    actualRatio,
    ratioDelta,
    conclusion:
      `费用率：预算 ${budgetRatio.toFixed(2)}% → 实际 ${actualRatio.toFixed(2)}%` +
      `（${ratioDelta > 0 ? '+' : ''}${ratioDelta.toFixed(2)} 个百分点）。` +
      (needsAttention
        ? '实际费用率高于预算，费用增长快于收入，需说明原因。'
        : ratioDelta < -tolerance
          ? '实际费用率低于预算，费用控制好于预期。'
          : '费用率在容差内，结构正常。'),
    needsAttention,
  };
}

/* ==================== 资本预算（CAPEX）特化 ==================== */

export interface CapitalBudgetInput {
  period: string;
  budget: number;
  actual: number | null;
  /** 该期间是否有大额一次性支出计划 */
  isPlannedSpike?: boolean;
}

export interface CapitalBudgetResult {
  /** 已发生一次性支出的期间 */
  spentPeriods: Array<{ period: string; budget: number; actual: number }>;
  totalBudget: number;
  totalActual: number;
  /** 剩余可用额度 */
  remaining: number;
  /**
   * 资本预算的执行率**不以月份为分母**：一次性支出的性质决定了
   * "前 3 个月只花了 10%" 完全正常，按月算执行率会产生大量无意义告警。
   * 因此这里只给"已用额度 / 总额度"以及**已超支**判断。
   */
  utilizationRate: number | null;
  overspent: boolean;
  message: string;
}

/**
 * 资本预算执行分析。
 *
 * 与费用预算的**核心差异**：不做月度执行率、不做趋势外推 ——
 * 一次性支出没有"趋势"可言。只看额度是否够用。
 */
export function analyzeCapitalBudget(
  periods: CapitalBudgetInput[]
): CapitalBudgetResult {
  const totalBudget = round2(
    periods.reduce((sum, item) => sum + toNumber(item.budget), 0)
  );
  const spentPeriods = periods
    .filter((item) => item.actual !== null && toNumber(item.actual) !== 0)
    .map((item) => ({
      period: item.period,
      budget: round2(toNumber(item.budget)),
      actual: round2(toNumber(item.actual)),
    }));
  const totalActual = round2(
    spentPeriods.reduce((sum, item) => sum + item.actual, 0)
  );
  const remaining = round2(totalBudget - totalActual);
  const utilizationRate =
    totalBudget === 0 ? null : round2((totalActual / totalBudget) * 100);
  const overspent = totalActual > totalBudget;

  let message: string;
  if (totalBudget === 0) {
    message = '未维护资本预算，无法评估 CAPEX 额度使用情况。';
  } else if (spentPeriods.length === 0) {
    message = `资本预算总额度 ${totalBudget.toFixed(2)}，本期尚无资本性支出发生。`;
  } else if (overspent) {
    message =
      `资本预算已超支：已支出 ${totalActual.toFixed(2)} / 总额度 ${totalBudget.toFixed(2)}，` +
      `超出 ${Math.abs(remaining).toFixed(2)}。资本性支出超预算需专项审批。`;
  } else {
    message =
      `资本预算已支出 ${totalActual.toFixed(2)} / 总额度 ${totalBudget.toFixed(2)}` +
      `（${utilizationRate?.toFixed(2)}%），剩余 ${remaining.toFixed(2)}。` +
      `注意：CAPEX 为一次性支出，不按月度执行率考核。`;
  }

  return {
    spentPeriods,
    totalBudget,
    totalActual,
    remaining,
    utilizationRate,
    overspent,
    message,
  };
}

/* ==================== 科目表校验（收入预算的科目存在性） ==================== */

/**
 * 可选的收入税率（供收入预算做含税/不含税口径提示）。
 *
 * 为什么需要：收入预算通常按**不含税**编制（与利润表口径一致），
 * 而合同金额常是含税。若两者混用，收入预算会系统性虚高 6%~13%。
 * 这个函数给出税率档位供前端做口径切换，避免各处自己写死。
 */
export function revenueTaxRates(): readonly number[] {
  return TAX_RATE_DICTIONARY;
}
