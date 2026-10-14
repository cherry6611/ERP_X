import {
  BUDGET_TYPES,
  DEFAULT_FORECAST_THRESHOLD,
  DEFAULT_RATIO_TOLERANCE,
  DEFAULT_VARIANCE_THRESHOLD,
  analyzeCapitalBudget,
  analyzeExpenseRatio,
  analyzeVariance,
  forecastBudget,
  revenueTaxRates,
  type BudgetType,
} from './budget-forecast-rules';

/**
 * D-05 全面预算规则单测。
 *
 * 重点在三个**财务上不能错**的地方：
 *  1. 费用与收入的"有利差异"方向**相反** —— 差异分析只算 `实际 − 预算`
 *     会把收入欠收标成有利，这是预算分析最常见的错误；
 *  2. 滚动预测的基线口径是"实际 + 剩余预算"，**不是**线性外推实际数
 *     （预算本身就是管理层对未来最好的判断，不应被历史斜率覆盖）；
 *  3. 预算为 0 时比率返回 null 而非 Infinity（无预算有支出是另一类问题）。
 */
describe('D-05 差异分析', () => {
  it('费用预算：实际少于预算 = 有利差异', () => {
    const result = analyzeVariance({
      budgetType: 'expense',
      label: '研发部费用',
      budgetAmount: 100_000,
      actualAmount: 80_000,
    });
    expect(result.variance).toBe(-20_000);
    expect(result.varianceRate).toBe(-20);
    expect(result.favorable).toBe(true);
    expect(result.conclusion).toContain('少');
    expect(result.conclusion).toContain('有利');
  });

  it('费用预算：实际多于预算 = 不利差异', () => {
    const result = analyzeVariance({
      budgetType: 'expense',
      label: '研发部费用',
      budgetAmount: 100_000,
      actualAmount: 130_000,
    });
    expect(result.variance).toBe(30_000);
    expect(result.favorable).toBe(false);
    expect(result.requiresExplanation).toBe(true);
  });

  it('关键回归：收入预算的有利方向与费用相反（实际多于预算才是有利）', () => {
    const revenue = analyzeVariance({
      budgetType: 'revenue',
      label: '营业收入',
      budgetAmount: 1_000_000,
      actualAmount: 1_200_000,
    });
    expect(revenue.variance).toBe(200_000);
    expect(revenue.favorable).toBe(true);

    // 同样"实际多于预算"的金额，在费用口径下是不利的
    const expense = analyzeVariance({
      budgetType: 'expense',
      label: '费用',
      budgetAmount: 1_000_000,
      actualAmount: 1_200_000,
    });
    expect(expense.variance).toBe(200_000);
    expect(expense.favorable).toBe(false);
  });

  it('收入欠收 = 不利差异（最容易标反的情形）', () => {
    const result = analyzeVariance({
      budgetType: 'revenue',
      label: '营业收入',
      budgetAmount: 1_000_000,
      actualAmount: 700_000,
    });
    expect(result.variance).toBe(-300_000);
    expect(result.favorable).toBe(false);
    expect(result.requiresExplanation).toBe(true);
    expect(result.conclusion).toContain('不利');
  });

  it('资本预算按费用口径（越少越好，但性质不同）', () => {
    const result = analyzeVariance({
      budgetType: 'capital',
      label: 'GPU 采购',
      budgetAmount: 500_000,
      actualAmount: 300_000,
    });
    expect(result.favorable).toBe(true);
  });

  it('预算为 0 时差异率返回 null，不产生 Infinity', () => {
    const result = analyzeVariance({
      budgetType: 'expense',
      label: '无预算科目',
      budgetAmount: 0,
      actualAmount: 50_000,
    });
    expect(result.varianceRate).toBeNull();
    expect(Number.isFinite(result.variance)).toBe(true);
    expect(result.requiresExplanation).toBe(true);
    expect(result.conclusion).toContain('无预算');
  });

  it('预算与实际都为 0 → 差异率 null 但无需解释', () => {
    const result = analyzeVariance({
      budgetType: 'expense',
      label: '空科目',
      budgetAmount: 0,
      actualAmount: 0,
    });
    expect(result.varianceRate).toBeNull();
    expect(result.requiresExplanation).toBe(false);
    expect(result.favorable).toBe(true);
  });

  it('差异恰好等于阈值不要求解释（严格大于才算超）', () => {
    expect(DEFAULT_VARIANCE_THRESHOLD).toBe(10);
    const atThreshold = analyzeVariance({
      budgetType: 'expense',
      label: 'X',
      budgetAmount: 100,
      actualAmount: 110,
    });
    expect(atThreshold.varianceRate).toBe(10);
    expect(atThreshold.requiresExplanation).toBe(false);

    const above = analyzeVariance({
      budgetType: 'expense',
      label: 'X',
      budgetAmount: 100,
      actualAmount: 111,
    });
    expect(above.requiresExplanation).toBe(true);
  });

  it('可覆盖阈值', () => {
    const result = analyzeVariance(
      { budgetType: 'expense', label: 'X', budgetAmount: 100, actualAmount: 105 },
      1
    );
    expect(result.requiresExplanation).toBe(true);
  });
});

describe('D-05 滚动预测', () => {
  const year = (actuals: Array<number | null>) =>
    actuals.map((actual, index) => ({
      period: `2026-${String(index + 1).padStart(2, '0')}`,
      budget: 100_000,
      actual,
    }));

  it('无任何实际数 → 基线预测 = 全年预算，且不给趋势预测', () => {
    const result = forecastBudget(year([null, null, null]), 'expense');
    expect(result.budgetTotal).toBe(300_000);
    expect(result.actualToDate).toBe(0);
    expect(result.baselineForecast).toBe(300_000);
    expect(result.trendForecast).toBeNull();
    expect(result.executionRate).toBeNull();
    expect(result.message).toContain('不提供趋势外推');
  });

  it('关键口径：基线预测 = 实际 + 剩余预算（不是外推实际数）', () => {
    const result = forecastBudget(
      year([120_000, 110_000, 100_000, null, null, null]),
      'expense'
    );
    // 实际 330,000 + 剩余预算 300,000 = 630,000
    expect(result.actualToDate).toBe(330_000);
    expect(result.remainingBudget).toBe(300_000);
    expect(result.baselineForecast).toBe(630_000);
    expect(result.confirmedPeriods).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
    ]);
    expect(result.remainingPeriods).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
  });

  it('执行率在阈值内 → 不给趋势预测（避免制造噪音）', () => {
    // 已确认预算 300,000，实际 305,000 → 101.67%，偏差 1.67% < 10%
    const result = forecastBudget(
      year([100_000, 100_000, 105_000, null, null, null]),
      'expense'
    );
    expect(result.executionRate).toBe(101.67);
    expect(result.trendForecast).toBeNull();
    expect(result.needsAttention).toBe(false);
    expect(result.message).toContain('阈值内');
  });

  it('执行率超阈值 → 给出趋势预测，并明确标注"仅为提示"', () => {
    // 已确认预算 300,000，实际 360,000 → 120%
    const result = forecastBudget(
      year([120_000, 120_000, 120_000, null, null, null]),
      'expense'
    );
    expect(result.executionRate).toBe(120);
    expect(result.needsAttention).toBe(true);
    // 趋势外推：360,000 + 300,000 × 1.2 = 720,000
    expect(result.trendForecast).toBe(720_000);
    expect(result.trendGap).toBe(720_000 - result.baselineForecast);
    expect(result.message).toContain('仅为提示');
    expect(result.message).toContain('请管理层判断');
  });

  it('已确认期间无预算 → 执行率 null，但基线预测仍可用', () => {
    const periods = [
      { period: '2026-01', budget: 0, actual: 50_000 },
      { period: '2026-02', budget: 80_000, actual: null },
    ];
    const result = forecastBudget(periods, 'expense');
    expect(result.executionRate).toBeNull();
    expect(result.baselineForecast).toBe(130_000);
    expect(result.trendForecast).toBeNull();
    expect(result.message).toContain('无法计算执行率');
  });

  it('actual = 0 是"确实是 0"，与 null（未知）区分', () => {
    const result = forecastBudget(
      [
        { period: '2026-01', budget: 100, actual: 0 },
        { period: '2026-02', budget: 100, actual: null },
      ],
      'expense'
    );
    expect(result.confirmedPeriods).toEqual(['2026-01']);
    expect(result.actualToDate).toBe(0);
    // 基线 = 0 + 剩余预算 100
    expect(result.baselineForecast).toBe(100);
  });

  it('期间顺序打乱也不影响结果（内部排序）', () => {
    const result = forecastBudget(
      [
        { period: '2026-03', budget: 100, actual: null },
        { period: '2026-01', budget: 100, actual: 120 },
        { period: '2026-02', budget: 100, actual: 130 },
      ],
      'expense'
    );
    expect(result.confirmedPeriods).toEqual(['2026-01', '2026-02']);
    expect(result.remainingPeriods).toEqual(['2026-03']);
  });

  it('剩余预算为 0 时不做趋势外推（外推没有对象）', () => {
    const result = forecastBudget(
      [
        { period: '2026-01', budget: 100, actual: 200 },
        { period: '2026-02', budget: 0, actual: null },
      ],
      'expense'
    );
    expect(result.executionRate).toBe(200);
    expect(result.trendForecast).toBeNull();
  });

  it('空期间列表 → 全 0，不抛错', () => {
    const result = forecastBudget([], 'revenue');
    expect(result.budgetTotal).toBe(0);
    expect(result.baselineForecast).toBe(0);
    expect(Number.isFinite(result.baselineVariance)).toBe(true);
  });

  it('收入预算同样适用（基线口径与类型无关）', () => {
    const result = forecastBudget(
      [
        { period: '2026-01', budget: 500_000, actual: 400_000 },
        { period: '2026-02', budget: 500_000, actual: null },
      ],
      'revenue'
    );
    expect(result.baselineForecast).toBe(900_000);
    expect(result.budgetTotal).toBe(1_000_000);
    expect(result.baselineVariance).toBe(-100_000);
  });

  it('可覆盖预测阈值', () => {
    const result = forecastBudget(
      [
        { period: '2026-01', budget: 100, actual: 105 },
        { period: '2026-02', budget: 100, actual: null },
      ],
      'expense',
      2 // 阈值 2% → 5% 超阈值
    );
    expect(result.trendForecast).not.toBeNull();
  });

  it('默认阈值为 10%', () => {
    expect(DEFAULT_FORECAST_THRESHOLD).toBe(10);
  });
});

describe('D-05 收入费用率联动', () => {
  it('费用涨得比收入慢 → 费用率下降，结论为"控制好于预期"', () => {
    const result = analyzeExpenseRatio({
      revenueBudget: 1_000_000,
      revenueActual: 1_300_000,
      expenseBudget: 300_000,
      expenseActual: 330_000,
    });
    // 预算费用率 30%，实际 25.38%
    expect(result.budgetRatio).toBe(30);
    expect(result.actualRatio).toBe(25.38);
    expect(result.ratioDelta).toBe(-4.62);
    expect(result.needsAttention).toBe(false);
    expect(result.conclusion).toContain('控制好于预期');
  });

  it('关键场景：费用持平但收入腰斩 → 费用率飙升，需关注', () => {
    const result = analyzeExpenseRatio({
      revenueBudget: 1_000_000,
      revenueActual: 500_000,
      expenseBudget: 300_000,
      expenseActual: 300_000,
    });
    expect(result.actualRatio).toBe(60);
    expect(result.ratioDelta).toBe(30);
    expect(result.needsAttention).toBe(true);
    expect(result.conclusion).toContain('费用增长快于收入');
  });

  it('无收入预算 → 比率 null 且给出可读原因', () => {
    const result = analyzeExpenseRatio({
      revenueBudget: 0,
      revenueActual: 500_000,
      expenseBudget: 100_000,
      expenseActual: 120_000,
    });
    expect(result.budgetRatio).toBeNull();
    expect(result.ratioDelta).toBeNull();
    expect(result.conclusion).toContain('无收入预算');
    expect(result.needsAttention).toBe(false);
  });

  it('本期无收入实际数 → 比率 null 且给出可读原因', () => {
    const result = analyzeExpenseRatio({
      revenueBudget: 1_000_000,
      revenueActual: 0,
      expenseBudget: 300_000,
      expenseActual: 0,
    });
    expect(result.actualRatio).toBeNull();
    expect(result.conclusion).toContain('无收入实际数');
  });

  it('收入预算与实际均为 0 → 提示先维护预算', () => {
    const result = analyzeExpenseRatio({
      revenueBudget: 0,
      revenueActual: 0,
      expenseBudget: 0,
      expenseActual: 0,
    });
    expect(result.conclusion).toContain('收入预算与实际均为 0');
  });

  it('容差内不报警（默认 2 个百分点）', () => {
    expect(DEFAULT_RATIO_TOLERANCE).toBe(2);
    const result = analyzeExpenseRatio({
      revenueBudget: 1_000_000,
      revenueActual: 1_000_000,
      expenseBudget: 300_000,
      expenseActual: 310_000,
    });
    expect(result.ratioDelta).toBe(1);
    expect(result.needsAttention).toBe(false);
    expect(result.conclusion).toContain('结构正常');
  });

  it('负数收入被夹到 0（不产生负费用率）', () => {
    const result = analyzeExpenseRatio({
      revenueBudget: -100,
      revenueActual: -200,
      expenseBudget: 10,
      expenseActual: 10,
    });
    expect(result.budgetRatio).toBeNull();
    expect(result.actualRatio).toBeNull();
  });
});

describe('D-05 资本预算特化', () => {
  it('不做月度执行率，只看额度是否够用', () => {
    const result = analyzeCapitalBudget([
      { period: '2026-01', budget: 200_000, actual: 20_000 },
      { period: '2026-02', budget: 200_000, actual: null },
      { period: '2026-03', budget: 200_000, actual: null },
    ]);
    expect(result.totalBudget).toBe(600_000);
    expect(result.totalActual).toBe(20_000);
    expect(result.remaining).toBe(580_000);
    expect(result.utilizationRate).toBe(3.33);
    expect(result.overspent).toBe(false);
    expect(result.message).toContain('不按月度执行率考核');
    // 不应产生任何"执行率过低"的告警
    expect(result.message).not.toContain('低于');
  });

  it('超支 → 明确提示需专项审批', () => {
    const result = analyzeCapitalBudget([
      { period: '2026-01', budget: 200_000, actual: 250_000 },
    ]);
    expect(result.overspent).toBe(true);
    expect(result.remaining).toBe(-50_000);
    expect(result.message).toContain('超出 50000.00');
    expect(result.message).toContain('专项审批');
  });

  it('无资本支出 → 提示尚无发生', () => {
    const result = analyzeCapitalBudget([
      { period: '2026-01', budget: 200_000, actual: null },
      { period: '2026-02', budget: 200_000, actual: 0 },
    ]);
    expect(result.spentPeriods).toEqual([]);
    expect(result.message).toContain('尚无资本性支出');
  });

  it('未维护预算 → 明确提示无法评估（而不是显示 0% 使用率）', () => {
    const result = analyzeCapitalBudget([
      { period: '2026-01', budget: 0, actual: 50_000 },
    ]);
    expect(result.utilizationRate).toBeNull();
    expect(result.message).toContain('未维护资本预算');
    expect(result.overspent).toBe(true);
  });

  it('空列表 → 全 0，不抛错', () => {
    const result = analyzeCapitalBudget([]);
    expect(result.totalBudget).toBe(0);
    expect(result.totalActual).toBe(0);
    expect(result.message).toContain('未维护资本预算');
  });
});

describe('D-05 预算类型', () => {
  it('三种类型齐全且有中文标签', () => {
    expect(BUDGET_TYPES).toEqual(['expense', 'revenue', 'capital']);
  });

  it('收入税率档位来自 shared/tax（避免各处写死）', () => {
    const rates = revenueTaxRates();
    expect(rates).toContain(6);
    expect(rates).toContain(13);
    // 应为只读档位而非任意值
    expect(rates.length).toBeLessThan(10);
  });
});
