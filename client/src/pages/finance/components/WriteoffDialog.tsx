/**
 * 付款核销（支持部分核销）弹窗（§5.9 / F8）。
 *
 * 从 `ApTab.tsx` 抽出的**自包含**弹窗：`useForm`、提交流程与渲染都在本文件里。
 * 处理器名保持原样（`onWriteoff`），以便与原实现逐字对照。
 *
 * ⚠️ **行为零变更**：JSX 是原块的逐字搬运 —— 只做了两件事：
 *   ① 整体去掉一层缩进；
 *   ② `writeoffOpen` / `setWriteoffOpen` 改为 props `open` / `onOpenChange`，
 *      `unpaidAps` / `paidPayments` 改为同名 props。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置在**提交成功之后**（`toast.success` 之后、`await onSaved()` 之前），
 * 不是"打开弹窗时" —— 原实现没有 reset-on-open。
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
import { financeApi } from '@client/src/api';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { formatMoney } from '@client/src/utils/format';
import {
  writeoffSchema,
  type WriteoffFormData,
  type WriteoffFormInput,
} from '../ap-schemas';
import type { ApItem, ApWriteoffDto, PaymentItem } from '@shared/api.interface';

interface WriteoffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 可核销的应付单（父组件按状态过滤后传入） */
  unpaidAps: ApItem[];
  /** 可核销的已批准付款（父组件按状态过滤后传入） */
  paidPayments: PaymentItem[];
  /** 写成功后调用，父组件据此重取数据 */
  onSaved: () => void | Promise<void>;
}

const WriteoffDialog: React.FC<WriteoffDialogProps> = ({
  open,
  onOpenChange,
  unpaidAps,
  paidPayments,
  onSaved,
}) => {
  const writeoffForm = useForm<WriteoffFormInput, unknown, WriteoffFormData>({
    resolver: zodResolver(writeoffSchema),
    defaultValues: { apId: '', paymentId: '', amount: 0 },
  });

  const onWriteoff = writeoffForm.handleSubmit(async (values) => {
    const dto: ApWriteoffDto = {
      apId: values.apId,
      paymentId: values.paymentId,
      amount: values.amount,
    };
    try {
      await financeApi.apWriteoff(dto);
      toast.success('付款核销成功');
      onOpenChange(false);
      writeoffForm.reset({ apId: '', paymentId: '', amount: 0 });
      await onSaved();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '核销失败'));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>付款核销（支持部分核销）</DialogTitle>
        </DialogHeader>
        <Form {...writeoffForm}>
          <form onSubmit={onWriteoff} className="space-y-4">
            <FormField
              control={writeoffForm.control}
              name="apId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    应付 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择应付" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {unpaidAps.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} - {a.supplierName}（未付{' '}
                          {formatMoney(a.amount - a.paidAmount)}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={writeoffForm.control}
              name="paymentId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    已批准付款 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择付款记录" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {paidPayments.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.code} - {p.supplierName}（{formatMoney(p.amount)}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={writeoffForm.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <Explained
                    title="核销金额"
                    content="本次用这笔已批准付款冲掉的应付金额。可以小于未付余额。不能超过未付金额。"
                  >
                    <FormLabel>
                      核销金额（元）{' '}
                      <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
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
            <DialogFooter>
              <Button type="submit">核销</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default WriteoffDialog;
