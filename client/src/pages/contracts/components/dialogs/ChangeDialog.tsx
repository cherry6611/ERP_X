/**
 * 「登记合同变更」弹窗（§5.9 / F8 拆分第二轮）。
 *
 * 从 909 行的 `ContractDetailDialog.tsx` 抽出的六个 `<Dialog>` 之一，抽出手法与
 * `MilestoneDialog` 完全一致（见该文件头的逐条说明）。
 *
 * ⚠️ **行为零变更**：JSX 与提交处理逐字搬运，只做了三件事 ——
 *   ① 整体去掉两层缩进；
 *   ② `changeOpen` / `setChangeOpen` 改为 props `open` / `onOpenChange`
 *      （父组件传入的就是 `changeOpen` / `setChangeOpen`）；
 *   ③ `await load()` 改为 `await onSaved()`（父组件传入的就是 `load`）。
 *
 * ## 重置时机（刻意保持原样：写成功之后，**不是**打开时）
 *
 * 原实现只有一处重置 —— 提交成功后
 * `setChangeOpen(false)` → `changeForm.reset(CHANGE_FORM_DEFAULTS)` → `await load()`。
 * 因此 `useForm` 仍留在父组件（理由见 `MilestoneDialog` 文件头第 2 条）。
 *
 * ## `newAmount` 填 0 是"金额不变"
 *
 * 标签就写着"变更后金额（元，不变可填 0）"，`buildChangePayload` 里
 * `newAmount || undefined` 把 0 转成 `undefined`，服务端 `dto.newAmount ?? oldAmount`
 * 收到 `undefined` 就沿用原金额 —— 这是**既定语义**，不是漏判（见
 * `contract-detail-model.ts` 文件头「两处看着该统一、其实不能统一的门槛」）。
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
import type { ChangeFormData, ChangeFormInput } from '../../contract-detail-model';

interface ChangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: ReturnType<typeof useForm<ChangeFormInput, unknown, ChangeFormData>>;
  onSubmit: React.FormEventHandler<HTMLFormElement>;
}

const ChangeDialog: React.FC<ChangeDialogProps> = ({
  open,
  onOpenChange,
  form: changeForm,
  onSubmit: onCreateChange,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>登记合同变更</DialogTitle>
        </DialogHeader>
        <Form {...changeForm}>
          <form onSubmit={onCreateChange} className="space-y-4">
            <FormField
              control={changeForm.control}
              name="changeLog"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    变更说明 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea placeholder="请描述本次变更内容" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={changeForm.control}
              name="newAmount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>变更后金额（元，不变可填 0）</FormLabel>
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
            <DialogFooter>
              <Button type="submit">保存变更</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default ChangeDialog;
