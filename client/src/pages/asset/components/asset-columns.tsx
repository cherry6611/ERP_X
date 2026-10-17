/**
 * 资产列表的列定义
 *
 * §5.9（F8）：从 `AssetPanel.tsx` 抽出的列定义模块（原 `const columns` 数组）。
 *
 * ## 为什么用工厂函数而不是常量
 *
 * 「操作」列的「发起变更」按钮闭包了父组件的入口 `openChangeDialog`（它随父组件
 * 每次渲染而变），常量数组持有不了，故按 `attendance-columns.tsx` / `employee-columns.tsx`
 * 的同一形态导出 `assetColumns({ ... })`，由父组件在渲染时调用。
 * ⚠️ 入参名保持父组件的原名 `openChangeDialog`，因此数组字面量（列头文案、宽度、
 * `fixed`、`dataIndex`、`render`）**逐字未动**，只多了外层函数与 `return`。
 *
 * ⚠️ **没有**给列定义加 `useMemo`：原文件也没有；加了会改变 antd 表格分页/排序
 * 状态的重置时机，那是行为变更，不是本次拆分的范围。
 */
import { TableColumnsType } from 'antd';
import { AssetStatusBadge, ASSET_CATEGORY_LABELS } from './AssetStatusBadge';
import { Button } from '@client/src/components/ui/button';
import { formatMoney } from '@client/src/utils/format';
import type { AssetItem } from '@shared/api.interface';

interface AssetColumnsArgs {
  /** 打开「发起资产变更」弹窗并预置该资产的初始值（父组件 `openChangeDialog`） */
  openChangeDialog: (asset: AssetItem) => void;
}

export function assetColumns({
  openChangeDialog,
}: AssetColumnsArgs): TableColumnsType<AssetItem> {
  const columns: TableColumnsType<AssetItem> = [
    { title: '资产编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '资产名称', dataIndex: 'name', width: 160 },
    {
      title: '类别',
      dataIndex: 'category',
      width: 100,
      render: (v: string) => ASSET_CATEGORY_LABELS[v] ?? v,
    },
    {
      title: '原值',
      dataIndex: 'originalValue',
      width: 110,
      render: (v: number) => formatMoney(v),
    },
    {
      title: '残值',
      dataIndex: 'residualValue',
      width: 100,
      render: (v: number) => formatMoney(v),
    },
    {
      title: '净值',
      dataIndex: 'netValue',
      width: 110,
      render: (v: number) => (
        <span className="font-medium">{formatMoney(v)}</span>
      ),
    },
    {
      title: '归属部门',
      dataIndex: 'departmentName',
      width: 120,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '归属项目',
      dataIndex: 'projectName',
      width: 140,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '采购日期',
      dataIndex: 'purchaseDate',
      width: 110,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '折旧月数',
      dataIndex: 'usefulMonths',
      width: 90,
      render: (v: number) => `${v} 个月`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <AssetStatusBadge status={s} />,
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 110,
      render: (_: unknown, record: AssetItem) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openChangeDialog(record)}
        >
          发起变更
        </Button>
      ),
    },
  ];
  return columns;
}
