import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Download, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import DateField from '@client/src/components/erp/DateField';
import { DataState } from '@client/src/components/DataState';
import StatusBadge from '@client/src/components/erp/StatusBadge';
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
import { financeApi, masterDataApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { formatMoney } from '@client/src/utils/format';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  ApItem,
  ApWriteoffDto,
  CreateApDto,
  CreatePaymentDto,
  GenerateVendorSettlementDto,
  PaymentItem,
  Project,
  Supplier,
  VendorSettlementLine,
  VendorSettlementPreview,
} from '@shared/api.interface';

const AP_STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  partial: '部分付款',
  paid: '已付清',
};

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  paid: '已支付',
};

const AP_EXPORT_COLUMNS: ExcelSheetColumn<ApItem>[] = [
  { header: '应付编号', value: (row: ApItem) => row.code },
  { header: '供应商', value: (row: ApItem) => row.supplierName },
  { header: '项目', value: (row: ApItem) => row.projectName ?? '' },
  { header: '应付金额（含税）', value: (row: ApItem) => row.amount },
  { header: '已付', value: (row: ApItem) => row.paidAmount },
  {
    header: '未付',
    value: (row: ApItem) => row.amount - row.paidAmount,
  },
  { header: '到期日', value: (row: ApItem) => row.dueDate ?? '' },
  {
    header: '状态',
    value: (row: ApItem) => AP_STATUS_LABELS[row.status] ?? row.status,
  },
];

const apSchema = z.object({
  supplierId: z.string().min(1, '请选择供应商'),
  amount: z.coerce.number().min(1, '应付金额必须大于 0'),
  dueDate: z.string().optional(),
  remark: z.string(),
});

type ApFormData = z.output<typeof apSchema>;
type ApFormInput = z.input<typeof apSchema>;

const paymentSchema = z.object({
  apId: z.string().min(1, '请选择应付'),
  amount: z.coerce.number().min(1, '付款金额必须大于 0'),
  method: z.string(),
  remark: z.string(),
});

type PaymentFormData = z.output<typeof paymentSchema>;
type PaymentFormInput = z.input<typeof paymentSchema>;

const writeoffSchema = z.object({
  apId: z.string().min(1, '请选择应付'),
  paymentId: z.string().min(1, '请选择付款'),
  amount: z.coerce.number().min(0.01, '核销金额必须大于 0'),
});

type WriteoffFormData = z.output<typeof writeoffSchema>;
type WriteoffFormInput = z.input<typeof writeoffSchema>;

const vendorSettlementSchema = z.object({
  supplierId: z.string().min(1, '请选择供应商'),
  period: z.string().min(1, '请选择月份'),
  projectId: z.string().optional(),
  dueDate: z.string().optional(),
});

type VendorSettlementFormData = z.output<typeof vendorSettlementSchema>;
type VendorSettlementFormInput = z.input<typeof vendorSettlementSchema>;

/** 近 12 个月（含当月）的期间选项，格式 YYYY-MM */
function buildRecentPeriods(count: number): string[] {
  const periods: string[] = [];
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return periods;
}

const VENDOR_SETTLEMENT_PERIODS: string[] = buildRecentPeriods(12);

const ApTab: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState('all');
  const [apOpen, setApOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [writeoffOpen, setWriteoffOpen] = useState(false);
  const [vendorSettlementOpen, setVendorSettlementOpen] = useState(false);
  const [settlementPreview, setSettlementPreview] = useState<VendorSettlementPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [generating, setGenerating] = useState(false);

  const { data: aps, loading, error, reload } = useAsyncData<ApItem[]>(
    () => financeApi.listAps(undefined, statusFilter !== 'all' ? statusFilter : undefined),
    [statusFilter],
  );
  const { data: payments, reload: reloadPayments } = useAsyncData<PaymentItem[]>(
    () => financeApi.listPayments(),
    []
  );
  const { data: suppliers } = useAsyncData<Supplier[]>(
    () => masterDataApi.listSuppliers(),
    [],
  );
  const { data: projects } = useAsyncData<Project[]>(() => projectsApi.listProjects(), []);

  const apForm = useForm<ApFormInput, unknown, ApFormData>({
    resolver: zodResolver(apSchema),
    defaultValues: { supplierId: '', amount: 0, remark: '' },
  });
  const paymentForm = useForm<PaymentFormInput, unknown, PaymentFormData>({
    resolver: zodResolver(paymentSchema),
    defaultValues: { apId: '', amount: 0, method: 'bank', remark: '' },
  });
  const writeoffForm = useForm<WriteoffFormInput, unknown, WriteoffFormData>({
    resolver: zodResolver(writeoffSchema),
    defaultValues: { apId: '', paymentId: '', amount: 0 },
  });
  const vendorSettlementForm = useForm<
    VendorSettlementFormInput,
    unknown,
    VendorSettlementFormData
  >({
    resolver: zodResolver(vendorSettlementSchema),
    defaultValues: { supplierId: '', period: '', projectId: '', dueDate: '' },
  });
  const vsSupplierId: string = vendorSettlementForm.watch('supplierId');
  const vsPeriod: string = vendorSettlementForm.watch('period');
  const vsProjectId: string = vendorSettlementForm.watch('projectId') ?? '';

  const onCreateAp = apForm.handleSubmit(async (values) => {
    const dto: CreateApDto = {
      supplierId: values.supplierId,
      amount: values.amount,
      dueDate: values.dueDate,
      remark: values.remark || undefined,
    };
    try {
      await financeApi.createAp(dto);
      toast.success('应付已登记');
      setApOpen(false);
      apForm.reset({ supplierId: '', amount: 0, remark: '' });
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '登记失败'));
    }
  });

  const onCreatePayment = paymentForm.handleSubmit(async (values) => {
    const dto: CreatePaymentDto = {
      apId: values.apId,
      amount: values.amount,
      method: values.method,
      remark: values.remark || undefined,
    };
    try {
      await financeApi.createPayment(dto);
      toast.success('付款申请已提交，待审批');
      setPaymentOpen(false);
      paymentForm.reset({ apId: '', amount: 0, method: 'bank', remark: '' });
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '提交失败'));
    }
  });

  const onWriteoff = writeoffForm.handleSubmit(async (values) => {
    const dto: ApWriteoffDto = {
      apId: values.apId,
      paymentId: values.paymentId,
      amount: values.amount,
    };
    try {
      await financeApi.apWriteoff(dto);
      toast.success('付款核销成功');
      setWriteoffOpen(false);
      writeoffForm.reset({ apId: '', paymentId: '', amount: 0 });
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '核销失败'));
    }
  });

  const approvePayment = async (p: PaymentItem, action: 'approve' | 'reject') => {
    try {
      await financeApi.approvePayment(p.id, action);
      toast.success(action === 'approve' ? '付款已批准' : '付款已驳回');
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  useEffect(() => {
    if (!vsSupplierId || !vsPeriod) {
      setSettlementPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    financeApi
      .vendorSettlementPreview(vsSupplierId, vsPeriod, vsProjectId || undefined)
      .then((data: VendorSettlementPreview) => {
        if (!cancelled) setSettlementPreview(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSettlementPreview(null);
          toast.error(getApiErrorMessage(err, '获取结算明细失败'));
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vsSupplierId, vsPeriod, vsProjectId]);

  const onGenerateVendorSettlement = vendorSettlementForm.handleSubmit(
    async (values) => {
      setGenerating(true);
      try {
        const dto: GenerateVendorSettlementDto = {
          supplierId: values.supplierId,
          period: values.period,
          projectId: values.projectId || null,
          dueDate: values.dueDate,
        };
        const result = await financeApi.generateVendorSettlement(dto);
        toast.success(`结算单已生成，应付单号 ${result.code}`);
        setVendorSettlementOpen(false);
        vendorSettlementForm.reset({
          supplierId: '',
          period: '',
          projectId: '',
          dueDate: '',
        });
        setSettlementPreview(null);
        await reload();
      } catch (err) {
        toast.error(getApiErrorMessage(err, '生成失败'));
      } finally {
        setGenerating(false);
      }
    },
  );

  const vendorSettlementLineColumns: TableColumnsType<VendorSettlementLine> = [
    { title: '员工', dataIndex: 'employeeName', width: 120 },
    { title: '角色', dataIndex: 'roleName', width: 120, render: (v) => v ?? '-' },
    { title: '工时(h)', dataIndex: 'hours', width: 90, align: 'right' },
    {
      title: '单价(元/h)',
      dataIndex: 'rate',
      width: 110,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '金额（不含税）',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
  ];

  const unpaidAps = (aps ?? []).filter((a) => a.status !== 'paid');
  const paidPayments = (payments ?? []).filter((p) => p.status === 'approved');

  const handleExport = () => {
    const rows: ApItem[] = aps ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('应付列表.xlsx', '应付', AP_EXPORT_COLUMNS, rows);
  };

  const apColumns: TableColumnsType<ApItem> = [
    { title: '应付编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '供应商', dataIndex: 'supplierName', width: 160 },
    { title: '项目', dataIndex: 'projectName', width: 160, render: (v) => v ?? '-' },
    {
      title: '应付金额（含税）',
      dataIndex: 'amount',
      width: 140,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '已付',
      dataIndex: 'paidAmount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '未付',
      key: 'unpaid',
      width: 120,
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
    { title: '供应商', dataIndex: 'supplierName', width: 160 },
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
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={PAYMENT_STATUS_LABELS} />,
    },
    { title: '审批人', dataIndex: 'approver', width: 100, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 140,
      render: (_, record) => (
        <CanRole roles={['admin']}>
          <div className="flex gap-1">
            {record.status === 'pending' ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void approvePayment(record, 'approve')}
                >
                  批准
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void approvePayment(record, 'reject')}
                >
                  驳回
                </Button>
              </>
            ) : null}
            {record.status !== 'voided' && record.status !== 'rejected' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const ok = await confirmDanger(
                      `确认作废付款 ${record.code ?? record.id}？此操作不可恢复。`,
                    );
                    if (!ok) return;
                    try {
                      await financeApi.voidPayment(record.id);
                      toast.success('付款已作废');
                      await Promise.all([reload(), reloadPayments()]);
                    } catch (err: unknown) {
                      toast.error(getApiErrorMessage(err, '作废失败'));
                    }
                  })();
                }}
              >
                作废
              </Button>
            ) : null}
          </div>
        </CanRole>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">状态</span>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-32" aria-label="应付状态筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {Object.entries(AP_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CanRole roles={['admin']}>
          <Button onClick={() => setApOpen(true)}>
            <Plus className="h-4 w-4" />
            登记应付
          </Button>
        </CanRole>
        <CanRole roles={['admin']}>
          <Button variant="outline" onClick={() => setPaymentOpen(true)}>
            <Plus className="h-4 w-4" />
            付款申请
          </Button>
        </CanRole>
        <CanRole roles={['admin']}>
          <Button variant="outline" onClick={() => setWriteoffOpen(true)}>
            付款核销
          </Button>
        </CanRole>
        <CanRole roles={['admin']}>
          <Button onClick={() => setVendorSettlementOpen(true)}>
            <Plus className="h-4 w-4" />
            外协结算
          </Button>
        </CanRole>
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
        </Button>
      </div>
      <DataState
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        skeleton="table"
      >
        <div className="flex flex-col gap-3">
          <h3 className="text-base font-semibold">应付账款</h3>
          <Table
            columns={apColumns}
            dataSource={aps ?? []}
            rowKey="id"
            scroll={{ x: 1200, y: 400 }}
            pagination={{
              pageSize: 10,
              showTotal: (t: number) => `共 ${t} 条`,
            }}
            locale={{ emptyText: '暂无应付，点击右上角「登记应付」创建' }}
          />
        </div>
        <div className="flex flex-col gap-3">
          <h3 className="text-base font-semibold">付款记录</h3>
          <Table
            columns={paymentColumns}
            dataSource={payments ?? []}
            rowKey="id"
            scroll={{ x: 1000, y: 300 }}
            pagination={{
              pageSize: 10,
              showTotal: (t: number) => `共 ${t} 条`,
            }}
            locale={{ emptyText: '暂无付款记录，点击右上角「付款申请」创建' }}
            size="small"
          />
        </div>
      </DataState>

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
                        {(suppliers ?? []).map((s) => (
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
                  control={apForm.control}
                  name="dueDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>到期日</FormLabel>
                      <FormControl>
                        <Input placeholder="YYYY-MM-DD" {...field} value={field.value ?? ''} />
                      </FormControl>
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
                <Button type="submit">保存</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={paymentOpen} onOpenChange={setPaymentOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>付款申请（需审批）</DialogTitle>
          </DialogHeader>
          <Form {...paymentForm}>
            <form onSubmit={onCreatePayment} className="space-y-4">
              <FormField
                control={paymentForm.control}
                name="apId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      应付 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择应付" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {unpaidAps.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.code} - {a.supplierName}（未付{' '}
                            {formatMoney(a.amount - a.paidAmount)}）
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
                  name="method"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>付款方式</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
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
              </div>
              <FormField
                control={paymentForm.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Input placeholder="备注" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit">提交</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={writeoffOpen} onOpenChange={setWriteoffOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>付款核销（支持部分核销）</DialogTitle>
          </DialogHeader>
          <Form {...writeoffForm}>
            <form onSubmit={onWriteoff} className="space-y-4">
              <FormField
                control={writeoffForm.control}
                name="apId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      应付 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择应付" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {unpaidAps.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.code} - {a.supplierName}（未付{' '}
                            {formatMoney(a.amount - a.paidAmount)}）
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
                name="paymentId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      已批准付款 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择付款记录" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {paidPayments.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.code} - {p.supplierName}（{formatMoney(p.amount)}）
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
      <Dialog open={vendorSettlementOpen} onOpenChange={setVendorSettlementOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>外协供应商结算</DialogTitle>
          </DialogHeader>
          <Form {...vendorSettlementForm}>
            <form onSubmit={onGenerateVendorSettlement} className="space-y-4">
              <div className="flex gap-4">
                <FormField
                  control={vendorSettlementForm.control}
                  name="supplierId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        供应商{' '}
                        <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择供应商" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(suppliers ?? []).map((s) => (
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
                <FormField
                  control={vendorSettlementForm.control}
                  name="period"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        月份{' '}
                        <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择月份" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {VENDOR_SETTLEMENT_PERIODS.map((p: string) => (
                            <SelectItem key={p} value={p}>
                              {p}
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
                  control={vendorSettlementForm.control}
                  name="projectId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>项目（可选）</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || undefined}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择项目" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(projects ?? []).map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={vendorSettlementForm.control}
                  name="dueDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>付款到期日</FormLabel>
                      <DateField value={field.value} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex flex-col gap-2">
                <h4 className="text-sm font-semibold">结算明细</h4>
                {previewLoading ? (
                  <DataState loading skeleton="table" />
                ) : !settlementPreview ? (
                  <p className="text-sm text-muted-foreground">
                    请选择供应商与月份后查看结算明细
                  </p>
                ) : settlementPreview.lines.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    该期间无已确认的外协工时
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Table
                      columns={vendorSettlementLineColumns}
                      dataSource={settlementPreview.lines}
                      rowKey="employeeId"
                      pagination={false}
                      size="small"
                      scroll={{ x: 600 }}
                    />
                    <div className="flex items-center justify-end gap-8 border-t pt-2 text-sm font-semibold">
                      <span>合计</span>
                      <span>{formatMoney(settlementPreview.totalAmount)}</span>
                    </div>
                  </div>
                )}
                {settlementPreview?.alreadyGenerated ? (
                  <p className="text-sm text-warning">
                    该供应商该期间结算单已生成
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button
                  type="submit"
                  disabled={
                    generating ||
                    previewLoading ||
                    !settlementPreview ||
                    settlementPreview.alreadyGenerated ||
                    settlementPreview.lines.length === 0
                  }
                >
                  生成结算单
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ApTab;
