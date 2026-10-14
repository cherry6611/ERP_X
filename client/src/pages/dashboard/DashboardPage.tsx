import React, { useState } from 'react';
import ReactECharts from 'echarts-for-react';
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
  UserCog,
  UserMinus,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { EChartsOption } from 'echarts';
import { Table, TableColumnsType } from 'antd';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import StatCard from '@client/src/components/erp/StatCard';
import { seriesColorMap as seriesColor } from '@client/src/theme/tokens';
import AlertsPanel from './components/AlertsPanel';
import ProjectFinancialHealthPanel from './components/ProjectFinancialHealthPanel';
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

type OverviewStat = {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  tone: 'primary' | 'success' | 'warning' | 'info' | 'neutral';
  delta?: React.ReactNode;
};

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

  const trendList = trends ?? [];
  const trendOption: EChartsOption = {
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
  };

  const budgetExecutionList = budgetExecutions ?? [];
  const budgetExecutionOption: EChartsOption = {
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
  };

  const agingBuckets = aging ?? [];
  const hrTrendList = hrOverview?.headcountTrend ?? [];
  const hrTrendOption: EChartsOption = {
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
  };
  const agingOption: EChartsOption = {
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
  };

  const marginColumns: TableColumnsType<ProjectMargin> = [
    { title: '项目', dataIndex: 'name', fixed: 'left', width: 220, render: (v, record) => (
      <span>
        {record.code} - {v}
      </span>
    ) },
    { title: '项目经理', dataIndex: 'pm', width: 110, render: (v) => v ?? '-' },
    {
      title: '已确认收入',
      dataIndex: 'recognizedRevenue',
      width: 140,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '已归集成本',
      dataIndex: 'totalCost',
      width: 140,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '毛利',
      dataIndex: 'grossMargin',
      width: 140,
      align: 'right',
      render: (v: number) => (
        <span className={v >= 0 ? '' : 'text-destructive'}>{formatMoney(v)}</span>
      ),
    },
    {
      title: '毛利率',
      dataIndex: 'marginRate',
      width: 100,
      render: (v: number) => formatPercent(v),
    },
    {
      title: '分摊固定成本',
      dataIndex: 'allocatedFixedCost',
      width: 140,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '贡献净额',
      dataIndex: 'contributionMargin',
      width: 140,
      align: 'right',
      render: (v: number) => (
        <span className={v >= 0 ? '' : 'text-destructive'}>{formatMoney(v)}</span>
      ),
    },
  ];

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

  const contributionColumns: TableColumnsType<CustomerContribution> = [
    { title: '客户', dataIndex: 'name', fixed: 'left', width: 200 },
    {
      title: '合同金额',
      dataIndex: 'contractAmount',
      width: 140,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '已确认收入',
      dataIndex: 'recognizedRevenue',
      width: 140,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '应收余额',
      dataIndex: 'openArAmount',
      width: 140,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
  ];

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

          <TabsContent value="overview" className="flex flex-col gap-6">
            <AlertsPanel />
            {coreCards.length > 0 ? (
              <section aria-labelledby="dash-kpi">
                <h2 id="dash-kpi" className="mb-3 text-base font-semibold">
                  核心指标
                </h2>
                <div data-ai-section-type="card-stat" className="grid grid-cols-12 gap-4">
                  {coreCards.map((card) => (
                    <div key={card.label} className="col-span-12 md:col-span-6 xl:col-span-3">
                      <StatCard
                        label={card.label}
                        value={card.value}
                        icon={card.icon}
                        tone={card.tone}
                        delta={card.delta}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            <div className="grid grid-cols-12 gap-4">
              <div className="col-span-12 rounded-xl border bg-card p-5 shadow-card xl:col-span-8">
                <h2 className="mb-3 text-base font-semibold">收入成本月度趋势</h2>
                <DataState empty={trendList.length === 0} emptyText="暂无趋势数据">
                  <div role="img" aria-label="收入与成本月度趋势图">
                    <ReactECharts
                      option={trendOption}
                      theme="ud"
                      className="h-[300px] w-full"
                    />
                  </div>
                </DataState>
              </div>
              <div className="col-span-12 flex flex-col gap-3 rounded-xl border bg-card p-5 shadow-card xl:col-span-4">
                <h2 className="text-base font-semibold">分域查看</h2>
                <p className="text-sm text-muted-foreground">
                  毛利、客户贡献与人力预算已拆到对应 Tab，首屏只保留决策核心。
                </p>
                <div className="flex flex-col gap-2">
                  <a className="text-sm font-medium text-primary hover:underline" href="#finance">
                    查看财务明细 →
                  </a>
                  <p className="text-xs text-muted-foreground">
                    使用上方「财务 / 人力 / 预算」标签切换
                  </p>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="finance" className="flex flex-col gap-6">
            <div className="grid grid-cols-12 gap-4">
              <div className="col-span-12 rounded-xl border bg-card p-5 shadow-card xl:col-span-6">
                <h2 className="mb-3 text-base font-semibold">收入成本月度趋势</h2>
                <DataState empty={trendList.length === 0} emptyText="暂无趋势数据">
                  <div role="img" aria-label="收入与成本月度趋势图">
                    <ReactECharts
                      option={trendOption}
                      theme="ud"
                      className="h-[300px] w-full"
                    />
                  </div>
                </DataState>
              </div>
              <div className="col-span-12 rounded-xl border bg-card p-5 shadow-card xl:col-span-6">
                <h2 className="mb-3 text-base font-semibold">应收账龄分布</h2>
                <DataState empty={agingBuckets.length === 0} emptyText="暂无应收数据">
                  <div role="img" aria-label="应收账龄分布图">
                    <ReactECharts
                      option={agingOption}
                      theme="ud"
                      className="h-[300px] w-full"
                    />
                  </div>
                </DataState>
              </div>
              <div className="col-span-12 rounded-xl border bg-card p-5 shadow-card xl:col-span-6">
                <h2 className="mb-3 text-base font-semibold">纳税主体开票分布</h2>
                <DataState
                  empty={(taxDistribution ?? []).length === 0}
                  emptyText="暂无开票分布数据"
                >
                  <div role="img" aria-label="纳税主体开票分布图">
                    <ReactECharts
                      theme="ud"
                      className="h-[300px] w-full"
                      option={{
                        tooltip: { trigger: 'item' },
                        series: [
                          {
                            type: 'pie',
                            radius: ['35%', '65%'],
                            data: (taxDistribution ?? []).map((row) => ({
                              name: row.taxEntityName,
                              value: row.amount,
                            })),
                          },
                        ],
                      }}
                    />
                  </div>
                </DataState>
              </div>
            </div>
            {statCards.length > 4 ? (
              <section aria-labelledby="dash-more-kpi">
                <h2 id="dash-more-kpi" className="mb-3 text-base font-semibold">
                  更多财务指标
                </h2>
                <div className="grid grid-cols-12 gap-4">
                  {statCards.slice(4).map((card) => (
                    <div key={card.label} className="col-span-12 md:col-span-6 xl:col-span-3">
                      <StatCard
                        label={card.label}
                        value={card.value}
                        icon={card.icon}
                        tone={card.tone}
                        delta={card.delta}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            <div className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">项目毛利排行</h2>
              <p className="text-sm text-muted-foreground">点击行展开查看项目成本构成</p>
              <Table
                columns={marginColumns}
                dataSource={margins ?? []}
                rowKey="projectId"
                scroll={{ x: 1150, y: 400 }}
                pagination={false}
                locale={{ emptyText: <DataState empty emptyText="暂无毛利数据" /> }}
                expandable={{
                  expandedRowRender: renderCostBreakdown,
                  onExpand: (expanded: boolean, record: ProjectMargin) => {
                    void handleMarginExpand(expanded, record);
                  },
                }}
              />
            </div>
            <ProjectFinancialHealthPanel />
            <div className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">客户贡献</h2>
              <Table
                columns={contributionColumns}
                dataSource={contributions ?? []}
                rowKey="customerId"
                scroll={{ x: 700, y: 400 }}
                pagination={false}
                locale={{ emptyText: <DataState empty emptyText="暂无客户贡献数据" /> }}
              />
            </div>
          </TabsContent>

          <TabsContent value="hr" className="flex flex-col gap-6">
            <DataState empty={!hrOverview} emptyText="暂无人力数据">
              {hrOverview ? (
                <>
                  <div data-ai-section-type="card-stat" className="grid grid-cols-12 gap-4">
                    <div className="col-span-12 md:col-span-6 xl:col-span-3">
                      <StatCard
                        label="在职人数"
                        value={String(hrOverview.activeCount)}
                        icon={Users}
                        tone="primary"
                      />
                    </div>
                    <div className="col-span-12 md:col-span-6 xl:col-span-3">
                      <StatCard
                        label="试用期人数"
                        value={String(hrOverview.probationCount)}
                        icon={UserCog}
                        tone="info"
                      />
                    </div>
                    <div className="col-span-12 md:col-span-6 xl:col-span-3">
                      <StatCard
                        label="本年入职"
                        value={String(hrOverview.hiredThisYear)}
                        icon={UserPlus}
                        tone="success"
                      />
                    </div>
                    <div className="col-span-12 md:col-span-6 xl:col-span-3">
                      <StatCard
                        label="本年离职"
                        value={String(hrOverview.resignedThisYear)}
                        icon={UserMinus}
                        tone="warning"
                      />
                    </div>
                    <div className="col-span-12 md:col-span-6 xl:col-span-3">
                      <StatCard
                        label="人均创收（近12月）"
                        value={formatMoney(hrOverview.revenuePerHead)}
                        icon={CircleDollarSign}
                        tone="success"
                      />
                    </div>
                  </div>
                  <div className="rounded-lg border bg-card p-4">
                    <h2 className="mb-3 text-lg font-semibold">近 12 个月在册人数趋势</h2>
                    <DataState empty={hrTrendList.length === 0} emptyText="暂无人力趋势">
                      <div role="img" aria-label="近12个月在册人数趋势图">
                        <ReactECharts
                          option={hrTrendOption}
                          theme="ud"
                          className="h-[220px] w-full"
                        />
                      </div>
                    </DataState>
                  </div>
                </>
              ) : null}
            </DataState>
          </TabsContent>

          <TabsContent value="budget" className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">预算执行率</h2>
              <div className="rounded-lg border bg-card p-4">
                <DataState
                  empty={budgetExecutionList.length === 0}
                  emptyText="暂无预算执行数据"
                >
                  <div role="img" aria-label="预算执行率图">
                    <ReactECharts
                      option={budgetExecutionOption}
                      theme="ud"
                      className="h-[300px] w-full"
                    />
                  </div>
                </DataState>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DataState>
    </PageShell>
  );
};

export default DashboardPage;
