/**
 * 「订单验收」弹窗（§5.9 / F8）
 *
 * 从 `PurOrderPanel.tsx` 抽出的渲染块（原 `<Dialog open={acceptTarget !== null}>`，
 * 原文件 676-747 行），连同它的 `acceptSchema`。
 *
 * ## 为什么 `useForm` 留在父组件（不是漏搬）
 *
 * 原实现在**行点击处理函数里同步重置表单**，触发点就是表格「操作」列那一行：
 *
 *     const openAcceptDialog = (order: PurOrderItem) => {
 *       acceptForm.reset({
 *         quantity: order.quantity - order.acceptedQuantity,
 *         acceptDate: todayIso(),
 *       });
 *       setAcceptTarget(order);
 *     };
 *
 * 搬进本组件后这行重置无处安放：改用 `useEffect`（或「按需挂载 + `defaultValues`」）
 * 会把触发点从「点击」挪到「挂载 / 渲染」，而「每次打开都按该行剩余量预填、日期取当天」
 * 正是可见行为。故表单实例、`setAcceptTarget` 与提交处理器以下沉的**同名 props** 传入
 * （`acceptForm` / `setAcceptTarget` / `onAcceptSubmit`），本组件**没有**新增任何重置。
 *
 * ## 为什么 `acceptTarget` 是 `PurOrderItem | null` 而不是非空
 *
 * 原始 JSX 里 `open={acceptTarget !== null}` 与 `{acceptTarget ? … : null}` 两处判空
 * 都逐字保留（弹窗关闭动画期间仍会渲染一次），因此 prop 类型保持可空，
 * 与 `AcceptDeliverableDialog.tsx` 的既有写法一致。
 *
 * ⚠️ **行为零变更**：JSX 逐字搬运，只做了两件事 ——
 *   ① 整体去掉一层缩进（2 个空格）；
 *   ② `acceptForm` / `acceptTarget` / `setAcceptTarget` / `operating` / `onAcceptSubmit`
 *      由父组件的同名 props 提供；`acceptSchema` 与表单类型随本文件搬走、由父组件 import。
 */
import React from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { z } from 'zod';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import DateField from '@client/src/components/erp/DateField';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@client/src/components/ui/form';
import { Input } from '@client/src/components/ui/input';
import type { PurOrderItem } from '@shared/api.interface';

export const acceptSchema = z.object({
  quantity: z.coerce.number().int().min(1, '验收数量至少为 1'),
  acceptDate: z.string(),
});

export type AcceptOrderFormInput = z.input<typeof acceptSchema>;
export type AcceptOrderFormData = z.output<typeof acceptSchema>;

/** 父组件 `useForm<AcceptOrderFormInput, unknown, AcceptOrderFormData>` 的返回值 */
export type AcceptOrderForm = UseFormReturn<
  AcceptOrderFormInput,
  unknown,
  AcceptOrderFormData
>;

interface AcceptOrderDialogProps {
  acceptForm: AcceptOrderForm;
  /** 正在验收的订单；`null` 时不渲染内容（原实现如此） */
  acceptTarget: PurOrderItem | null;
  /** 父组件的 `setAcceptTarget`：关闭分支逐字保留（`if (!open) setAcceptTarget(null);`） */
  setAcceptTarget: (target: PurOrderItem | null) => void;
  operating: boolean;
  /** 父组件的 `acceptForm.handleSubmit(...)` 返回值 */
  onAcceptSubmit: (e?: React.BaseSyntheticEvent) => Promise<void>;
}

const AcceptOrderDialog: React.FC<AcceptOrderDialogProps> = ({
  acceptForm,
  acceptTarget,
  setAcceptTarget,
  operating,
  onAcceptSubmit,
}) => {
  return (
    <Dialog
      open={acceptTarget !== null}
      onOpenChange={(open: boolean) => {
        if (!open) setAcceptTarget(null);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>订单验收</DialogTitle>
          {acceptTarget ? (
            <DialogDescription>
              订单 {acceptTarget.code}（{acceptTarget.itemName}）：订单数量{' '}
              {acceptTarget.quantity}，已验收 {acceptTarget.acceptedQuantity}，可验收上限{' '}
              {acceptTarget.quantity - acceptTarget.acceptedQuantity}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <Form {...acceptForm}>
          <form onSubmit={onAcceptSubmit} className="space-y-4">
            <FormField
              control={acceptForm.control}
              name="quantity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    验收数量 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      placeholder="请输入验收数量"
                      value={String(field.value ?? '')}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={acceptForm.control}
              name="acceptDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>验收日期</FormLabel>
                  <DateField value={field.value || undefined} onChange={field.onChange} />
                  <FormMessage />
                </FormItem>
              )}
            />
            {acceptTarget ? (
              <div className="border-t pt-4">
                <AttachmentField
                  resourceType="pur_order"
                  resourceId={acceptTarget.id}
                  usageHint="订单扫描件、采购合同等"
                />
              </div>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={operating}>
                确认验收
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default AcceptOrderDialog;
