import React from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { Table, TableColumnsType } from 'antd';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Button } from '@client/src/components/ui/button';
import { financeApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { seriesColor } from '@client/src/theme/tokens';
import { formatMoney } from '@client/src/utils/format';
import type { AgingBucket } from '@shared/api.interface';

const AgingTab: React.FC = () => {
  const { data, loading, error, reload } = useAsyncData<AgingBucket[]>(
    () => financeApi.getAging(),
    [],
  );

  const buckets = data ?? [];
  const option: EChartsOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: '3%', right: '4%', bottom: '20%', containLabel: true },
    xAxis: {
      type: 'category',
      data: buckets.map((b) => b.label),
      boundaryGap: true,
    },
    yAxis: { type: 'value' },
    series: [
      {
        type: 'bar',
        name: '应收金额',
        data: buckets.map((b) => b.amount),
        itemStyle: { color: seriesColor('cost') },
      },
    ],
  };

  const columns: TableColumnsType<AgingBucket> = [
    { title: '账龄区间', dataIndex: 'label', fixed: 'left', width: 200 },
    {
      title: '应收金额',
      dataIndex: 'amount',
      width: 160,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '笔数', dataIndex: 'count', width: 100 },
  ];

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p className="text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reload()}>
            重试
          </Button>
        </p>
      ) : null}
      <div className="rounded-lg border bg-card p-4">
        <SectionTitle>应收账龄分布</SectionTitle>
        {buckets.length > 0 ? (
          <div role="img" aria-label="应收账龄分布图">
            <ReactECharts option={option} theme="ud" className="h-[300px] w-full" />
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            暂无账龄数据，登记应收单据后自动生成
          </p>
        )}
      </div>
      <Table
        columns={columns}
        dataSource={buckets}
        loading={loading}
        rowKey="label"
        scroll={{ x: 500, y: 400 }}
        pagination={{
          pageSize: 10,
          showTotal: (t: number) => `共 ${t} 条`,
        }}
        locale={{ emptyText: '暂无账龄数据，登记应收单据后自动生成' }}
      />
    </div>
  );
};

export default AgingTab;
