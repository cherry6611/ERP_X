/**
 * 付款申请（需审批）弹窗（§5.9 / F8）。
 *
 * 从 `ApTab.tsx` 抽出的**自包含**弹窗：`useForm`、提交流程与渲染都在本文件里。
 *
 * ⚠️ **行为零变更**：JSX 是原块的逐字搬运 —— 只做了两件事：
 *   ① 整体去掉一层缩进；
 *   ② `paymentOpen` / `setPaymentOpen` 改为 props `open` / `onOpenChange`，
 *      `unpaidAps` 改为同名 prop。
 *
 * ## 为什么 `unpaidAps` 由父组件传入（而不是在本组件里过滤）
 *
 * 它同时被本弹窗与「付款核销」弹窗使用，两个下拉框必须给出**同一批**候选应付单；
 * 过滤条件留在父组件一处，避免两个孩子各写一份而在后续改动里走偏。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置在**提交成功之后**（`toast.success` 之后、`await onSaved()` 之前），
 * 不是"打开弹窗时" —— 原实现没有 reset-on-open，故关闭再打开会保留上次输入。
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
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
  paymentSchema,
  type PaymentFormData,
  type PaymentFormInput,
} from '../ap-schemas';
import type { ApItem, CreatePaymentDto } from '@shared/api.interface';

interface PaymentApplyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 可付款的应付单（父组件按状态过滤后传入） */
  unpaidAps: ApItem[];
  /** 写成功后调用，父组件据此重取数据 */
  onSaved: () => void | Promise<void>;
}

const PaymentApplyDialog: React.FC<PaymentApplyDialogProps> = ({
  open,
  onOpenChange,
  unpaidAps,
  onSaved,
}) => {
  const paymentForm = useForm<PaymentFormInput, unknown, PaymentFormData>({
    resolver: zodResolver(paymentSchema),
    defaultValues: { apId: '', amount: 0, method: 'bank', remark: '' },
  });

  const onCreatePayment = paymentForm.handleSubmit(async (values) => {
    const dto: CreatePaymentDto = {
      apId: values.apId,
      amount: values.amount,
      method: values.method,
      remark: values.remark || undefined,
    };
    try {
      await financeApi.createPayment(dto);
      toast.success('付款申请已提交，待审批');
      onOpenChange(false);
      paymentForm.reset({ apId: '', amount: 0, method: 'bank', remark: '' });
      await onSaved();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '提交失败'));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>付款申请（需审批）</DialogTitle>
        </DialogHeader>
        <Form {...paymentForm}>
          <form onSubmit={onCreatePayment} className="space-y-4">
            <FormField
              control={paymentForm.control}
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
            <div className="flex gap-4">
              <FormField
                control={paymentForm.control}
                name="amount"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      付款金额（元）{' '}
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
                control={paymentForm.control}
                name="method"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>付款方式</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="bank">银行转账</SelectItem>
                        <SelectItem value="cash">现金</SelectItem>
                        <SelectItem value="other">其他</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={paymentForm.control}
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
              <Button type="submit" disabled={paymentForm.formState.isSubmitting}>提交</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default PaymentApplyDialog;
