import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import DateField from '@client/src/components/erp/DateField';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
import { financeApi, masterDataApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import { INVOICE_TYPE_LABELS } from '@client/src/utils/biz-labels';
import type {
  ChainInvoiceItem,
  CreateInvoiceDto,
  InvoiceDirection,
  InvoiceType,
  Supplier,
} from '@shared/api.interface';

const INVOICE_STATUS_LABELS: Record<string, string> = {
  issued: '已开票',
  voided: '已作废',
};

const DIRECTION_LABELS: Record<InvoiceDirection, string> = {
  sales: '销项',
  purchase: '进项',
};

const TAX_RATE_OPTIONS: { value: string; label: string }[] = [
  { value: '0', label: '0%' },
  { value: '6', label: '6%' },
  { value: '9', label: '9%' },
  { value: '13', label: '13%' },
];

const invoiceSchema = z
  .object({
    direction: z.enum(['sales', 'purchase']),
    supplierId: z.string(),
    invoiceType: z.string().min(1, '请选择发票类型'),
    amount: z.coerce.number().min(0.01, '开票金额必须大于 0'),
    taxRate: z.coerce.number().min(0).max(100),
    invoiceNo: z.string(),
    invoiceDate: z.string(),
    remark: z.string(),
  })
  .superRefine((val, ctx) => {
    if (val.direction === 'purchase' && !val.supplierId) {
      ctx.addIssue({ code: 'custom', path: ['supplierId'], message: '请选择供应商' });
    }
  });

type InvoiceFormData = z.output<typeof invoiceSchema>;
type InvoiceFormInput = z.input<typeof invoiceSchema>;

const FORM_DEFAULTS: InvoiceFormInput = {
  direction: 'sales',
  supplierId: '',
  invoiceType: 'vat_special',
  amount: 0,
  taxRate: 6,
  invoiceNo: '',
  invoiceDate: '',
  remark: '',
};

interface InvoiceSectionProps {
  projectId: string;
  onChanged?: () => void;
}

const InvoiceSection: React.FC<InvoiceSectionProps> = ({ projectId, onChanged }) => {
  const [createOpen, setCreateOpen] = useState(false);

  const { data: chain, loading, error, reload } = useAsyncData(
    () => projectsApi.getProjectChain(projectId),
    [projectId],
  );
  const { data: accounting, reload: reloadAccounting } = useAsyncData(
    () => projectsApi.getProjectAccounting(projectId),
    [projectId],
  );
  const { data: suppliers } = useAsyncData<Supplier[]>(
    () => masterDataApi.listSuppliers(),
    [],
  );

  const form = useForm<InvoiceFormInput, unknown, InvoiceFormData>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: FORM_DEFAULTS,
  });
  const formDirection: InvoiceDirection = form.watch('direction');

  const contractId: string = chain?.contract?.id ?? '';
  const contractLabel: string = chain?.contract
    ? `${chain.contract.code} - ${chain.contract.name}`
    : '';
  const invoices: ChainInvoiceItem[] = chain?.invoices ?? [];
  const invoiceTotal: number = chain?.invoiceTotalAmount ?? 0;
  const recognizedRevenue: number = accounting?.recognizedRevenue ?? 0;

  const columns: TableColumnsType<ChainInvoiceItem> = [
    { title: '单据编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '发票号', dataIndex: 'invoiceNo', width: 160, render: (v) => v ?? '-' },
    {
      title: '发票类型',
      dataIndex: 'invoiceType',
      width: 140,
      render: (t: string) => INVOICE_TYPE_LABELS[t] ?? t,
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '税额',
      dataIndex: 'taxAmount',
      width: 110,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '开票日期', dataIndex: 'invoiceDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <StatusBadge status={s} labels={INVOICE_STATUS_LABELS} />,
    },
  ];

  const onSubmit = form.handleSubmit(async (values) => {
    if (values.direction === 'sales' && !contractId) {
      toast.error('项目未关联合同，无法开具销项发票');
      return;
    }
    const dto: CreateInvoiceDto = {
      direction: values.direction,
      invoiceType: values.invoiceType as InvoiceType,
      amount: values.amount,
      taxRate: values.taxRate,
      projectId,
      remark: values.remark || undefined,
    };
    if (values.direction === 'sales') {
      dto.contractId = contractId;
    } else {
      dto.supplierId = values.supplierId;
    }
    const invoiceNoTrim: string = values.invoiceNo.trim();
    if (invoiceNoTrim) dto.invoiceNo = invoiceNoTrim;
    if (values.invoiceDate) dto.invoiceDate = values.invoiceDate;
    try {
      await financeApi.createInvoice(dto);
      toast.success(values.direction === 'sales' ? '销项发票登记成功' : '进项发票登记成功');
      setCreateOpen(false);
      form.reset(FORM_DEFAULTS);
      await Promise.all([reload(), reloadAccounting()]);
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '发票登记失败');
    }
  });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base font-semibold">发票</CardTitle>
          <CardDescription>
            开票金额合计 {formatMoney(invoiceTotal)}，已确认收入{' '}
            {formatMoney(recognizedRevenue)}
          </CardDescription>
        </div>
        <CanRole roles={['admin']}>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            开票
          </Button>
        </CanRole>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-destructive">
            {error}
            <Button
              variant="ghost"
              size="sm"
              className="ml-2"
              onClick={() => void reload()}
            >
              重试
            </Button>
          </p>
        ) : null}
        <Table
          columns={columns}
          dataSource={invoices}
          loading={loading}
          rowKey="id"
          scroll={{ x: 900, y: 400 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: '暂无发票，点击右上角「开票」登记' }}
        />
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>开票</DialogTitle>
            <DialogDescription>
              销项自动关联本项目与关联合同；进项需选择供应商，并自动归属本项目
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
                <FormItem>
                  <FormLabel>关联合同（自动带入）</FormLabel>
                  <FormControl>
                    <Input value={contractLabel || '项目未关联合同'} readOnly aria-readonly="true" />
                  </FormControl>
                </FormItem>
              ) : (
                <FormField
                  control={form.control}
                  name="supplierId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        供应商 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
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
                  name="taxRate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>税率</FormLabel>
                      <Select onValueChange={field.onChange} value={String(field.value)}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择税率" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {TAX_RATE_OPTIONS.map((opt) => (
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
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      开票金额（元，不含税）{' '}
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
                      <DateField value={field.value} onChange={field.onChange} />
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
    </Card>
  );
};

export default InvoiceSection;
