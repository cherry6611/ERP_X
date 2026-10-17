/**
 * 「从报价导入明细」弹窗（§5.9 / F8 拆分第二轮）。
 *
 * 从 909 行的 `ContractDetailDialog.tsx` 抽出的六个 `<Dialog>` 之一。
 *
 * ⚠️ **行为零变更**：JSX 逐字搬运，只做了三件事 ——
 *   ① 整体去掉两层缩进；
 *   ② `quotationImportOpen` 改为 prop `open`；弹窗的 `onOpenChange` 回调
 *      **仍留在父组件**（它除了设置开关还要清空 `selectedQuotationId`），
 *      原样传入本组件，因此关窗时的清空时机分毫未动；
 *   ③ 三个受控值保持同名 prop 下传：`selectedQuotationId` /
 *      `setSelectedQuotationId` / `importingQuotation` / `setImportingQuotation`，
 *      以及提交体 `onImport`（父组件持有 `contractsApi` 与写后 `load()`）。
 *
 * ## 清空 `selectedQuotationId` 的两个时机（刻意保持原样，一个不多一个不少）
 *
 *   · **关窗时**（父组件的 `onOpenChange(next)` 里 `if (!next)`）—— 原实现就有
 *     这个"下次打开从空白开始"，它是**回调驱动**的，不是 reset-on-open 的
 *     `useEffect`；
 *   · **导入成功后**（`toast.success('已从报价导入明细')` 之后）。
 * 打开弹窗的那一下**没有**清空动作，本组件也没有添加。
 *
 * ## 标签关联（`check:label-a11y`）
 *
 * `<label htmlFor="quotation-import-select">` 与 `<SelectTrigger id="quotation-import-select">`
 * 是**一对**，本轮**同文件整体搬运**，没有把 id 或 htmlFor 拆到别的文件去
 * （那会让 `check:label-a11y` 的"同文件内 id 必须存在"规则失败）。
 */
import React from 'react';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import type { Quotation } from '@shared/api.interface';

interface QuotationImportDialogProps {
  open: boolean;
  /** 父组件持有：除了开关还要清空 `selectedQuotationId`，故整个回调下传 */
  onOpenChange: (open: boolean) => void;
  quotations: Quotation[];
  selectedQuotationId: string;
  setSelectedQuotationId: React.Dispatch<React.SetStateAction<string>>;
  importingQuotation: boolean;
  /** 「取消」按钮：只关窗（父组件的 `onOpenChange` 会顺带清空已选报价） */
  onCancel: () => void;
  /** 「导入」按钮的提交体（父组件持有 `contractsApi` 与写后 `load()`） */
  onImport: () => void;
}

const QuotationImportDialog: React.FC<QuotationImportDialogProps> = ({
  open,
  onOpenChange,
  quotations,
  selectedQuotationId,
  setSelectedQuotationId,
  importingQuotation,
  onCancel,
  onImport,
}) => {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>从报价导入明细</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="quotation-import-select">
            选择报价单
          </label>
          <Select
            value={selectedQuotationId || undefined}
            onValueChange={setSelectedQuotationId}
          >
            <SelectTrigger id="quotation-import-select">
              <SelectValue placeholder="请选择报价单" />
            </SelectTrigger>
            <SelectContent>
              {quotations.map((q) => (
                <SelectItem key={q.id} value={q.id}>
                  {q.code} · {q.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={importingQuotation}
          >
            取消
          </Button>
          <Button
            disabled={!selectedQuotationId || importingQuotation}
            onClick={onImport}
          >
            {importingQuotation ? '导入中…' : '导入'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default QuotationImportDialog;
