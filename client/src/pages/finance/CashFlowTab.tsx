import React, { useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import dayjs from 'dayjs';
import { toast } from 'sonner';
import { TrendingUp, Wallet } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { DataState } from '@client/src/components/DataState';
import { SectionTitle } from '@client/src/components/SectionTitle';
import StatCard from '@client/src/components/erp/StatCard';
import { financeApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { seriesColor } from '@client/src/theme/tokens';
import { formatMoney } from '@client/src/utils/format';
import type { CashFlowForecast, CashFlowWeek } from '@shared/api.interface';

const FORECAST_WEEKS = 13;

const formatWeek = (weekStart: string): string => dayjs(weekStart).format('YYYY-MM-DD');

const CashFlowTab: React.FC = () => {
  const { data, loading, error, reload } = useAsyncData<CashFlowForecast>(
    () => financeApi.cashFlowForecast(FORECAST_WEEKS),
    [],
  );

  useEffect(() => {
    if (error) toast.error(`现金流预测加载失败：${error}`);
  }, [error]);

  const weeks: CashFlowWeek[] = data?.weeks ?? [];
  const openingCash: number = data?.openingCash ?? 0;
  const netFlowTotal: number = weeks.reduce(
    (sum: number, w: CashFlowWeek) => sum + w.netFlow,
    0,
  );

  const option: EChartsOption = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['流入', '流出', '累计现金'] },
    grid: { left: '3%', right: '4%', bottom: '10%', containLabel: true },
    xAxis: {
      type: 'category',
      data: weeks.map((w: CashFlowWeek) => formatWeek(w.weekStart)),
      boundaryGap: true,
    },
    yAxis: [
      { type: 'value', name: '周净流' },
      { type: 'value', name: '累计现金' },
    ],
    series: [
      {
        type: 'bar',
        name: '流入',
        data: weeks.map((w: CashFlowWeek) => w.inflow),
        itemStyle: { color: seriesColor('budget') },
      },
      {
        type: 'bar',
        name: '流出',
        data: weeks.map((w: CashFlowWeek) => -w.outflow),
        itemStyle: { color: seriesColor('cost') },
      },
      {
        type: 'line',
        name: '累计现金',
        yAxisIndex: 1,
        data: weeks.map((w: CashFlowWeek) => w.cumulativeCash),
        smooth: true,
        itemStyle: { color: seriesColor('revenue') },
        lineStyle: { color: seriesColor('revenue') },
      },
    ],
  };

  const columns: TableColumnsType<CashFlowWeek> = [
    {
      title: '周起始日',
      dataIndex: 'weekStart',
      fixed: 'left',
      width: 130,
      render: (v: string) => formatWeek(v),
    },
    {
      title: '流入',
      dataIndex: 'inflow',
      width: 150,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '流出',
      dataIndex: 'outflow',
      width: 150,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '净流',
      dataIndex: 'netFlow',
      width: 150,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '累计现金',
      dataIndex: 'cumulativeCash',
      width: 160,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4">
        <StatCard
          label="期初现金"
          value={formatMoney(openingCash)}
          icon={Wallet}
          tone="primary"
          hint="已确认回款 − 已支付"
        />
        <StatCard
          label={`${FORECAST_WEEKS} 周净流合计`}
          value={formatMoney(netFlowTotal)}
          icon={TrendingUp}
          tone={netFlowTotal >= 0 ? 'success' : 'warning'}
          hint={`未来 ${FORECAST_WEEKS} 周流入流出的净额合计`}
        />
      </div>
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !error && weeks.length === 0}
        emptyText="暂无现金流预测数据"
        onRetry={() => void reload()}
        skeleton="table"
      >
        <div className="rounded-lg border bg-card p-4">
          <SectionTitle>未来 {FORECAST_WEEKS} 周现金流预测</SectionTitle>
          <div role="img" aria-label={`未来 ${FORECAST_WEEKS} 周现金流预测图`}>
            <ReactECharts option={option} theme="ud" className="h-[360px] w-full" />
          </div>
        </div>
        <Table
          columns={columns}
          dataSource={weeks}
          rowKey="weekStart"
          scroll={{ x: 740, y: 420 }}
          pagination={{
            pageSize: 13,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: ' ' }}
        />
      </DataState>
      <p className="text-sm text-muted-foreground">
        口径说明：流入=未结应收按账期落周；流出=未付应付、每月工资固定流出（按最近已审批周期）、已审批未付报销；期初现金=已确认回款−已支付
      </p>
    </div>
  );
};

export default CashFlowTab;
