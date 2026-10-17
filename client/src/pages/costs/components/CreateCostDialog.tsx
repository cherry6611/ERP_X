/**
 * 归集成本弹窗（§5.9 / F8）。
 *
 * 从 `CostsTab.tsx` 抽出的**自包含**弹窗：`useForm`、提交处理
 * （`onSubmit`）与整段 JSX 原先都散在 530 行的 Tab 组件里，
 * 抽出后与使用它们的表单同处一文件，父组件只留查询与编排。
 *
 * ⚠️ **行为零变更**：JSX、zod 校验与提交处理都是原块的逐字搬运 ——
 * 只做了四件事：
 *   ① 整体去掉一层缩进；
 *   ② `createOpen` / `setCreateOpen` 改为 props `open` / `onOpenChange`；
 *   ③ `projects` 改为同名 prop（父组件持有该查询）；
 *   ④ `await reload()` 改为 `await onSaved()`（父组件传入的就是 `reload`）。
 *
 * ⚠️ 本组件**必须无条件挂载**（父组件不能用 `{open && <CreateCostDialog/>}`
 * 渲染）：`useForm` 的实例与 `defaultValues` 原先在 `CostsTab` 里是常驻的，
 * 条件挂载会在每次打开时重建表单实例。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 提交成功后重置 —— 不是"打开弹窗时"：
 *
 * ```tsx
 * await costsApi.createCost(dto);
 * toast.success('成本已归集');
 * onOpenChange(false);
 * form.reset({ projectId: '', costType: 'compute', amount: 0, sourceRef: '', remark: '' });
 * await onSaved();
 * ```
 *
 * 原实现**没有** reset-on-open（`setCreateOpen(true)` 只改 `createOpen`），
 * 这里也不加：加了会让"关闭弹窗后重开"丢掉上次未提交的草稿输入，
 * 那是行为变更。重置的触发点仍是**写入成功之后**，且顺序不变
 * （先关弹窗、再 reset、最后重取列表）。
 */
import React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@client/src/components/ui/button';
import { dialogSize } from '@client/src/theme/dialog-size';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { costsApi } from '@client/src/api';
import { COST_TYPE_LABELS } from '@client/src/utils/biz-labels';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { costSchema, type CostFormData, type CostFormInput } from '../costs-schemas';
import type { CostType, CreateCostDto, Project } from '@shared/api.interface';

interface CreateCostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 项目选项。父组件持有查询，故允许 `undefined`（加载中） */
  projects: Project[] | undefined;
  /** 归集成功后调用，父组件据此重取成本列表 */
  onSaved: () => void | Promise<void>;
}

const CreateCostDialog: React.FC<CreateCostDialogProps> = ({
  open,
  onOpenChange,
  projects,
  onSaved,
}) => {
  const form = useForm<CostFormInput, unknown, CostFormData>({
    resolver: zodResolver(costSchema),
    defaultValues: { projectId: '', costType: 'compute', amount: 0, sourceRef: '', remark: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateCostDto = {
      projectId: values.projectId,
      costType: values.costType as CostType,
      amount: values.amount,
      sourceRef: values.sourceRef,
      remark: values.remark || undefined,
    };
    try {
      await costsApi.createCost(dto);
      toast.success('成本已归集');
      onOpenChange(false);
      form.reset({ projectId: '', costType: 'compute', amount: 0, sourceRef: '', remark: '' });
      await onSaved();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '归集失败'));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogSize.md}>
        <DialogHeader>
          <DialogTitle>归集成本</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="projectId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    项目 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择项目" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(projects ?? []).map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="costType"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      成本类型 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(COST_TYPE_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => {
                  const costType = form.watch('costType');
                  const isLabor =
                    costType === 'labor' || costType === 'flex_labor';
                  return (
                    <FormItem className="flex-1">
                      <FormLabel>
                        {isLabor ? '金额（不含税）' : '金额（含税）'}{' '}
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
                  );
                }}
              />
            </div>
            <FormField
              control={form.control}
              name="sourceRef"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    来源摘要 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="如：10 月云资源账单" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
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
              {/*
                ⚠️ 补「取消」按钮（2026-10-17）。
                原实现底部只有「保存」——虽然 X 图标 / Esc / 点遮罩三条路都能关，
                但同页另一个弹窗（`FeishuSyncRecordsDialog`）与同步确认框都成对给了
                「取消」+ 动作按钮，只有这里没有 —— 使用者会先找取消再找 X。
                统一成 `variant="outline"` 的次要按钮放左侧，与其余弹窗一致。
              */}
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
              <Button type="submit">保存</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default CreateCostDialog;
