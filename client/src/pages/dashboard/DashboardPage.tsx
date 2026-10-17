import React, { useMemo, useState } from 'react';
import {
  Briefcase,
  CircleDollarSign,
  Coins,
  CreditCard,
  FileText,
  HandCoins,
  Landmark,
  Percent,
  Receipt,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import type { EChartsOption } from 'echarts';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import { Tabs, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import { seriesColorMap as seriesColor } from '@client/src/theme/tokens';
import BudgetTab from './components/BudgetTab';
import FinanceTab from './components/FinanceTab';
import HrTab from './components/HrTab';
import OverviewTab from './components/OverviewTab';
import type { OverviewStat } from './components/dashboard-types';
import { biApi, financeApi, finBudgetApi, hrApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import { COST_TYPE_LABELS } from '@client/src/utils/biz-labels';
import type {
  AgingBucket,
  BiProjectCostBreakdownItem,
  BudgetExecution,
  CustomerContribution,
  HrOverview,
  MonthlyTrend,
  ProjectMargin,
} from '@shared/api.interface';

const renderTrendDelta = (delta: number | undefined): React.ReactNode => {
  if (delta === undefined) return undefined;
  const positive = delta >= 0;
  return (
    <span
      className={`flex items-center gap-1 ${
        positive ? 'text-success' : 'text-destructive'
      }`}
    >
      {positive ? (
        <TrendingUp className="h-3 w-3" aria-hidden="true" />
      ) : (
        <TrendingDown className="h-3 w-3" aria-hidden="true" />
      )}
      环比 {positive ? '+' : ''}
      {delta.toFixed(1)}%
    </span>
  );
};

/**
 * §5.9 / F8：本文件现在只做**布局编排**（非空行 720 → 463）。
 *
 * 上一轮的教训是「只搬纯声明不够 —— JSX 才是体量所在」。本轮与前几轮同一办法：
 * **四段 `<TabsContent>` 逐字搬到同目录 `components/`，只去一层缩进**。
 *
 * | 原位置 | 去向 | 承担什么 |
 * |---|---|---|
 * | `overview` 面板 | `components/OverviewTab.tsx` | 预警中心 + 核心指标卡 + 收入成本趋势 |
 * | `finance` 面板 | `components/FinanceTab.tsx` | 趋势/账龄/开票分布三图 + 更多指标 + 毛利排行 + 客户贡献（含两张表的列定义） |
 * | `hr` 面板 | `components/HrTab.tsx` | 五项人数指标 + 近 12 个月在册趋势 |
 * | `budget` 面板 | `components/BudgetTab.tsx` | 预算执行率图 |
 * | `OverviewStat` 类型 | `components/dashboard-types.ts` | 指标卡结构（概览与财务共用） |
 *
 * **本文件保留**：八路数据查询（`useAsyncData`）、四张图的 `option` 及其
 * `useMemo`、环比与 `statCards` 的派生，以及**毛利表下钻的 `costBreakdowns`
 * 缓存与两个处理器** —— 后者刻意留在这层：它挂在 `<Tabs>` **之上**，
 * 因此切换 Tab（Radix 会卸载非活动面板）或点重试重新取数时**缓存不丢**；
 * 搬进 `FinanceTab` 会让「展开过的项目再展开要重新请求」变成新行为。
 *
 * ## F2（§5.3）的 memo 一个都没动
 *
 * 四条 option 的 `useMemo` 与依赖数组**原样留在本文件**
 * （`[trendList]` / `[budgetExecutionList]` / `[hrTrendList]` / `[agingBuckets]`），
 * 子组件**只接收 memo 后的引用**（`trendOption` 等），自己不重建 option ——
 * 引用不变，`echarts-for-react` 就不会走 `setOption` 全量重绘。
 * 传给子组件的四个数组同样取自这些 `useMemo`（供空态判断），引用稳定。
 * ⚠️ 下面几条 F2 说明里写的「694 行」是拆分前的实测值，原文保留未改。
 */
const DashboardPage: React.FC = () => {
  const [costBreakdowns, setCostBreakdowns] = useState<
    Record<string, BiProjectCostBreakdownItem[]>
  >({});
  const {
    data: overview,
    loading,
    error,
    reload,
  } = useAsyncData(() => biApi.getBiOverview(), []);
  const { data: margins } = useAsyncData<ProjectMargin[]>(
    () => biApi.getProjectMargins(),
    [],
  );
  const { data: contributions } = useAsyncData<CustomerContribution[]>(
    () => biApi.getCustomerContributions(),
    [],
  );
  const { data: trends } = useAsyncData<MonthlyTrend[]>(
    () => biApi.getMonthlyTrends(),
    [],
  );
  const { data: taxDistribution } = useAsyncData(
    () => biApi.getTaxDistribution(),
    []
  );
  const { data: aging } = useAsyncData<AgingBucket[]>(() => financeApi.getAging(), []);
  const { data: hrOverview } = useAsyncData<HrOverview>(
    () => hrApi.getHrOverview(),
    [],
  );
  const { data: budgetExecutions } = useAsyncData<BudgetExecution[]>(
    () => finBudgetApi.getExecutions(),
    [],
  );

  /*
   * F2：`?? []` 每次渲染都产生**新数组**，会让下面的 useMemo 每次都失效。
   * 必须先 memo 住数据源本身，option 的 memo 才有意义 —— 这正是
   * `react-hooks/exhaustive-deps` 那条提示的实质。
   */
  const trendList = useMemo(() => trends ?? [], [trends]);
  /*
   * F2（§5.3）：**option 必须 memo**。
   *
   * 原实现把 option 建在组件体内，而本组件是 694 行 + 7 个 `useAsyncData` +
   * 多个 `useState`：**任何 state 变化都会重建 option 对象**。
   * `echarts-for-react` 对新对象引用一律走 `setOption` → 全量 diff 重绘，
   * 于是一次筛选、一次弹窗开关都会让 4~5 张图表整体重绘。
   *
   * 依赖只列**数据源**：option 的其余部分全是常量，不需要参与比较。
   */
  const trendOption: EChartsOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0 },
    grid: { left: '3%', right: '4%', bottom: '20%', containLabel: true },
    xAxis: {
      type: 'category',
      data: trendList.map((t) => t.period),
      boundaryGap: true,
    },
    yAxis: { type: 'value' },
    series: [
      {
        name: '收入',
        type: 'bar',
        data: trendList.map((t) => t.revenue),
        itemStyle: { color: seriesColor.revenueHex },
      },
      {
        name: '成本',
        type: 'bar',
        data: trendList.map((t) => t.cost),
        itemStyle: { color: seriesColor.costHex },
      },
      {
        name: '期间费用',
        type: 'bar',
        data: trendList.map((t) => t.periodExpense),
        itemStyle: { color: seriesColor.alertHex },
      },
    ],
  }), [trendList]);

  const budgetExecutionList = useMemo(() => budgetExecutions ?? [], [budgetExecutions]);
  /*
   * F2（§5.3）：**option 必须 memo**。
   *
   * 原实现把 option 建在组件体内，而本组件是 694 行 + 7 个 `useAsyncData` +
   * 多个 `useState`：**任何 state 变化都会重建 option 对象**。
   * `echarts-for-react` 对新对象引用一律走 `setOption` → 全量 diff 重绘，
   * 于是一次筛选、一次弹窗开关都会让 4~5 张图表整体重绘。
   *
   * 依赖只列**数据源**：option 的其余部分全是常量，不需要参与比较。
   */
  const budgetExecutionOption: EChartsOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0 },
    grid: { left: '3%', right: '4%', bottom: '20%', containLabel: true },
    xAxis: {
      type: 'category',
      data: budgetExecutionList.map((b) => b.period),
      boundaryGap: true,
    },
    yAxis: { type: 'value' },
    series: [
      {
        name: '预算金额',
        type: 'bar',
        data: budgetExecutionList.map((b) => b.budgetAmount),
        itemStyle: { color: seriesColor.revenueHex },
      },
      {
        name: '已执行',
        type: 'bar',
        data: budgetExecutionList.map((b) => b.executedAmount),
        itemStyle: { color: seriesColor.budgetHex },
      },
      {
        name: '在途占用',
        type: 'bar',
        data: budgetExecutionList.map((b) => b.occupiedAmount),
        itemStyle: { color: seriesColor.alertHex },
      },
    ],
  }), [budgetExecutionList]);

  const agingBuckets = useMemo(() => aging ?? [], [aging]);
  const hrTrendList = useMemo(() => hrOverview?.headcountTrend ?? [], [hrOverview]);
  /*
   * F2（§5.3）：**option 必须 memo**。
   *
   * 原实现把 option 建在组件体内，而本组件是 694 行 + 7 个 `useAsyncData` +
   * 多个 `useState`：**任何 state 变化都会重建 option 对象**。
   * `echarts-for-react` 对新对象引用一律走 `setOption` → 全量 diff 重绘，
   * 于是一次筛选、一次弹窗开关都会让 4~5 张图表整体重绘。
   *
   * 依赖只列**数据源**：option 的其余部分全是常量，不需要参与比较。
   */
  const hrTrendOption: EChartsOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    grid: { left: '3%', right: '4%', bottom: '10%', containLabel: true },
    xAxis: {
      type: 'category',
      data: hrTrendList.map((p) => p.month),
      boundaryGap: true,
    },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      {
        name: '在册人数',
        type: 'line',
        data: hrTrendList.map((p) => p.count),
        itemStyle: { color: seriesColor.revenueHex },
        areaStyle: { opacity: 0.1 },
      },
    ],
  }), [hrTrendList]);
  /*
   * F2（§5.3）：**option 必须 memo**。
   *
   * 原实现把 option 建在组件体内，而本组件是 694 行 + 7 个 `useAsyncData` +
   * 多个 `useState`：**任何 state 变化都会重建 option 对象**。
   * `echarts-for-react` 对新对象引用一律走 `setOption` → 全量 diff 重绘，
   * 于是一次筛选、一次弹窗开关都会让 4~5 张图表整体重绘。
   *
   * 依赖只列**数据源**：option 的其余部分全是常量，不需要参与比较。
   */
  const agingOption: EChartsOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    grid: { left: '3%', right: '4%', bottom: '20%', containLabel: true },
    xAxis: {
      type: 'category',
      data: agingBuckets.map((b) => b.label),
      boundaryGap: true,
    },
    yAxis: { type: 'value' },
    series: [
      {
        name: '应收金额',
        type: 'bar',
        data: agingBuckets.map((b) => b.amount),
        itemStyle: { color: seriesColor.costHex },
      },
    ],
  }), [agingBuckets]);

  const handleMarginExpand = async (
    expanded: boolean,
    record: ProjectMargin
  ): Promise<void> => {
    if (!expanded || costBreakdowns[record.projectId]) return;
    try {
      const items = await biApi.getProjectCostBreakdown(record.projectId);
      setCostBreakdowns((prev: Record<string, BiProjectCostBreakdownItem[]>) => ({
        ...prev,
        [record.projectId]: items,
      }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '请求失败';
      toast.error('获取项目成本构成失败', { description: message });
    }
  };

  const renderCostBreakdown = (record: ProjectMargin): React.ReactNode => {
    const items = costBreakdowns[record.projectId];
    return (
      <div className="px-4 py-2">
        <DataState
          loading={!items}
          empty={!!items && items.length === 0}
          emptyText="暂无成本构成数据"
          skeleton="table"
        >
          <table className="w-full max-w-xl text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-4 py-1 font-normal">成本类型</th>
                <th className="px-4 py-1 text-right font-normal">金额</th>
                <th className="px-4 py-1 text-right font-normal">占比</th>
              </tr>
            </thead>
            <tbody>
              {(items ?? []).map((item: BiProjectCostBreakdownItem) => (
                <tr key={item.costType} className="border-t">
                  <td className="px-4 py-1">
                    {COST_TYPE_LABELS[item.costType] ?? item.costType}
                  </td>
                  <td className="px-4 py-1 text-right">{formatMoney(item.totalAmount)}</td>
                  <td className="px-4 py-1 text-right">
                    {(item.ratio ?? 0).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataState>
      </div>
    );
  };

  const computeTrendDelta = (pick: (t: MonthlyTrend) => number): number | undefined => {
    if (trendList.length < 2) return undefined;
    const last = pick(trendList[trendList.length - 1]);
    const prev = pick(trendList[trendList.length - 2]);
    if (prev === 0) return undefined;
    return ((last - prev) / prev) * 100;
  };
  const revenueDelta = computeTrendDelta((t) => t.revenue);
  const costDelta = computeTrendDelta((t) => t.cost);
  const grossDelta = computeTrendDelta((t) => t.revenue - t.cost);
  const periodExpenseDelta = computeTrendDelta((t) => t.periodExpense);

  const statCards: OverviewStat[] = overview
    ? [
        {
          label: '合同总额',
          value: formatMoney(overview.contractAmount),
          icon: FileText,
          tone: 'primary',
        },
        {
          label: '已确认收入',
          value: formatMoney(overview.recognizedRevenue),
          icon: CircleDollarSign,
          tone: 'success',
          delta: renderTrendDelta(revenueDelta),
        },
        {
          label: '已归集成本',
          value: formatMoney(overview.totalCost),
          icon: Coins,
          tone: 'warning',
          delta: renderTrendDelta(costDelta),
        },
        {
          label: '毛利 / 毛利率',
          value: `${formatMoney(overview.grossMargin)} / ${formatPercent(overview.marginRate)}`,
          icon: Percent,
          tone: 'success',
          delta: renderTrendDelta(grossDelta),
        },
        {
          label: '期间费用',
          value: formatMoney(overview.periodExpenseTotal),
          icon: Receipt,
          tone: 'info',
          delta: renderTrendDelta(periodExpenseDelta),
        },
        {
          label: '营业利润',
          value:
            overview.operatingProfit < 0 ? (
              <span className="text-destructive">
                {formatMoney(overview.operatingProfit)}
              </span>
            ) : (
              formatMoney(overview.operatingProfit)
            ),
          icon: Landmark,
          tone: 'primary',
        },
        {
          label: '应收余额',
          value: formatMoney(overview.openArAmount),
          icon: HandCoins,
          tone: 'neutral',
        },
        {
          label: '应付余额',
          value: formatMoney(overview.openApAmount),
          icon: CreditCard,
          tone: 'neutral',
        },
        {
          label: '活跃项目',
          value: String(overview.activeProjectCount),
          icon: Briefcase,
          tone: 'primary',
        },
        {
          label: '生效合同 / 客户数',
          value: `${overview.activeContractCount} / ${overview.customerCount}`,
          icon: Users,
          tone: 'info',
        },
      ]
    : [];

  const coreCards = statCards.slice(0, 4);

  return (
    <PageShell title="经营看板" description="核心经营指标、趋势与分域概览">
      <DataState
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        skeleton="card"
      >
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="finance">财务</TabsTrigger>
            <TabsTrigger value="hr">人力</TabsTrigger>
            <TabsTrigger value="budget">预算</TabsTrigger>
          </TabsList>

          {/*
           * §5.9 / F8：四个 Tab 面板已拆到同目录 `components/`（清单见文件头）。
           *
           * ⚠️ F2：四张图的 option 仍在本组件 `useMemo`，这里**只把引用传下去**；
           * 子组件不重建 option，父组件重渲染（一次 toast、一次行展开、一次重试）
           * 不会让图表整体重绘。
           */}
          <OverviewTab
            coreCards={coreCards}
            trendList={trendList}
            trendOption={trendOption}
          />

          <FinanceTab
            trendList={trendList}
            trendOption={trendOption}
            agingBuckets={agingBuckets}
            agingOption={agingOption}
            taxDistribution={taxDistribution}
            statCards={statCards}
            margins={margins}
            contributions={contributions}
            renderCostBreakdown={renderCostBreakdown}
            handleMarginExpand={handleMarginExpand}
          />

          <HrTab
            hrOverview={hrOverview}
            hrTrendList={hrTrendList}
            hrTrendOption={hrTrendOption}
          />

          <BudgetTab
            budgetExecutionList={budgetExecutionList}
            budgetExecutionOption={budgetExecutionOption}
          />

        </Tabs>
      </DataState>
    </PageShell>
  );
};

export default DashboardPage;
