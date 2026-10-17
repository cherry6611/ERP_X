/**
 * 「票据流转」弹窗：持有 / 背书 / 贴现 / 到期收款 / 拒付（§5.9 / F8）。
 *
 * 从 `NotesPage.tsx` 抽出的**第六段 JSX**（原第 791–929 行，139 行）+ 只被它使用的
 * 两个派生值（原第 142–149 行的 `actionOptions` / `currentAction`）。
 *
 * ⚠️ **行为零变更**：JSX 与两个派生值**逐字搬运**，只做了两处编辑：
 *   ① 整体去一层缩进（6 → 4）；
 *   ② 页面级标识符改为**同名** props（`actionTarget` / `setActionTarget` /
 *      `actionKind` / `counterparty` / `setCounterparty` / `discountRate` /
 *      `setDiscountRate` / `discountDate` / `setDiscountDate` / `remark` /
 *      `setRemark` / `preview` / `setPreview` / `busy` / `dict` / `basis`），
 *      加上父组件的两个处理器（`runDiscountPreview` / `submitAction`）。
 *      同名是关键：JSX 正文一行未动。
 *
 * ## ⚠️ 为什么这个弹窗的 state 留在父组件（与「登记票据」弹窗不同）
 *
 * `ApTab` 那一轮的模式是"子组件自持 `useForm` / state / 提交处理器"。本弹窗
 * **不能**照搬，原因是**重置时机**：
 *
 * ```ts
 * const openAction = (note: NoteItem, action: NoteAction) => {   // 父组件，行内按钮点击时同步执行
 *   setActionTarget(note);
 *   setActionKind(action);
 *   setPreview(null);          // ← 四个字段在"打开那一刻"被重置
 *   setCounterparty('');
 *   setDiscountRate('');
 *   setRemark('');
 * };
 * ```
 *
 * 这个重置由**表格行的点击**触发，且发生在同一个事件处理器内（同一次提交，
 * 不会渲染出旧值）。若把这四个字段搬进本组件，父组件就无法在点击时清它们，
 * 只能改成下面两种之一 —— **两者都会改变行为，故不采用**：
 *   · `useEffect` 里按 `open` 重置：副作用在**渲染提交之后**执行，
 *     于是会先渲染一帧"上一次的试算结果 / 上一次的受让方"，再被清空（可见闪烁）；
 *   · `key={序号}` 强制重挂载：会连 `discountDate` 一起重置回今天，
 *     而原实现**刻意不重置贴现日**（见下），属于行为变更。
 *
 * 因此这里选择任务书允许的编辑 (a)：**父组件的 state/setter 变成 props**，
 * 让重置点与重置内容逐字不动。
 *
 * ## 表单重置时机（**刻意保持原样**）
 *
 * · 打开时（`openAction`）：清 `preview` / `counterparty` / `discountRate` / `remark`；
 * · 提交成功后（`submitAction`）：只 `setActionTarget(null)` + `setPreview(null)`，
 *   **不清** `counterparty` / `discountRate` / `remark`（下次打开时由 `openAction` 清）；
 * · 取消：只 `setActionTarget(null)`；
 * · `discountDate` **任何时机都不重置** —— 它初始化为业务时区的今天
 *   （`todayIso()`），此后一直保留用户选过的日期。
 *   这不是疏漏：连续给多张票做贴现时，贴现日通常是同一天，重置反而要重选。
 */
import React from 'react';
import StatCard from '@client/src/components/erp/StatCard';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { money, type NoteDictionaries } from '../note-format';
import type {
  NoteAction,
  NoteDiscountPreview,
  NoteItem,
} from '@shared/api.interface';

interface NoteActionDialogProps {
  /** 流转目标票据；`null` 表示弹窗关闭（即原 `open={actionTarget !== null}`） */
  actionTarget: NoteItem | null;
  setActionTarget: (value: NoteItem | null) => void;
  /** 当前动作（由行内按钮点击时设置） */
  actionKind: NoteAction;
  counterparty: string;
  setCounterparty: (value: string) => void;
  discountRate: string;
  setDiscountRate: (value: string) => void;
  discountDate: string;
  setDiscountDate: (value: string) => void;
  remark: string;
  setRemark: (value: string) => void;
  /** 贴现试算结果（提交前确认息费、到账额与分录） */
  preview: NoteDiscountPreview | null;
  setPreview: (value: NoteDiscountPreview | null) => void;
  busy: boolean;
  /** 动作字典（`GET /api/notes/dictionaries`），标题文案与字段显隐由它驱动 */
  dict: NoteDictionaries | null;
  /** 贴现计息基准说明（`GET /api/notes/discount-basis`） */
  basis: { basis: number; note: string } | null;
  /** 试算贴现息与分录（父组件持有：需要 `notesApi` 与 `actionTarget`） */
  runDiscountPreview: () => void;
  /** 提交流转（父组件持有：写成功后要重取列表 / 备查簿 / 预警） */
  submitAction: () => void;
}

const NoteActionDialog: React.FC<NoteActionDialogProps> = ({
  actionTarget,
  setActionTarget,
  actionKind,
  counterparty,
  setCounterparty,
  discountRate,
  setDiscountRate,
  discountDate,
  setDiscountDate,
  remark,
  setRemark,
  preview,
  setPreview,
  busy,
  dict,
  basis,
  runDiscountPreview,
  submitAction,
}) => {
  const actionOptions = (dict?.actions ?? []).filter((item) => {
    if (!actionTarget) return false;
    if (actionTarget.status === 'settled' || actionTarget.status === 'dishonored') {
      return false;
    }
    return true;
  });
  const currentAction = actionOptions.find((item) => item.value === actionKind);

  /* 流转动作 */
  return (
    <Dialog
      open={actionTarget !== null}
      onOpenChange={(open) => {
        if (!open) {
          setActionTarget(null);
          setPreview(null);
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {actionOptions.find((a) => a.value === actionKind)?.label ?? '票据流转'}{' '}
            · {actionTarget?.noteNo}
          </DialogTitle>
          <DialogDescription>
            票面 {actionTarget ? money(actionTarget.amount) : ''} 元，到期日{' '}
            {actionTarget?.dueDate}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {currentAction?.requiresCounterparty && (
            <div className="grid gap-2">
              <Label htmlFor="note-counterparty">受让方（背书给谁）</Label>
              <Input
                id="note-counterparty"
                value={counterparty}
                onChange={(event) => setCounterparty(event.target.value)}
              />
            </div>
          )}
          {currentAction?.requiresRate && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="note-rate">贴现率（%）</Label>
                  <Input
                    id="note-rate"
                    inputMode="decimal"
                    value={discountRate}
                    onChange={(event) => setDiscountRate(event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="note-discount-date">贴现日</Label>
                  <Input
                    id="note-discount-date"
                    type="date"
                    value={discountDate}
                    onChange={(event) => setDiscountDate(event.target.value)}
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={runDiscountPreview}
                >
                  试算贴现息与分录
                </Button>
              </div>
              {preview && (
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <StatCard label="票面" value={money(preview.amount)} />
                    <StatCard
                      label={`贴现天数（基准 ${basis?.basis ?? 360}）`}
                      value={`${preview.days} 天`}
                    />
                    <StatCard
                      label="贴现息"
                      value={money(preview.interest)}
                      tone="warning"
                    />
                    <StatCard
                      label="实际到账"
                      value={money(preview.netProceeds)}
                      tone="success"
                    />
                  </div>
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr className="text-left">
                          <th className="p-2 font-medium">科目</th>
                          <th className="p-2 text-right font-medium">借方</th>
                          <th className="p-2 text-right font-medium">贷方</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.lines.map((line, index) => (
                          <tr key={`${line.accountCode}-${index}`} className="border-t">
                            <td className="p-2 font-mono">
                              {line.accountCode}
                            </td>
                            <td className="p-2 text-right tabular-nums">
                              {line.debit ? money(line.debit) : ''}
                            </td>
                            <td className="p-2 text-right tabular-nums">
                              {line.credit ? money(line.credit) : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
          <div className="grid gap-2">
            <Label htmlFor="note-remark">备注</Label>
            <Input
              id="note-remark"
              value={remark}
              onChange={(event) => setRemark(event.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            提交后会生成凭证；若凭证服务不可用，业务状态照常推进并进入补偿队列，
            可在凭证失败队列中补录。
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setActionTarget(null)}
          >
            取消
          </Button>
          <Button type="button" disabled={busy} onClick={submitAction}>
            {busy ? '提交中…' : '确认'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default NoteActionDialog;
