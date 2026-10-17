/**
 * 票据台账表格（§5.9 / F8）。
 *
 * 从 `NotesPage.tsx` 抽出的**第二段 JSX**（原第 341–462 行）+ 紧邻它的两个派生值
 * （原第 134–140 行的 `allNotes` / `rows`）—— 那两个值只被这张表用（行数据与空态判定），
 * 留在页面里等于"数据在父、判定在子"，故一并搬来。
 *
 * ⚠️ **行为零变更**：JSX 与原块**逐字相同**，只做了三处编辑：
 *   ① 整体去一层缩进（8 → 4）；
 *   ② 页面级标识符改为 props（同名，故 JSX 正文未动）：
 *      `notes`（父组件传 `notes?.items`）、`statusFilter`、`loading`、`error`、
 *      `dict`、`reload` → `onRetry`、`openAction` → `onAction`；
 *   ③ `allNotes` 的 `notes?.items ?? []` 改为 `notes ?? []`（父组件已在 props
 *      边界上取了 `.items`），语义不变。
 *
 * ## 唯一的**有意**改动：操作列的动作过滤（真实缺陷修复）
 *
 * 原实现只把 `endorse` / `discount` 钉到后端状态机上，其余动作落到 `return true`
 * 兜底，于是**已背书 / 已贴现**的票据（两者都不是终态，默认"未结清"筛选下就在
 * 列表里）会多出一个「确认持有」按钮 —— 后端 `NOTE_TRANSITIONS.hold` 只允许
 * `received` / `held`，点击必然被 `NoteService.noteAction()` 的
 * `validateNoteAction()` 拒绝（400「「确认持有」不允许从「已背书」发起…」）。
 * 这与本仓 B-01 已修复的"前端显示点了必然 403 的按钮"是同一类问题。
 *
 * 修法不是在客户端再抄一份状态机，而是让**后端字典把允许前置状态一起下发**
 * （`NoteService.dictionaries()` 的 `actions[].allowedFrom` = `NOTE_TRANSITIONS[action]`，
 * 见该方法的注释），前端改为 `action.allowedFrom.includes(note.status)` ——
 * 于是本页**不再存在**状态机副本，"改一处漏一处"的可能被彻底移除，
 * 也终于兑现了页面顶部写的"动作按钮由后端字典驱动，前端不硬编码状态机"。
 */
import React from 'react';
import { Button } from '@client/src/components/ui/button';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import { cn } from '@client/src/lib/utils';
// §5.8 收尾：状态文案改用 `utils/biz-labels` 的字典版（理由同 AssetDisposalPanel）。
// 共享表的键集合已与 `NoteStatus` 契约对齐（原先那版缺 `received/held/dishonored`
// 且多了 `draft/registered/void`，已一并修正）。
import { NOTE_STATUS_LABELS as STATUS_LABELS } from '@client/src/utils/biz-labels';
import {
  STATUS_TONE,
  TYPE_LABELS,
  money,
  type NoteDictionaries,
} from '../note-format';
import type { NoteAction, NoteItem } from '@shared/api.interface';

interface NotesTableProps {
  /** 票据列表（`listNotes()` 的 `items`）；未取到时为 `undefined` */
  notes: NoteItem[] | undefined;
  /** 状态筛选值。`outstanding` 是**前端语义**：未结清 = 排除已结清与已拒付 */
  statusFilter: string;
  loading: boolean;
  error: string | null;
  /** 状态/类型/动作字典（`GET /api/notes/dictionaries`），操作列据此渲染 */
  dict: NoteDictionaries | null;
  onRetry: () => void;
  /** 点击某行的流转动作：字段重置与弹窗开关仍由父组件负责（见 `openAction`） */
  onAction: (note: NoteItem, action: NoteAction) => void;
}

const NotesTable: React.FC<NotesTableProps> = ({
  notes,
  statusFilter,
  loading,
  error,
  dict,
  onRetry,
  onAction,
}) => {
  const allNotes: NoteItem[] = notes ?? [];
  const rows =
    statusFilter === 'outstanding'
      ? allNotes.filter(
          (note) => note.status !== 'settled' && note.status !== 'dishonored',
        )
      : allNotes;

  return (
    <DataBoundary
      loading={loading}
      error={error}
      empty={rows.length === 0}
      emptyText="暂无票据记录"
      onRetry={onRetry}
    >
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr className="text-left">
              <th className="p-2 font-medium">票号</th>
              <th className="p-2 font-medium">类型</th>
              <th className="p-2 font-medium">出票人</th>
              <th className="p-2 text-right font-medium">票面</th>
              <th className="p-2 font-medium">到期日</th>
              <th className="p-2 font-medium">状态</th>
              <th className="p-2 font-medium">关联</th>
              <th className="p-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((note) => (
              <tr key={note.id} className="border-t">
                <td className="p-2 font-mono text-xs">
                  {note.noteNo}
                  <div className="text-muted-foreground">{note.code}</div>
                </td>
                <td className="p-2">{TYPE_LABELS[note.noteType]}</td>
                <td className="p-2">{note.drawer ?? '—'}</td>
                <td className="p-2 text-right tabular-nums">
                  {money(note.amount)}
                </td>
                <td className="p-2">
                  {note.dueDate}
                  {note.daysToDue <= 15 && note.daysToDue >= -9999 && (
                    <div
                      className={cn(
                        'text-xs',
                        note.daysToDue < 0
                          ? 'text-destructive'
                          : 'text-amber-700',
                      )}
                    >
                      {note.daysToDue < 0
                        ? `逾期 ${-note.daysToDue} 天`
                        : `${note.daysToDue} 天后`}
                    </div>
                  )}
                </td>
                <td className="p-2">
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-xs',
                      STATUS_TONE[note.status],
                    )}
                  >
                    {STATUS_LABELS[note.status]}
                  </span>
                  {note.discountInterest !== null && (
                    <div className="text-xs text-muted-foreground">
                      息 {money(note.discountInterest)}
                    </div>
                  )}
                </td>
                <td className="p-2 text-xs">
                  {note.customerName ?? note.supplierName ?? '—'}
                  {note.endorsementCounterparty && (
                    <div className="text-muted-foreground">
                      背书给 {note.endorsementCounterparty}
                    </div>
                  )}
                </td>
                <td className="p-2">
                  {note.status === 'settled' || note.status === 'dishonored' ? (
                    <span className="text-xs text-muted-foreground">
                      已终态
                    </span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {(dict?.actions ?? [])
                        .filter(
                          // 只显示当前状态允许的动作。允许前置状态由**后端字典**
                          // 下发（`allowedFrom` = `NOTE_TRANSITIONS[action]`），
                          // 前端因此不持有状态机副本。
                          (action) => action.allowedFrom.includes(note.status),
                        )
                        .map((action) => (
                          <CanCapabilityWrite
                            key={action.value}
                            capability="finance_write"
                          >
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-1.5 text-xs"
                              onClick={() => onAction(note, action.value)}
                            >
                              {action.label}
                            </Button>
                          </CanCapabilityWrite>
                        ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DataBoundary>
  );
};

export default NotesTable;
