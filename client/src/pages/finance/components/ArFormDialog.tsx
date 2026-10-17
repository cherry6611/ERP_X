/**
 * 登记应收弹窗（§5.9 / F8）。
 *
 * 从 `ArTab.tsx` 抽出的**自包含**弹窗：`useForm`、提交流程与渲染都在本文件里，
 * 主文件只保留数据查询，并传入 `contracts`（选项数据）与 `onSaved`
 * （写成功后刷新应收列表）。
 *
 * ⚠️ **行为零变更**：JSX 是原块的逐字搬运 —— 只做了两件事：
 *   ① 整体去掉一层缩进（原块在 `ArTab` 的 `return` 里，外面还裹着一层 `<div>`）；
 *   ② `arOpen` / `setArOpen` 改为 props `open` / `onOpenChange`。
 * DialogTitle / FormLabel / placeholder / toast 文案全部逐字未动。
 *
 * ## 挂载方式：**无条件挂载**（不要改成 `{open && <ArFormDialog/>}`）
 *
 * `useForm` 原先在 `ArTab` 函数体里（组件挂载即创建实例），表单状态因此是**常驻**的。
 * 条件挂载会在每次关闭时销毁实例，等价于"打开即清空"，见下节。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置发生在**提交成功之后**（`toast.success` 之后、`await onSaved()` 之前），
 * 而不是"打开弹窗时" —— 原实现里就没有 `useEffect(..., [arOpen])` 这类
 * "打开即清空"的逻辑，因此**中途关掉弹窗再打开会保留上次没提交的输入**。
 * 抽取时不得顺手补一个 reset-on-open：那会改变用户看到的行为（输入被清掉），
 * 也会改变 reset 的触发次数。
 *
 * ## 为什么选项是「合同」而不是「客户」（与应付的**有意不对称**）
 *
 * 应收单挂在**合同**上（收入按合同确认、需可追溯），回款单才挂在**客户**上
 * （一个客户可能一次付多个合同的钱，归属由「核销」分摊）。应付侧没有这个
 * 区分：应付单与付款都直接对供应商。这与 `ar-schemas.ts` 文件头记的是同一件事。
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
import { Textarea } from '@/components/ui/textarea';
import { financeApi } from '@client/src/api';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import {
  arSchema,
  type ArFormData,
  type ArFormInput,
} from '../ar-schemas';
import type { Contract, CreateArDto } from '@shared/api.interface';

interface ArFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 合同选项。父组件持有查询，故允许 `undefined`（加载中） */
  contracts: Contract[] | undefined;
  /** 写成功后调用，父组件据此重取应收列表 */
  onSaved: () => void | Promise<void>;
}

const ArFormDialog: React.FC<ArFormDialogProps> = ({
  open,
  onOpenChange,
  contracts,
  onSaved,
}) => {
  const arForm = useForm<ArFormInput, unknown, ArFormData>({
    resolver: zodResolver(arSchema),
    defaultValues: { contractId: '', amount: 0, remark: '' },
  });

  const onCreateAr = arForm.handleSubmit(async (values) => {
    const dto: CreateArDto = {
      contractId: values.contractId,
      amount: values.amount,
      dueDate: values.dueDate,
      remark: values.remark || undefined,
    };
    try {
      await financeApi.createAr(dto);
      toast.success('应收已登记');
      onOpenChange(false);
      arForm.reset({ contractId: '', amount: 0, remark: '' });
      await onSaved();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '登记失败'));
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
            <FormField
              control={arForm.control}
              name="contractId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    合同 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择合同" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(contracts ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.code} - {c.name}
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
                control={arForm.control}
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
                control={arForm.control}
                name="dueDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>到期日（账期）</FormLabel>
                    <FormControl>
                      <Input placeholder="YYYY-MM-DD" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
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
              <Button type="submit">保存</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default ArFormDialog;
