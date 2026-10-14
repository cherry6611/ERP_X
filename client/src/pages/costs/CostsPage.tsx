import React, { useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@client/src/components/ui/toggle-group';
import { costsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { seriesColor } from '@client/src/theme/tokens';
import { formatMoney } from '@client/src/utils/format';
import { CHART_COLORS } from '@client/src/utils/chart-colors';
import type { CostDimension, CostDimensionSummary } from '@shared/api.interface';
import CostsTab from './CostsTab';
import TimesheetsTab from './TimesheetsTab';
import RatesTab from './RatesTab';
import AllocationTab from './AllocationTab';

const DIMENSION_OPTIONS: { value: CostDimension; label: string }[] = [
  { value: 'costType', label: '成本类型' },
  { value: 'department', label: '部门' },
  { value: 'contract', label: '合同' },
  { value: 'period', label: '期间' },
];

const formatMoneyValue = (value: unknown): string => formatMoney(Number(value));

const buildDimensionOption = (
  items: CostDimensionSummary[],
  dimension: CostDimension,
): EChartsOption => {
  if (dimension === 'period') {
    return {
      tooltip: { trigger: 'axis', valueFormatter: formatMoneyValue },
      grid: { left: '3%', right: '4%', bottom: '20%', containLabel: true },
      xAxis: {
        type: 'category',
        data: items.map((item: CostDimensionSummary) => item.label),
        boundaryGap: true,
      },
      yAxis: { type: 'value' },
      series: [
        {
          type: 'bar',
          name: '成本金额',
          data: items.map((item: CostDimensionSummary) => item.amount),
          itemStyle: { color: seriesColor('cost') },
        },
      ],
    };
  }
  return {
    color: CHART_COLORS,
    tooltip: { trigger: 'item', valueFormatter: formatMoneyValue },
    legend: { type: 'scroll', bottom: 0 },
    series: [
      {
        type: 'pie',
        radius: ['40%', '65%'],
        center: ['50%', '45%'],
        data: items.map((item: CostDimensionSummary) => ({
          name: item.label,
          value: item.amount,
        })),
        label: { show: false },
        emphasis: { label: { show: false } },
      },
    ],
  };
};

const CostDimensionAnalysisSection: React.FC = () => {
  const [dimension, setDimension] = useState<CostDimension>('costType');
  const { data, loading, error, reload } = useAsyncData<CostDimensionSummary[]>(
    () => costsApi.fetchCostDimensionSummary(dimension),
    [dimension],
  );

  const items: CostDimensionSummary[] = data ?? [];
  const option = buildDimensionOption(items, dimension);

  const handleDimensionChange = (value: string) => {
    const next = DIMENSION_OPTIONS.find(
      (opt: { value: CostDimension; label: string }) => opt.value === value,
    );
    if (next) setDimension(next.value);
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle>多维成本分析</SectionTitle>
        <ToggleGroup
          type="single"
          variant="outline"
          value={dimension}
          onValueChange={handleDimensionChange}
        >
          {DIMENSION_OPTIONS.map((opt: { value: CostDimension; label: string }) => (
            <ToggleGroupItem
              key={opt.value}
              value={opt.value}
              aria-label={`按${opt.label}分析成本`}
            >
              {opt.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !error && items.length === 0}
        emptyText="暂无成本数据"
        onRetry={() => void reload()}
        skeleton="card"
      >
        <div role="img" aria-label="多维成本分析图">
          <ReactECharts option={option} theme="ud" className="h-[300px] w-full" />
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {items.map((item: CostDimensionSummary) => (
            <div key={item.key} className="flex flex-col rounded-md border bg-background px-3 py-2">
              <span className="truncate text-sm text-muted-foreground" title={item.label}>
                {item.label}
              </span>
              <span className="text-sm font-semibold">{formatMoney(item.amount)}</span>
            </div>
          ))}
        </div>
      </DataState>
    </div>
  );
};

const CostsPage: React.FC = () => {
  const [tab, setTab] = useState('items');
  return (
    <PageShell title="成本核算" description="成本归集六类、工时×费率折算、角色费率与公共成本分摊">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="items">成本归集</TabsTrigger>
          <TabsTrigger value="timesheets">工时登记</TabsTrigger>
          <TabsTrigger value="rates">角色费率</TabsTrigger>
          <TabsTrigger value="allocation">公共分摊</TabsTrigger>
          <TabsTrigger value="analysis">多维分析</TabsTrigger>
        </TabsList>
        <TabsContent value="items">
          <CostsTab />
        </TabsContent>
        <TabsContent value="timesheets">
          <TimesheetsTab />
        </TabsContent>
        <TabsContent value="rates">
          <RatesTab />
        </TabsContent>
        <TabsContent value="allocation">
          <AllocationTab />
        </TabsContent>
        <TabsContent value="analysis">
          <CostDimensionAnalysisSection />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
};

export default CostsPage;
