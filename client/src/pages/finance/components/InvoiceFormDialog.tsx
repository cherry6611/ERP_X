/**
 * 发票登记弹窗（§5.9 / F8）。
 *
 * 从 `InvoicesTab.tsx` 抽出的**自包含**弹窗：`useForm`（`invoiceSchema`）、
 * 合同/供应商 → 纳税主体 → 税率档位的联动，以及提交流程都在本文件里；
 * 主文件只保留数据查询，传入 `contracts` / `suppliers` / `taxEntities` /
 * `linkableArs`（下拉选项）与 `onSaved`（写成功后刷新台账）。
 *
 * ⚠️ **行为零变更**：JSX 与表单逻辑是原块的逐字搬运 —— 只做了三件事：
 *   ① 整体去掉一层缩进（原块在 `InvoicesTab` 的 `return` 里，深一级）；
 *   ② `createOpen` / `setCreateOpen` 改为 props `open` / `onOpenChange`；
 *   ③ `await reload()` 改为 `await onSaved()`（父组件传入的就是 `reload`）。
 * DialogTitle / FormLabel / placeholder / toast 文案全部逐字未动。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置发生在**提交成功之后**（`toast.success` 之后、`await onSaved()` 之前），
 * 而不是"打开弹窗时" —— 原实现里没有 `useEffect(..., [createOpen])` 这类
 * "打开即清空"的逻辑，因此**中途关掉弹窗再打开会保留上次没提交的输入**。
 * 抽取时不得顺手补一个 reset-on-open：那会改变用户看到的行为（输入被清掉），
 * 也会改变 reset 的触发次数。
 *
 * ⚠️ 发票类型下拉用的是 `../invoice-schemas` 的**三键**字典（含 `electronic`），
 * 不是 `utils/biz-labels.ts` 的同名两键版 —— 后者会让「电子发票」从下拉里消失，
 * 表格与导出也会退化成英文 key（见 `invoice-schemas.ts` 文件头与规格里的断言）。
 */
import React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { financeApi } from '@client/src/api';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import {
  resolveFormTaxRate,
  resolveRateOptions,
  resolveTaxEntity,
} from '@client/src/utils/tax-rate-options';
import { formatTaxSplitLine } from '@client/src/utils/tax-display';
import type {
  ArItem,
  Contract,
  CreateInvoiceDto,
  InvoiceDirection,
  InvoiceType,
  Supplier,
  TaxEntity,
} from '@shared/api.interface';
import {
  FORM_DEFAULTS,
  INVOICE_TYPE_LABELS,
  invoiceSchema,
  toLocalDate,
  type InvoiceFormData,
  type InvoiceFormInput,
} from '../invoice-schemas';

interface InvoiceFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 合同选项（销项）。父组件持有查询，故允许 `undefined`（加载中） */
  contracts: Contract[] | undefined;
  /** 供应商选项（进项）。父组件持有查询，故允许 `undefined`（加载中） */
  suppliers: Supplier[] | undefined;
  /** 纳税主体选项（决定税率档位）。父组件持有查询，故允许 `undefined`（加载中） */
  taxEntities: TaxEntity[] | undefined;
  /** 可关联应收白名单（仅开放中 / 部分回款），由父组件派生后传入 */
  linkableArs: ArItem[];
  /** 登记成功后调用，父组件据此重取发票台账 */
  onSaved: () => void | Promise<void>;
}

const InvoiceFormDialog: React.FC<InvoiceFormDialogProps> = ({
  open,
  onOpenChange,
  contracts,
  suppliers,
  taxEntities,
  linkableArs,
  onSaved,
}) => {
  const form = useForm<InvoiceFormInput, unknown, InvoiceFormData>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: FORM_DEFAULTS,
  });
  const formDirection: InvoiceDirection = form.watch('direction');
  const watchedContractId = form.watch('contractId');
  const watchedSupplierId = form.watch('supplierId');
  const watchedAmount = form.watch('amount');
  const watchedTaxRate = form.watch('taxRate');

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateInvoiceDto = {
      direction: values.direction,
      invoiceType: values.invoiceType as InvoiceType,
      amount: values.amount,
      taxRate: values.taxRate,
      remark: values.remark || undefined,
    };
    if (values.direction === 'sales') {
      dto.contractId = values.contractId;
      if (values.arId && values.arId !== 'none') dto.arId = values.arId;
    } else {
      dto.supplierId = values.supplierId;
    }
    const invoiceNoTrim: string = values.invoiceNo.trim();
    if (invoiceNoTrim) dto.invoiceNo = invoiceNoTrim;
    if (values.invoiceDate) dto.invoiceDate = values.invoiceDate;
    try {
      await financeApi.createInvoice(dto);
      toast.success(values.direction === 'sales' ? '销项发票登记成功' : '进项发票登记成功');
      onOpenChange(false);
      form.reset(FORM_DEFAULTS);
      await onSaved();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '发票登记失败'));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>发票登记</DialogTitle>
          <DialogDescription>
            销项发票需选择合同（客户与项目随合同带出）；进项发票需选择供应商。关联应收时请先开票再回款核销，已核销完毕的应收不可再关联开票。
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="direction"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    方向 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择方向" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="sales">销项</SelectItem>
                      <SelectItem value="purchase">进项</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {formDirection === 'sales' ? (
              <FormField
                control={form.control}
                name="contractId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      合同 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        const contract = (contracts ?? []).find((c) => c.id === value);
                        const entity = resolveTaxEntity({
                          taxEntityId: contract?.taxEntityId,
                          taxEntities: taxEntities ?? [],
                        });
                        const nextRate = resolveFormTaxRate(
                          Number(contract?.taxRate ?? form.getValues('taxRate') ?? 6),
                          entity
                        );
                        form.setValue('taxRate', nextRate);
                      }}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择合同" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(contracts ?? []).map((c: Contract) => (
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
            ) : (
              <FormField
                control={form.control}
                name="supplierId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      供应商 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        const supplier = (suppliers ?? []).find((s) => s.id === value);
                        const entity = resolveTaxEntity({
                          taxEntityId: supplier?.taxEntityId,
                          taxEntities: taxEntities ?? [],
                          supplierTaxEntityId: supplier?.taxEntityId,
                        });
                        form.setValue(
                          'taxRate',
                          resolveFormTaxRate(Number(form.getValues('taxRate') ?? 6), entity)
                        );
                      }}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择供应商" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(suppliers ?? []).map((s: Supplier) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.code} - {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {formDirection === 'sales' ? (
              <FormField
                control={form.control}
                name="arId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>关联应收（可选）</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择应收单" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">不关联</SelectItem>
                        {linkableArs.map((a: ArItem) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.code} - {a.customerName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="invoiceType"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      发票类型 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(INVOICE_TYPE_LABELS).map(([value, label]) => (
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
            </div>
            <FormField
              control={form.control}
              name="taxRate"
              render={({ field }) => {
                const selectedContract = (contracts ?? []).find(
                  (c) => c.id === watchedContractId
                );
                const selectedSupplier = (suppliers ?? []).find(
                  (s) => s.id === watchedSupplierId
                );
                const entity = resolveTaxEntity({
                  taxEntityId:
                    formDirection === 'sales'
                      ? selectedContract?.taxEntityId
                      : selectedSupplier?.taxEntityId,
                  taxEntities: taxEntities ?? [],
                  customerTaxEntityId: null,
                  supplierTaxEntityId: selectedSupplier?.taxEntityId,
                });
                const rates = resolveRateOptions(entity);
                return (
                  <FormItem>
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
                    <p className="text-xs text-muted-foreground">
                      {formatTaxSplitLine(
                        Number(watchedAmount ?? 0),
                        Number(watchedTaxRate ?? field.value ?? 0)
                      )}
                    </p>
                    <FormMessage />
                  </FormItem>
                );
              }}
            />
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="invoiceNo"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>发票号码（可选）</FormLabel>
                    <FormControl>
                      <Input placeholder="不填则使用系统编号" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="invoiceDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>开票日期（可选）</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            type="button"
                            className="w-full justify-start font-normal"
                          >
                            {field.value || '请选择开票日期'}
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={field.value ? new Date(`${field.value}T00:00:00`) : undefined}
                          onSelect={(date: Date | undefined) =>
                            field.onChange(date ? toLocalDate(date) : '')
                          }
                        />
                      </PopoverContent>
                    </Popover>
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

export default InvoiceFormDialog;
