/**
 * 「框架合同下单（Call-off）」弹窗（§5.9 / F8 拆分第二轮）。
 *
 * 从 909 行的 `ContractDetailDialog.tsx` 抽出的六个 `<Dialog>` 之一，抽出手法与
 * `MilestoneDialog` 完全一致（见该文件头的逐条说明）。
 *
 * ⚠️ **行为零变更**：JSX 与提交处理逐字搬运，只做了三件事 ——
 *   ① 整体去掉两层缩进；
 *   ② `calloffOpen` / `setCalloffOpen` 改为 props `open` / `onOpenChange`
 *      （父组件传入的就是 `calloffOpen` / `setCalloffOpen`）；
 *   ③ `await load()` 改为 `await onSaved()`（父组件传入的就是 `load`）。
 *
 * ## 重置时机（刻意保持原样：写成功之后，**不是**打开时）
 *
 * 原实现只有一处重置 —— 提交成功后
 * `setCalloffOpen(false)` → `calloffForm.reset(CALLOFF_FORM_DEFAULTS)` → `await load()`；
 * 没有任何"打开即清空"的 `useEffect`。因此 `useForm` 仍留在父组件
 * （理由见 `MilestoneDialog` 文件头第 2 条），本组件只接 `form` 与 `onSubmit`。
 *
 * ## 下单金额门槛是 1（不是 0.01）
 *
 * `calloffSchema.amount` 是 `min(1, '下单金额必须大于 0')`，比服务端
 * `CreateCalloffDto` 的 `@Min(0.01)` 严一档 —— 这是**有意**的，不是笔误：
 * 0.5 元的下单会被前端拦下。见 `contract-detail-model.ts` 文件头
 * 「两处看着该统一、其实不能统一的门槛」。本轮未动。
 */
import React from 'react';
import { useForm } from 'react-hook-form';
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
import { Input } from '@client/src/components/ui/input';
import { Textarea } from '@client/src/components/ui/textarea';
import type { CalloffFormData, CalloffFormInput } from '../../contract-detail-model';

interface CalloffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: ReturnType<typeof useForm<CalloffFormInput, unknown, CalloffFormData>>;
  onSubmit: React.FormEventHandler<HTMLFormElement>;
}

const CalloffDialog: React.FC<CalloffDialogProps> = ({
  open,
  onOpenChange,
  form: calloffForm,
  onSubmit: onAddCalloff,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>框架合同下单（Call-off）</DialogTitle>
        </DialogHeader>
        <Form {...calloffForm}>
          <form onSubmit={onAddCalloff} className="space-y-4">
            <FormField
              control={calloffForm.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    下单金额（元）{' '}
                    <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
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
              control={calloffForm.control}
              name="remark"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>备注</FormLabel>
                  <FormControl>
                    <Textarea placeholder="下单说明" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit">下单</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default CalloffDialog;
