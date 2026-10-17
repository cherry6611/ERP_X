/**
 * 登记回款弹窗（§5.9 / F8）。
 *
 * 从 `ArTab.tsx` 抽出的**自包含**弹窗：`useForm`、提交流程与渲染都在本文件里，
 * 主文件只保留数据查询，并传入 `customers`（选项数据）与 `onSaved`
 * （主文件传的是 `reload`，即**只刷新应收列表** —— 逐字保持原实现：
 * 原 `onCreateReceipt` 调的就是 `reload()` 而不是 `reloadReceipts()`，
 * 所以「回款记录」表在登记成功后不会立即刷新。这是原行为，本轮不顺手改；
 * 应付侧 `PaymentApplyDialog` 同样是 `onSaved={reload}`）。
 *
 * ⚠️ **行为零变更**：JSX 是原块的逐字搬运 —— 只做了两件事：
 *   ① 整体去掉一层缩进（原块在 `ArTab` 的 `return` 里，外面还裹着一层 `<div>`）；
 *   ② `receiptOpen` / `setReceiptOpen` 改为 props `open` / `onOpenChange`。
 * DialogTitle / FormLabel / placeholder / toast 文案全部逐字未动。
 *
 * ## 挂载方式：**无条件挂载**（不要改成 `{open && <ReceiptApplyDialog/>}`）
 *
 * `useForm` 原先在 `ArTab` 函数体里（组件挂载即创建实例），表单状态因此是常驻的。
 * 条件挂载会在每次关闭时销毁实例，等价于"打开即清空"，见下节。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置发生在**提交成功之后**（`toast.success` 之后、`await onSaved()` 之前），
 * 而不是"打开弹窗时" —— 原实现里就没有 `useEffect(..., [receiptOpen])` 这类
 * "打开即清空"的逻辑，因此**中途关掉弹窗再打开会保留上次没提交的输入**。
 * 抽取时不得顺手补一个 reset-on-open。
 *
 * ## 为什么回款挂的是「客户」而不是「合同」（与应付的**有意不对称**）
 *
 * 一个客户可能一次付多个合同的钱，故回款单只记到客户，
 * 「这笔钱冲哪个合同」由「回款核销」按应收单分摊（见 `ArWriteoffDialog`）。
 * 应付侧没有这个区分（付款直接挂应付单）。这与 `ar-schemas.ts` 文件头同源。
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
import {
  receiptSchema,
  type ReceiptFormData,
  type ReceiptFormInput,
} from '../ar-schemas';
import type { CreateReceiptDto, Customer } from '@shared/api.interface';

interface ReceiptApplyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 客户选项。父组件持有查询，故允许 `undefined`（加载中） */
  customers: Customer[] | undefined;
  /** 写成功后调用，父组件据此重取应收 / 回款列表 */
  onSaved: () => void | Promise<void>;
}

const ReceiptApplyDialog: React.FC<ReceiptApplyDialogProps> = ({
  open,
  onOpenChange,
  customers,
  onSaved,
}) => {
  const receiptForm = useForm<ReceiptFormInput, unknown, ReceiptFormData>({
    resolver: zodResolver(receiptSchema),
    defaultValues: { customerId: '', amount: 0, method: 'bank', remark: '' },
  });

  const onCreateReceipt = receiptForm.handleSubmit(async (values) => {
    const dto: CreateReceiptDto = {
      customerId: values.customerId,
      amount: values.amount,
      method: values.method,
      remark: values.remark || undefined,
    };
    try {
      await financeApi.createReceipt(dto);
      toast.success('回款已登记');
      onOpenChange(false);
      receiptForm.reset({ customerId: '', amount: 0, method: 'bank', remark: '' });
      await onSaved();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '登记失败'));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>登记回款</DialogTitle>
        </DialogHeader>
        <Form {...receiptForm}>
          <form onSubmit={onCreateReceipt} className="space-y-4">
            <FormField
              control={receiptForm.control}
              name="customerId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    客户 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择客户" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(customers ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
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
                control={receiptForm.control}
                name="amount"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      回款金额（元）{' '}
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
                control={receiptForm.control}
                name="method"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>回款方式</FormLabel>
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
              control={receiptForm.control}
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

export default ReceiptApplyDialog;
