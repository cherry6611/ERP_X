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
              <EChart
                option={trendOption}
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
  );
};

export default OverviewTab;
