import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Download, FileInput, FilePlus, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import FilterBar from '@client/src/components/erp/FilterBar';
import StatCard from '@client/src/components/erp/StatCard';
import { Badge } from '@client/src/components/ui/badge';
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
import { extractErrorMessage } from '@client/src/components/excel/excel-utils';
import { contractsApi, financeApi, masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import { STATUS_VARIANTS } from '@client/src/utils/biz-labels';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import {
  coerceTaxRate,
  resolveRateOptions,
  resolveTaxEntity,
} from '@client/src/utils/tax-rate-options';
import { formatTaxSplitLine } from '@client/src/utils/tax-display';
import { VAT_RATES } from '@shared/tax';
import type {
  ArItem,
  Contract,
  CreateInvoiceDto,
  InvoiceDirection,
  InvoiceItem,
  InvoiceType,
  Supplier,
  TaxEntity,
} from '@shared/api.interface';

const INVOICE_TYPE_LABELS: Record<string, string> = {
  vat_special: '增值税专用发票',
  vat_normal: '增值税普通发票',
  electronic: '电子发票',
};

const INVOICE_STATUS_LABELS: Record<string, string> = {
  issued: '已开票',
  voided: '已作废',
};

const DIRECTION_LABELS: Record<InvoiceDirection, string> = {
  sales: '销项',
  purchase: '进项',
};

type DirectionFilter = 'all' | InvoiceDirection;

const toLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return `"${s.replace(/"/gu, '""')}"`;
};

const invoiceSchema = z
  .object({
    direction: z.enum(['sales', 'purchase']),
    contractId: z.string(),
    supplierId: z.string(),
    invoiceType: z.string().min(1, '请选择发票类型'),
    amount: z.coerce.number().min(0.01, '开票金额必须大于 0'),
    taxRate: z.coerce
      .number()
      .refine((value) => (VAT_RATES as readonly number[]).includes(value), '请选择合法税率'),
    arId: z.string(),
    invoiceNo: z.string(),
    invoiceDate: z.string(),
    remark: z.string(),
  })
  .superRefine((val, ctx) => {
    if (val.direction === 'sales' && !val.contractId) {
      ctx.addIssue({ code: 'custom', path: ['contractId'], message: '请选择合同' });
    }
    if (val.direction === 'purchase' && !val.supplierId) {
      ctx.addIssue({ code: 'custom', path: ['supplierId'], message: '请选择供应商' });
    }
  });

type InvoiceFormData = z.output<typeof invoiceSchema>;
type InvoiceFormInput = z.input<typeof invoiceSchema>;

const FORM_DEFAULTS: InvoiceFormInput = {
  direction: 'sales',
  contractId: '',
  supplierId: '',
  invoiceType: 'vat_special',
  amount: 0,
  taxRate: 6,
  arId: 'none',
  invoiceNo: '',
  invoiceDate: '',
  remark: '',
};

const InvoicesTab: React.FC = () => {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [linkTarget, setLinkTarget] = useState<InvoiceItem | null>(null);
  const [linkArId, setLinkArId] = useState('');
  const [linking, setLinking] = useState(false);

  const { data, loading, error, reload } = useAsyncData<InvoiceItem[]>(
    () =>
      financeApi.listInvoices(
        undefined,
        directionFilter === 'all' ? undefined : directionFilter,
      ),
    [directionFilter],
  );
  const { data: contracts } = useAsyncData<Contract[]>(() => contractsApi.listContracts(), []);
  const { data: suppliers } = useAsyncData<Supplier[]>(
    () => masterDataApi.listSuppliers(),
    [],
  );
  const { data: taxEntities } = useAsyncData<TaxEntity[]>(
    () => masterDataApi.listTaxEntities(),
    [],
  );
  const { data: ars } = useAsyncData<ArItem[]>(() => financeApi.listArs(), []);

  const form = useForm<InvoiceFormInput, unknown, InvoiceFormData>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: FORM_DEFAULTS,
  });
  const formDirection: InvoiceDirection = form.watch('direction');
  const watchedContractId = form.watch('contractId');
  const watchedSupplierId = form.watch('supplierId');
  const watchedAmount = form.watch('amount');
  const watchedTaxRate = form.watch('taxRate');

  const invoices: InvoiceItem[] = data ?? [];
  const salesTaxTotal: number = invoices
    .filter((it: InvoiceItem) => it.direction === 'sales')
    .reduce((sum: number, it: InvoiceItem) => sum + it.taxAmount, 0);
  const purchaseTaxTotal: number = invoices
    .filter((it: InvoiceItem) => it.direction === 'purchase')
    .reduce((sum: number, it: InvoiceItem) => sum + it.taxAmount, 0);
  const linkableArs: ArItem[] = (ars ?? []).filter(
    (a: ArItem) => a.status === 'open' || a.status === 'partial',
  );

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
      setCreateOpen(false);
      form.reset(FORM_DEFAULTS);
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '发票登记失败'));
    }
  });

  const handleVoid = async (invoice: InvoiceItem) => {
    const ok = await confirmDanger(
      `确认作废发票 ${invoice.code}（${invoice.invoiceNo ?? '系统编号'}）？作废后不可恢复`,
      { title: '作废发票', confirmLabel: '确认作废' },
    );
    if (!ok) return;
    try {
      await financeApi.voidInvoice(invoice.id);
      toast.success('发票已作废');
      await reload();
    } catch (err) {
      toast.error(extractErrorMessage(err, '发票作废失败'));
    }
  };

  const handleExportCsv = () => {
    if (invoices.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    const header: string = [
      '申请编号',
      '方向',
      '往来方',
      '合同',
      '发票类型',
      '发票号码',
      '关联应收',
      '开票金额（含税）',
      '税率',
      '税额',
      '开票日期',
      '状态',
      '备注',
    ]
      .map(csvCell)
      .join(',');
    const body: string[] = invoices.map((it: InvoiceItem) =>
      [
        it.code,
        DIRECTION_LABELS[it.direction] ?? it.direction,
        it.direction === 'sales' ? it.customerName : (it.supplierName ?? ''),
        it.contractName ?? '',
        INVOICE_TYPE_LABELS[it.invoiceType] ?? it.invoiceType,
        it.invoiceNo ?? '',
        it.arCode ?? '',
        it.amount,
        it.taxRate,
        it.taxAmount,
        it.invoiceDate ?? '',
        INVOICE_STATUS_LABELS[it.status] ?? it.status,
        it.remark ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
    const blob = new Blob([`\uFEFF${[header, ...body].join('\n')}`], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '发票台账.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const openLinkDialog = (record: InvoiceItem) => {
    setLinkArId(record.arId ?? '');
    setLinkTarget(record);
  };

  const handleLink = async () => {
    if (!linkTarget || !linkArId) return;
    setLinking(true);
    try {
      await financeApi.updateInvoice(linkTarget.id, { arId: linkArId });
      toast.success('关联应收成功');
      setLinkTarget(null);
      setLinkArId('');
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '关联应收失败'));
    } finally {
      setLinking(false);
    }
  };

  const columns: TableColumnsType<InvoiceItem> = [
    { title: '申请编号', dataIndex: 'code', fixed: 'left', width: 150 },
    {
      title: '方向',
      dataIndex: 'direction',
      width: 80,
      render: (v: InvoiceDirection) => (
        <Badge variant={v === 'sales' ? 'info' : 'secondary'}>{DIRECTION_LABELS[v] ?? v}</Badge>
      ),
    },
    {
      title: '往来方',
      dataIndex: 'customerName',
      width: 160,
      render: (v: string, record: InvoiceItem) =>
        record.direction === 'sales' ? record.customerName : (record.supplierName ?? '-'),
    },
    { title: '合同', dataIndex: 'contractName', width: 180, render: (v: string) => v ?? '-' },
    {
      title: '发票类型',
      dataIndex: 'invoiceType',
      width: 140,
      render: (t: string) => INVOICE_TYPE_LABELS[t] ?? t,
    },
    {
      title: '发票号码',
      dataIndex: 'invoiceNo',
      width: 160,
      render: (v: string | null, record: InvoiceItem) =>
        v ? (
          record.status === 'voided' ? (
            <span className="text-muted-foreground line-through">{v}</span>
          ) : (
            v
          )
        ) : (
          '-'
        ),
    },
    {
      title: '关联应收',
      dataIndex: 'arCode',
      width: 140,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '开票金额（含税）',
      dataIndex: 'amount',
      width: 180,
      align: 'right',
      render: (v: number, record) => (
        <div className="text-right">
          <div>{formatMoney(v)}</div>
          <div className="text-xs text-muted-foreground">
            {formatTaxSplitLine(v, record.taxRate)}
          </div>
        </div>
      ),
    },
    {
      title: '税额',
      dataIndex: 'taxAmount',
      width: 110,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '开票日期', dataIndex: 'invoiceDate', width: 110, render: (v: string) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => (
        <Badge variant={STATUS_VARIANTS[s] ?? 'secondary'}>
          {INVOICE_STATUS_LABELS[s] ?? s}
        </Badge>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      fixed: 'right',
      render: (_: unknown, record: InvoiceItem) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/finance/invoices/${record.id}`)}
          >
            详情
          </Button>
          {record.direction === 'sales' ? (
            <CanCapabilityWrite capability="finance_write">
              <Button variant="ghost" size="sm" onClick={() => openLinkDialog(record)}>
                关联应收
              </Button>
            </CanCapabilityWrite>
          ) : null}
          {record.status === 'issued' ? (
            <CanCapabilityWrite capability="finance_write">
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => void handleVoid(record)}
              >
                作废
              </Button>
            </CanCapabilityWrite>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <StatCard
          label="销项税额合计"
          value={formatMoney(salesTaxTotal)}
          icon={FilePlus}
          tone="primary"
          hint="当前列表销项发票税额合计"
        />
        <StatCard
          label="进项可抵扣税额合计"
          value={formatMoney(purchaseTaxTotal)}
          icon={FileInput}
          tone="info"
          hint="当前列表进项发票税额合计"
        />
      </div>
      <div className="flex items-center justify-between">
        <FilterBar>
          <Select
            value={directionFilter}
            onValueChange={(v) => setDirectionFilter(v as DirectionFilter)}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="发票方向" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="sales">销项</SelectItem>
              <SelectItem value="purchase">进项</SelectItem>
            </SelectContent>
          </Select>
        </FilterBar>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleExportCsv}>
            <Download className="h-4 w-4" />
            导出 CSV
          </Button>
          <CanCapabilityWrite capability="finance_write">
            <Button onClick={() => navigate('/finance/invoices/new')}>
              <Plus className="h-4 w-4" />
              发票登记
            </Button>
          </CanCapabilityWrite>
        </div>
      </div>
      <DataState
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          columns={columns}
          dataSource={invoices}
          rowKey="id"
          scroll={{ x: 1500, y: 500 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: '暂无发票，点击右上角「发票登记」创建' }}
        />
      </DataState>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
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
                          const nextRate = coerceTaxRate(
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
                            coerceTaxRate(Number(form.getValues('taxRate') ?? 6), entity)
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

      <Dialog open={linkTarget !== null} onOpenChange={(open: boolean) => {
        if (!open) {
          setLinkTarget(null);
          setLinkArId('');
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>关联应收</DialogTitle>
            <DialogDescription>
              为发票 {linkTarget?.code} 选择待回款的应收单，提交后完成关联
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Select value={linkArId} onValueChange={setLinkArId}>
              <SelectTrigger>
                <SelectValue placeholder="请选择应收单" />
              </SelectTrigger>
              <SelectContent>
                {linkableArs.map((a: ArItem) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code} - {a.customerName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {linkableArs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                暂无可关联的应收单（仅开放中 / 部分回款的应收可关联）
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setLinkTarget(null)}>
                取消
              </Button>
              <Button disabled={!linkArId || linking} onClick={() => void handleLink()}>
                确认关联
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
};

export default InvoicesTab;
