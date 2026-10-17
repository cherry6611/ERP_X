/**
 * 凭证列表筛选区（§5.9 / F8）。
 *
 * 从 `VoucherPanel.tsx` 抽出的**受控**筛选条：三个 `<Select>` 的值与
 * `onValueChange` 都来自父组件（筛选值同时驱动父组件的数据查询，所以 state
 * 必须留在父组件，否则 `useAsyncData` 的 deps 与查询都要跟着搬）。
 *
 * ⚠️ 每个筛选的 `onValueChange` 里都带 `setPage(1)`（换筛选条件要回到第 1 页），
 * 它现在由父组件以 `resetPage` 传入 —— **调用次数与顺序未变**：
 * 先 `setXxxFilter(v)`，再 `resetPage()`。
 *
 * ⚠️ 三个 `<Label htmlFor="…">` 与它们各自的 `<SelectTrigger id="…">` 成对留在
 * **同一文件**内（`check:label-a11y` 要求 `htmlFor` 指向的 `id` 在同文件存在）。
 */
import React from 'react';
import { Download, Plus } from 'lucide-react';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import { Button } from '@client/src/components/ui/button';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import {
  VOUCHER_SOURCE_LABELS,
  VOUCHER_STATUS_LABELS,
} from './VoucherBadges';
import type { PeriodStatus } from '@shared/api.interface';

interface VoucherFilterBarProps {
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  periodFilter: string;
  setPeriodFilter: (v: string) => void;
  sourceFilter: string;
  setSourceFilter: (v: string) => void;
  /** 期间下拉的选项。父组件持有查询，故允许 `undefined`（加载中） */
  periods: PeriodStatus[] | null | undefined;
  /** 换筛选条件后回到第 1 页（原实现内联在各 `onValueChange` 里） */
  resetPage: () => void;
  /** 导出当前列表（无数据时的 toast 在父组件里） */
  onExport: () => void;
  /** 打开「新增手工凭证」弹窗 */
  onCreate: () => void;
}

const VoucherFilterBar: React.FC<VoucherFilterBarProps> = ({
  statusFilter,
  setStatusFilter,
  periodFilter,
  setPeriodFilter,
  sourceFilter,
  setSourceFilter,
  periods,
  resetPage,
  onExport,
  onCreate,
}) => {
  return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="voucher-status-filter">状态</Label>
            <Select
              value={statusFilter}
              onValueChange={(v: string) => {
                setStatusFilter(v);
                resetPage();
              }}
            >
              <SelectTrigger id="voucher-status-filter" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {Object.entries(VOUCHER_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="voucher-period-filter">期间</Label>
            <Select
              value={periodFilter}
              onValueChange={(v: string) => {
                setPeriodFilter(v);
                resetPage();
              }}
            >
              <SelectTrigger id="voucher-period-filter" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部期间</SelectItem>
                {(periods ?? []).map((p: PeriodStatus) => (
                  <SelectItem key={p.period} value={p.period}>
                    {p.period}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="voucher-source-filter">来源类型</Label>
            <Select
              value={sourceFilter}
              onValueChange={(v: string) => {
                setSourceFilter(v);
                resetPage();
              }}
            >
              <SelectTrigger id="voucher-source-filter" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部来源</SelectItem>
                {Object.entries(VOUCHER_SOURCE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onExport}>
            <Download className="h-4 w-4" />
            导出 Excel
          </Button>
          <CanCapabilityWrite capability="finance_write">
            <Button onClick={onCreate}>
              <Plus className="h-4 w-4" />
              新增手工凭证
            </Button>
          </CanCapabilityWrite>
      </div>
    </div>
  );
};

export default VoucherFilterBar;
