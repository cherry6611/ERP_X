import React from 'react';
import { ColumnHelpTitle } from '@client/src/components/erp/ItemHelp';
import { EChart } from '@client/src/components/EChart';
import type { EChartsOption } from 'echarts';
import { Table, TableColumnsType } from 'antd';
import { DataState } from '@client/src/components/DataState';
import { TabsContent } from '@client/src/components/ui/tabs';
import StatCard from '@client/src/components/erp/StatCard';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import ProjectFinancialHealthPanel from './ProjectFinancialHealthPanel';
import type { OverviewStat } from './dashboard-types';
import type {
  AgingBucket,
  CustomerContribution,
  MonthlyTrend,
  ProjectMargin,
  TaxDistributionItem,
} from '@shared/api.interface';

/**
 * §5.9 / F8：经营看板「财务」Tab（从 `DashboardPage.tsx` 逐字搬出）。
 *
 * 两张表的列定义（`marginColumns` / `contributionColumns`）随本 Tab 一起搬 ——
 * 它们只被这里使用。
 *
 * ⚠️ F2：`trendOption` / `agingOption` 是父组件 `useMemo` 的产物，这里**只透传
 * 引用**（引用不变 → `EChart` 不会走 `setOption` 全量重绘）。
 *
 * ⚠️ 毛利表下钻的 `costBreakdowns` 缓存与两个处理器**留在父组件**：那个 state
 * 挂在 `<Tabs>` **之上**，切换 Tab（Radix 会卸载非活动面板）或重新取数时不会
 * 丢；搬进本组件会让「展开过的项目再展开要重新请求」变成新行为。
 */
interface FinanceTabProps {
  trendList: MonthlyTrend[];
  trendOption: EChartsOption;
  agingBuckets: AgingBucket[];
  agingOption: EChartsOption;
  taxDistribution: TaxDistributionItem[] | null;
  statCards: OverviewStat[];
  margins: ProjectMargin[] | null;
  contributions: CustomerContribution[] | null;
  renderCostBreakdown: (record: ProjectMargin) => React.ReactNode;
  handleMarginExpand: (
    expanded: boolean,
    record: ProjectMargin
  ) => Promise<void>;
}

const FinanceTab: React.FC<FinanceTabProps> = ({
  trendList,
  trendOption,
  agingBuckets,
  agingOption,
  taxDistribution,
  statCards,
  margins,
  contributions,
  renderCostBreakdown,
  handleMarginExpand,
}) => {
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
      title: (
        <ColumnHelpTitle
          title="毛利率"
          content="毛利除以已确认收入。收入为 0 时按 0。和报表不一致时，以报表为准。"
        />
      ),
      dataIndex: 'marginRate',
      width: 100,
      render: (v: number) => formatPercent(v),
    },
    {
      title: (
        <ColumnHelpTitle
          title="分摊固定成本"
          content="分到这个项目上的工资、折旧等固定成本。"
        />
      ),
      dataIndex: 'allocatedFixedCost',
      width: 140,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: (
        <ColumnHelpTitle
          title="贡献净额"
          content="毛利再减去分摊到项目上的固定成本。用来看这个项目扣掉公共费用后还剩多少。"
        />
      ),
      dataIndex: 'contributionMargin',
      width: 140,
      align: 'right',
      render: (v: number) => (
        <span className={v >= 0 ? '' : 'text-destructive'}>{formatMoney(v)}</span>
      ),
    },
  ];

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

  return (
    <TabsContent value="finance" className="flex flex-col gap-6">
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 rounded-xl border bg-card p-5 shadow-card xl:col-span-6">
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
        <div className="col-span-12 rounded-xl border bg-card p-5 shadow-card xl:col-span-6">
          <h2 className="mb-3 text-base font-semibold">应收账龄分布</h2>
          <DataState empty={agingBuckets.length === 0} emptyText="暂无应收数据">
            <div role="img" aria-label="应收账龄分布图">
              <EChart
                option={agingOption}
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
              <EChart
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
                  help={card.help}
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
  );
};

export default FinanceTab;
