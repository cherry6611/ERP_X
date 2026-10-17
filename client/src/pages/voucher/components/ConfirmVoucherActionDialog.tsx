/**
 * 过账 / 作废确认弹窗（§5.9 / F8）。
 *
 * 从 `VoucherPanel.tsx` 抽出的**自包含**弹窗：它自持 `operating`（按钮禁用）
 * 并自己调 `voucherApi.voucherAction`、自己弹 toast。父组件只给
 * 「要操作哪张凭证 + 哪个动作」与一个 `onConfirmed`（重取列表）。
 *
 * ⚠️ 原实现里 `onConfirmAction` 在面板作用域内读写 `confirmTarget` 与
 * `operating`；搬进本组件后二者仍在本组件内（`confirmTarget` 由 props 传入、
 * `operating` 由本组件持有），**调用时机与分支逐字未改**：
 *   · 成功 → `toast.success` → `setConfirmTarget(null)` → `await reload()`
 *     （后两步现在是 `onOpenChange(false)` 与 `await onConfirmed()`）；
 *   · 失败 → `toast.error(getApiErrorMessage(err, '操作失败'))`，弹窗保持打开；
 *   · `finally` → 恢复按钮可用。
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
import { voucherApi } from '@client/src/api';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { VoucherAction, VoucherItem } from '@shared/api.interface';

export interface ConfirmTarget {
  voucher: VoucherItem;
  action: VoucherAction;
}

interface ConfirmVoucherActionDialogProps {
  /** 待确认的目标；`null` 表示弹窗关闭（同原实现用它当 open 判据） */
  confirmTarget: ConfirmTarget | null;
  onOpenChange: (open: boolean) => void;
  /** 操作成功后调用，父组件据此重取列表 */
  onConfirmed: () => void | Promise<void>;
}

const ConfirmVoucherActionDialog: React.FC<ConfirmVoucherActionDialogProps> = ({
  confirmTarget,
  onOpenChange,
  onConfirmed,
}) => {
  const [operating, setOperating] = useState(false);

  const onConfirmAction = async () => {
    if (!confirmTarget) return;
    setOperating(true);
    try {
      await voucherApi.voucherAction(confirmTarget.voucher.id, confirmTarget.action);
      toast.success(
        confirmTarget.action === 'post' ? '凭证已过账' : '凭证已作废',
      );
      onOpenChange(false);
      await onConfirmed();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    } finally {
      setOperating(false);
    }
  };

  return (
      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) onOpenChange(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmTarget?.action === 'post' ? '确认过账' : '确认作废'}
            </DialogTitle>
            {confirmTarget ? (
              <DialogDescription>
                {confirmTarget.action === 'post'
                  ? `凭证 ${confirmTarget.voucher.code} 过账后将进入正式账簿，不可再修改分录。`
                  : `凭证 ${confirmTarget.voucher.code} 作废后将不再参与账簿汇总。`}
                确认继续吗？
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={operating}>
              取消
            </Button>
            <Button
              variant={confirmTarget?.action === 'void' ? 'destructive' : 'default'}
              disabled={operating}
              onClick={() => void onConfirmAction()}
            >
              {confirmTarget?.action === 'post' ? '确认过账' : '确认作废'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
};

export default ConfirmVoucherActionDialog;
