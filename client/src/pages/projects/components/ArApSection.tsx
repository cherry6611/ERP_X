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
import { UserSelect } from '@client/src/components/business-ui/user-select';
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import { financeApi, masterDataApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import { AP_STATUS_LABELS, AR_STATUS_LABELS } from '@client/src/utils/biz-labels';
import type {
  ChainApItem,
  ChainArItem,
  CreateApDto,
  CreateArDto,
  CreatePaymentDto,
  CreateReceiptDto,
  PaymentItem,
  ReceiptItem,
  Supplier,
} from '@shared/api.interface';

const RECEIPT_STATUS_LABELS_FALLBACK: Record<string, string> = {
  matched: '已核销',
  unmatched: '未核销',
};

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  paid: '已支付',
};

const arSchema = z.object({
  amount: z.coerce.number().min(1, '应收金额必须大于 0'),
  dueDate: z.string().optional(),
  ownerUserId: z.string().optional(),
  remark: z.string(),
});

type ArFormData = z.output<typeof arSchema>;
type ArFormInput = z.input<typeof arSchema>;

const receiptSchema = z.object({
  arId: z.string().min(1, '请选择应收单'),
  amount: z.coerce.number().min(1, '回款金额必须大于 0'),
  receiptDate: z.string().optional(),
  method: z.string(),
  remark: z.string(),
});

type ReceiptFormData = z.output<typeof receiptSchema>;
type ReceiptFormInput = z.input<typeof receiptSchema>;

const apSchema = z.object({
  supplierId: z.string().min(1, '请选择供应商'),
  amount: z.coerce.number().min(1, '应付金额必须大于 0'),
  dueDate: z.string().optional(),
  remark: z.string(),
});

type ApFormData = z.output<typeof apSchema>;
type ApFormInput = z.input<typeof apSchema>;

const paymentSchema = z.object({
  apId: z.string().min(1, '请选择应付单'),
  amount: z.coerce.number().min(1, '付款金额必须大于 0'),
  payDate: z.string().optional(),
  method: z.string(),
  remark: z.string(),
});

type PaymentFormData = z.output<typeof paymentSchema>;
type PaymentFormInput = z.input<typeof paymentSchema>;

interface ArApSectionProps {
  projectId: string;
  onChanged?: () => void;
}

const ArApSection: React.FC<ArApSectionProps> = ({ projectId, onChanged }) => {
  const [arOpen, setArOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [apOpen, setApOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);

  const { data: chain, loading, error, reload } = useAsyncData(
    () => projectsApi.getProjectChain(projectId),
    [projectId],
  );
  const customerId: string | undefined = chain?.customer?.id ?? undefined;
  const contractId: string = chain?.contract?.id ?? '';
  const { data: suppliers } = useAsyncData<Supplier[]>(
    () => masterDataApi.listSuppliers(),
    [],
  );
  const { data: receipts, reload: reloadReceipts } = useAsyncData<ReceiptItem[]>(
    () => (customerId ? financeApi.listReceipts(customerId) : Promise.resolve([])),
    [customerId],
  );
  const { data: payments, reload: reloadPayments } = useAsyncData<PaymentItem[]>(
    () => financeApi.listPayments(),
    [],
  );

  const arItems: ChainArItem[] = chain?.arItems ?? [];
  const apItems: ChainApItem[] = chain?.apItems ?? [];
  const apIds: string[] = apItems.map((a: ChainApItem) => a.id);
  const projectPayments: PaymentItem[] = (payments ?? []).filter(
    (p: PaymentItem) => apIds.includes(p.apId),
  );
  const openArs: ChainArItem[] = arItems.filter(
    (a: ChainArItem) => a.status !== 'settled',
  );
  const payableAps: ChainApItem[] = apItems.filter(
    (a: ChainApItem) => a.status !== 'paid',
  );

  const arForm = useForm<ArFormInput, unknown, ArFormData>({
    resolver: zodResolver(arSchema),
    defaultValues: { amount: 0, ownerUserId: '', remark: '' },
  });
  const receiptForm = useForm<ReceiptFormInput, unknown, ReceiptFormData>({
    resolver: zodResolver(receiptSchema),
    defaultValues: { arId: '', amount: 0, method: 'bank', remark: '' },
  });
  const apForm = useForm<ApFormInput, unknown, ApFormData>({
    resolver: zodResolver(apSchema),
    defaultValues: { supplierId: '', amount: 0, remark: '' },
  });
  const paymentForm = useForm<PaymentFormInput, unknown, PaymentFormData>({
    resolver: zodResolver(paymentSchema),
    defaultValues: { apId: '', amount: 0, method: 'bank', remark: '' },
  });
  const selectedReceiptArId: string = receiptForm.watch('arId');
  const selectedReceiptAr: ChainArItem | undefined = openArs.find(
    (a: ChainArItem) => a.id === selectedReceiptArId,
  );

  const refreshAll = async () => {
    await Promise.all([reload(), reloadReceipts(), reloadPayments()]);
    onChanged?.();
  };

  const onCreateAr = arForm.handleSubmit(async (values) => {
    if (!contractId) {
      toast.error('项目未关联合同，无法登记应收');
      return;
    }
    const dto: CreateArDto = {
      contractId,
      projectId,
      amount: values.amount,
      dueDate: values.dueDate,
      ownerUserId: values.ownerUserId || undefined,
      remark: values.remark || undefined,
    };
    try {
      await financeApi.createAr(dto);
      toast.success('应收已登记');
      setArOpen(false);
      arForm.reset({ amount: 0, ownerUserId: '', remark: '' });
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
    }
  });

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
    };
    try {
      await financeApi.createReceipt(dto);
      toast.success('回款已登记');
      setReceiptOpen(false);
      receiptForm.reset({ arId: '', amount: 0, method: 'bank', remark: '' });
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
    }
  });

  const onCreateAp = apForm.handleSubmit(async (values) => {
    const dto: CreateApDto = {
      supplierId: values.supplierId,
      projectId,
      amount: values.amount,
      dueDate: values.dueDate,
      remark: values.remark || undefined,
    };
    try {
      await financeApi.createAp(dto);
      toast.success('应付已登记');
      setApOpen(false);
      apForm.reset({ supplierId: '', amount: 0, remark: '' });
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
    }
  });

  const onCreatePayment = paymentForm.handleSubmit(async (values) => {
    const dto: CreatePaymentDto = {
      apId: values.apId,
      amount: values.amount,
      payDate: values.payDate,
      method: values.method,
      remark: values.remark || undefined,
    };
    try {
      await financeApi.createPayment(dto);
      toast.success('付款申请已提交，待审批');
      setPaymentOpen(false);
      paymentForm.reset({ apId: '', amount: 0, method: 'bank', remark: '' });
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '提交失败');
    }
  });

  const arColumns: TableColumnsType<ChainArItem> = [
    { title: '应收编号', dataIndex: 'code', fixed: 'left', width: 150 },
    {
      title: '应收金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '已核销',
      dataIndex: 'settledAmount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '未核销',
      key: 'unsettled',
      width: 120,
      align: 'right',
      render: (_, record) => formatMoney(record.amount - record.settledAmount),
    },
    { title: '到期日', dataIndex: 'dueDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '责任人',
      dataIndex: 'ownerUserId',
      width: 110,
      render: (v: string | null) =>
        v ? <UserDisplay value={[v]} size="small" /> : '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={AR_STATUS_LABELS} />,
    },
  ];

  const receiptColumns: TableColumnsType<ReceiptItem> = [
    { title: '回款编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '客户', dataIndex: 'customerName', width: 140 },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '回款日期', dataIndex: 'receiptDate', width: 110, render: (v) => v ?? '-' },
    { title: '方式', dataIndex: 'method', width: 90, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => (
        <StatusBadge status={s} labels={RECEIPT_STATUS_LABELS_FALLBACK} />
      ),
    },
  ];

  const apColumns: TableColumnsType<ChainApItem> = [
    { title: '应付编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '供应商', dataIndex: 'supplierName', width: 150, render: (v) => v ?? '-' },
    {
      title: '应付金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '已付',
      dataIndex: 'paidAmount',
      width: 110,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '未付',
      key: 'unpaid',
      width: 110,
      align: 'right',
      render: (_, record) => formatMoney(record.amount - record.paidAmount),
    },
    { title: '到期日', dataIndex: 'dueDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={AP_STATUS_LABELS} />,
    },
  ];

  const paymentColumns: TableColumnsType<PaymentItem> = [
    { title: '付款编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '供应商', dataIndex: 'supplierName', width: 150 },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '付款日期', dataIndex: 'payDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <StatusBadge status={s} labels={PAYMENT_STATUS_LABELS} />,
    },
  ];

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-base font-semibold">应收 / 应付</CardTitle>
        <CardDescription>
          应收未回款 {formatMoney(chain?.arOpenAmount ?? 0)}，应付未付{' '}
          {formatMoney(chain?.apOpenAmount ?? 0)}
          {customerId ? `，客户：${chain?.customer?.name ?? ''}` : '，项目未关联客户'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
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
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">应收 / 回款</h4>
            <div className="flex items-center gap-2">
              <CanRole roles={['admin']}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!contractId}
                  onClick={() => setArOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  登记应收
                </Button>
              </CanRole>
              <CanRole roles={['admin']}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!customerId}
                  onClick={() => setReceiptOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  登记回款
                </Button>
              </CanRole>
            </div>
          </div>
          <Table
            columns={arColumns}
            dataSource={arItems}
            loading={loading}
            rowKey="id"
            scroll={{ x: 800, y: 300 }}
            pagination={{ pageSize: 5, showTotal: (t: number) => `共 ${t} 条` }}
            locale={{ emptyText: '暂无应收，点击「登记应收」创建' }}
          />
          <Table
            columns={receiptColumns}
            dataSource={receipts ?? []}
            rowKey="id"
            scroll={{ x: 800, y: 300 }}
            pagination={{ pageSize: 5, showTotal: (t: number) => `共 ${t} 条` }}
            locale={{ emptyText: '暂无回款记录' }}
            size="small"
          />
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">应付 / 付款</h4>
            <div className="flex items-center gap-2">
              <CanRole roles={['admin']}>
                <Button variant="outline" size="sm" onClick={() => setApOpen(true)}>
                  <Plus className="h-4 w-4" />
                  登记应付
                </Button>
              </CanRole>
              <CanRole roles={['admin']}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={payableAps.length === 0}
                  onClick={() => setPaymentOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  登记付款
                </Button>
              </CanRole>
            </div>
          </div>
          <Table
            columns={apColumns}
            dataSource={apItems}
            loading={loading}
            rowKey="id"
            scroll={{ x: 900, y: 300 }}
            pagination={{ pageSize: 5, showTotal: (t: number) => `共 ${t} 条` }}
            locale={{ emptyText: '暂无应付，点击「登记应付」创建' }}
          />
          <Table
            columns={paymentColumns}
            dataSource={projectPayments}
            rowKey="id"
            scroll={{ x: 800, y: 300 }}
            pagination={{ pageSize: 5, showTotal: (t: number) => `共 ${t} 条` }}
            locale={{ emptyText: '暂无付款记录' }}
            size="small"
          />
        </div>
      </CardContent>

      <Dialog open={arOpen} onOpenChange={setArOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>登记应收</DialogTitle>
          </DialogHeader>
          <Form {...arForm}>
            <form onSubmit={onCreateAr} className="space-y-4">
              <FormItem>
                <FormLabel>合同 / 客户（自动带入）</FormLabel>
                <FormControl>
                  <Input
                    value={
                      chain?.contract && chain?.customer
                        ? `${chain.contract.code} - ${chain.customer.name}`
                        : chain?.contract
                          ? chain.contract.code
                          : '项目未关联合同'
                    }
                    readOnly
                    aria-readonly="true"
                  />
                </FormControl>
              </FormItem>
              <FormField
                control={arForm.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      应收金额（元）{' '}
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
                  <FormItem>
                    <FormLabel>到期日</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={arForm.control}
                name="ownerUserId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>回款责任人</FormLabel>
                    <div className="flex items-center gap-2">
                      <UserSelect
                        value={field.value || null}
                        onChange={(v: string | null) => field.onChange(v ?? '')}
                        placeholder="请选择回款责任人"
                      />
                      {field.value ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label="清除回款责任人"
                          onClick={() => field.onChange('')}
                        >
                          清除
                        </Button>
                      ) : null}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
                <Button type="submit">提交登记</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={receiptOpen} onOpenChange={setReceiptOpen}>
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
                            {a.code} - 未回款 {formatMoney(a.amount - a.settledAmount)}
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
                  该应收单未回款 {formatMoney(selectedReceiptAr.amount - selectedReceiptAr.settledAmount)}
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

      <Dialog open={apOpen} onOpenChange={setApOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>登记应付</DialogTitle>
          </DialogHeader>
          <Form {...apForm}>
            <form onSubmit={onCreateAp} className="space-y-4">
              <FormField
                control={apForm.control}
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
                            {s.name}
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
                  control={apForm.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        应付金额（元）{' '}
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
                  control={apForm.control}
                  name="dueDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>到期日</FormLabel>
                      <DateField value={field.value} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={apForm.control}
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

      <Dialog open={paymentOpen} onOpenChange={setPaymentOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>登记付款</DialogTitle>
          </DialogHeader>
          <Form {...paymentForm}>
            <form onSubmit={onCreatePayment} className="space-y-4">
              <FormField
                control={paymentForm.control}
                name="apId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      应付单 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择应付单" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {payableAps.map((a: ChainApItem) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.code} - 未付 {formatMoney(a.amount - a.paidAmount)}
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
                  control={paymentForm.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        付款金额（元）{' '}
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
                  control={paymentForm.control}
                  name="payDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>付款日期</FormLabel>
                      <DateField value={field.value} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={paymentForm.control}
                name="method"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>付款方式</FormLabel>
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
                control={paymentForm.control}
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
                <Button type="submit">提交申请</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </Card>
  );
};

export default ArApSection;
