/**
 * 「登记脱敏字段」弹窗（§5.9 / F8）。
 *
 * 从 `DataMaskPanel.tsx` 抽出的**自包含**弹窗：连同只属于它的三个输入值
 * （`columnName` / `fieldKind` / `fieldLabel`）与提交处理器 `saveField` 一起搬走。
 * 父组件只留"打开 / 关闭"这一个开关（`fieldOpen`），因为「登记字段」按钮在父组件
 * 的区块标题行里。
 *
 * ⚠️ **行为零变更**：JSX 与 `saveField` 的函数体逐字搬运，只做了三处编辑：
 *   ① 整体去一层缩进（6 → 4）；
 *   ② `fieldOpen` / `setFieldOpen` → props `open` / `onOpenChange`；
 *   ③ `busy` 与本弹窗的输入值一样改为本组件自持 —— 原先它与「回收授权」弹窗
 *      共用一个 `busy`。两个弹窗都是模态的（Radix `Dialog` 打开时底层区块不可点、
 *      也从可访问树里移出），任何时刻最多只有一个在提交，故拆成两个独立 `busy`
 *      不改变可见行为（「登记票据」弹窗的拆分同理）。
 *
 * ## 表单重置时机（**刻意保持原样**：写成功后重置，不是"打开即清空"）
 *
 * 原实现只在 `upsertDatasetField()` **成功返回之后**清空输入：
 *
 * ```ts
 * toast.success('字段登记已保存');
 * setFieldOpen(false);
 * setColumnName('');
 * setFieldLabel('');
 * reloadFields();
 * ```
 *
 * 三处细节照搬，不要"顺手统一"：
 *   · **`fieldKind` 不重置**（它不在上面的 setter 里）—— 连续登记同语义的列时
 *     用户不需要重新选；
 *   · **取消与失败都不清空**：`catch` 分支只弹 toast，输入值原样留着供改一个字段重试；
 *   · 因此本组件**不添加**任何"打开即重置"。
 *
 * 本组件**必须无条件挂载**（父组件不能写成 `{open && <FieldRegisterDialog/>}`）：
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
import * as dataAssetApi from '@client/src/api/data-asset';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { FIELD_KIND_LABELS } from '../mask-labels';
import type { SensitiveFieldKind } from '@shared/api.interface';

interface FieldRegisterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前选中的数据集 id（父组件持有；弹窗只能在该值非空时打开） */
  selectedDataset: string;
  /** 保存成功后调用，父组件据此重取该数据集的字段列表 */
  reloadFields: () => void;
}

const FieldRegisterDialog: React.FC<FieldRegisterDialogProps> = ({
  open,
  onOpenChange,
  selectedDataset,
  reloadFields,
}) => {
  const [columnName, setColumnName] = useState('');
  const [fieldKind, setFieldKind] = useState<SensitiveFieldKind>('phone');
  const [fieldLabel, setFieldLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const saveField = async () => {
    if (!selectedDataset) {
      toast.error('请先选择数据集');
      return;
    }
    if (!columnName.trim()) {
      toast.error('请填写列名');
      return;
    }
    setBusy(true);
    try {
      await dataAssetApi.upsertDatasetField(selectedDataset, {
        columnName: columnName.trim(),
        fieldKind,
        fieldLabel: fieldLabel || undefined,
      });
      toast.success('字段登记已保存');
      onOpenChange(false);
      setColumnName('');
      setFieldLabel('');
      reloadFields();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '保存失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>登记脱敏字段</DialogTitle>
          <DialogDescription>
            列名必须与导出文件中的列头一致，否则该列会按「其它」处理（L4 下被阻断）。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="mask-column">列名</Label>
            <Input
              id="mask-column"
              value={columnName}
              placeholder="customerName"
              onChange={(event) => setColumnName(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mask-kind">字段语义</Label>
            <Select
              value={fieldKind}
              onValueChange={(value) =>
                setFieldKind(value as SensitiveFieldKind)
              }
            >
              <SelectTrigger id="mask-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(FIELD_KIND_LABELS) as SensitiveFieldKind[]).map(
                  (key) => (
                    <SelectItem key={key} value={key}>
                      {FIELD_KIND_LABELS[key]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mask-label">说明</Label>
            <Input
              id="mask-label"
              value={fieldLabel}
              onChange={(event) => setFieldLabel(event.target.value)}
            />
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
          <Button type="button" disabled={busy} onClick={saveField}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default FieldRegisterDialog;
