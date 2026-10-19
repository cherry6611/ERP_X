/**
 * 「添加合同明细」弹窗（§5.9 / F8 拆分第二轮）。
 *
 * 从 909 行的 `ContractDetailDialog.tsx` 抽出的六个 `<Dialog>` 之一。
 *
 * ⚠️ **行为零变更**：JSX 逐字搬运，只做了三件事 ——
 *   ① 整体去掉两层缩进；
 *   ② 原来内联读写的 `itemDraft` 草稿与它的四个 `setItemDraft({...})` 改为
 *      **同名 prop**：`itemDraft` + `setItemDraft`（父组件持有 `useState`，
 *      类型 `React.Dispatch<React.SetStateAction<ContractItemDraft>>`）。
 *      刻意**不**把草稿搬进本组件：父组件的「添加明细」按钮在**点击那一刻**
 *      `setItemDraft(prev => …)` 校正默认税率再 `setItemOpen(true)`，
 *      草稿状态搬进来会让那一处在打开前拿不到 setter；
 *   ③ `.then(() => { … })` 里的 `setItemOpen(false)` 改为 `onOpenChange(false)`、
 *      `load()` 改为 `onSaved()`（父组件传入的就是 `setItemOpen` 与 `load`）。
 * `itemOpen` 同样原样保留在父组件（本组件接 `open` / `onOpenChange`）。
 *
 * ## 下拉选项与"保存后重置"的税率校正（P0-3，不得回退）
 *
 * `itemRateOptions`（选项）与 `createItemDraft`（保存成功后重置）都来自
 * `../contract-detail-model`，与打开弹窗时的 `resolveItemTaxRate` **同源**：
 * `coerceTaxRate` 越界返回 `null` 的旧路径已被 `?? defaultTaxRate(entity)` 兜住，
 * 否则小规模主体下下拉空白、保存必然 400（完整证据见该模块文件头表格）。
 * 本次搬迁保留这两处调用与那行中文注释，未做任何"顺手统一"。
 *
 * ## 标签关联（`check:label-a11y`）
 *
 * 明细名称 / 数量 / 含税单价走 `placeholder`，税率下拉是原生 `<select>` ——
 * 三者都没有 `<Label>`，故不涉及 htmlFor 配对；本文件也没有从别的文件搬 id 进来。
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
import { Input } from '@client/src/components/ui/input';
import { contractsApi } from '@client/src/api';
import { toast } from 'sonner';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import {
  createItemDraft,
  itemRateOptions,
  type ContractItemDraft,
} from '../../contract-detail-model';
import type { ContractDetail, TaxEntity } from '@shared/api.interface';

interface ItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contractId: string | null;
  /** 草稿与 setter 都由父组件持有（见文件头第 ② 条） */
  itemDraft: ContractItemDraft;
  setItemDraft: React.Dispatch<React.SetStateAction<ContractItemDraft>>;
  taxEntities: TaxEntity[];
  /** 合同主体与税率：下拉选项按主体取，重置草稿时按主体校正 */
  detail: ContractDetail | null;
  /** 保存成功后重取详情与明细（父组件传入的就是 `load`） */
  onSaved: () => void | Promise<void>;
}

const ItemDialog: React.FC<ItemDialogProps> = ({
  open,
  onOpenChange,
  contractId,
  itemDraft,
  setItemDraft,
  taxEntities,
  detail,
  onSaved,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加合同明细</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder="明细名称"
            value={itemDraft.itemName}
            onChange={(e) =>
              setItemDraft({ ...itemDraft, itemName: e.target.value })
            }
          />
          <div className="flex gap-3">
            <Input
              type="number"
              min={0}
              placeholder="数量"
              value={String(itemDraft.quantity)}
              onChange={(e) =>
                setItemDraft({
                  ...itemDraft,
                  quantity: Number(e.target.value),
                })
              }
            />
            <Input
              type="number"
              min={0}
              placeholder="含税单价"
              value={String(itemDraft.unitPrice)}
              onChange={(e) =>
                setItemDraft({
                  ...itemDraft,
                  unitPrice: Number(e.target.value),
                })
              }
            />
            <select
              className="h-9 rounded-md border px-2 text-sm"
              value={itemDraft.taxRate}
              onChange={(e) =>
                setItemDraft({
                  ...itemDraft,
                  taxRate: Number(e.target.value),
                })
              }
            >
              {itemRateOptions(taxEntities, detail?.taxEntityId).map((rate) => (
                <option key={rate} value={rate}>
                  {rate}%
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              if (!contractId) return;
              void contractsApi
                .createContractItem(contractId, itemDraft)
                .then((result) => {
                  if (result.differs) {
                    toast.warning(
                      `明细合计 ${result.itemSum} 与合同金额 ${result.headerAmount} 不一致，提交前需要改平`,
                    );
                  }
                  onOpenChange(false);
                  // 修复 P0-3：重置时同样要校正，否则又把 6 塞回小规模主体的下拉里
                  setItemDraft(
                    createItemDraft(
                      detail?.taxRate,
                      taxEntities,
                      detail?.taxEntityId
                    )
                  );
                  return onSaved();
                })
                .catch((err: unknown) =>
                  toast.error(getApiErrorMessage(err, '添加失败'))
                );
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ItemDialog;
