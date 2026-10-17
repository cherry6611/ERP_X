/**
 * 「结转损益预览」区块：已完成结转提示 + 四个指标卡 + 前置校验清单 + 待结转明细表。
 *
 * §5.9（F8）：从 `YearEndPage.tsx` 的 return 中**整段搬出**（原块就是 `PageShell`
 * 的直接子节点，缩进未动；外层用 Fragment 包住以保持 DOM 结构不变）。
 *
 * ⚠️ **行为零变更**：文案、条件分支、`className`、`DataBoundary` 的参数、
 * 表格分页与空态逐字未动。只把原先闭包捕获的页面值改成 props ——
 * `period` / `data` / `loading` / `error` / `onRetry`（名字与原表达式一一对应），
 * 两个派生量（`items` / `checks`）随代码一起搬进来。
 *
 * ⚠️ `carryColumns` 仍然放在 `useMemo` 里（依赖与原页面一致，都是 `[]`）。
 * 直接写 `columns={buildCarryColumns()}` 会让 antd 每次渲染收到新数组 →
 * 表头重建、排序/筛选状态被重置。
 */
import React, { useMemo } from 'react';
import { Table, type TableColumnsType } from 'antd';
import { CalendarCheck, CheckCircle2, XCircle } from 'lucide-react';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Badge } from '@client/src/components/ui/badge';
import { cn } from '@client/src/lib/utils';
import { formatMoney } from '@client/src/utils/format';
import { buildCarryColumns, type YearEndCarryItem } from './year-end-columns';
import type { PeriodCarryForwardPreview } from '@shared/api.interface';

interface CarryForwardPreviewSectionProps {
  /** 当前筛选期间（仅用于展示提示语，取数不在本组件内） */
  period: string;
  data: PeriodCarryForwardPreview | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

const CarryForwardPreviewSection: React.FC<CarryForwardPreviewSectionProps> = ({
  period,
  data,
  loading,
  error,
  onRetry,
}) => {
  const items = data?.items ?? [];
  const checks = data?.checks ?? [];

  /** §5.5（F4）：年度结转明细列定义 */
  const carryColumns = useMemo<TableColumnsType<YearEndCarryItem>>(
    () => buildCarryColumns(),
    [],
  );

  return (
    <>
      {data?.alreadyCarried ? (
        <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/5 px-4 py-2 text-sm text-success">
          <CheckCircle2 className="size-4" />
          期间 {period} 已完成结转损益（如需调整请先反年结）。
        </div>
      ) : null}

      <DataBoundary
        loading={loading}
        error={error}
        empty={false}
        onRetry={onRetry}
      >
        {data ? (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
              <StatCard
                label="收入合计"
                value={formatMoney(data.totalRevenue)}
                icon={CalendarCheck}
                tone="primary"
                hint="损益类收入科目本期发生额"
              />
              <StatCard
                label="费用合计"
                value={formatMoney(data.totalExpense)}
                icon={CalendarCheck}
                tone="warning"
                hint="成本费用科目本期发生额"
              />
              <StatCard
                label="净利润"
                value={formatMoney(data.netProfit)}
                icon={CalendarCheck}
                tone={data.netProfit >= 0 ? 'success' : 'warning'}
                hint="收入 − 费用（结转至本年利润）"
              />
              <StatCard
                label="可结转状态"
                value={data.canCarry ? '可结转' : '不可结转'}
                icon={data.canCarry ? CheckCircle2 : XCircle}
                tone={data.canCarry ? 'success' : 'neutral'}
                hint={
                  data.canCarry
                    ? '前置校验全部通过'
                    : `存在 ${checks.filter((check) => !check.passed).length} 项前置校验未通过`
                }
              />
            </div>

            <div className="flex flex-col gap-3">
              <SectionTitle>前置校验清单</SectionTitle>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {checks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">本次未返回前置校验项。</p>
                ) : (
                  checks.map((check) => (
                    <div
                      key={check.code}
                      className={cn(
                        'flex flex-col gap-2 rounded-xl border bg-card p-4',
                        check.passed ? 'border-success/30' : 'border-destructive/40',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium">{check.label}</p>
                        <Badge variant={check.passed ? 'success' : 'destructive'}>
                          {check.passed ? '通过' : '不通过'}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{check.message}</p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <SectionTitle>待结转损益科目明细</SectionTitle>
              {items.length === 0 ? (
                <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
                  期间 {period} 无需要结转的损益类科目发生额（收入与费用科目本期均为 0）。
                </p>
              ) : (
                <div className="rounded-lg border bg-card">
                  {/*
                    §5.5（F4）：年度结转明细改 antd `<Table>`。
                    原先用 shadcn `Table`（纯样式表）：无分页/排序/固定列/空态钩子。
                    损益类科目可上百个且金额列需横向滚动 —— 固定「科目编码/科目名称」
                    两列是**可读性**需求（原先滚动后不知道在看哪个科目）。
                  */}
                  <Table<YearEndCarryItem>
                    columns={carryColumns}
                    dataSource={items}
                    rowKey="accountCode"
                    size="small"
                    scroll={{ x: 1000 }}
                    pagination={{
                      pageSize: 50,
                      showSizeChanger: false,
                      showTotal: (total: number) => `共 ${total} 个科目`,
                    }}
                    locale={{ emptyText: '该期间无需要结转的损益类科目' }}
                  />
                </div>
              )}
            </div>
          </div>
        ) : null}
      </DataBoundary>
    </>
  );
};

export default CarryForwardPreviewSection;
