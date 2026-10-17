import React from 'react';
import { EChart } from '@client/src/components/EChart';
import type { EChartsOption } from 'echarts';
import { DataState } from '@client/src/components/DataState';
import { TabsContent } from '@client/src/components/ui/tabs';
import type { BudgetExecution } from '@shared/api.interface';

/**
 * §5.9 / F8：经营看板「预算」Tab（从 `DashboardPage.tsx` 逐字搬出）。
 *
 * ⚠️ F2：`budgetExecutionOption` 是父组件 `useMemo` 的产物（依赖
 * `budgetExecutionList`），这里只透传引用；`budgetExecutionList` 同样取自父组件
 * 的 `useMemo`，因此子组件重渲染不会重建 option。
 */
interface BudgetTabProps {
  budgetExecutionList: BudgetExecution[];
  budgetExecutionOption: EChartsOption;
}

const BudgetTab: React.FC<BudgetTabProps> = ({
  budgetExecutionList,
  budgetExecutionOption,
}) => {
  return (
    <TabsContent value="budget" className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">预算执行率</h2>
        <div className="rounded-lg border bg-card p-4">
          <DataState
            empty={budgetExecutionList.length === 0}
            emptyText="暂无预算执行数据"
          >
            <div role="img" aria-label="预算执行率图">
              <EChart
                option={budgetExecutionOption}
                className="h-[300px] w-full"
              />
            </div>
          </DataState>
        </div>
      </div>
    </TabsContent>
  );
};

export default BudgetTab;
