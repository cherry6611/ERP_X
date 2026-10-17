import React, { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, RefreshCw, TrendingUp } from 'lucide-react';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import * as budgetApi from '@client/src/api/fin-budget';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { currentBizYear } from '@client/src/utils/format';
import { cn } from '@client/src/lib/utils';
import type {
  BudgetForecastResult,
  BudgetType,
  FullBudgetOverview,
} from '@shared/api.interface';

const BUDGET_TYPE_LABELS: Record<BudgetType, string> = {
  expense: '费用预算',
  revenue: '收入预算',
  capital: '资本预算（CAPEX）',
};

function money(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * D-05：全面预算面板（滚动预测 + 差异分析 + 费用率联动）。
 *
 * ## 界面必须传达的三个口径
 *
 * 1. **基线预测是权威数字**：`实际 + 剩余预算`。趋势外推只在偏差超阈值时
 *    作为**提示**出现，且界面上要明确标注"仅为提示" —— 否则使用者会把
 *    趋势值当成预测结论，等于让历史斜率替管理层做判断。
 * 2. **费用与收入的有利差异方向相反**：差异卡片必须分别着色，
 *    不能统一用"实际 − 预算"标绿/标红（收入欠收会显示为负数却被标成有利）。
 * 3. **资本实际数是近似值**：系统没有独立 CAPEX 支出表，该数字取自
 *    "费用申请中类别含 capex/资本 的已批准单据"。必须显式提示，
 *    否则使用者会以为它是精确值。
 */
const FullBudgetPanel: React.FC = () => {
  /*
   * 时区修正：预算年必须取**业务时区**的年份。
   *
   * 原为 `String(new Date().getFullYear())` —— 浏览器本地时区。元旦前后
   * 跨时区用户会拿到上一年/下一年，而服务端的预算与期间闸门全按
   * Asia/Shanghai，表现为"默认选中的年份查不到数据"。
   * 详见 `utils/format.ts` 的 `currentBizYear`。
   */
  const currentYear = currentBizYear();
  const [year, setYear] = useState(currentYear);
  const [asOf, setAsOf] = useState('');
  const [overview, setOverview] = useState<FullBudgetOverview | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!/^\d{4}$/.test(year)) {
      toast.error('年度必须为 4 位数字（YYYY）');
      return;
    }
    setLoading(true);
    try {
      const data = await budgetApi.getFullBudgetOverview({
        year,
        asOf: asOf || undefined,
      });
      setOverview(data);
      if (data.needsAttention) {
        toast.warning('存在需关注的预算偏差，请查看差异明细');
      } else {
        toast.success(`${year} 年全面预算执行正常`);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, '加载失败'));
    } finally {
      setLoading(false);
    }
  };

  const renderForecast = (forecast: BudgetForecastResult) => (
    <div key={forecast.budgetType} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">
          {BUDGET_TYPE_LABELS[forecast.budgetType]}
        </h4>
        {forecast.needsAttention && (
          <Badge variant="destructive">偏差超阈值</Badge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="全年预算" value={money(forecast.budgetTotal)} />
        <StatCard label="已发生" value={money(forecast.actualToDate)} />
        <StatCard
          label="基线预测（实际+剩余预算）"
          value={money(forecast.baselineForecast)}
          tone="info"
        />
        <StatCard
          label="执行率"
          value={
            forecast.executionRate === null
              ? '—'
              : `${forecast.executionRate.toFixed(2)}%`
          }
          tone={
            forecast.needsAttention
              ? 'warning'
              : forecast.executionRate === null
                ? 'neutral'
                : 'success'
          }
        />
      </div>

      {forecast.trendForecast !== null && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 p-3">
          <AlertTriangle className="h-4 w-4 text-amber-700" />
          <span className="text-sm text-amber-900">
            <strong>趋势提示（仅为提示，非预测值）：</strong>
            若按已确认期间的趋势外推，全年约 {money(forecast.trendForecast)}，
            与基线预测相差 {money(forecast.trendGap ?? 0)}。
            请管理层判断是否需要调整预算。
          </span>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{forecast.message}</p>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr className="text-left">
              <th className="p-2 font-medium">期间</th>
              <th className="p-2 text-right font-medium">预算</th>
              <th className="p-2 text-right font-medium">实际</th>
              <th className="p-2 text-right font-medium">差额</th>
              <th className="p-2 font-medium">状态</th>
            </tr>
          </thead>
          <tbody>
            {forecast.series.map((item) => {
              const diff =
                item.actual === null ? null : item.actual - item.budget;
              return (
                <tr key={item.period} className="border-t">
                  <td className="p-2">{item.period}</td>
                  <td className="p-2 text-right tabular-nums">
                    {money(item.budget)}
                  </td>
                  <td className="p-2 text-right tabular-nums">
                    {item.actual === null ? '—' : money(item.actual)}
                  </td>
                  <td
                    className={cn(
                      'p-2 text-right tabular-nums',
                      diff !== null && Math.abs(diff) > 0.005 && 'font-medium',
                    )}
                  >
                    {diff === null ? '—' : money(diff)}
                  </td>
                  <td className="p-2">
                    {item.confirmed ? (
                      <span className="text-muted-foreground">已确认</span>
                    ) : (
                      <span className="text-muted-foreground">待发生</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">全面预算（D-05）</h3>
          <p className="text-sm text-muted-foreground">
            费用/收入/资本三类预算的滚动预测、差异分析与费用率联动。
            基线预测口径为「已发生 + 剩余预算」—— 预算本身就是对未来最好的判断，
            因此不以历史趋势覆盖它；趋势值仅在偏差超阈值时作为提示给出。
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="grid gap-1">
            <Label className="text-xs" htmlFor="full-budget-year">
              年度
            </Label>
            <Input
              id="full-budget-year"
              className="w-24"
              value={year}
              onChange={(event) => setYear(event.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs" htmlFor="full-budget-as-of">
              截止期间（可选，YYYY-MM）
            </Label>
            <Input
              id="full-budget-as-of"
              className="w-40"
              value={asOf}
              placeholder="保留空=按数据自然截止"
              onChange={(event) => setAsOf(event.target.value)}
            />
          </div>
          <Button type="button" disabled={loading} onClick={() => void load()}>
            {loading ? (
              <RefreshCw className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <TrendingUp className="mr-1 h-4 w-4" />
            )}
            加载
          </Button>
        </div>
      </div>

      {overview && (
        <div className="flex flex-col gap-4">
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            判定阈值（可在「设置 → 参数」调整）：
            预测偏差 {overview.thresholds.forecastThreshold}%、
            差异说明 {overview.thresholds.varianceThreshold}%、
            费用率容差 {overview.thresholds.ratioTolerance} 个百分点。
            {overview.asOf && ` 截止期间：${overview.asOf}。`}
          </div>

          {/* 费用率联动：这是"全面预算"相对"费用预算"的核心增量 */}
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
            <h4 className="text-sm font-semibold">收入费用率联动</h4>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                label="预算费用率"
                value={
                  overview.expenseRatio.budgetRatio === null
                    ? '—'
                    : `${overview.expenseRatio.budgetRatio.toFixed(2)}%`
                }
              />
              <StatCard
                label="实际费用率"
                value={
                  overview.expenseRatio.actualRatio === null
                    ? '—'
                    : `${overview.expenseRatio.actualRatio.toFixed(2)}%`
                }
                tone={overview.expenseRatio.needsAttention ? 'warning' : 'success'}
              />
              <StatCard
                label="偏离（百分点）"
                value={
                  overview.expenseRatio.ratioDelta === null
                    ? '—'
                    : overview.expenseRatio.ratioDelta.toFixed(2)
                }
              />
              <StatCard
                label="需关注"
                value={overview.needsAttention ? '是' : '否'}
                tone={overview.needsAttention ? 'warning' : 'success'}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {overview.expenseRatio.conclusion}
            </p>
            <p className="text-xs text-muted-foreground">
              为什么要看费用率：费用涨 10% 而收入涨 30% 是效率提升，
              费用持平而收入腰斩是严重失控。只看费用绝对值无法区分这两种情况。
            </p>
          </div>

          {/* 差异分析：费用与收入的有利方向相反 */}
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">差异分析</h4>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-2 font-medium">项目</th>
                    <th className="p-2 text-right font-medium">已确认预算</th>
                    <th className="p-2 text-right font-medium">已确认实际</th>
                    <th className="p-2 text-right font-medium">差异</th>
                    <th className="p-2 text-right font-medium">差异率</th>
                    <th className="p-2 font-medium">结论</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.variances.map((item) => (
                    <tr key={item.label} className="border-t">
                      <td className="p-2">{item.label}</td>
                      <td className="p-2 text-right tabular-nums">
                        {money(item.budgetAmount)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {money(item.actualAmount)}
                      </td>
                      <td
                        className={cn(
                          'p-2 text-right tabular-nums',
                          item.favorable ? 'text-emerald-600' : 'text-destructive',
                        )}
                      >
                        {money(item.variance)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {item.varianceRate === null
                          ? '无预算'
                          : `${item.varianceRate.toFixed(2)}%`}
                      </td>
                      <td className="p-2 text-xs">
                        <Badge variant={item.favorable ? 'default' : 'destructive'}>
                          {item.favorable ? '有利' : '不利'}
                        </Badge>
                        {item.requiresExplanation && (
                          <span className="ml-2 text-amber-700">需说明</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              注意：费用与资本的「有利差异」是实际**少于**预算，收入则相反。
              统一按「实际 − 预算」正负判断会把收入欠收标成有利 —— 这是预算分析最常见的错误。
            </p>
          </div>

          {/* CAPEX 特化 */}
          <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold">资本预算（CAPEX）额度</h4>
              {overview.capitalAnalysis.overspent && (
                <Badge variant="destructive">已超支</Badge>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                label="总额度"
                value={money(overview.capitalAnalysis.totalBudget)}
              />
              <StatCard
                label="已支出"
                value={money(overview.capitalAnalysis.totalActual)}
              />
              <StatCard
                label="剩余额度"
                value={money(overview.capitalAnalysis.remaining)}
                tone={overview.capitalAnalysis.overspent ? 'warning' : 'success'}
              />
              <StatCard
                label="额度使用率"
                value={
                  overview.capitalAnalysis.utilizationRate === null
                    ? '—'
                    : `${overview.capitalAnalysis.utilizationRate.toFixed(2)}%`
                }
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {overview.capitalAnalysis.message}
            </p>
            {overview.capitalActualIsApproximation && (
              <p className="text-xs text-amber-700">
                ⚠️ 资本实际数为**近似值**：系统暂无独立 CAPEX 支出表，
                该数字取自「费用申请中类别含 capex/资本 的已批准单据」。
                若贵司走采购订单/固定资产建卡流程，实际支出会高于此数。
              </p>
            )}
          </div>

          {/* 三类预算明细 */}
          <DataBoundary
            loading={false}
            error={null}
            empty={false}
            emptyText=""
          >
            <div className="flex flex-col gap-4">
              <h4 className="text-sm font-semibold">逐月明细</h4>
              {renderForecast(overview.forecasts.expense)}
              {renderForecast(overview.forecasts.revenue)}
              {renderForecast(overview.forecasts.capital)}
            </div>
          </DataBoundary>

          <p className="text-xs text-muted-foreground">
            生成时间：{new Date(overview.generatedAt).toLocaleString('zh-CN')}
          </p>
        </div>
      )}

      {!overview && (
        <p className="text-sm text-muted-foreground">
          点击「加载」查看该年度的全面预算执行情况与滚动预测。
        </p>
      )}
    </div>
  );
};

export default FullBudgetPanel;
