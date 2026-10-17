/**
 * 关联应收弹窗（§5.9 / F8）。
 *
 * 从 `InvoicesTab.tsx` 抽出：`handleLink`（`PATCH /api/finance/invoices/:id`）
 * 与提交态 `linking` 都在本文件里；主文件只保留台账查询与 `reload`。
 *
 * ## 为什么 `linkArId` 的 state **留在父组件**（而不是一起搬进来）
 *
 * 这一处与同目录另外三个弹窗不同：`linkArId` 有一个**打开时**的初始化 ——
 * 表格「关联应收」按钮走 `openLinkDialog(record)`，在那里
 * `setLinkArId(record.arId ?? '')`（带出该发票当前已关联的应收）+ `setLinkTarget(record)`。
 * 若把 state 搬进本组件、改用 `useEffect(..., [linkTarget])` 去补这一步，
 * 就多出一帧"旧值"渲染，**不再是同一个触发点**。因此这里保持父组件持有
 * `linkArId` / `setLinkArId` 并以 props 传入，三处时机逐字不变：
 *   ① 打开时带出 `record.arId ?? ''`（`openLinkDialog`）；
 *   ② 关闭时（`onOpenChange(false)`）清空 `linkArId` 并置 `linkTarget=null`；
 *   ③ 提交成功后清空同一对 state 并 `await onSaved()`。
 * 原实现没有"每次打开都清空"的兜底，也没有 reset-on-open 之外的任何重置。
 *
 * ⚠️ **行为零变更**：JSX 与 `handleLink` 是原块的逐字搬运 —— 只做了两件事：
 *   ① 整体去掉一层缩进（原块在 `InvoicesTab` 的 `return` 里，深一级）；
 *   ② `await reload()` 改为 `await onSaved()`。
 * DialogTitle / placeholder / toast 文案全部逐字未动。
 *
 * ⚠️ 本组件**必须无条件挂载**（父组件不能写成 `{linkTarget && <InvoiceLinkDialog/>}`）：
 * `linkArId` 与 `linkTarget` 的成对赋值发生在父组件的 `openLinkDialog` 里，
 * 条件挂载会让"打开前先清空/带出"的那一步落空。
 */
import React, { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { financeApi } from '@client/src/api';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { ArItem, InvoiceItem } from '@shared/api.interface';

interface InvoiceLinkDialogProps {
  /** 待关联的发票；`null` 表示弹窗关闭。父组件 state，直接透传 */
  linkTarget: InvoiceItem | null;
  /** 父组件的 `setLinkTarget`（打开/关闭/提交成功三处都要用，故透传 setter） */
  setLinkTarget: (value: InvoiceItem | null) => void;
  /** 选中的应收单 id。父组件 state —— 打开时由 `openLinkDialog` 带出，见文件头说明 */
  linkArId: string;
  /** 父组件的 `setLinkArId` */
  setLinkArId: (value: string) => void;
  /** 可关联应收白名单（仅开放中 / 部分回款），由父组件派生后传入 */
  linkableArs: ArItem[];
  /** 关联成功后调用，父组件据此重取发票台账 */
  onSaved: () => void | Promise<void>;
}

const InvoiceLinkDialog: React.FC<InvoiceLinkDialogProps> = ({
  linkTarget,
  setLinkTarget,
  linkArId,
  setLinkArId,
  linkableArs,
  onSaved,
}) => {
  const [linking, setLinking] = useState(false);

  const handleLink = async () => {
    if (!linkTarget || !linkArId) return;
    setLinking(true);
    try {
      await financeApi.updateInvoice(linkTarget.id, { arId: linkArId });
      toast.success('关联应收成功');
      setLinkTarget(null);
      setLinkArId('');
      await onSaved();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '关联应收失败'));
    } finally {
      setLinking(false);
    }
  };

  return (
    <Dialog open={linkTarget !== null} onOpenChange={(open: boolean) => {
      if (!open) {
        setLinkTarget(null);
        setLinkArId('');
      }
    }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>关联应收</DialogTitle>
          <DialogDescription>
            为发票 {linkTarget?.code} 选择待回款的应收单，提交后完成关联
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Select value={linkArId} onValueChange={setLinkArId}>
            <SelectTrigger>
              <SelectValue placeholder="请选择应收单" />
            </SelectTrigger>
            <SelectContent>
              {linkableArs.map((a: ArItem) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.code} - {a.customerName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {linkableArs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              暂无可关联的应收单（仅开放中 / 部分回款的应收可关联）
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkTarget(null)}>
              取消
            </Button>
            <Button disabled={!linkArId || linking} onClick={() => void handleLink()}>
              确认关联
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default InvoiceLinkDialog;
