/**
 * 「添加里程碑」弹窗（§5.9 / F8 拆分第二轮）。
 *
 * 从 909 行的 `ContractDetailDialog.tsx` 抽出的六个 `<Dialog>` 之一：原先每个弹窗
 * 是一段 `useForm` + 提交处理函数 + 60 行 JSX 挤在组件体末尾，抽出来后
 * "表单字段 → schema → DTO → 写后动作"四件事就近可读。
 *
 * ⚠️ **行为零变更**：JSX 与提交处理逐字搬运，只做了三件事 ——
 *   ① 整体去掉两层缩进；
 *   ② `milestoneOpen` / `setMilestoneOpen` 改为 props `open` / `onOpenChange`
 *      （父组件传入的就是 `milestoneOpen` / `setMilestoneOpen`，函数身份未变）；
 *   ③ `await load()` 改为 `await onSaved()`（父组件传入的就是 `load`）。
 *
 * ## ⚠️ 弹窗必须**无条件挂载**，且**表单状态必须留在父组件**
 *
 * 这是本组件唯一容易搬错的地方，两条都刻意保持原样：
 *
 * 1. `<MilestoneDialog …/>` 不能写成 `{milestoneOpen && <MilestoneDialog/>}`。
 *    原实现里 `milestoneForm` 与 `milestoneOpen` 都是**常驻**的组件状态，
 *    条件挂载会让 `useForm` 在每次打开时重建：用户填到一半关掉再打开，
 *    草稿值会从"还在"变成"没了"。
 * 2. `useForm` **不**搬进本组件，而是由父组件创建后经 `form` prop 传入。
 *    原因是**重置时机**：原实现在提交成功后依次执行
 *    `setMilestoneOpen(false)` → `milestoneForm.reset(MILESTONE_FORM_DEFAULTS)`
 *    → `await load()`，全文件**没有** reset-on-open 的 `useEffect`。若把 `useForm`
 *    搬进来，实例身份会随父组件渲染重建、`FormProvider` 重新绑定，重置时点随之
 *    漂移。这里选择"状态留在父组件、以同名 prop 下传"，触发点因此与原来完全一致
 *    （父组件仍是同一行 `milestoneForm.reset(...)`）。
 */
import React from 'react';
import { Explained } from '@client/src/components/erp/ItemHelp';
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
import type { MilestoneFormData, MilestoneFormInput } from '../../contract-detail-model';

interface MilestoneDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 表单实例由父组件持有（见文件头「表单状态必须留在父组件」） */
  form: ReturnType<typeof useForm<MilestoneFormInput, unknown, MilestoneFormData>>;
  /** 提交处理函数由父组件持有（内含 `contractsApi.addMilestone` 与写后 `load()`） */
  onSubmit: React.FormEventHandler<HTMLFormElement>;
}

const MilestoneDialog: React.FC<MilestoneDialogProps> = ({
  open,
  onOpenChange,
  form: milestoneForm,
  onSubmit: onAddMilestone,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加里程碑</DialogTitle>
        </DialogHeader>
        <Form {...milestoneForm}>
          <form onSubmit={onAddMilestone} className="space-y-4">
            <FormField
              control={milestoneForm.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    名称 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="请输入里程碑名称" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-4">
              <FormField
                control={milestoneForm.control}
                name="amount"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <Explained
                      title="金额"
                      content="这个里程碑对应的含税金额。它用来拆分合同收款，不自动生成应收。"
                    >
                      <FormLabel>金额（元）</FormLabel>
                    </Explained>
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
                control={milestoneForm.control}
                name="dueCondition"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <Explained
                      title="触发条件"
                      content="写明什么情况下达到这个里程碑，例如验收通过。它不参与计税。"
                    >
                      <FormLabel>触发条件</FormLabel>
                    </Explained>
                    <FormControl>
                      <Input placeholder="如：验收通过" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter>
              <Button type="submit">保存</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default MilestoneDialog;
