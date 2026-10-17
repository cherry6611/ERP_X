/**
 * 回款核销（支持部分核销）弹窗（§5.9 / F8）。
 *
 * 从 `ArTab.tsx` 抽出的**自包含**弹窗：`useForm`、提交流程与渲染都在本文件里。
 * 处理器名保持原样（`onWriteoff`），以便与原实现逐字对照。
 *
 * ⚠️ **行为零变更**：JSX 是原块的逐字搬运 —— 只做了两件事：
 *   ① 整体去掉一层缩进（原块在 `ArTab` 的 `return` 里，外面还裹着一层 `<div>`）；
 *   ② `writeoffOpen` / `setWriteoffOpen` 改为 props `open` / `onOpenChange`，
 *      `openArItems` / `receiptOptions` 改为**同名 props**。
 *
 * 文件名带 `Ar` 前缀是为了与应付侧的 `WriteoffDialog.tsx`（付款核销）区分：
 * 两者提交的 DTO 不同（`ArWriteoffDto` ↔ `ApWriteoffDto`），字段名也不同
 * （`arId`/`receiptId` ↔ `apId`/`paymentId`），**不是同一份代码的两个实例**。
 *
 * ## 两个下拉的候选为什么都由父组件传入
 *
 * 它们都是"过滤后的列表"而非原始数据：过滤条件留在 `ArTab` 一处，
 * 与主列表共用同一个 `ars` / `receipts` 数据源，避免两个孩子各写一份而在
 * 后续改动里走偏（应付侧 `WriteoffDialog` 同一做法）。
 *
 * ## 候选里必须**同时**排除 `voided`（两处，理由不同）
 *
 *   · 应收侧（`openArItems`）：作废单 `amount − settledAmount` 通常仍为正数，
 *     只排 `settled` 拦不住它 —— 详见 `ArTab` 里那段注释与
 *     `server/modules/finance/void-guard.ts`；
 *   · 回款侧（`receiptOptions`）：原实现只排 `matched`（**已核销完**这个"顺利
 *     走完流程"的终态），漏了 `voided`。而服务端 `ArService.writeoff` 对
 *     `voided` 回款是**无条件拒绝**的（文案「回款已作废，不可核销」），
 *     且 `listReceipts()` 不过滤状态、作废件真的会出现在列表里 ——
 *     于是下拉里出现一个"选了必然失败"的候选。
 *     与 `ArTab.openArItems`、`ApTab.unpaidAps` / `paidPayments` 保持同一口径。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置在**提交成功之后**（`toast.success` 之后、`await onSaved()` 之前），
 * 不是"打开弹窗时" —— 原实现没有 reset-on-open。
 *
 * `onSaved` 传的是主文件的 `reload`（只重取应收列表）：核销会同时改动回款的
 * `usedAmount`，但原实现里 `receipts` 那一份查询没有跟着重取 —— 逐字保持原样，
 * 不在此处顺手加一次 `reloadReceipts()`。
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
  writeoffSchema,
  type WriteoffFormData,
  type WriteoffFormInput,
} from '../ar-schemas';
import type { ArItem, ArWriteoffDto, ReceiptItem } from '@shared/api.interface';

interface ArWriteoffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 可核销的应收单（父组件按状态过滤后传入：排除 settled 与 voided） */
  openArItems: ArItem[];
  /** 可核销的回款单（父组件按状态过滤后传入：排除 matched 与 voided） */
  receiptOptions: ReceiptItem[];
  /** 写成功后调用，父组件据此重取应收列表 */
  onSaved: () => void | Promise<void>;
}

const ArWriteoffDialog: React.FC<ArWriteoffDialogProps> = ({
  open,
  onOpenChange,
  openArItems,
  receiptOptions,
  onSaved,
}) => {
  const writeoffForm = useForm<WriteoffFormInput, unknown, WriteoffFormData>({
    resolver: zodResolver(writeoffSchema),
    defaultValues: { arId: '', receiptId: '', amount: 0 },
  });

  const onWriteoff = writeoffForm.handleSubmit(async (values) => {
    const dto: ArWriteoffDto = {
      arId: values.arId,
      receiptId: values.receiptId,
      amount: values.amount,
    };
    try {
      await financeApi.arWriteoff(dto);
      toast.success('核销成功');
      onOpenChange(false);
      writeoffForm.reset({ arId: '', receiptId: '', amount: 0 });
      await onSaved();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '核销失败'));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>回款核销（支持部分核销）</DialogTitle>
        </DialogHeader>
        <Form {...writeoffForm}>
          <form onSubmit={onWriteoff} className="space-y-4">
            <FormField
              control={writeoffForm.control}
              name="arId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    应收 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择应收" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {openArItems.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} - {a.customerName}（未核销{' '}
                          {formatMoney(a.amount - a.settledAmount)}）
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
              name="receiptId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    回款 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择回款" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {receiptOptions.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.code} - {r.customerName}（{formatMoney(r.amount)}）
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
                  <FormLabel>
                    核销金额（元）{' '}
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
            <DialogFooter>
              <Button type="submit">核销</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default ArWriteoffDialog;
