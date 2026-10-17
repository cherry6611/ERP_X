import React from 'react';
import { EChart } from '@client/src/components/EChart';
import type { EChartsOption } from 'echarts';
import {
  CircleDollarSign,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import { DataState } from '@client/src/components/DataState';
import { TabsContent } from '@client/src/components/ui/tabs';
import StatCard from '@client/src/components/erp/StatCard';
import { formatMoney } from '@client/src/utils/format';
import type { HeadcountPoint, HrOverview } from '@shared/api.interface';

/**
 * §5.9 / F8：经营看板「人力」Tab（从 `DashboardPage.tsx` 逐字搬出）。
 *
 * 本组件**不取数**：`hrOverview` 由父组件查询后传入。
 *
 * ⚠️ F2：`hrTrendOption` 是父组件 `useMemo` 的产物（依赖 `hrTrendList`），
 * 这里只透传引用；`hrTrendList` 也取自父组件的 `useMemo`（`hrOverview?.headcountTrend ?? []`），
 * 因此子组件重渲染不会重建 option。
 */
interface HrTabProps {
  hrOverview: HrOverview | null;
  hrTrendList: HeadcountPoint[];
  hrTrendOption: EChartsOption;
}

const HrTab: React.FC<HrTabProps> = ({
  hrOverview,
  hrTrendList,
  hrTrendOption,
}) => {
  return (
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
                  <EChart
                    option={hrTrendOption}
                    className="h-[220px] w-full"
                  />
                </div>
              </DataState>
            </div>
          </>
        ) : null}
      </DataState>
    </TabsContent>
  );
};

export default HrTab;
