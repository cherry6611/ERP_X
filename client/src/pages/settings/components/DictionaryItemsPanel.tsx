import React, { useMemo } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@client/src/components/ui/tooltip';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Table, type TableColumnsType } from 'antd';
import type { DictionaryItem } from '@shared/api.interface';

/**
 * 字典项分组列表（§5.9 / F8）。
 *
 * 从 `DictionarySettings.tsx` 抽出的**第一段 JSX**（字典项列定义 `dictColumns` +
 * 分组列表的 `DataBoundary`）+ 只被它消费的 `grouped` 分组 memo：
 * "哪些行可见"与"每列怎么渲染"是同一条链路上的东西，留在页面里等于数据在父、
 * 渲染在子。
 *
 * ⚠️ 行为零变更：搬过来的代码**逐字相同**，只有以下编辑：
 *   ① `DataBoundary` 那段 JSX 整体去一层缩进（6 → 4）；两个 `useMemo`
 *      本来就位于组件体顶层（缩进 2），未动；
 *   ② 父组件标识符 → props（`items` / `typeFilter` / `deletingKey` 同名直传）：
 *      `dicts.loading` → `loading`、`dicts.error` → `error`、
 *      `() => void dicts.reload()` → `onRetry`、`openEdit` → `onEdit`、
 *      `handleDelete` → `onDelete`；
 *   ③ `dictColumns` 的 memo 依赖数组随之改名：
 *      `[openEdit, deletingKey, handleDelete]` → `[onEdit, deletingKey, onDelete]`。
 *
 * **`useCallback` 的不变式依然成立**：父组件的 `openEdit` / `handleDelete` 仍然是
 * `useCallback`（引用稳定），所以这里的 `dictColumns`（useMemo）不会每次渲染失效
 * 重建表头 —— 父组件那两处注释说的就是这个不变式。
 *
 * a11y（§5.10 / P2-3）：本文件不含 `<Label>`（操作列是 `<Button>` + `Tooltip`），
 * 不涉及 `htmlFor` / `id` 配对。
 */

interface DictionaryItemsPanelProps {
  /** 字典项全量（父组件 `dicts.data ?? []`，已按 §5.5 做引用稳定） */
  items: DictionaryItem[];
  /** 字典类型筛选值；`all` 表示不过滤 */
  typeFilter: string;
  loading: boolean;
  error: string | null;
  /** 正在删除的 `${dictType}.${dictKey}`，用于禁用在途删除按钮 */
  deletingKey: string | null;
  onRetry: () => void;
  /** 点击「编辑」→ 父组件 `openEdit`（同步填表后开弹窗） */
  onEdit: (item: DictionaryItem) => void;
  /** 点击「删除」→ 父组件 `handleDelete` */
  onDelete: (item: DictionaryItem) => void;
}

const DictionaryItemsPanel: React.FC<DictionaryItemsPanelProps> = ({
  items,
  typeFilter,
  loading,
  error,
  deletingKey,
  onRetry,
  onEdit,
  onDelete,
}) => {
  const grouped = useMemo(() => {
    const map = new Map<string, DictionaryItem[]>();
    for (const item of items) {
      if (typeFilter !== 'all' && item.dictType !== typeFilter) continue;
      map.set(item.dictType, [...(map.get(item.dictType) ?? []), item]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [items, typeFilter]);

  /** §5.5（F4）：字典项列定义 */
  const dictColumns = useMemo<TableColumnsType<DictionaryItem>>(
    () => [
      {
        title: '字典键',
        dataIndex: 'dictKey',
        width: 180,
        fixed: 'left',
        render: (value: string) => (
          <span className="tabular-nums">{value}</span>
        ),
        sorter: (a, b) => a.dictKey.localeCompare(b.dictKey),
      },
      {
        title: '字典标签',
        dataIndex: 'dictLabel',
        width: 200,
        sorter: (a, b) => a.dictLabel.localeCompare(b.dictLabel, 'zh-Hans-CN'),
      },
      {
        title: '扩展值 extra',
        dataIndex: 'extra',
        width: 200,
        // `ellipsis` 自带 tooltip；原先 `truncate` 静默截断
        ellipsis: true,
        render: (value: string | null) => value ?? '-',
      },
      {
        title: '排序',
        dataIndex: 'sortNo',
        width: 80,
        align: 'right',
        render: (value: number) => <span className="tabular-nums">{value}</span>,
        sorter: (a, b) => Number(a.sortNo ?? 0) - Number(b.sortNo ?? 0),
      },
      {
        title: '启用',
        dataIndex: 'enabled',
        width: 90,
        filters: [
          { text: '启用', value: true },
          { text: '停用', value: false },
        ],
        onFilter: (value, record) => record.enabled === value,
        render: (value: boolean) => (
          <Badge variant={value ? 'success' : 'secondary'}>
            {value ? '启用' : '停用'}
          </Badge>
        ),
      },
      {
        title: '来源',
        dataIndex: 'builtin',
        width: 90,
        filters: [
          { text: '内置', value: true },
          { text: '自定义', value: false },
        ],
        onFilter: (value, record) => record.builtin === value,
        render: (value: boolean) =>
          value ? (
            <Badge variant="info">内置</Badge>
          ) : (
            <Badge variant="outline">自定义</Badge>
          ),
      },
      {
        title: '备注',
        dataIndex: 'remark',
        width: 180,
        ellipsis: true,
        render: (value: string | null) => value ?? '-',
      },
      {
        title: '操作',
        key: 'action',
        width: 160,
        fixed: 'right',
        render: (_value, record) => (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onEdit(record)}
            >
              <Pencil className="size-3" />
              编辑
            </Button>
            {record.builtin ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* span 包裹：disabled 按钮不触发 hover 事件，无法显示 tooltip */}
                  <span className="inline-flex">
                    <Button type="button" variant="ghost" size="sm" disabled>
                      <Trash2 className="size-3" />
                      删除
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>内置字典项不可删除</TooltipContent>
              </Tooltip>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive"
                disabled={deletingKey === `${record.dictType}.${record.dictKey}`}
                onClick={() => void onDelete(record)}
              >
                <Trash2 className="size-3" />
                删除
              </Button>
            )}
          </div>
        ),
      },
    ],
    [onEdit, deletingKey, onDelete],
  );

  return (
    <DataBoundary
      loading={loading}
      error={error}
      skeleton="table"
      empty={!loading && !error && grouped.length === 0}
      emptyText="暂无字典数据；可点击「新增字典项」创建第一个业务字典"
      onRetry={onRetry}
    >
      <div className="flex flex-col gap-6">
        {grouped.map(([dictType, rows]) => (
          <div key={dictType} className="flex flex-col gap-2">
            <SectionTitle>
              {dictType}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                共 {rows.length} 项
              </span>
            </SectionTitle>
            <div className="rounded-lg border bg-card">
              {/*
                §5.5（F4）：字典项表改 antd `<Table>`。
                `extra` 与「备注」原先用 `max-w-* truncate`（静默截断、无 tooltip），
                改用 `ellipsis` 后可悬停看全文。
              */}
              <Table<DictionaryItem>
                columns={dictColumns}
                dataSource={rows}
                rowKey={(row) => `${row.dictType}.${row.dictKey}`}
                size="small"
                scroll={{ x: 1150 }}
                pagination={false}
                locale={{ emptyText: '该字典类型暂无字典项' }}
              />
            </div>
          </div>
        ))}
      </div>
    </DataBoundary>
  );
};

export default DictionaryItemsPanel;
