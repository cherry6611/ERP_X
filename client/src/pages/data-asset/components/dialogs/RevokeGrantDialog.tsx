/**
 * 「回收授权」弹窗（§5.9 / F8）。
 *
 * 从 `DataMaskPanel.tsx` 抽出的**自包含**弹窗：连同只属于它的三个输入值
 * （`revokeReason` / `reviewedBy` / `destructionProof`）与提交处理器 `submitRevoke`
 * 一起搬走。父组件只留**被回收的那条授权**（`revokeTarget`，因为「回收」按钮在
 * 父组件的授权表格行里）与派生的 `revokeNeedsDualControl`。
 *
 * ⚠️ **行为零变更**：JSX 与 `submitRevoke` 的函数体**逐字搬运**，只做了三处编辑：
 *   ① 整体去一层缩进（6 → 4）；
 *   ② 三个输入值改为本组件自持（同名 state/setter，函数体一个字都不用改）；
 *   ③ `busy` 同样改为本组件自持 —— 原先它与「登记脱敏字段」弹窗共用一个 `busy`。
 *      两个弹窗都是模态的（Radix `Dialog` 打开时底层区块不可点、也从可访问树里
 *      移出），任何时刻最多只有一个在提交，故两个独立 `busy` 不改变可见行为。
 *   `setRevokeTarget` / `reloadGrants` / `reloadLogs` **按原名作 props 传入**，
 *   因此 handler 里的调用点保持原样（`setRevokeTarget(null)` 等）。
 *
 * ## 表单重置时机（**刻意保持原样**：回收成功后重置，不是"打开即清空"）
 *
 * 原实现只在 `revokeGrant()` **成功返回之后**清空输入：
 *
 * ```ts
 * toast.success(`授权已回收，审计记录 ${result.logId.slice(0, 8)}…（${REVOKE_REASON_LABELS[revokeReason]}）`);
 * setRevokeTarget(null);
 * setReviewedBy('');
 * setDestructionProof('');
 * reloadGrants();
 * reloadLogs();
 * ```
 *
 * 两处细节照搬，不要"顺手统一"：
 *   · **`revokeReason` 不重置** —— 连续回收同原因的授权时用户不需要重新选；
 *   · **取消与失败都不清空**：取消按钮只关弹窗，输入值原样留着。
 *
 * 本组件**必须无条件挂载**（父组件不能写成 `{revokeTarget && <RevokeGrantDialog/>}`）：
 * 上面这些输入值是常驻状态，条件挂载会改变"取消后重开仍保留上次输入"这一行为，
 * 也会让 `<Dialog open={revokeTarget !== null}>` 的关闭动画失去宿主。
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
import { REVOKE_REASON_LABELS } from '../mask-labels';
import type { GrantItem, GrantRevokeReason } from '@shared/api.interface';

interface RevokeGrantDialogProps {
  /** 待回收的授权；`null` 表示弹窗关闭 */
  revokeTarget: GrantItem | null;
  setRevokeTarget: (target: GrantItem | null) => void;
  /** 该授权所属数据集是否需要"双人复核 + 销毁凭证"（L4 核心等级） */
  revokeNeedsDualControl: boolean;
  /** 回收成功后调用，父组件据此重取生效中的授权 */
  reloadGrants: () => void;
  /** 回收成功后调用，父组件据此重取审计记录 */
  reloadLogs: () => void;
}

const RevokeGrantDialog: React.FC<RevokeGrantDialogProps> = ({
  revokeTarget,
  setRevokeTarget,
  revokeNeedsDualControl,
  reloadGrants,
  reloadLogs,
}) => {
  const [revokeReason, setRevokeReason] =
    useState<GrantRevokeReason>('manual');
  const [reviewedBy, setReviewedBy] = useState('');
  const [destructionProof, setDestructionProof] = useState('');
  const [busy, setBusy] = useState(false);

  const submitRevoke = async () => {
    if (!revokeTarget) return;
    setBusy(true);
    try {
      const result = await dataAssetApi.revokeGrant(revokeTarget.id, {
        reason: revokeReason,
        reviewedBy: reviewedBy || undefined,
        destructionProof: destructionProof || undefined,
      });
      toast.success(
        `授权已回收，审计记录 ${result.logId.slice(0, 8)}…（${
          REVOKE_REASON_LABELS[revokeReason]
        }）`,
      );
      setRevokeTarget(null);
      setReviewedBy('');
      setDestructionProof('');
      reloadGrants();
      reloadLogs();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '回收失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={revokeTarget !== null}
      onOpenChange={(open) => {
        if (!open) setRevokeTarget(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            回收授权 {revokeTarget?.code}
            {revokeNeedsDualControl && '（L4 核心数据）'}
          </DialogTitle>
          <DialogDescription>
            {revokeNeedsDualControl
              ? '该数据集为 L4 核心等级：必须由他人复核，并登记对方删除副本的凭证。'
              : '违规回收必须登记销毁凭证；其余情况可选填。'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="revoke-reason">回收原因</Label>
            <Select
              value={revokeReason}
              onValueChange={(value) =>
                setRevokeReason(value as GrantRevokeReason)
              }
            >
              <SelectTrigger id="revoke-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(REVOKE_REASON_LABELS) as GrantRevokeReason[]).map(
                  (key) => (
                    <SelectItem key={key} value={key}>
                      {REVOKE_REASON_LABELS[key]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="revoke-reviewer">
              复核人{revokeNeedsDualControl ? '（必填，且不能是操作人本人）' : ''}
            </Label>
            <Input
              id="revoke-reviewer"
              value={reviewedBy}
              placeholder="复核人 妙搭 userId"
              onChange={(event) => setReviewedBy(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="revoke-proof">
              销毁凭证
              {revokeNeedsDualControl || revokeReason === 'violation'
                ? '（必填）'
                : ''}
            </Label>
            <Input
              id="revoke-proof"
              value={destructionProof}
              placeholder="对方出具的删除确认函编号"
              onChange={(event) => setDestructionProof(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setRevokeTarget(null)}
          >
            取消
          </Button>
          <Button type="button" disabled={busy} onClick={submitRevoke}>
            {busy ? '提交中…' : '确认回收'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default RevokeGrantDialog;
