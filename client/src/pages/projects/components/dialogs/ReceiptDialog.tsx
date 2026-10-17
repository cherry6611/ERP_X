/**
 * 登记回款弹窗（§5.9 / F8）。
 *
 * 从 `ArApSection.tsx` 抽出的**自包含**弹窗：`useForm`、`handleSubmit` 与渲染
 * 都在本文件里。
 *
 * ⚠️ **行为零变更**：JSX 是原块的逐字搬运 —— 只做了三件事：
 *   ① 整体去掉一层缩进（2 个空格）；
 *   ② `receiptOpen` / `setReceiptOpen` 改为 props `open` / `onOpenChange`，
 *      `customerId` / `openArs` 由父组件传入（原是同名的组件内绑定），
 *      `await refreshAll()` 改为 `await onSaved()`；
 *   ③ `selectedReceiptArId` / `selectedReceiptAr` 两行派生值跟着 `receiptForm`
 *      一起搬进来 —— 它们读的是 `receiptForm.watch('arId')`，表单在哪它们就在哪。
 *      两行的表达式逐字未改，`openArs` 仍是同一个数组（父组件传入）。
 *
 * ## 为什么 `openArs` 由父组件传入（而不是在本组件里过滤）
 *
 * 过滤条件（`openArItems`，见 `./ar-ap-model`）是**交互前提**而不是展示细节：
 * 它同时决定「登记付款」按钮的置灰判据。留在父组件一处，避免两个孩子各写一份
 * 而在后续改动里走偏（与 `pages/finance/ApTab.tsx` → `PaymentApplyDialog` 同一做法）。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置在**提交成功之后**（`toast.success` → 关闭 → `receiptForm.reset(...)` → 重取），
 * 不是"打开弹窗时" —— 原实现没有 reset-on-open，故关闭再打开会保留上次输入。
 * `if (!customerId) { … return; }` 的守卫也仍在提交处理器开头、位置未变。
 *
 * ## 为什么本组件必须**无条件挂载**
 *
 * `useForm` 的状态随本组件的生命周期存在；父组件写成 `{open && <ReceiptDialog …/>}`
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
import { formatMoney } from '@client/src/utils/format';
import {
  arReceiptOptionLabel,
  arUnsettledAmount,
  receiptSchema,
  type ReceiptFormData,
  type ReceiptFormInput,
} from '../ar-ap-model';
import type { ChainArItem, CreateReceiptDto } from '@shared/api.interface';

interface ReceiptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 关联客户 id；为空时提交被守卫拦下（原实现如此） */
  customerId: string | undefined;
  /** 可回款的应收单（父组件按状态过滤后传入） */
  openArs: ChainArItem[];
  /** 写成功后调用，父组件据此重取数据（原 `refreshAll`） */
  onSaved: () => void | Promise<void>;
}

const ReceiptDialog: React.FC<ReceiptDialogProps> = ({
  open,
  onOpenChange,
  customerId,
  openArs,
  onSaved,
}) => {
  const receiptForm = useForm<ReceiptFormInput, unknown, ReceiptFormData>({
    resolver: zodResolver(receiptSchema),
    defaultValues: { arId: '', amount: 0, method: 'bank', remark: '' },
  });
  const selectedReceiptArId: string = receiptForm.watch('arId');
  const selectedReceiptAr: ChainArItem | undefined = openArs.find(
    (a: ChainArItem) => a.id === selectedReceiptArId,
  );

  const onCreateReceipt = receiptForm.handleSubmit(async (values) => {
    if (!customerId) {
      toast.error('项目未关联客户，无法登记回款');
      return;
    }
    const dto: CreateReceiptDto = {
      customerId,
      amount: values.amount,
      receiptDate: values.receiptDate,
      method: values.method,
      remark: values.remark || undefined,
      /*
       * ⚠️ 必须把「应收单」一起提交 —— 原先这里漏了它，于是使用者**必选**
       * 的那张应收单被静默丢弃：回款建成 `unmatched`、与所选单据毫无关联，
       * 而弹窗上还显示着「该应收单未回款 ¥X」。服务端在同一事务内据此核销
       * （见 `CreateReceiptDto.arId` 的说明）。
       */
      arId: values.arId,
    };
    try {
      await financeApi.createReceipt(dto);
      toast.success('回款已登记');
      onOpenChange(false);
      receiptForm.reset({ arId: '', amount: 0, method: 'bank', remark: '' });
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
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
              name="arId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    应收单 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择应收单" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {openArs.map((a: ChainArItem) => (
                        <SelectItem key={a.id} value={a.id}>
                          {arReceiptOptionLabel(a)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {selectedReceiptAr ? (
              <p className="text-sm text-muted-foreground">
                该应收单未回款 {formatMoney(arUnsettledAmount(selectedReceiptAr))}
              </p>
            ) : null}
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
                name="receiptDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>回款日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={receiptForm.control}
              name="method"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>回款方式</FormLabel>
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
              control={receiptForm.control}
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

export default ReceiptDialog;
