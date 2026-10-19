/**
 * 登记付款弹窗（§5.9 / F8）。
 *
 * 从 `ArApSection.tsx` 抽出的**自包含**弹窗：`useForm`、`handleSubmit` 与渲染
 * 都在本文件里。
 *
 * ⚠️ **行为零变更**：JSX 是原块的逐字搬运 —— 只做了两件事：
 *   ① 整体去掉一层缩进（2 个空格）；
 *   ② `paymentOpen` / `setPaymentOpen` 改为 props `open` / `onOpenChange`，
 *      `payableAps` 由父组件传入（原是同名的组件内绑定），
 *      `await refreshAll()` 改为 `await onSaved()`。
 *
 * ## 为什么 `payableAps` 由父组件传入（而不是在本组件里过滤）
 *
 * 父组件的「登记付款」按钮用 `disabled={payableAps.length === 0}` 置灰 ——
 * 按钮的可用性与下拉候选必须来自**同一批**数据。过滤留在父组件一处
 * （与 `pages/finance/ApTab.tsx` → `PaymentApplyDialog` 同一做法）。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置在**提交成功之后**（`toast.success` → 关闭 → `paymentForm.reset(...)` → 重取），
 * 不是"打开弹窗时" —— 原实现没有 reset-on-open，故关闭再打开会保留上次输入。
 * 成功文案「付款申请已提交，待审批」逐字未改：本走的是 `createPayment`，
 * 与「登记应付」不同，落库后是待审批状态。
 *
 * ## 为什么本组件必须**无条件挂载**
 *
 * `useForm` 的状态随本组件的生命周期存在；父组件写成 `{open && <PaymentDialog …/>}`
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
import {
  apPaymentOptionLabel,
  paymentSchema,
  type PaymentFormData,
  type PaymentFormInput,
} from '../ar-ap-model';
import type { ChainApItem, CreatePaymentDto } from '@shared/api.interface';

interface PaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 可付款的应付单（父组件按状态过滤后传入） */
  payableAps: ChainApItem[];
  /** 写成功后调用，父组件据此重取数据（原 `refreshAll`） */
  onSaved: () => void | Promise<void>;
}

const PaymentDialog: React.FC<PaymentDialogProps> = ({
  open,
  onOpenChange,
  payableAps,
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
      payDate: values.payDate,
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
      toast.error(err instanceof Error ? err.message : '提交失败');
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>登记付款</DialogTitle>
        </DialogHeader>
        <Form {...paymentForm}>
          <form onSubmit={onCreatePayment} className="space-y-4">
            <FormField
              control={paymentForm.control}
              name="apId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    应付单 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择应付单" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {payableAps.map((a: ChainApItem) => (
                        <SelectItem key={a.id} value={a.id}>
                          {apPaymentOptionLabel(a)}
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
                name="payDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>付款日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={paymentForm.control}
              name="method"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>付款方式</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择方式" />
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
            <FormField
              control={paymentForm.control}
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
              <Button type="submit" disabled={paymentForm.formState.isSubmitting}>提交申请</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default PaymentDialog;
