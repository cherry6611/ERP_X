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
import {
  coerceTaxRate,
  resolveRateOptions,
  resolveTaxEntity,
} from '@client/src/utils/tax-rate-options';
import { formatTaxSplitLine } from '@client/src/utils/tax-display';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { VAT_RATES } from '@shared/tax';
import type { CreateContractDto, Customer } from '@shared/api.interface';

const contractSchema = z.object({
  name: z.string().min(1, '合同名称不能为空'),
  customerId: z.string().min(1, '请选择客户'),
  billingModel: z.string().min(1, '请选择计费模式'),
  amount: z.coerce.number().min(1, '合同金额必须大于 0'),
  taxRate: z.coerce
    .number()
    .refine((value) => (VAT_RATES as readonly number[]).includes(value), '请选择合法税率'),
  taxEntityId: z.string().optional(),
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
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCreated: (id: string) => void;
  asPage?: boolean;
  onCancel?: () => void;
}

const ContractFormDialog: React.FC<ContractFormDialogProps> = ({
  open = false,
  onOpenChange,
  onCreated,
  asPage = false,
  onCancel,
}) => {
  const { data: customers } = useAsyncData<Customer[]>(() => masterDataApi.listCustomers(), []);
  const { data: taxEntities } = useAsyncData(
    () => masterDataApi.listTaxEntities(),
    []
  );

  const form = useForm<ContractFormInput, unknown, ContractFormData>({
    resolver: zodResolver(contractSchema),
    defaultValues: {
      name: '',
      customerId: '',
      billingModel: 'project',
      amount: 0,
      taxRate: 6,
      taxEntityId: '',
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
      taxEntityId: values.taxEntityId || undefined,
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
      onOpenChange?.(false);
      form.reset();
      onCreated(created.id);
    } catch (err) {
      toast.error(getApiErrorMessage(err, '登记失败'));
    }
  });

  const formInner = (
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
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        // 修复 P0-1：切换客户时同步校正税率。
                        // 客户可能绑定了小规模主体，此时 6% 是非法值，不校正会被后端拒 400。
                        const entity = resolveTaxEntity({
                          taxEntityId: form.getValues('taxEntityId'),
                          taxEntities: taxEntities ?? [],
                          customerTaxEntityId:
                            (customers ?? []).find((row) => row.id === value)
                              ?.taxEntityId ?? null,
                        });
                        form.setValue(
                          'taxRate',
                          coerceTaxRate(
                            Number(form.getValues('taxRate') ?? 6),
                            entity
                          )
                        );
                      }}
                    >
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
                control={form.control}
                name="taxEntityId"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>纳税主体</FormLabel>
                    <Select
                      value={field.value || '__default__'}
                      onValueChange={(value) => {
                        const nextId = value === '__default__' ? '' : value;
                        field.onChange(nextId);
                        const entity = (taxEntities ?? []).find(
                          (row) => row.id === nextId
                        );
                        const current = Number(form.getValues('taxRate') ?? 6);
                        form.setValue('taxRate', coerceTaxRate(current, entity));
                      }}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="默认主体" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__default__">系统默认</SelectItem>
                        {(taxEntities ?? [])
                          .filter((entity) => entity.status === 'active')
                          .map((entity) => (
                            <SelectItem key={entity.id} value={entity.id}>
                              {entity.name}
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
                name="taxRate"
                render={({ field }) => {
                  // 修复 P0-1：解析顺序必须与后端一致（显式主体 → 客户绑定主体 → 默认主体），
                  // 否则客户绑定了小规模主体、用户主体留空时，下拉仍显示 6% 而提交被拒 400。
                  const entity = resolveTaxEntity({
                    taxEntityId: form.watch('taxEntityId'),
                    taxEntities: taxEntities ?? [],
                    customerTaxEntityId:
                      (customers ?? []).find(
                        (row) => row.id === form.watch('customerId')
                      )?.taxEntityId ?? null,
                  });
                  const rates = resolveRateOptions(entity);
                  return (
                    <FormItem className="w-36">
                      <FormLabel>税率（%）</FormLabel>
                      <Select
                        value={String(field.value)}
                        onValueChange={(value) => field.onChange(Number(value))}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="税率" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {rates.map((rate) => (
                            <SelectItem key={rate} value={String(rate)}>
                              {rate}%
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground -mt-2">
              {formatTaxSplitLine(
                Number(form.watch('amount') ?? 0),
                Number(form.watch('taxRate') ?? 0)
              )}
            </p>
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
            <div className="flex justify-end gap-2 border-t pt-3">
              {asPage && onCancel ? (
                <Button type="button" variant="outline" onClick={onCancel}>
                  取消
                </Button>
              ) : null}
              <Button type="submit">保存</Button>
            </div>
          </form>
        </Form>
  );

  if (asPage) {
    return <div className="mx-auto max-w-xl space-y-4">{formInner}</div>;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>登记合同</DialogTitle>
        </DialogHeader>
        {formInner}
      </DialogContent>
    </Dialog>
  );
};

export default ContractFormDialog;
