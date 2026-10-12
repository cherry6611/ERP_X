import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { adminApi } from '@client/src/api';
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
import { Textarea } from '@client/src/components/ui/textarea';
import DateField from '@client/src/components/erp/DateField';
import type { AdminPaymentCycle, AdminRentContractItem } from '@shared/api.interface';

const PAYMENT_CYCLE_OPTIONS: { value: AdminPaymentCycle; label: string }[] = [
  { value: 'monthly', label: '月付' },
  { value: 'quarterly', label: '季付' },
  { value: 'half_yearly', label: '半年付' },
  { value: 'yearly', label: '年付' },
];

const nonNegativeAmount = z
  .string()
  .refine(
    (v: string) => v === '' || (!Number.isNaN(Number(v)) && Number(v) >= 0),
    '需为非负数字',
  );

const rentContractSchema = z.object({
  name: z.string().min(1, '请填写合同名称'),
  propertyAddress: z.string().min(1, '请填写房产地址'),
  lessor: z.string().min(1, '请填写出租方'),
  monthlyRent: z
    .string()
    .refine(
      (v: string) => v !== '' && !Number.isNaN(Number(v)) && Number(v) >= 0,
      '月租金需为非负数字',
    ),
  deposit: nonNegativeAmount,
  area: nonNegativeAmount,
  startDate: z.string().min(1, '请选择起租日期'),
  endDate: z.string().min(1, '请选择到期日期'),
  paymentCycle: z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly']),
  remark: z.string(),
});

type RentContractFormData = z.output<typeof rentContractSchema>;

const EMPTY_FORM: z.input<typeof rentContractSchema> = {
  name: '',
  propertyAddress: '',
  lessor: '',
  monthlyRent: '',
  deposit: '',
  area: '',
  startDate: '',
  endDate: '',
  paymentCycle: 'monthly',
  remark: '',
};

interface RentContractFormDialogProps {
  open: boolean;
  target: AdminRentContractItem | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void | Promise<void>;
}

const RentContractFormDialog: React.FC<RentContractFormDialogProps> = ({
  open,
  target,
  onOpenChange,
  onSuccess,
}) => {
  const [operating, setOperating] = useState(false);

  const form = useForm<
    z.input<typeof rentContractSchema>,
    unknown,
    RentContractFormData
  >({
    resolver: zodResolver(rentContractSchema),
    defaultValues: EMPTY_FORM,
  });

  useEffect(() => {
    if (!open) return;
    form.reset(
      target
        ? {
            name: target.name,
            propertyAddress: target.propertyAddress,
            lessor: target.lessor,
            monthlyRent: String(target.monthlyRent),
            deposit: target.deposit == null ? '' : String(target.deposit),
            area: target.area == null ? '' : String(target.area),
            startDate: target.startDate,
            endDate: target.endDate,
            paymentCycle: target.paymentCycle,
            remark: target.remark ?? '',
          }
        : EMPTY_FORM,
    );
  }, [open, target, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    setOperating(true);
    try {
      if (target) {
        await adminApi.updateRentContract(target.id, {
          name: values.name,
          propertyAddress: values.propertyAddress,
          lessor: values.lessor,
          monthlyRent: Number(values.monthlyRent),
          deposit: values.deposit === '' ? null : Number(values.deposit),
          area: values.area === '' ? null : Number(values.area),
          startDate: values.startDate,
          endDate: values.endDate,
          paymentCycle: values.paymentCycle,
          remark: values.remark || null,
        });
        toast.success('租房合同已更新');
      } else {
        await adminApi.createRentContract({
          name: values.name,
          propertyAddress: values.propertyAddress,
          lessor: values.lessor,
          monthlyRent: Number(values.monthlyRent),
          deposit: values.deposit === '' ? undefined : Number(values.deposit),
          area: values.area === '' ? undefined : Number(values.area),
          startDate: values.startDate,
          endDate: values.endDate,
          paymentCycle: values.paymentCycle,
          remark: values.remark || undefined,
        });
        toast.success('租房合同已登记（草稿）');
      }
      onOpenChange(false);
      await onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setOperating(false);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{target ? '编辑租房合同' : '新建租房合同'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    合同名称{' '}
                    <span aria-hidden="true" className="text-destructive">
                      *
                    </span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="如：办公室租赁合同" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="propertyAddress"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-56">
                    <FormLabel>
                      房产地址{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：朝阳区xx路xx号" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lessor"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>
                      出租方{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：xx置业有限公司" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="monthlyRent"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-32">
                    <FormLabel>
                      月租金（元）{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="deposit"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-32">
                    <FormLabel>押金（元）</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder="选填"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="area"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-32">
                    <FormLabel>面积（㎡）</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder="选填"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="startDate"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>
                      起租日期{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <DateField
                      value={field.value || null}
                      onChange={(v) => field.onChange(v ?? '')}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-40">
                    <FormLabel>
                      到期日期{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <DateField
                      value={field.value || null}
                      onChange={(v) => field.onChange(v ?? '')}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="paymentCycle"
                render={({ field }) => (
                  <FormItem className="flex-1 min-w-32">
                    <FormLabel>付款方式</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择付款方式" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PAYMENT_CYCLE_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
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
                    <Textarea
                      placeholder="选填"
                      rows={2}
                      className="resize-none"
                      {...field}
                    />
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

export default RentContractFormDialog;
