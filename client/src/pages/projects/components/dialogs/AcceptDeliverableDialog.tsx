/**
 * 「验收交付物」弹窗（§5.9 / F8）。
 *
 * 从 `DeliverableSection.tsx` 抽出的弹窗渲染块（原 `<Dialog open={acceptTarget !== null}>`），
 * 连同它的 schema。两个分支与拆分前一致：`submitted` 行是验收表单，
 * `accepted` 行是只读回看（验收结论 + 验收日期），两者都带 `erp_deliverable` 附件区。
 *
 * ## 为什么 `useForm` 留在父组件（不是漏搬）
 *
 * 原实现在**打开弹窗时**按行数据重置表单，触发点是父组件表格行那一行：
 *
 *     const openAcceptDeliverable = (d: DeliverableItem) => {
 *       deliverableAcceptForm.reset({
 *         conclusion: d.acceptConclusion ?? '',
 *         acceptDate: dayjs().format('YYYY-MM-DD'),
 *       });
 *       setAcceptTarget(d);
 *     };
 *
 * 搬进本组件后这行重置无处安放：改用 `useEffect` 会改变触发点与执行时机，
 * 而"打开时按该行预填验收结论 + 当天日期"正是可见行为（关掉再打开会回到该行的
 * 结论，而不是上次输入）。故表单实例以下沉的同名 props 传入
 * （`deliverableAcceptForm` / `onAcceptDeliverable`），`open` 条件
 * （`acceptTarget !== null`）与关闭分支仍留在父组件的调用处。本组件**没有**
 * 新增任何重置。
 *
 * ⚠️ **行为零变更**：JSX 逐字搬运，只做了两件事 ——
 *   ① 整体去掉一层缩进（2 个空格）；
 *   ② `acceptTarget` 由父组件的同名 prop 传入（仍是 `DeliverableItem | null`）。
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
import type { DeliverableItem } from '@shared/api.interface';

export const deliverableAcceptSchema = z.object({
  conclusion: z.string(),
  acceptDate: z.string().optional(),
});

export type DeliverableAcceptFormData = z.infer<typeof deliverableAcceptSchema>;

interface AcceptDeliverableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 正在查看 / 验收的交付物；`null` 时不渲染内容（原实现如此） */
  acceptTarget: DeliverableItem | null;
  /** 父组件持有的表单实例：打开弹窗时的 `reset` 由父组件调用（见文件头说明） */
  deliverableAcceptForm: UseFormReturn<DeliverableAcceptFormData>;
  /** 父组件的提交处理器，即 `deliverableAcceptForm.handleSubmit(...)` 的返回值 */
  onAcceptDeliverable: (e?: React.BaseSyntheticEvent) => Promise<void>;
}

const AcceptDeliverableDialog: React.FC<AcceptDeliverableDialogProps> = ({
  open,
  onOpenChange,
  acceptTarget,
  deliverableAcceptForm,
  onAcceptDeliverable,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>验收交付物 - {acceptTarget?.name ?? ''}</DialogTitle>
        </DialogHeader>
        {acceptTarget ? (
          <div className="space-y-4">
            {acceptTarget.status === 'accepted' ? (
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium">验收结论</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                    {acceptTarget.acceptConclusion ?? '-'}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium">验收日期</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {acceptTarget.acceptedAt ? acceptTarget.acceptedAt.slice(0, 10) : '-'}
                  </p>
                </div>
              </div>
            ) : (
              <Form {...deliverableAcceptForm}>
                <form onSubmit={onAcceptDeliverable} className="space-y-4">
                  <FormField
                    control={deliverableAcceptForm.control}
                    name="conclusion"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>验收结论</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="如：数据质量达标，客户确认通过"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={deliverableAcceptForm.control}
                    name="acceptDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>验收日期</FormLabel>
                        <DateField value={field.value} onChange={field.onChange} />
                        <p className="text-xs text-muted-foreground">
                          仅作提示，验收日期由后端按当日记录
                        </p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <DialogFooter>
                    <Button type="submit">确认通过</Button>
                  </DialogFooter>
                </form>
              </Form>
            )}
            <div className="space-y-2">
              <p className="text-sm font-medium">验收附件</p>
              <AttachmentField
                resourceType="erp_deliverable"
                resourceId={acceptTarget.id}
                usageHint="客户验收单扫描件、云文档链接"
              />
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};

export default AcceptDeliverableDialog;
