/**
 * 票据状态筛选区（§5.9 / F8）。
 *
 * 从 `NotesPage.tsx` 抽出的状态筛选行（原第 311–339 行）。
 *
 * ⚠️ **行为零变更**：JSX 与原块**逐字相同**，只做了两处编辑：
 *   ① 整体去一层缩进（8 → 4）；
 *   ② 页面级标识符改为**同名** props（`statusFilter` / `setStatusFilter` /
 *      `dict` / `basis`），因此 JSX 正文一行未动 —— 这也是刻意不改叫
 *      `value` / `onChange` 的原因：改名对读代码的人几乎无差别，
 *      但会让"逐字比对"的验证多出一层需要解释的差异。
 *
 * ## 为什么筛选值仍由父组件持有
 *
 * `statusFilter` 不只是本区块的显示状态：它同时是
 * `listNotes({ status })` 的**请求参数**（`useAsyncData` 的依赖），
 * 所以它的归属是父组件（数据查询方），这里只做受控展示。
 *
 * ## a11y（原注释保留）
 *
 * Radix `SelectTrigger` 渲染的是 `<button>`，`htmlFor` 给不出可访问名，
 * 故用 `aria-labelledby` 指向本区块内的 `Label id`。
 * `check:label-a11y` 要求 `aria-labelledby` 引用的字面量 id **在同一文件内存在** ——
 * 标签与触发器一起搬进本文件，正是为了不让这条门禁失效。
 */
import React from 'react';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import type { NoteDictionaries } from '../note-format';

interface NotesStatusFilterProps {
  /** 当前筛选值；同时是 `listNotes({ status })` 的请求参数，故由父组件持有 */
  statusFilter: string;
  setStatusFilter: (value: string) => void;
  /** 状态字典（`GET /api/notes/dictionaries`） */
  dict: NoteDictionaries | null;
  /** 贴现计息基准说明（`GET /api/notes/discount-basis`） */
  basis: { basis: number; note: string } | null;
}

const NotesStatusFilter: React.FC<NotesStatusFilterProps> = ({
  statusFilter,
  setStatusFilter,
  dict,
  basis,
}) => {
  return (
    <div className="flex items-center gap-3">
      {/*
        a11y（§5.10 / P2-3）：Radix Select 触发器是 <button>，
        `htmlFor` 不适用，改用 `aria-labelledby` 指向本标签 id。
      */}
      <Label className="text-sm" id="notes-status-filter-label">
        状态筛选
      </Label>
      <Select value={statusFilter} onValueChange={setStatusFilter}>
        <SelectTrigger
          className="w-44"
          aria-labelledby="notes-status-filter-label"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="outstanding">未结清</SelectItem>
          <SelectItem value="all">全部</SelectItem>
          {(dict?.statuses ?? []).map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {basis && (
        <span className="text-xs text-muted-foreground">{basis.note}</span>
      )}
    </div>
  );
};

export default NotesStatusFilter;
