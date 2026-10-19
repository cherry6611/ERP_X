/**
 * 登记应收弹窗（§5.9 / F8）。
 *
 * 从 `ArApSection.tsx` 抽出的**自包含**弹窗：`useForm`、`handleSubmit` 与渲染
 * 都在本文件里，父组件只保留数据查询与"打开了哪个弹窗"这一个布尔 state。
 *
 * ⚠️ **行为零变更**：JSX 是原块的逐字搬运 —— 只做了两件事：
 *   ① 整体去掉一层缩进（2 个空格）；
 *   ② `arOpen` / `setArOpen` 改为 props `open` / `onOpenChange`，
 *      `chain` / `contractId` / `projectId` 由父组件传入（原是同名的组件内绑定），
 *      `await refreshAll()` 改为 `await onSaved()`。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置在**提交成功之后**（`toast.success` → 关闭 → `arForm.reset(...)` → 重取），
 * 不是"打开弹窗时" —— 原实现没有 reset-on-open，故关闭再打开会保留上次输入。
 * 触发点逐字未改：`if (!contractId) { … return; }` 的守卫仍在提交处理器开头。
 *
 * ## 为什么本组件必须**无条件挂载**
 *
 * `useForm` 的状态随本组件的生命周期存在。父组件写成
 * `{open && <ArDialog … />}` 会让"提交失败后再关掉弹窗"丢掉已填内容
 * （原实现的表单常驻），所以父组件是常挂载 + `open` prop。
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import DateField from '@client/src/components/erp/DateField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Explained } from '@client/src/components/erp/ItemHelp';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { UserSelect } from '@client/src/components/business-ui/user-select';
import { financeApi } from '@client/src/api';
import {
  arSchema,
  contractCustomerLabel,
  type ArFormData,
  type ArFormInput,
} from '../ar-ap-model';
import type { CreateArDto, ProjectChainOverview } from '@shared/api.interface';

interface ArDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 项目 id：`CreateArDto` 需要（应收单挂在合同上，但仍归属项目） */
  projectId: string;
  /** 关联合同 id；为空时提交被守卫拦下（原实现如此） */
  contractId: string;
  /** 项目链路数据：只读输入框的「合同 / 客户（自动带入）」取自它 */
  chain: ProjectChainOverview | undefined;
  /** 写成功后调用，父组件据此重取数据（原 `refreshAll`） */
  onSaved: () => void | Promise<void>;
}

const ArDialog: React.FC<ArDialogProps> = ({
  open,
  onOpenChange,
  projectId,
  contractId,
  chain,
  onSaved,
}) => {
  const arForm = useForm<ArFormInput, unknown, ArFormData>({
    resolver: zodResolver(arSchema),
    defaultValues: { amount: 0, ownerUserId: '', remark: '' },
  });

  const onCreateAr = arForm.handleSubmit(async (values) => {
    if (!contractId) {
      toast.error('项目未关联合同，无法登记应收');
      return;
    }
    const dto: CreateArDto = {
      contractId,
      projectId,
      amount: values.amount,
      dueDate: values.dueDate,
      ownerUserId: values.ownerUserId || undefined,
      remark: values.remark || undefined,
    };
    try {
      await financeApi.createAr(dto);
      toast.success('应收已登记');
      onOpenChange(false);
      arForm.reset({ amount: 0, ownerUserId: '', remark: '' });
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>登记应收</DialogTitle>
        </DialogHeader>
        <Form {...arForm}>
          <form onSubmit={onCreateAr} className="space-y-4">
            <FormItem>
              <FormLabel>合同 / 客户（自动带入）</FormLabel>
              <FormControl>
                <Input
                  value={contractCustomerLabel(chain)}
                  readOnly
                  aria-readonly="true"
                />
              </FormControl>
            </FormItem>
            <FormField
              control={arForm.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    应收金额（元）{' '}
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
              control={arForm.control}
              name="dueDate"
              render={({ field }) => (
                <FormItem>
                  <Explained
                    title="到期日"
                    content="账龄从这一天计算逾期天数。不填时，这笔未结清应收记在未逾期。已结清和已作废的不进入账龄。"
                  >
                    <FormLabel>到期日</FormLabel>
                  </Explained>
                  <DateField value={field.value} onChange={field.onChange} />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={arForm.control}
              name="ownerUserId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>回款责任人</FormLabel>
                  <div className="flex items-center gap-2">
                    <UserSelect
                      value={field.value || null}
                      onChange={(v: string | null) => field.onChange(v ?? '')}
                      placeholder="请选择回款责任人"
                    />
                    {field.value ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label="清除回款责任人"
                        onClick={() => field.onChange('')}
                      >
                        清除
                      </Button>
                    ) : null}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={arForm.control}
              name="remark"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>备注</FormLabel>
                  <FormControl>
                    <Textarea placeholder="备注" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={arForm.formState.isSubmitting}>提交登记</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default ArDialog;
