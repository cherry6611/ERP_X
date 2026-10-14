import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Download, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import { SectionTitle } from '@client/src/components/SectionTitle';
import StatusBadge from '@client/src/components/erp/StatusBadge';
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
import { contractsApi, financeApi, masterDataApi } from '@client/src/api';
import { PrintButton } from '@client/src/components/print';
import { compactFields, metaField } from '@client/src/components/print';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { formatMoney } from '@client/src/utils/format';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  ArItem,
  ArWriteoffDto,
  Contract,
  CreateArDto,
  CreateReceiptDto,
  Customer,
  ReceiptItem,
} from '@shared/api.interface';

const AR_STATUS_LABELS: Record<string, string> = {
  open: '未核销',
  partial: '部分核销',
  settled: '已结清',
};

/** C-06 回款单打印用状态文案 */
const RECEIPT_STATUS_LABELS: Record<string, string> = {
  unmatched: '未核销',
  partial: '部分核销',
  matched: '已核销',
  voided: '已作废',
};

const AR_EXPORT_COLUMNS: ExcelSheetColumn<ArItem>[] = [
  { header: '应收编号', value: (row: ArItem) => row.code },
  { header: '客户', value: (row: ArItem) => row.customerName },
  { header: '合同', value: (row: ArItem) => row.contractName },
  { header: '应收金额（含税）', value: (row: ArItem) => row.amount },
  { header: '已核销', value: (row: ArItem) => row.settledAmount },
  {
    header: '未核销',
    value: (row: ArItem) => row.amount - row.settledAmount,
  },
  { header: '到期日', value: (row: ArItem) => row.dueDate ?? '' },
  {
    header: '状态',
    value: (row: ArItem) => AR_STATUS_LABELS[row.status] ?? row.status,
  },
  { header: '逾期', value: (row: ArItem) => (row.overdue ? '是' : '否') },
];

const arSchema = z.object({
  contractId: z.string().min(1, '请选择合同'),
  amount: z.coerce.number().min(1, '应收金额必须大于 0'),
  dueDate: z.string().optional(),
  remark: z.string(),
});

type ArFormData = z.output<typeof arSchema>;
type ArFormInput = z.input<typeof arSchema>;

const receiptSchema = z.object({
  customerId: z.string().min(1, '请选择客户'),
  amount: z.coerce.number().min(1, '回款金额必须大于 0'),
  method: z.string(),
  remark: z.string(),
});

type ReceiptFormData = z.output<typeof receiptSchema>;
type ReceiptFormInput = z.input<typeof receiptSchema>;

const writeoffSchema = z.object({
  arId: z.string().min(1, '请选择应收'),
  receiptId: z.string().min(1, '请选择回款'),
  amount: z.coerce.number().min(0.01, '核销金额必须大于 0'),
});

type WriteoffFormData = z.output<typeof writeoffSchema>;
type WriteoffFormInput = z.input<typeof writeoffSchema>;

const ArTab: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState('all');
  const [arOpen, setArOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [writeoffOpen, setWriteoffOpen] = useState(false);

  const { data: ars, loading, error, reload } = useAsyncData<ArItem[]>(
    () => financeApi.listArs(undefined, statusFilter !== 'all' ? statusFilter : undefined),
    [statusFilter],
  );
  const { data: receipts, reload: reloadReceipts } = useAsyncData<ReceiptItem[]>(
    () => financeApi.listReceipts(),
    []
  );
  const { data: contracts } = useAsyncData<Contract[]>(() => contractsApi.listContracts(), []);
  const { data: customers } = useAsyncData<Customer[]>(
    () => masterDataApi.listCustomers(),
    [],
  );

  const arForm = useForm<ArFormInput, unknown, ArFormData>({
    resolver: zodResolver(arSchema),
    defaultValues: { contractId: '', amount: 0, remark: '' },
  });
  const receiptForm = useForm<ReceiptFormInput, unknown, ReceiptFormData>({
    resolver: zodResolver(receiptSchema),
    defaultValues: { customerId: '', amount: 0, method: 'bank', remark: '' },
  });
  const writeoffForm = useForm<WriteoffFormInput, unknown, WriteoffFormData>({
    resolver: zodResolver(writeoffSchema),
    defaultValues: { arId: '', receiptId: '', amount: 0 },
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
      setArOpen(false);
      arForm.reset({ contractId: '', amount: 0, remark: '' });
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '登记失败'));
    }
  });

  const onCreateReceipt = receiptForm.handleSubmit(async (values) => {
    const dto: CreateReceiptDto = {
      customerId: values.customerId,
      amount: values.amount,
      method: values.method,
      remark: values.remark || undefined,
    };
    try {
      await financeApi.createReceipt(dto);
      toast.success('回款已登记');
      setReceiptOpen(false);
      receiptForm.reset({ customerId: '', amount: 0, method: 'bank', remark: '' });
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '登记失败'));
    }
  });

  const onWriteoff = writeoffForm.handleSubmit(async (values) => {
    const dto: ArWriteoffDto = {
      arId: values.arId,
      receiptId: values.receiptId,
      amount: values.amount,
    };
    try {
      await financeApi.arWriteoff(dto);
      toast.success('核销成功');
      setWriteoffOpen(false);
      writeoffForm.reset({ arId: '', receiptId: '', amount: 0 });
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '核销失败'));
    }
  });

  const openArItems = (ars ?? []).filter((a) => a.status !== 'settled');

  const handleExport = () => {
    const rows: ArItem[] = ars ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('应收列表.xlsx', '应收', AR_EXPORT_COLUMNS, rows);
  };

  const arColumns: TableColumnsType<ArItem> = [
    { title: '应收编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '客户', dataIndex: 'customerName', width: 160 },
    { title: '合同', dataIndex: 'contractName', width: 180 },
    {
      title: '应收金额（含税）',
      dataIndex: 'amount',
      width: 140,
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
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={AR_STATUS_LABELS} />,
    },
    {
      title: '逾期',
      dataIndex: 'overdue',
      width: 70,
      render: (v: boolean) =>
        v ? <span className="text-destructive font-medium">逾期</span> : '-',
    },
  ];

  const receiptColumns: TableColumnsType<ReceiptItem> = [
    { title: '回款编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '客户', dataIndex: 'customerName', width: 160 },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '回款日期', dataIndex: 'receiptDate', width: 110, render: (v) => v ?? '-' },
    { title: '方式', dataIndex: 'method', width: 100, render: (v) => v ?? '-' },
    { title: '来源', dataIndex: 'source', width: 140, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_, record) => (
        <div className="flex gap-1">
          {/* C-06：回款单（收据）打印；作废件仍可补打留档 */}
          <PrintButton
            variant="ghost"
            label="打印"
            stopPropagation
            build={() => ({
              kind: 'receipt',
              code: record.code,
              title: '回款单（收据）',
              subtitle: `回款编号：${record.code}`,
              meta: compactFields([
                metaField('客户', record.customerName),
                metaField('回款日期', record.receiptDate),
                metaField('回款方式', record.method),
                metaField('来源', record.source),
                metaField(
                  '状态',
                  RECEIPT_STATUS_LABELS[record.status] ?? record.status,
                ),
              ]),
              totals: [
                {
                  label: '回款金额（小写）',
                  amount: record.amount,
                  inWords: true,
                  emphasize: true,
                },
              ],
              clauses: [
                record.remark ? `备注：${record.remark}` : '',
                '本收据以银行到账为准，如有差异请于 7 个工作日内联系财务。',
              ].filter(Boolean),
              signatures: [
                { slot: 'prepared', label: '收款经办', signer: null },
                { slot: 'reviewed', label: '财务复核', signer: null },
                { slot: 'chief_accountant', label: '财务主管', signer: null },
              ],
              sourceNote: '数据来源：应收回款台账',
            })}
          />
          {record.status !== 'voided' ? (
            <CanCapability capability="finance_write">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const ok = await confirmDanger(
                      `确认作废回款 ${record.code ?? record.id}？此操作不可恢复。`,
                    );
                    if (!ok) return;
                    try {
                      await financeApi.voidReceipt(record.id);
                      toast.success('回款已作废');
                      await Promise.all([reload(), reloadReceipts()]);
                    } catch (err: unknown) {
                      toast.error(getApiErrorMessage(err, '作废失败'));
                    }
                  })();
                }}
              >
                作废
              </Button>
            </CanCapability>
          ) : null}
        </div>
      ),
    },
  ];

  const receiptOptions = (receipts ?? []).filter((r) => r.status !== 'matched');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">状态</span>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger id="ar-status-filter" className="w-32" aria-label="应收状态筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {Object.entries(AR_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CanCapability capability="finance_write">
          <Button onClick={() => setArOpen(true)}>
            <Plus className="h-4 w-4" />
            登记应收
          </Button>
        </CanCapability>
        <CanCapability capability="finance_write">
          <Button variant="outline" onClick={() => setReceiptOpen(true)}>
            <Plus className="h-4 w-4" />
            登记回款
          </Button>
        </CanCapability>
        <CanCapability capability="finance_write">
          <Button variant="outline" onClick={() => setWriteoffOpen(true)}>
            回款核销
          </Button>
        </CanCapability>
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
          <SectionTitle>应收账款</SectionTitle>
          <Table
            columns={arColumns}
            dataSource={ars ?? []}
            rowKey="id"
            scroll={{ x: 1200, y: 400 }}
            pagination={{
              pageSize: 10,
              showTotal: (t: number) => `共 ${t} 条`,
            }}
            locale={{ emptyText: '暂无应收，点击右上角「登记应收」创建' }}
          />
        </div>
        <div className="flex flex-col gap-3">
          <SectionTitle>回款记录</SectionTitle>
          <Table
            columns={receiptColumns}
            dataSource={receipts ?? []}
            rowKey="id"
            scroll={{ x: 800, y: 300 }}
            pagination={{
              pageSize: 10,
              showTotal: (t: number) => `共 ${t} 条`,
            }}
            locale={{ emptyText: '暂无回款，点击右上角「登记回款」创建' }}
            size="small"
          />
        </div>
      </DataState>

      <Dialog open={arOpen} onOpenChange={setArOpen}>
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

      <Dialog open={receiptOpen} onOpenChange={setReceiptOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>登记回款</DialogTitle>
          </DialogHeader>
          <Form {...receiptForm}>
            <form onSubmit={onCreateReceipt} className="space-y-4">
              <FormField
                control={receiptForm.control}
                name="customerId"
                render={({ field }) => (
                  <FormItem>
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
                  name="method"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>回款方式</FormLabel>
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
                control={receiptForm.control}
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
                <Button type="submit">保存</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={writeoffOpen} onOpenChange={setWriteoffOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>回款核销（支持部分核销）</DialogTitle>
          </DialogHeader>
          <Form {...writeoffForm}>
            <form onSubmit={onWriteoff} className="space-y-4">
              <FormField
                control={writeoffForm.control}
                name="arId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      应收 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择应收" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {openArItems.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.code} - {a.customerName}（未核销{' '}
                            {formatMoney(a.amount - a.settledAmount)}）
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
                name="receiptId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      回款 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择回款" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {receiptOptions.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.code} - {r.customerName}（{formatMoney(r.amount)}）
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
    </div>
  );
};

export default ArTab;
