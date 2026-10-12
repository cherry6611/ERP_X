import React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import DateField from '@client/src/components/erp/DateField';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
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
import { contractsApi, masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { BILLING_MODEL_LABELS } from '@client/src/utils/biz-labels';
import type { CreateContractDto, Customer } from '@shared/api.interface';

const contractSchema = z.object({
  name: z.string().min(1, '合同名称不能为空'),
  customerId: z.string().min(1, '请选择客户'),
  billingModel: z.string().min(1, '请选择计费模式'),
  amount: z.coerce.number().min(1, '合同金额必须大于 0'),
  taxRate: z.coerce.number().min(0).max(100),
  signDate: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  owner: z.string(),
  paymentTerms: z.string(),
  remark: z.string(),
});

type ContractFormData = z.output<typeof contractSchema>;
type ContractFormInput = z.input<typeof contractSchema>;

interface ContractFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}

const ContractFormDialog: React.FC<ContractFormDialogProps> = ({
  open,
  onOpenChange,
  onCreated,
}) => {
  const { data: customers } = useAsyncData<Customer[]>(() => masterDataApi.listCustomers(), []);

  const form = useForm<ContractFormInput, unknown, ContractFormData>({
    resolver: zodResolver(contractSchema),
    defaultValues: {
      name: '',
      customerId: '',
      billingModel: 'project',
      amount: 0,
      taxRate: 6,
      owner: '',
      paymentTerms: '',
      remark: '',
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateContractDto = {
      name: values.name,
      customerId: values.customerId,
      billingModel: values.billingModel as CreateContractDto['billingModel'],
      amount: values.amount,
      taxRate: values.taxRate,
      signDate: values.signDate,
      startDate: values.startDate,
      endDate: values.endDate,
      owner: values.owner || undefined,
      paymentTerms: values.paymentTerms || undefined,
      remark: values.remark || undefined,
    };
    try {
      const created = await contractsApi.createContract(dto);
      toast.success('合同已登记');
      onOpenChange(false);
      form.reset();
      onCreated(created.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>登记合同</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    合同名称 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="请输入合同名称" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="customerId"
                render={({ field }) => (
                  <FormItem className="flex-1">
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
              <FormField
                control={form.control}
                name="billingModel"
                render={({ field }) => (
                  <FormItem className="w-44">
                    <FormLabel>
                      计费模式 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(BILLING_MODEL_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      金额（元） <span aria-hidden="true" className="text-destructive">*</span>
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
                control={form.control}
                name="taxRate"
                render={({ field }) => (
                  <FormItem className="w-36">
                    <FormLabel>税率（%）</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={100}
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
            </div>
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="signDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>签订日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="startDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>开始日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>结束日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="owner"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>负责人</FormLabel>
                    <FormControl>
                      <Input placeholder="请输入负责人" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="paymentTerms"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>付款条款</FormLabel>
                    <FormControl>
                      <Input placeholder="如：验收后 30 天" {...field} />
                    </FormControl>
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
                    <Textarea placeholder="备注信息" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <AttachmentHint text="保存后将自动打开详情，可在其中上传合同扫描件、补充协议等附件" />
            <DialogFooter>
              <Button type="submit">保存</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default ContractFormDialog;
