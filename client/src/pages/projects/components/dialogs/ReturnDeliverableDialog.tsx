/**
 * 「退回交付物」弹窗（§5.9 / F8）。
 *
 * 从 `DeliverableSection.tsx` 抽出的弹窗渲染块（原 `<Dialog open={returnOpen}>`），
 * 连同它的 schema —— 字段名必须与下面的 JSX 对应，放在一起才不会各改一半。
 *
 * ## 为什么 `useForm` 留在父组件（不是漏搬）
 *
 * 原实现在**打开弹窗时**重置表单，触发点是父组件表格行「退回」按钮那一行：
 *
 *     const openReturnDeliverable = (d: DeliverableItem) => {
 *       setReturnTarget(d);
 *       deliverableReturnForm.reset({ reason: '' });
 *       setReturnOpen(true);
 *     };
 *
 * 把 `useForm` 搬进本组件，这行重置就无处安放 —— 只能用 `useEffect` 复现，
 * 而 effect 在提交之后才跑，触发点与执行时机都会变（关闭再打开会留下上次填的
 * 原因）。按拆分约定：**状态必须留在父组件以保住触发点时，就以下沉的同名 props
 * 传进来**（`deliverableReturnForm` / `onReturnDeliverable`）。本组件只负责渲染，
 * 也**没有**新增任何重置。
 *
 * ⚠️ **行为零变更**：JSX 为原块逐字搬运，只做了两件事 ——
 *   ① 整体去掉一层缩进（2 个空格）；
 *   ② `returnOpen` / `setReturnOpen` 改为 props `open` / `onOpenChange`。
 */
import React from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
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
import { Textarea } from '@client/src/components/ui/textarea';

export const deliverableReturnSchema = z.object({
  reason: z.string().min(1, '请填写退回原因'),
});

export type DeliverableReturnFormData = z.infer<typeof deliverableReturnSchema>;

interface ReturnDeliverableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 父组件持有的表单实例：打开弹窗时的 `reset` 由父组件调用（见文件头说明） */
  deliverableReturnForm: UseFormReturn<DeliverableReturnFormData>;
  /** 父组件的提交处理器，即 `deliverableReturnForm.handleSubmit(...)` 的返回值 */
  onReturnDeliverable: (e?: React.BaseSyntheticEvent) => Promise<void>;
}

const ReturnDeliverableDialog: React.FC<ReturnDeliverableDialogProps> = ({
  open,
  onOpenChange,
  deliverableReturnForm,
  onReturnDeliverable,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>退回交付物</DialogTitle>
        </DialogHeader>
        <Form {...deliverableReturnForm}>
          <form onSubmit={onReturnDeliverable} className="space-y-4">
            <FormField
              control={deliverableReturnForm.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    退回原因 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea placeholder="请填写退回原因" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit">确认退回</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default ReturnDeliverableDialog;
