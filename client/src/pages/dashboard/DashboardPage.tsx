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
import StatCard from '@client/src/components/erp/StatCard';
import { CHART_COLORS, CHART_SEMANTIC_COLORS } from '@client/src/utils/chart-colors';
import AlertsPanel from './components/AlertsPanel';
import ProjectFinancialHealthPanel from './components/ProjectFinancialHealthPanel';
import { Button } from '@/components/ui/button';
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
        positive ? 'text-emerald-600' : 'text-red-600'
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
        itemStyle: { color: CHART_COLORS[0] },
      },
      {
        name: '成本',
        type: 'bar',
        data: trendList.map((t) => t.cost),
        itemStyle: { color: CHART_SEMANTIC_COLORS.warning },
      },
      {
        name: '期间费用',
        type: 'bar',
        data: trendList.map((t) => t.periodExpense),
        itemStyle: { color: CHART_COLORS[4] },
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
        itemStyle: { color: CHART_COLORS[0] },
      },
      {
        name: '已执行',
        type: 'bar',
        data: budgetExecutionList.map((b) => b.executedAmount),
        itemStyle: { color: CHART_SEMANTIC_COLORS.success },
      },
      {
        name: '在途占用',
        type: 'bar',
        data: budgetExecutionList.map((b) => b.occupiedAmount),
        itemStyle: { color: CHART_COLORS[4] },
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
        itemStyle: { color: CHART_SEMANTIC_COLORS.success },
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
        itemStyle: { color: CHART_SEMANTIC_COLORS.danger },
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
    if (!items) {
      return <p className="px-4 py-2 text-sm text-muted-foreground">加载中...</p>;
    }
    if (items.length === 0) {
      return (
        <p className="px-4 py-2 text-sm text-muted-foreground">暂无成本构成数据</p>
      );
    }
    return (
      <table className="w-full max-w-xl text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="px-4 py-1 font-normal">成本类型</th>
            <th className="px-4 py-1 text-right font-normal">金额</th>
            <th className="px-4 py-1 text-right font-normal">占比</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item: BiProjectCostBreakdownItem) => (
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

  return (
    <PageShell title="BI 经营看板" description="核心经营指标、项目毛利排行、客户贡献与收入成本趋势">
      {error ? (
        <p className="text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reload()}>
            重试
          </Button>
        </p>
      ) : null}
      {loading ? <p className="text-sm text-muted-foreground">加载中...</p> : null}
      <AlertsPanel />
      {overview ? (
        <div data-ai-section-type="card-stat" className="grid grid-cols-4 gap-4">
          {statCards.map((card) => (
            <StatCard
              key={card.label}
              label={card.label}
              value={card.value}
              icon={card.icon}
              tone={card.tone}
              delta={card.delta}
            />
          ))}
        </div>
      ) : null}
      {hrOverview ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-base font-semibold">人力概览</h3>
          <div data-ai-section-type="card-stat" className="grid grid-cols-5 gap-4">
            <StatCard
              label="在职人数"
              value={String(hrOverview.activeCount)}
              icon={Users}
              tone="primary"
            />
            <StatCard
              label="试用期人数"
              value={String(hrOverview.probationCount)}
              icon={UserCog}
              tone="info"
            />
            <StatCard
              label="本年入职"
              value={String(hrOverview.hiredThisYear)}
              icon={UserPlus}
              tone="success"
            />
            <StatCard
              label="本年离职"
              value={String(hrOverview.resignedThisYear)}
              icon={UserMinus}
              tone="warning"
            />
            <StatCard
              label="人均创收（近12月）"
              value={formatMoney(hrOverview.revenuePerHead)}
              icon={CircleDollarSign}
              tone="success"
            />
          </div>
          <div className="rounded-lg border bg-card p-4">
            <h4 className="text-sm font-semibold text-muted-foreground">近 12 个月在册人数趋势</h4>
            {hrTrendList.length > 0 ? (
              <ReactECharts option={hrTrendOption} theme="ud" className="h-[220px] w-full" />
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">暂无人力数据</p>
            )}
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">预算执行率</h3>
        {budgetExecutionList.length > 0 ? (
          <div className="rounded-lg border bg-card p-4">
            <ReactECharts
              option={budgetExecutionOption}
              theme="ud"
              className="h-[300px] w-full"
            />
          </div>
        ) : (
          <div className="rounded-lg border bg-card p-4">
            <p className="py-16 text-center text-sm text-muted-foreground">
              暂无预算执行数据
            </p>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-base font-semibold">收入成本月度趋势</h3>
          {trendList.length > 0 ? (
            <ReactECharts option={trendOption} theme="ud" className="h-[300px] w-full" />
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">暂无趋势数据</p>
          )}
        </div>
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-base font-semibold">应收账龄分布</h3>
          {agingBuckets.length > 0 ? (
            <ReactECharts option={agingOption} theme="ud" className="h-[300px] w-full" />
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">暂无应收数据</p>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">项目毛利排行</h3>
        <p className="text-sm text-muted-foreground">点击行展开查看项目成本构成</p>
        <Table
          columns={marginColumns}
          dataSource={margins ?? []}
          rowKey="projectId"
          scroll={{ x: 1150, y: 400 }}
          pagination={false}
          locale={{
            emptyText: '暂无毛利数据，请在项目与收入模块维护后查看',
          }}
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
        <h3 className="text-base font-semibold">客户贡献</h3>
        <Table
          columns={contributionColumns}
          dataSource={contributions ?? []}
          rowKey="customerId"
          scroll={{ x: 700, y: 400 }}
          pagination={false}
          locale={{
            emptyText: '暂无客户贡献数据，请在客户与合同模块维护后查看',
          }}
        />
      </div>
    </PageShell>
  );
};

export default DashboardPage;
