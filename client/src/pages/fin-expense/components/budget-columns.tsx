/**
 * 预算列表的列定义（§5.9 / F8）。
 *
 * 从 `BudgetPanel.tsx` 抽出的 `TableColumnsType<BudgetItem>` 数组。
 *
 * ## 为什么是工厂函数而不是常量
 *
 * 「操作」列的「编辑」按钮闭包了父组件的 `openEdit(record)` —— 它负责**同步**
 * 预置表单并打开弹窗（见 `BudgetPanel.tsx` 的 reset 语义），随父组件每次渲染
 * 而变，常量数组持有不了，故按 `asset-columns.tsx` / `invoice-columns.tsx` /
 * `attendance-columns.tsx` 的同一形态导出 `budgetColumns({ openEdit })`，
 * 由父组件在渲染时调用。
 *
 * ⚠️ 入参名保持父组件的原名 `openEdit`，因此列头文案、宽度、`fixed`、
 * `dataIndex`、`render` 全部**逐字未动**，只多了外层函数与 `return columns;`。
 *
 * ⚠️ **没有**给列定义加 `useMemo`：原文件也没有；加了会改变 antd 表格分页
 * 状态的重置时机，那是行为变更，不是本次拆分的范围。
 */
import { TableColumnsType } from 'antd';
import { Pencil } from 'lucide-react';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import { Button } from '@client/src/components/ui/button';
import { Progress } from '@client/src/components/ui/progress';
import { formatMoney } from '@client/src/utils/format';
import type { BudgetItem } from '@shared/api.interface';

interface BudgetColumnsArgs {
  /** 打开「编辑预算」弹窗并预置该行数据 —— 父组件的 `openEdit`（同步 `form.reset` 后打开） */
  openEdit: (item: BudgetItem) => void;
}

export function budgetColumns({
  openEdit,
}: BudgetColumnsArgs): TableColumnsType<BudgetItem> {
  const columns: TableColumnsType<BudgetItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '期间', dataIndex: 'period', width: 90 },
    {
      title: '部门',
      dataIndex: 'departmentName',
      width: 130,
      render: (v: string | null) => v ?? '不限',
    },
    {
      title: '项目',
      dataIndex: 'projectName',
      width: 180,
      render: (v: string | null, record) =>
        v ?? (record.projectId ? '未知项目' : '不限'),
    },
    { title: '费用科目', dataIndex: 'expenseCategory', width: 120 },
    {
      title: '预算金额',
      dataIndex: 'budgetAmount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '已占用',
      dataIndex: 'occupiedAmount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '已执行',
      dataIndex: 'executedAmount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '可用金额',
      dataIndex: 'availableAmount',
      width: 130,
      align: 'right',
      render: (v: number) => (
        <span className={v < 0 ? 'text-destructive font-medium' : ''}>
          {formatMoney(v)}
        </span>
      ),
    },
    {
      title: '执行率',
      key: 'usage',
      width: 150,
      render: (_v: unknown, record) => {
        const used = record.occupiedAmount + record.executedAmount;
        const rate =
          record.budgetAmount > 0
            ? Math.min(100, (used / record.budgetAmount) * 100)
            : 0;
        return (
          <div className="flex items-center gap-2">
            <Progress value={rate} className="w-16" />
            <span className="text-xs text-muted-foreground">
              {rate.toFixed(0)}%
            </span>
          </div>
        );
      },
    },
    {
      title: '备注',
      dataIndex: 'remark',
      width: 140,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 90,
      render: (_v: unknown, record) => (
        <CanCapabilityWrite capability="finance_write">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openEdit(record)}
            aria-label={`编辑预算 ${record.code}`}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" />
            编辑
          </Button>
        </CanCapabilityWrite>
      ),
    },
  ];
  return columns;
}
