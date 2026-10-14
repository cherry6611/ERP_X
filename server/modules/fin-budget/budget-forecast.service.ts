import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, eq, sql } from 'drizzle-orm';
import { erpProjectRevenue, finBudget, finExpenseApply, finExpenseClaim } from '@server/database/schema';
import { unwrapRows } from '@server/common/utils/rows';
import { DictService } from '@server/modules/system-config/dict.service';
import {
  DEFAULT_FORECAST_THRESHOLD,
  DEFAULT_RATIO_TOLERANCE,
  DEFAULT_VARIANCE_THRESHOLD,
  analyzeCapitalBudget,
  analyzeExpenseRatio,
  analyzeVariance,
  forecastBudget,
  type BudgetType,
  type CapitalBudgetInput,
  type ForecastPeriodInput,
} from './budget-forecast-rules';
import type {
  BudgetForecastResult,
  FullBudgetOverview,
} from '@shared/api.interface';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * D-05：全面预算的滚动预测与差异分析。
 *
 * ## 与 C-09 的分工
 *
 * - `FinBudgetService`（C-09）：预算行 CRUD、维度匹配、**承诺**识别、三算表；
 * - `BudgetCommitmentService`（C-09）：孤儿承诺；
 * - 本服务（D-05）：把预算从"费用"扩展到**收入/资本**，并做**滚动预测**与
 *   **差异分析**。
 *
 * 三者共用 `fin_budget` 表，用 `budget_type` 区分类型，避免三张表各写一套匹配逻辑。
 *
 * ## 滚动预测的权威口径
 *
 * `baselineForecast = 已确认期间实际 + 剩余期间预算`。**不是**线性外推历史实际 ——
 * 预算本身就是管理层对未来最好的判断，用历史斜率覆盖它等于用更差的估计
 * 替换更好的估计。趋势外推只在偏差超阈值时**作为提示**给出。
 */
@Injectable()
export class BudgetForecastService {
  private readonly logger = new Logger(BudgetForecastService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly dictService: DictService
  ) {}

  private assertPeriod(period: string | undefined, field = 'period'): string {
    if (!period || !PERIOD_PATTERN.test(period)) {
      throw new BadRequestException(`${field} 必填且格式为 YYYY-MM`);
    }
    return period;
  }

  /** 可配置阈值（键名见 D-05 迁移里的 sys_param 种子） */
  async thresholds(): Promise<{
    forecastThreshold: number;
    varianceThreshold: number;
    ratioTolerance: number;
  }> {
    const [forecastThreshold, varianceThreshold, ratioTolerance] =
      await Promise.all([
        this.dictService.numberParam(
          'budget.forecast_threshold',
          DEFAULT_FORECAST_THRESHOLD
        ),
        this.dictService.numberParam(
          'budget.variance_threshold',
          DEFAULT_VARIANCE_THRESHOLD
        ),
        this.dictService.numberParam(
          'budget.expense_ratio_tolerance',
          DEFAULT_RATIO_TOLERANCE
        ),
      ]);
    return { forecastThreshold, varianceThreshold, ratioTolerance };
  }

  /** 年度内某类型预算的逐月预算额 */
  private async monthlyBudgets(
    year: string,
    budgetType: BudgetType,
    filters: { projectId?: string; departmentId?: string }
  ): Promise<Map<string, number>> {
    const conditions = [
      eq(finBudget.budgetType, budgetType),
      sql`${finBudget.period} LIKE ${`${year}-%`}`,
    ];
    if (filters.projectId) {
      conditions.push(eq(finBudget.projectId, filters.projectId));
    }
    if (filters.departmentId) {
      conditions.push(eq(finBudget.departmentId, filters.departmentId));
    }
    const rows = await this.db
      .select({ period: finBudget.period, amount: finBudget.budgetAmount })
      .from(finBudget)
      .where(and(...conditions))
      .orderBy(asc(finBudget.period));
    const map = new Map<string, number>();
    for (const row of rows) {
      if (!row.period) continue;
      map.set(
        row.period,
        round2((map.get(row.period) ?? 0) + toNumber(row.amount))
      );
    }
    return map;
  }

  /**
   * 费用实际数（按期间）：
   * 已批准报销 + 已批准费用申请 —— 与 C-09 三算表的"实际"口径一致。
   *
   * 口径必须一致：两处各算一次必然漂移，届时三算表与预测页会给出不同数字。
   */
  private async expenseActuals(
    year: string,
    filters: { projectId?: string; departmentId?: string }
  ): Promise<Map<string, number>> {
    const conditions = [
      eq(finExpenseClaim.status, 'approved'),
      sql`to_char(${finExpenseClaim.expenseDate}, 'YYYY') = ${year}`,
    ];
    if (filters.projectId) {
      conditions.push(eq(finExpenseClaim.projectId, filters.projectId));
    }
    if (filters.departmentId) {
      conditions.push(eq(finExpenseClaim.departmentId, filters.departmentId));
    }
    const claimRows = await this.db
      .select({
        period: sql<string>`to_char(${finExpenseClaim.expenseDate}, 'YYYY-MM')`,
        amount: sql<string>`coalesce(sum(${finExpenseClaim.amount}), 0)`,
      })
      .from(finExpenseClaim)
      .where(and(...conditions))
      .groupBy(sql`to_char(${finExpenseClaim.expenseDate}, 'YYYY-MM')`);

    const applyConditions = [
      eq(finExpenseApply.status, 'approved'),
      sql`to_char(${finExpenseApply.expectDate}, 'YYYY') = ${year}`,
    ];
    if (filters.projectId) {
      applyConditions.push(eq(finExpenseApply.projectId, filters.projectId));
    }
    if (filters.departmentId) {
      applyConditions.push(eq(finExpenseApply.departmentId, filters.departmentId));
    }
    const applyRows = await this.db
      .select({
        period: sql<string>`to_char(${finExpenseApply.expectDate}, 'YYYY-MM')`,
        amount: sql<string>`coalesce(sum(${finExpenseApply.amount}), 0)`,
      })
      .from(finExpenseApply)
      .where(and(...applyConditions))
      .groupBy(sql`to_char(${finExpenseApply.expectDate}, 'YYYY-MM')`);

    const map = new Map<string, number>();
    for (const row of [...claimRows, ...applyRows]) {
      if (!row.period) continue;
      map.set(row.period, round2((map.get(row.period) ?? 0) + toNumber(row.amount)));
    }
    return map;
  }

  /**
   * 收入实际数（按期间）：已确认收入的不含税净额。
   *
   * 与 BI 指标中心、D-06 税负率的收入口径一致 —— 同一"营业收入"在三个页面
   * 必须是同一个数，否则业务方会直接质疑系统可信度。
   */
  private async revenueActuals(
    year: string,
    filters: { projectId?: string }
  ): Promise<Map<string, number>> {
    const conditions = [
      eq(erpProjectRevenue.status, 'recognized'),
      sql`${erpProjectRevenue.period} LIKE ${`${year}-%`}`,
    ];
    if (filters.projectId) {
      conditions.push(eq(erpProjectRevenue.projectId, filters.projectId));
    }
    const rows = unwrapRows<{ period: string; total: string | null }>(
      await this.db.execute(sql`
        SELECT r.period AS period,
               coalesce(sum(
                 coalesce(r.amount, 0) * 100.0 / (100.0 + coalesce(c.tax_rate, 6))
               ), 0) AS total
        FROM erp_project_revenue r
        LEFT JOIN erp_contract c ON c.id = r.contract_id
        WHERE r.status = 'recognized'
          AND r.period LIKE ${`${year}-%`}
          ${filters.projectId ? sql`AND r.project_id = ${filters.projectId}::uuid` : sql``}
        GROUP BY r.period
      `)
    );
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.period, round2(toNumber(row.total)));
    }
    return map;
  }

  /**
   * 资本实际数（按期间）。
   *
   * ⚠️ 数据来源限制（**需业务确认**）：系统目前**没有独立的 CAPEX 支出表**，
   * 因此这里用"费用申请中 expenseCategory 以 capex/资本 开头的单据"作为近似。
   * 若贵司走采购订单/固定资产建卡流程，应改为从 `pur_order` + `ast_asset` 取数。
   * 这条限制在接口返回的 `capitalActualSource` 里如实告知前端，不静默取近似值。
   */
  private async capitalActuals(
    year: string,
    filters: { projectId?: string; departmentId?: string }
  ): Promise<{ map: Map<string, number>; isApproximation: boolean }> {
    const conditions = [
      eq(finExpenseApply.status, 'approved'),
      sql`to_char(${finExpenseApply.expectDate}, 'YYYY') = ${year}`,
      sql`(lower(coalesce(${finExpenseApply.expenseCategory}, '')) LIKE 'capex%'
           OR ${finExpenseApply.expenseCategory} LIKE '%资本%')`,
    ];
    if (filters.projectId) {
      conditions.push(eq(finExpenseApply.projectId, filters.projectId));
    }
    if (filters.departmentId) {
      conditions.push(eq(finExpenseApply.departmentId, filters.departmentId));
    }
    const rows = await this.db
      .select({
        period: sql<string>`to_char(${finExpenseApply.expectDate}, 'YYYY-MM')`,
        amount: sql<string>`coalesce(sum(${finExpenseApply.amount}), 0)`,
      })
      .from(finExpenseApply)
      .where(and(...conditions))
      .groupBy(sql`to_char(${finExpenseApply.expectDate}, 'YYYY-MM')`);
    const map = new Map<string, number>();
    for (const row of rows) {
      if (!row.period) continue;
      map.set(row.period, round2(toNumber(row.amount)));
    }
    return { map, isApproximation: true };
  }

  /**
   * 滚动预测（单类型）。
   *
   * @param year 会计年度（YYYY）
   * @param asOf  截止期间（含）；该期间之后视为"未确认"
   */
  async forecast(params: {
    year: string;
    budgetType: BudgetType;
    asOf?: string;
    projectId?: string;
    departmentId?: string;
  }): Promise<BudgetForecastResult> {
    const year = params.year;
    if (!/^\d{4}$/.test(year)) {
      throw new BadRequestException('year 必须为 YYYY');
    }
    const thresholds = await this.thresholds();

    const budgets = await this.monthlyBudgets(year, params.budgetType, {
      projectId: params.projectId,
      departmentId: params.departmentId,
    });
    const actuals =
      params.budgetType === 'expense'
        ? await this.expenseActuals(year, {
            projectId: params.projectId,
            departmentId: params.departmentId,
          })
        : params.budgetType === 'revenue'
          ? await this.revenueActuals(year, { projectId: params.projectId })
          : (await this.capitalActuals(year, {
              projectId: params.projectId,
              departmentId: params.departmentId,
            })).map;

    // 期间集合 = 预算期间 ∪ 实际期间（实际可能发生在没有预算的月份，
    // 漏掉它会让"已发生"金额凭空消失）
    const periods = [...new Set([...budgets.keys(), ...actuals.keys()])].sort();
    const asOf = params.asOf;

    const series: ForecastPeriodInput[] = periods.map((period) => {
      const budget = budgets.get(period) ?? 0;
      const actual = actuals.get(period);
      // asOf 之后的期间视为未确认，即使有实际数也不计入（用于"截至某月"的模拟）
      const confirmed = asOf ? period <= asOf : actual !== undefined;
      return {
        period,
        budget,
        actual: confirmed ? round2(actual ?? 0) : null,
      };
    });

    const forecast = forecastBudget(
      series,
      params.budgetType,
      thresholds.forecastThreshold
    );

    return {
      year,
      // budgetType 由 forecastBudget 随结果返回，因此不再显式重复指定
      asOf: asOf ?? null,
      ...forecast,
      series: series.map((item) => ({
        period: item.period,
        budget: round2(item.budget),
        actual: item.actual === null ? null : round2(item.actual),
        confirmed: item.actual !== null,
      })),
    };
  }

  /**
   * 全面预算总览：三类预算的预测 + 差异 + 收入费用率联动。
   *
   * 一次给出全部三类，因为**费用率必须同时看收入与费用** ——
   * 分两次请求会因期间/过滤条件不一致而算错费用率。
   */
  async overview(params: {
    year: string;
    asOf?: string;
    projectId?: string;
    departmentId?: string;
  }): Promise<FullBudgetOverview> {
    const thresholds = await this.thresholds();
    const [expense, revenue, capital] = await Promise.all([
      this.forecast({ ...params, budgetType: 'expense' }),
      this.forecast({ ...params, budgetType: 'revenue' }),
      this.forecast({ ...params, budgetType: 'capital' }),
    ]);

    // 费用率联动：用**已确认期间的合计**而不是预测值 ——
    // 用预测值算费用率会把"还没发生的事"算进实际结构，误导判断。
    const expenseRatio = analyzeExpenseRatio(
      {
        revenueBudget: this.sumConfirmedBudget(revenue),
        revenueActual: this.sumConfirmedActual(revenue),
        expenseBudget: this.sumConfirmedBudget(expense),
        expenseActual: this.sumConfirmedActual(expense),
      },
      thresholds.ratioTolerance
    );

    const varianceItems = [
      analyzeVariance(
        {
          budgetType: 'expense',
          label: '费用',
          budgetAmount: this.sumConfirmedBudget(expense),
          actualAmount: this.sumConfirmedActual(expense),
        },
        thresholds.varianceThreshold
      ),
      analyzeVariance(
        {
          budgetType: 'revenue',
          label: '收入',
          budgetAmount: this.sumConfirmedBudget(revenue),
          actualAmount: this.sumConfirmedActual(revenue),
        },
        thresholds.varianceThreshold
      ),
    ];

    const capitalAnalysis = analyzeCapitalBudget(
      capital.series.map<CapitalBudgetInput>((item) => ({
        period: item.period,
        budget: item.budget,
        actual: item.confirmed ? item.actual : null,
      }))
    );

    return {
      year: params.year,
      asOf: params.asOf ?? null,
      thresholds,
      forecasts: { expense, revenue, capital },
      expenseRatio,
      variances: varianceItems,
      capitalAnalysis,
      /** 资本实际数的来源是否只是近似（见 capitalActuals 注释） */
      capitalActualIsApproximation: true,
      needsAttention:
        expense.needsAttention ||
        revenue.needsAttention ||
        capitalAnalysis.overspent ||
        expenseRatio.needsAttention ||
        varianceItems.some((item) => item.requiresExplanation),
      generatedAt: new Date().toISOString(),
    };
  }

  private sumConfirmedBudget(result: BudgetForecastResult): number {
    return round2(
      result.series
        .filter((item) => item.confirmed)
        .reduce((sum, item) => sum + item.budget, 0)
    );
  }

  private sumConfirmedActual(result: BudgetForecastResult): number {
    return round2(
      result.series
        .filter((item) => item.confirmed)
        .reduce((sum, item) => sum + (item.actual ?? 0), 0)
    );
  }
}

