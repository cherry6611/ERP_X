/**
 * 新建采购退货弹窗（§5.9 / F8）。
 *
 * 从 `ReturnsPage.tsx` **整体**搬出的自包含弹窗：建单表单的 5 个 `useState`、
 * `loadReturnable`（建单前查可退数量）与 `submitCreate`（建单）连同 JSX 一起进来。
 * 主文件保留数据查询（`useAsyncData`）与页面编排，只传入 `orderOptions`
 * （订单下拉）与 `reloadAll`（建单成功后重取退货台账与两个列表）。
 *
 * ⚠️ 行为零变更（搬迁时逐条核对，勿"顺手改好"）：
 *   ① JSX 与两个处理函数**逐字搬运**，只有两处改名：
 *      `createOpen` → prop `open`、`setCreateOpen` → prop `onOpenChange`；
 *   ② 父组件**无条件挂载**本组件（不是 `{open && <…/>}`）—— 表单 state 原先常驻在
 *      页面组件里，条件挂载会让它随开关被重建；
 *   ③ 本页**没有"打开即清空"**：重置只发生在**建单成功之后**，即 `submitCreate`
 *      里 `onOpenChange(false)` 之后的 4 个 setState；中途取消再打开会保留
 *      上次未提交的输入（原实现如此）。
 *      ⚠️ `returnDate` **不在**重置之列 —— 原实现也没重置它，不要补；
 *   ④ `busy` 与"完成销售退货"弹窗共用同一个 state（原实现即如此），故仍留在
 *      父组件、按原名透传进来，不另造一个局部标志。
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
import StatCard from '@client/src/components/erp/StatCard';
import * as returnsApi from '@client/src/api/returns';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
// 业务时区取"今天"：避免 UTC 口径在北京时间 00:00–08:00 取到前一天
import { todayIso } from '@client/src/utils/format';
import { money } from './returns-format';
import type {
  PurOrderItem,
  ReturnableQuantityResult,
} from '@shared/api.interface';

interface PurchaseReturnCreateDialogProps {
  /** 弹窗开关（「新建采购退货」按钮在页头 actions 里，故由父组件持有） */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 采购订单下拉选项（父组件持有查询） */
  orderOptions: PurOrderItem[];
  /** 提交中标志：与「完成销售退货」弹窗共用同一个 state，故由父组件原名透传 */
  busy: boolean;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  /** 建单成功后重取退货台账与两个列表（原 `reloadAll`） */
  reloadAll: () => void;
}

const PurchaseReturnCreateDialog: React.FC<PurchaseReturnCreateDialogProps> = ({
  open,
  onOpenChange,
  orderOptions,
  busy,
  setBusy,
  reloadAll,
}) => {
  // 采购退货建单表单
  const [orderId, setOrderId] = useState('');
  const [returnable, setReturnable] = useState<ReturnableQuantityResult | null>(
    null,
  );
  const [returnQuantity, setReturnQuantity] = useState('');
  const [returnDate, setReturnDate] = useState(todayIso());
  const [reason, setReason] = useState('');

  const loadReturnable = async (id: string) => {
    setOrderId(id);
    setReturnable(null);
    if (!id) return;
    try {
      const info = await returnsApi.getPurchaseReturnable(id);
      setReturnable(info);
      if (info.notAccepted) {
        toast.warning(
          `订单 ${info.orderCode} 尚未验收，无可退数量（退货基准是已验收数量）`,
        );
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, '查询可退数量失败'));
    }
  };

  const submitCreate = async () => {
    if (!orderId) {
      toast.error('请先选择采购订单');
      return;
    }
    const quantity = Number(returnQuantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      toast.error('退货数量必须为大于 0 的整数');
      return;
    }
    if (returnable && quantity > returnable.returnableQuantity) {
      toast.error(
        `退货数量超过可退数量 ${returnable.returnableQuantity}（已验收 ${returnable.acceptedQuantity}，已退 ${returnable.returnedQuantity}）`,
      );
      return;
    }
    setBusy(true);
    try {
      await returnsApi.createPurchaseReturn({
        orderId,
        returnDate,
        returnQuantity: quantity,
        reason: reason || undefined,
      });
      toast.success('采购退货单已创建（草稿），提交审批后才生效');
      onOpenChange(false);
      setOrderId('');
      setReturnable(null);
      setReturnQuantity('');
      setReason('');
      reloadAll();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '建单失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建采购退货</DialogTitle>
          <DialogDescription>
            可退数量 = 已验收 − 已退。未验收的货不可退（应向供应商催货或取消订单）。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="return-order">采购订单</Label>
            <Select value={orderId} onValueChange={loadReturnable}>
              <SelectTrigger id="return-order">
                <SelectValue placeholder="选择采购订单" />
              </SelectTrigger>
              <SelectContent>
                {orderOptions.map((order) => (
                  <SelectItem key={order.id} value={order.id}>
                    {order.code} {order.itemName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {returnable && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatCard
                label="已验收"
                value={String(returnable.acceptedQuantity)}
              />
              <StatCard
                label="已退"
                value={String(returnable.returnedQuantity)}
              />
              <StatCard
                label="可退"
                value={String(returnable.returnableQuantity)}
                tone={returnable.returnableQuantity > 0 ? 'success' : 'warning'}
              />
              <StatCard
                label="含税单价 / 税率"
                value={`${money(returnable.unitPrice)} / ${returnable.taxRate}%`}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="return-qty">退货数量</Label>
              <Input
                id="return-qty"
                inputMode="numeric"
                value={returnQuantity}
                placeholder="0"
                onChange={(event) => setReturnQuantity(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="return-date">退货日期</Label>
              <Input
                id="return-date"
                type="date"
                value={returnDate}
                onChange={(event) => setReturnDate(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="return-reason">退货原因</Label>
            <Input
              id="return-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            批准并「完成」后才生成红字凭证：借 2202 应付账款（含税）/
            贷 1403 原材料（净额）+ 贷 222102 进项税额。
          </p>
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
            {busy ? '创建中…' : '创建退货单'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PurchaseReturnCreateDialog;
