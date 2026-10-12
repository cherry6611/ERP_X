import React, { useEffect, useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import DateField from '@client/src/components/erp/DateField';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@client/src/components/ui/form';
import { Input } from '@client/src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { adminApi } from '@client/src/api';
import { currentPeriod } from '@client/src/utils/format';
import { BILL_TYPE_LABELS } from './AdminBillMeta';
import type {
  AdminBillItem,
  AdminBillType,
  AdminRentContractItem,
  CreateAdminBillDto,
  UpdateAdminBillDto,
} from '@shared/api.interface';

const NONE = 'none';

const billSchema = z.object({
  title: z.string().min(1, '请填写标题'),
  billType: z.string().min(1, '请选择类型'),
  amount: z.coerce.number().positive('金额必须大于 0'),
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/, '期间格式为 YYYY-MM，如 2026-10'),
  expenseDate: z.string().min(1, '请选择费用日期'),
  payee: z.string(),
  rentContractId: z.string(),
  remark: z.string(),
});

type BillFormData = z.infer<typeof billSchema>;

interface AdminBillFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑目标；null 表示新建 */
  editing: AdminBillItem | null;
  rentContracts: AdminRentContractItem[];
  onSuccess: () => void | Promise<void>;
}

const toFormValues = (editing: AdminBillItem | null): BillFormData =>
  editing
    ? {
        title: editing.title,
        billType: editing.billType,
        amount: editing.amount,
        period: editing.period,
        expenseDate: editing.expenseDate,
        payee: editing.payee ?? '',
        rentContractId: editing.rentContractId ?? NONE,
        remark: editing.remark ?? '',
      }
    : {
        title: '',
        billType: '',
        amount: 0,
        period: currentPeriod(),
        expenseDate: '',
        payee: '',
        rentContractId: NONE,
        remark: '',
      };

const AdminBillFormDialog: React.FC<AdminBillFormDialogProps> = ({
  open,
  onOpenChange,
  editing,
  rentContracts,
  onSuccess,
}) => {
  const defaultValues = useMemo(() => toFormValues(editing), [editing]);
  const isEdit = editing !== null;

  const form = useForm<z.input<typeof billSchema>, unknown, BillFormData>({
    resolver: zodResolver(billSchema),
    defaultValues,
  });

  useEffect(() => {
    if (open) {
      form.reset(toFormValues(editing));
    }
  }, [open, editing, form]);

  const operating = form.formState.isSubmitting;

  const onSubmit = form.handleSubmit(async (values) => {
    const rentContractId =
      values.rentContractId !== NONE ? values.rentContractId : undefined;
    try {
      if (isEdit && editing) {
        const dto: UpdateAdminBillDto = {
          title: values.title,
          billType: values.billType as AdminBillType,
          amount: values.amount,
          period: values.period,
          expenseDate: values.expenseDate,
          payee: values.payee || null,
          rentContractId: rentContractId ?? null,
          remark: values.remark || null,
        };
        await adminApi.updateAdminBill(editing.id, dto);
        toast.success('缴费单已更新');
      } else {
        const dto: CreateAdminBillDto = {
          title: values.title,
          billType: values.billType as AdminBillType,
          amount: values.amount,
          period: values.period,
          expenseDate: values.expenseDate,
          payee: values.payee || undefined,
          rentContractId,
          remark: values.remark || undefined,
        };
        await adminApi.createAdminBill(dto);
        toast.success('缴费单已创建（草稿）');
      }
      onOpenChange(false);
      await onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑缴费单' : '新建缴费单'}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          保存后为草稿，提交审批通过并登记付款后完成流程。
        </p>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-56">
                    <FormLabel>
                      标题{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：10 月办公室房租" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="billType"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>
                      类型{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择类型" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(BILL_TYPE_LABELS).map(
                          ([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>
                      金额（元）{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
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
                control={form.control}
                name="period"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>
                      期间{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="YYYY-MM" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="expenseDate"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>
                      费用日期{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="payee"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>收款方</FormLabel>
                    <FormControl>
                      <Input placeholder="选填" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="rentContractId"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>关联租房合同</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="不关联合同" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NONE}>不关联合同</SelectItem>
                        {rentContracts.map((contract: AdminRentContractItem) => (
                          <SelectItem key={contract.id} value={contract.id}>
                            {contract.code} - {contract.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="remark"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>备注</FormLabel>
                  <FormControl>
                    <Input placeholder="选填" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={operating}>
                {operating ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default AdminBillFormDialog;
