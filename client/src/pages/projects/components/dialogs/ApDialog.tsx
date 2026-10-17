/**
 * 登记应付弹窗（§5.9 / F8）。
 *
 * 从 `ArApSection.tsx` 抽出的**自包含**弹窗：`useForm`、`handleSubmit` 与渲染
 * 都在本文件里。
 *
 * ⚠️ **行为零变更**：JSX 是原块的逐字搬运 —— 只做了两件事：
 *   ① 整体去掉一层缩进（2 个空格）；
 *   ② `apOpen` / `setApOpen` 改为 props `open` / `onOpenChange`，
 *      `suppliers` / `projectId` 由父组件传入（原是同名的组件内绑定），
 *      `await refreshAll()` 改为 `await onSaved()`。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置在**提交成功之后**（`toast.success` → 关闭 → `apForm.reset(...)` → 重取），
 * 不是"打开弹窗时" —— 原实现没有 reset-on-open，故关闭再打开会保留上次输入。
 * 与其他三个弹窗不同，本弹窗没有前置守卫（应付单挂在供应商上、不依赖合同/客户）。
 *
 * ## 为什么本组件必须**无条件挂载**
 *
 * `useForm` 的状态随本组件的生命周期存在；父组件写成 `{open && <ApDialog …/>}`
 * 会让"提交失败后再关掉弹窗"丢掉已填内容（原实现的表单常驻）。
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { financeApi } from '@client/src/api';
import { apSchema, type ApFormData, type ApFormInput } from '../ar-ap-model';
import type { CreateApDto, Supplier } from '@shared/api.interface';

interface ApDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 项目 id：`CreateApDto` 需要（应付单挂在供应商上，但仍归属项目） */
  projectId: string;
  /** 供应商下拉的数据源（父组件的 `useAsyncData` 结果，可能尚未加载完） */
  suppliers: Supplier[] | undefined;
  /** 写成功后调用，父组件据此重取数据（原 `refreshAll`） */
  onSaved: () => void | Promise<void>;
}

const ApDialog: React.FC<ApDialogProps> = ({
  open,
  onOpenChange,
  projectId,
  suppliers,
  onSaved,
}) => {
  const apForm = useForm<ApFormInput, unknown, ApFormData>({
    resolver: zodResolver(apSchema),
    defaultValues: { supplierId: '', amount: 0, remark: '' },
  });

  const onCreateAp = apForm.handleSubmit(async (values) => {
    const dto: CreateApDto = {
      supplierId: values.supplierId,
      projectId,
      amount: values.amount,
      dueDate: values.dueDate,
      remark: values.remark || undefined,
    };
    try {
      await financeApi.createAp(dto);
      toast.success('应付已登记');
      onOpenChange(false);
      apForm.reset({ supplierId: '', amount: 0, remark: '' });
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>登记应付</DialogTitle>
        </DialogHeader>
        <Form {...apForm}>
          <form onSubmit={onCreateAp} className="space-y-4">
            <FormField
              control={apForm.control}
              name="supplierId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    供应商 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择供应商" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(suppliers ?? []).map((s: Supplier) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
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
                control={apForm.control}
                name="amount"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      应付金额（元）{' '}
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
                control={apForm.control}
                name="dueDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>到期日</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={apForm.control}
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
              <Button type="submit">提交登记</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default ApDialog;
