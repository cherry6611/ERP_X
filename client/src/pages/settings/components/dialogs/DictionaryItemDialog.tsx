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
import { Textarea } from '@client/src/components/ui/textarea';
import * as systemConfigApi from '@client/src/api/system-config';
import type { UpsertDictionaryDto } from '@shared/api.interface';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';

/**
 * 字典项新增/编辑弹窗（§5.9 / F8）。
 *
 * 从 `DictionarySettings.tsx` 抽出的**第二段 JSX**（`<Dialog>` 整块）+ `handleSave`
 * （保存校验与写接口调用）+ 只被弹窗消费的 `saving` state。
 *
 * ## 为什么 `open` / `form` / `formError` / `editingKey` 仍留在父组件
 *
 * 本页的"打开即重置"**同步发生在点击处理函数里**（`openCreate` / `openEdit` 依次
 * `setEditingKey` → `setForm` → `setFormError(null)` → `setDialogOpen(true)`），
 * **不是** `useEffect`。把 `form` / `formError` 搬进本组件后，父组件就再也不能在
 * 那两个函数的同一点上重置它们 —— 只能补一个 `useEffect`，那等于**新增**一次
 * 重置时机（还多一次渲染）。因此按"状态留在父、以同名 props 下发"处理：
 * `open` / `onOpenChange` / `editingKey` / `form` / `setForm` / `formError` /
 * `setFormError`；本组件只自持 `saving`（父组件没有别的消费点）。
 *
 * `DictFormState` / `EMPTY_FORM` 也定义在本文件：它们是弹窗的表单模型，
 * 父组件只借用 `EMPTY_FORM` 作为同步重置的种子值（`openCreate`）与 `useState` 初值。
 *
 * ⚠️ 行为零变更：搬过来的代码**逐字相同**，只有以下编辑：
 *   ① `<Dialog>` 整块去一层缩进（6 → 4）；
 *   ② 父组件标识符 → props：`dialogOpen` → `open`；`setDialogOpen(false)` →
 *      `onOpenChange(false)`（父组件传入的 `onOpenChange` 就是原来那个
 *      `(open) => { if (!open) setDialogOpen(false); }`，故二者完全等价）；
 *      `await dicts.reload()` → `await onSaved()`；`editingKey` / `form` /
 *      `setForm` / `formError` / `setFormError` 名字不变，直接作 props 传入；
 *   ③ `DictFormState` / `EMPTY_FORM` 各加一个 `export` 关键字（原文只有本文件用，
 *      现在父组件的 `useState<DictFormState>(EMPTY_FORM)` 与 `openCreate` 也要用），
 *      声明本身一字未动。
 *
 * a11y（§5.10 / P2-3）：本文件内的 `<Label htmlFor="dict-*">` 与对应控件的 `id`
 * **成对搬入同一文件**（dict-type / dict-key / dict-label / dict-sort / dict-extra /
 * dict-remark），没有把 `htmlFor` 与其 `id` 目标拆到两个文件里。
 */

export interface DictFormState {
  dictType: string;
  dictKey: string;
  dictLabel: string;
  extra: string;
  sortNo: string;
  enabled: boolean;
  remark: string;
}

export const EMPTY_FORM: DictFormState = {
  dictType: '',
  dictKey: '',
  dictLabel: '',
  extra: '',
  sortNo: '100',
  enabled: true,
  remark: '',
};

interface DictionaryItemDialogProps {
  /** 弹窗开关（父组件 `dialogOpen`） */
  open: boolean;
  /** 父组件原本内联在 `<Dialog>` 上的 `(open) => { if (!open) setDialogOpen(false); }` */
  onOpenChange: (open: boolean) => void;
  /** `${dictType}.${dictKey}`；非 null 即编辑态（字典类型/字典键不可改） */
  editingKey: string | null;
  form: DictFormState;
  setForm: React.Dispatch<React.SetStateAction<DictFormState>>;
  formError: string | null;
  setFormError: React.Dispatch<React.SetStateAction<string | null>>;
  /** 保存成功后父组件重取字典列表（原 `await dicts.reload()`） */
  onSaved: () => Promise<void>;
}

const DictionaryItemDialog: React.FC<DictionaryItemDialogProps> = ({
  open,
  onOpenChange,
  editingKey,
  form,
  setForm,
  formError,
  setFormError,
  onSaved,
}) => {
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const dictType = form.dictType.trim();
    const dictKey = form.dictKey.trim();
    const dictLabel = form.dictLabel.trim();
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(dictType)) {
      setFormError('字典类型必须小写字母开头，仅含小写字母/数字/下划线，长度 2~64');
      return;
    }
    if (!dictKey) {
      setFormError('字典键必填');
      return;
    }
    if (!dictLabel) {
      setFormError('字典标签必填');
      return;
    }
    const sortNo = Number(form.sortNo);
    if (!Number.isInteger(sortNo) || sortNo < 0 || sortNo > 9999) {
      setFormError('排序号必须为 0~9999 的整数');
      return;
    }
    const dto: UpsertDictionaryDto = {
      dictType,
      dictKey,
      dictLabel,
      extra: form.extra.trim() || undefined,
      sortNo,
      enabled: form.enabled,
      remark: form.remark.trim() || undefined,
    };
    setSaving(true);
    try {
      await systemConfigApi.upsertDictionary(dto);
      toast.success(editingKey ? '字典项已更新' : '字典项已新增');
      onOpenChange(false);
      await onSaved();
    } catch (err) {
      // 409 / 400 的中文原因直接透出，不吞成通用提示
      toast.error(getApiErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editingKey ? '编辑字典项' : '新增字典项'}</DialogTitle>
          <DialogDescription>
            字典键在同一字典类型内唯一；内置项（builtin）只能停用，不能删除。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="dict-type">字典类型</Label>
            <Input
              id="dict-type"
              value={form.dictType}
              disabled={editingKey !== null}
              placeholder="如 invoice_type"
              onChange={(e) => {
                setForm({ ...form, dictType: e.target.value });
                setFormError(null);
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="dict-key">字典键</Label>
            <Input
              id="dict-key"
              value={form.dictKey}
              disabled={editingKey !== null}
              placeholder="如 vat_special"
              onChange={(e) => {
                setForm({ ...form, dictKey: e.target.value });
                setFormError(null);
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="dict-label">字典标签</Label>
            <Input
              id="dict-label"
              value={form.dictLabel}
              placeholder="如 增值税专用发票"
              onChange={(e) => {
                setForm({ ...form, dictLabel: e.target.value });
                setFormError(null);
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="dict-sort">排序号</Label>
              <Input
                id="dict-sort"
                type="number"
                min={0}
                max={9999}
                value={form.sortNo}
                onChange={(e) => {
                  setForm({ ...form, sortNo: e.target.value });
                  setFormError(null);
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dict-extra">扩展值 extra</Label>
              <Input
                id="dict-extra"
                value={form.extra}
                placeholder="如税率数值 0.06"
                onChange={(e) => setForm({ ...form, extra: e.target.value })}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            启用
          </label>
          <div className="flex flex-col gap-2">
            <Label htmlFor="dict-remark">备注</Label>
            <Textarea
              id="dict-remark"
              rows={2}
              value={form.remark}
              onChange={(e) => setForm({ ...form, remark: e.target.value })}
            />
          </div>
          {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DictionaryItemDialog;
