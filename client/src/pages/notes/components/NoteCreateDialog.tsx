/**
 * 「登记票据」弹窗（§5.9 / F8）。
 *
 * 从 `NotesPage.tsx` 抽出的**第五段 JSX**（原第 709–789 行），连同**只属于它的**
 * 状态与提交处理器（原第 97–101 行的四个输入值、原第 158–193 行的 `submitCreate`）。
 * 父组件只给数据（`dict`）与写成功回调（`onSaved`），不再传任何 setter。
 *
 * ⚠️ **行为零变更**：JSX 与 `submitCreate` 的**函数体逐字搬运**，只做了四处编辑：
 *   ① 整体去一层缩进（6 → 4）；
 *   ② `createOpen` / `setCreateOpen` → props `open` / `onOpenChange`；
 *   ③ `reloadAll()` → `onSaved()`（父组件传入的就是 `reloadAll`）；
 *   ④ `busy` 改为本组件自持 —— 原先它与"流转动作"弹窗共用一个 `busy`。
 *      两个弹窗都是模态的（Radix `Dialog` 打开时底层表格不可点），
 *      任何时刻最多只有一个在提交，故拆成两个独立 `busy` 不会改变可见行为；
 *      反而修掉了"另一弹窗的提交中状态串到本弹窗的按钮上"这一潜在串扰。
 *
 * ## 表单重置时机（**刻意保持原样**：写成功后重置，不是"打开即清空"）
 *
 * 原实现只在 `createNote()` **成功返回之后**清空输入：
 *
 * ```ts
 * toast.success('票据已登记');
 * setCreateOpen(false);
 * setNoteNo('');   setAmount('');   setDueDate('');   setDrawer('');
 * reloadAll();
 * ```
 *
 * ⚠️ 注意三处细节，搬迁时逐条保留：
 *   · **`noteType` 不重置**（它不在上面四个 setter 里）—— 连续登记同类型票据时
 *     用户不需要重新选类型；
 *   · **`dueDate` 清成 `''`** 而不是"今天"，与原始行为一致；
 *   · **失败 / 取消都不清空**：`catch` 分支与取消按钮只关弹窗，输入值原样留着，
 *     用户可以改一个字段重试。本组件**不添加**任何"打开即重置"。
 *
 * 本组件**必须无条件挂载**（父组件不能写成 `{open && <NoteCreateDialog/>}`）：
 * 上面这些输入值是常驻状态，条件挂载会让"取消后重开仍保留上次输入"这一行为改变。
 */
import React, { useState } from 'react';
import { toast } from 'sonner';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import * as notesApi from '@client/src/api/notes';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { NoteDictionaries } from '../note-format';
import type { NoteType } from '@shared/api.interface';

interface NoteCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 类型字典（`GET /api/notes/dictionaries`） */
  dict: NoteDictionaries | null;
  /** 登记成功后调用，父组件据此重取列表 / 备查簿 / 预警 */
  onSaved: () => void;
}

const NoteCreateDialog: React.FC<NoteCreateDialogProps> = ({
  open,
  onOpenChange,
  dict,
  onSaved,
}) => {
  // 新建表单
  const [noteNo, setNoteNo] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('bank');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [drawer, setDrawer] = useState('');
  const [busy, setBusy] = useState(false);

  const submitCreate = async () => {
    const parsedAmount = Number(amount);
    if (!noteNo.trim()) {
      toast.error('请填写票号');
      return;
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast.error('票面金额必须大于 0');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      toast.error('到期日格式必须为 YYYY-MM-DD');
      return;
    }
    setBusy(true);
    try {
      await notesApi.createNote({
        noteNo: noteNo.trim(),
        noteType,
        amount: parsedAmount,
        dueDate,
        drawer: drawer || undefined,
      });
      toast.success('票据已登记');
      onOpenChange(false);
      setNoteNo('');
      setAmount('');
      setDueDate('');
      setDrawer('');
      onSaved();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '登记失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>登记票据</DialogTitle>
          <DialogDescription>
            票号在系统内唯一，同一张票据重复登记会被拒绝（防止重复入账）。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="note-no">票号</Label>
            <Input
              id="note-no"
              value={noteNo}
              onChange={(event) => setNoteNo(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="note-type">票据类型</Label>
              <Select
                value={noteType}
                onValueChange={(value) => setNoteType(value as NoteType)}
              >
                <SelectTrigger id="note-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(dict?.types ?? []).map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="note-amount">票面金额</Label>
              <Input
                id="note-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="note-due">到期日</Label>
              <Input
                id="note-due"
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="note-drawer">出票人</Label>
              <Input
                id="note-drawer"
                value={drawer}
                onChange={(event) => setDrawer(event.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type="button" disabled={busy} onClick={submitCreate}>
            {busy ? '登记中…' : '确认登记'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default NoteCreateDialog;
