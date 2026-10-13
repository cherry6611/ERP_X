import React from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { Clock, Coins, Timer, UserCheck, UserMinus, UserPlus, Wallet } from 'lucide-react';
import { DataState } from '@client/src/components/DataState';
import StatCard from '@client/src/components/erp/StatCard';
import { hrApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, formatNumber } from '@client/src/utils/format';
import { CHART_SEMANTIC_COLORS } from '@client/src/utils/chart-colors';
import type {
  DepartmentHeadcount,
  HeadcountPoint,
  HrOverview,
  LaborCostPoint,
} from '@shared/api.interface';

const HrOverviewPanel: React.FC = () => {
  const { data, loading, error, reload } = useAsyncData<HrOverview>(
    () => hrApi.getHrOverview(),
    [],
  );

  const trend: HeadcountPoint[] = data?.headcountTrend ?? [];
  const trendOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: '3%', right: '4%', bottom: '10%', containLabel: true },
    xAxis: {
      type: 'category',
      data: trend.map((p: HeadcountPoint) => p.month),
      boundaryGap: true,
    },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      {
        name: '在职人数',
        type: 'bar',
        data: trend.map((p: HeadcountPoint) => p.count),
        itemStyle: { color: CHART_SEMANTIC_COLORS.primary },
      },
    ],
  };

  const deptData: DepartmentHeadcount[] = data?.departmentDistribution ?? [];
  const deptOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: '3%', right: '4%', bottom: '20%', containLabel: true },
    xAxis: {
      type: 'category',
      data: deptData.map((d: DepartmentHeadcount) => d.departmentName),
      boundaryGap: true,
    },
    yAxis: { type: 'value', minInterval: 1 },
    series: [
      {
        name: '在职人数',
        type: 'bar',
        data: deptData.map((d: DepartmentHeadcount) => d.count),
        itemStyle: { color: CHART_SEMANTIC_COLORS.other },
      },
    ],
  };

  const laborTrend: LaborCostPoint[] = data?.laborCostTrend ?? [];
  const laborOption: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0, type: 'scroll' },
    grid: { left: '3%', right: '4%', bottom: '20%', containLabel: true },
    xAxis: {
      type: 'category',
      data: laborTrend.map((p: LaborCostPoint) => p.period),
      boundaryGap: true,
    },
    yAxis: { type: 'value' },
    series: [
      {
        name: '工资总包',
        type: 'bar',
        data: laborTrend.map((p: LaborCostPoint) => p.payrollCost),
        itemStyle: { color: CHART_SEMANTIC_COLORS.cost },
      },
      {
        name: '项目人力成本',
        type: 'bar',
        data: laborTrend.map((p: LaborCostPoint) => p.projectLaborCost),
        itemStyle: { color: CHART_SEMANTIC_COLORS.warning },
      },
    ],
  };

  return (
    <DataState
      loading={loading}
      error={error}
      empty={!loading && !error && !data}
      emptyText="暂无人力看板数据"
      onRetry={() => void reload()}
      skeleton="card"
    >
      {data ? (
        <div className="flex flex-col gap-6">
          <h3 className="text-base font-semibold">人力看板</h3>
          <div className="grid grid-cols-4 gap-4">
            <StatCard
              label="在职人数"
              value={formatNumber(data.activeCount)}
              icon={UserCheck}
              tone="success"
            />
            <StatCard
              label="试用期人数"
              value={formatNumber(data.probationCount)}
              icon={Clock}
              tone="warning"
            />
            <StatCard
              label="本年入职"
              value={formatNumber(data.hiredThisYear)}
              icon={UserPlus}
              tone="primary"
            />
            <StatCard
              label="本年离职"
              value={formatNumber(data.resignedThisYear)}
              icon={UserMinus}
              tone="neutral"
            />
            <StatCard
              label="人均创收"
              value={formatMoney(data.revenuePerHead)}
              icon={Coins}
              tone="info"
            />
            <StatCard
              label="人力成本(最近周期)"
              value={formatMoney(data.latestLaborCost)}
              hint={data.latestLaborCostPeriod ?? '暂无已审批工资单'}
              icon={Wallet}
              tone="primary"
            />
            <StatCard
              label="人均项目工时(近30天)"
              value={`${formatNumber(data.avgProjectHoursPerHead)} 小时`}
              icon={Timer}
              tone="info"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg border bg-card p-4">
              <p className="text-sm text-muted-foreground">近 12 个月人数趋势</p>
              {trend.length > 0 ? (
                <ReactECharts option={trendOption} theme="ud" className="h-[300px]" />
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  暂无人数趋势数据
                </p>
              )}
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-sm text-muted-foreground">部门人数分布（在职）</p>
              {deptData.length > 0 ? (
                <ReactECharts option={deptOption} theme="ud" className="h-[300px]" />
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  暂无部门人数数据
                </p>
              )}
            </div>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">近 6 个月工资总包 vs 项目人力成本</p>
            {laborTrend.length > 0 ? (
              <ReactECharts option={laborOption} theme="ud" className="h-[300px]" />
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                暂无工资与人力成本数据
              </p>
            )}
          </div>
        </div>
      ) : null}
    </DataState>
  );
};

export default HrOverviewPanel;
