/**
 * 登记应付弹窗（§5.9 / F8）。
 *
 * 从 `ApTab.tsx` 抽出的**自包含**弹窗：`useForm`、提交流程与渲染都在本文件里，
 * 主文件只保留数据查询，并传入 `suppliers`（选项数据）与 `onSaved`（写成功后刷新列表）。
 *
 * ⚠️ **行为零变更**：JSX 是原块的逐字搬运 —— 只做了两件事：
 *   ① 整体去掉一层缩进（原块在 `ApTab` 的 `return` 里，深一级）；
 *   ② `apOpen` / `setApOpen` 改为 props `open` / `onOpenChange`。
 * DialogTitle、Label、placeholder、toast 文案全部逐字未动。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置发生在**提交成功之后**（`toast.success` 之后、`await onSaved()` 之前），
 * 而不是"打开弹窗时" —— 原实现里就没有 `useEffect(..., [apOpen])` 这类
 * "打开即清空"的逻辑，因此**中途关掉弹窗再打开会保留上次没提交的输入**。
 * 抽取时不得顺手补一个 reset-on-open：那会改变用户看到的行为（输入被清掉），
 * 也会改变 reset 的触发次数。
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Explained } from '@client/src/components/erp/ItemHelp';
import { Button } from '@client/src/components/ui/button';
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
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import {
  apSchema,
  type ApFormData,
  type ApFormInput,
} from '../ap-schemas';
import type { CreateApDto, Supplier } from '@shared/api.interface';

interface ApFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 供应商选项。父组件持有查询，故允许 `undefined`（加载中） */
  suppliers: Supplier[] | undefined;
  /** 写成功后调用，父组件据此重取应付列表 */
  onSaved: () => void | Promise<void>;
}

const ApFormDialog: React.FC<ApFormDialogProps> = ({
  open,
  onOpenChange,
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
      toast.error(getApiErrorMessage(err, '登记失败'));
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
                      {(suppliers ?? []).map((s) => (
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
                      金额（含税）{' '}
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
                    <Explained
                      title="到期日"
                      content="账龄和付款提醒从这一天起算。不填时，这笔应付不按逾期计算。"
                    >
                      <FormLabel>到期日</FormLabel>
                    </Explained>
                    <FormControl>
                      <Input placeholder="YYYY-MM-DD" {...field} value={field.value ?? ''} />
                    </FormControl>
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
              <Button type="submit" disabled={apForm.formState.isSubmitting}>保存</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default ApFormDialog;
