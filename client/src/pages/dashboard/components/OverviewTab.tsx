import React from 'react';
import { EChart } from '@client/src/components/EChart';
import type { EChartsOption } from 'echarts';
import { DataState } from '@client/src/components/DataState';
import { TabsContent } from '@client/src/components/ui/tabs';
import StatCard from '@client/src/components/erp/StatCard';
import AlertsPanel from './AlertsPanel';
import type { MonthlyTrend } from '@shared/api.interface';
import type { OverviewStat } from './dashboard-types';

/**
 * §5.9 / F8：经营看板「概览」Tab（从 `DashboardPage.tsx` 逐字搬出）。
 *
 * 本组件**不取数**：数据与图表 option 全由父组件提供，它只负责渲染。
 *
 * ⚠️ F2：`trendOption` 是父组件 `useMemo` 的产物，这里**只透传引用**。
 * 子组件随父组件重渲染时拿到的是同一个对象，`EChart` 的 `option` 引用不变
 * → 不会触发 `setOption` 全量 diff 重绘。**不要**在这里重建 option，也不要
 * 给 `trendList` 加 `?? []`（新数组会让父组件的 `useMemo` 失效 —— 那正是
 * F2 要修的问题）。
 */
interface OverviewTabProps {
  coreCards: OverviewStat[];
  trendList: MonthlyTrend[];
  trendOption: EChartsOption;
}

const OverviewTab: React.FC<OverviewTabProps> = ({
  coreCards,
  trendList,
  trendOption,
}) => {
  return (
    <TabsContent value="overview" className="flex flex-col gap-5">
      {coreCards.length > 0 ? (
        <section aria-labelledby="dash-kpi">
          <div data-ai-section-type="card-stat" className="grid grid-cols-12 gap-3">
            {coreCards.map((card) => (
              <div key={card.label} className="col-span-12 md:col-span-6 xl:col-span-3">
                <StatCard
                  label={card.label}
                  value={card.value}
                  icon={card.icon}
                  tone={card.tone}
                  delta={card.delta}
                  help={card.help}
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 rounded-xl border border-border/80 bg-card xl:col-span-8">
          <div className="flex h-14 items-center justify-between border-b border-border/70 px-5">
            <h2 className="text-[13px] font-semibold">收入、成本与期间费用趋势</h2>
            <a className="text-[11px] font-medium text-primary hover:underline" href="#finance">
              查看财务报表 →
            </a>
          </div>
          <div className="p-4">
            <DataState empty={trendList.length === 0} emptyText="暂无趋势数据">
              <div role="img" aria-label="收入与成本月度趋势图">
                <EChart option={trendOption} className="h-[300px] w-full" />
              </div>
            </DataState>
          </div>
        </div>
        <div className="col-span-12 xl:col-span-4">
          <AlertsPanel />
        </div>
      </div>
    </TabsContent>
  );
};

export default OverviewTab;
