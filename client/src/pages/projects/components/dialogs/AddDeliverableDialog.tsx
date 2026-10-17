/**
 * 「添加交付物」弹窗（§5.9 / F8）。
 *
 * 从 `DeliverableSection.tsx` 抽出的**自包含**弹窗：schema、`useForm`、
 * `handleSubmit` 与渲染都在本文件里；父组件只剩数据查询、表格列定义、
 * "打开了哪个弹窗"的布尔 state 与三个弹窗的触发处理器。
 *
 * ⚠️ **行为零变更**：schema、提交处理器与 JSX 都是原块逐字搬运，只做了三件事：
 *   ① JSX 整体去掉一层缩进（2 个空格）；
 *   ② `addOpen` / `setAddOpen` 改为 props `open` / `onOpenChange`；
 *   ③ 提交成功后的 `await refresh()` 改为 `await onSaved()`（父组件传进来的
 *      就是 `refresh`：先重取列表、再回调 `onChanged` 联动顶部财务卡）。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置在**提交成功之后**（`toast.success` → 关闭 → `reset(...)` → 重取），
 * 原实现**没有** reset-on-open —— 关掉弹窗再打开会保留上次输入。因此本组件
 * 必须**无条件挂载**（父组件只切 `open` prop）：`useForm` 的状态随本组件的
 * 生命周期存在，若写成 `{addOpen && <AddDeliverableDialog … />}`，
 * "关掉再打开"就会丢掉已填内容 —— 那是行为变更，不是等价改写。
 */

import React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
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
import { projectsApi } from '@client/src/api';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { CreateDeliverableDto } from '@shared/api.interface';

const dateStringSchema = z
  .string()
  .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/u.test(v), '请输入 YYYY-MM-DD 格式日期');

const deliverableSchema = z.object({
  name: z.string().min(1, '交付物名称不能为空'),
  deliverableType: z.string(),
  acceptanceCriteria: z.string(),
  dueDate: dateStringSchema,
  reviewer: z.string(),
  remark: z.string(),
});

type DeliverableFormData = z.infer<typeof deliverableSchema>;

interface AddDeliverableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** 写成功后调用：父组件的 `refresh`（重取列表 + `onChanged`） */
  onSaved: () => void | Promise<void>;
}

const AddDeliverableDialog: React.FC<AddDeliverableDialogProps> = ({
  open,
  onOpenChange,
  projectId,
  onSaved,
}) => {
  const deliverableForm = useForm<DeliverableFormData>({
    resolver: zodResolver(deliverableSchema),
    defaultValues: {
      name: '',
      deliverableType: '',
      acceptanceCriteria: '',
      dueDate: '',
      reviewer: '',
      remark: '',
    },
  });

  const onCreateDeliverable = deliverableForm.handleSubmit(async (values) => {
    const dto: CreateDeliverableDto = {
      name: values.name,
      deliverableType: values.deliverableType || undefined,
      acceptanceCriteria: values.acceptanceCriteria || undefined,
      dueDate: values.dueDate || undefined,
      reviewer: values.reviewer || undefined,
      remark: values.remark || undefined,
    };
    try {
      await projectsApi.createDeliverable(projectId, dto);
      toast.success('交付物已添加');
      onOpenChange(false);
      deliverableForm.reset({
        name: '',
        deliverableType: '',
        acceptanceCriteria: '',
        dueDate: '',
        reviewer: '',
        remark: '',
      });
      await onSaved();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '添加失败'));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加交付物</DialogTitle>
        </DialogHeader>
        <Form {...deliverableForm}>
          <form onSubmit={onCreateDeliverable} className="space-y-4">
            <FormField
              control={deliverableForm.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    名称 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="如：数据交付报告" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={deliverableForm.control}
              name="deliverableType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>类型</FormLabel>
                  <FormControl>
                    <Input placeholder="如：文档 / 代码 / 模型 / 报告" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={deliverableForm.control}
              name="acceptanceCriteria"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>验收标准</FormLabel>
                  <FormControl>
                    <Textarea placeholder="请描述验收标准" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={deliverableForm.control}
              name="dueDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>截止日期</FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      placeholder="YYYY-MM-DD"
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={deliverableForm.control}
              name="reviewer"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>评审人</FormLabel>
                  <FormControl>
                    <Input placeholder="评审人" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={deliverableForm.control}
              name="remark"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>备注</FormLabel>
                  <FormControl>
                    <Input placeholder="备注" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit">保存</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default AddDeliverableDialog;
