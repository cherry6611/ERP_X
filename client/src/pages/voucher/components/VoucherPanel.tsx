import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Download, Plus, Trash2 } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import {
  VoucherStatusBadge,
  VOUCHER_SOURCE_LABELS,
  VOUCHER_STATUS_LABELS,
} from './VoucherBadges';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import DateField from '@client/src/components/erp/DateField';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { voucherApi } from '@client/src/api';
import * as financeReportsApi from '@client/src/api/finance-reports';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, currentPeriod, todayIso } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  AccountItem,
  AuxDimensionItem,
  CreateVoucherDto,
  CreateVoucherLineDto,
  PeriodStatus,
  VoucherAction,
  VoucherItem,
  VoucherLineAuxDto,
  VoucherLineItem,
} from '@shared/api.interface';

const round2 = (n: number): number => Math.round(n * 100) / 100;

const lineSchema = z.object({
  accountId: z.string().min(1, '请选择科目'),
  summary: z.string(),
  debit: z.string(),
  credit: z.string(),
  /** A-05：科目要求的辅助核算维度值（dimensionCode → dimensionValue） */
  aux: z.record(z.string(), z.string()),
});

const voucherSchema = z.object({
  voucherDate: z.string().min(1, '请选择凭证日期'),
  period: z.string().min(1, '请输入期间（YYYY-MM）'),
  summary: z.string().min(1, '请输入摘要'),
  remark: z.string(),
  lines: z.array(lineSchema).min(2, '至少需要两行分录'),
});

type VoucherFormData = z.infer<typeof voucherSchema>;

const EMPTY_LINES = (): {
  accountId: string;
  summary: string;
  debit: string;
  credit: string;
  aux: Record<string, string>;
}[] => [
  { accountId: '', summary: '', debit: '', credit: '', aux: {} },
  { accountId: '', summary: '', debit: '', credit: '', aux: {} },
];

const EMPTY_FORM: VoucherFormData = {
  voucherDate: todayIso(),
  period: currentPeriod(),
  summary: '',
  remark: '',
  lines: EMPTY_LINES(),
};

interface ConfirmTarget {
  voucher: VoucherItem;
  action: VoucherAction;
}

const PAGE_SIZE = 20;

const VOUCHER_EXPORT_COLUMNS: ExcelSheetColumn<VoucherItem>[] = [
  { header: '凭证编号', value: (row: VoucherItem) => row.code },
  { header: '日期', value: (row: VoucherItem) => row.voucherDate ?? '' },
  { header: '期间', value: (row: VoucherItem) => row.period },
  { header: '摘要', value: (row: VoucherItem) => row.summary ?? '' },
  {
    header: '来源',
    value: (row: VoucherItem) => VOUCHER_SOURCE_LABELS[row.sourceType] ?? row.sourceType,
  },
  {
    header: '状态',
    value: (row: VoucherItem) => VOUCHER_STATUS_LABELS[row.status] ?? row.status,
  },
  { header: '借方合计', value: (row: VoucherItem) => row.totalDebit },
  { header: '贷方合计', value: (row: VoucherItem) => row.totalCredit },
];

const VoucherPanel: React.FC = () => {
  const navigate = useNavigate();
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [periodFilter, setPeriodFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
    const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [operating, setOperating] = useState(false);
  // P1-3：表单内「错误提示」单列展示（后端 message 原样）
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsyncData(
    () =>
      voucherApi.listVouchers({
        page,
        pageSize: PAGE_SIZE,
        status: statusFilter !== 'all' ? statusFilter : undefined,
        period: periodFilter !== 'all' ? periodFilter : undefined,
        sourceType: sourceFilter !== 'all' ? sourceFilter : undefined,
      }),
    [page, statusFilter, periodFilter, sourceFilter],
  );

  const { data: periods } = useAsyncData<PeriodStatus[]>(
    () => voucherApi.listPeriods(),
    [],
  );

  const { data: accountsResult } = useAsyncData(
    () => voucherApi.listAccounts({ page: 1, pageSize: 500 }),
    [],
  );
  /**
   * P1-2：科目下拉只能选末级科目。
   * 后端对非末级（汇总）科目直接报错「不可直接做账」，前端不应先把非法项列出来，
   * 让用户选完再被拒。
   */
  const activeAccounts = (accountsResult?.items ?? []).filter(
    (a: AccountItem) => a.status === 'active' && a.isLeaf,
  );

  /** A-05：辅助核算维度定义（code → 名称） */
  const { data: auxDimensions } = useAsyncData<AuxDimensionItem[]>(
    () => financeReportsApi.listAuxDimensions(),
    [],
  );
  const auxNameByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const dim of auxDimensions ?? []) {
      if (dim.enabled) map.set(dim.code, dim.name);
    }
    return map;
  }, [auxDimensions]);

  const form = useForm<VoucherFormData>({
    resolver: zodResolver(voucherSchema),
    defaultValues: EMPTY_FORM,
  });
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'lines',
  });

  const watchedDate = form.watch('voucherDate');
  const watchedPeriod = form.watch('period');
  const watchedLines = form.watch('lines');

  /** 当前表单可能用到的辅助维度编码（已选科目要求挂的维度合集） */
  const requiredAuxCodes = useMemo(() => {
    const accountById = new Map(activeAccounts.map((a) => [a.id, a]));
    const codes = new Set<string>();
    for (const line of watchedLines ?? []) {
      const account = accountById.get(line.accountId);
      for (const code of account?.auxRequired ?? []) codes.add(code);
    }
    return [...codes].sort();
  }, [watchedLines, activeAccounts]);

  /**
   * A-05：辅助维度可选值（datalist 提示用）。
   * 取自本期已在用的取值；本期尚无数据时为空，输入框仍允许手录，
   * 不会因为“新期间没有历史值”而卡住录账。
   */
  const { data: auxValueHints } = useAsyncData(async () => {
    const map = new Map<string, string[]>();
    await Promise.all(
      requiredAuxCodes.map(async (code) => {
        try {
          const values = await financeReportsApi.getAuxDimensionValues({
            period: watchedPeriod || currentPeriod(),
            dimensionCode: code,
          });
          map.set(
            code,
            values
              .map((v) => v.dimensionValue)
              .filter((v) => v && v !== '（未指定）'),
          );
        } catch {
          map.set(code, []);
        }
      }),
    );
    return map;
  }, [requiredAuxCodes.join(','), watchedPeriod]);

  useEffect(() => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(watchedDate)) {
      form.setValue('period', watchedDate.slice(0, 7));
    }
  }, [watchedDate, form]);

  useEffect(() => {
    if (createOpen) {
      form.reset(EMPTY_FORM);
    }
  }, [createOpen, form]);

  const totalDebit = round2(
    (watchedLines ?? []).reduce(
      (sum: number, line: { debit: string }) => sum + Number(line.debit || 0),
      0,
    ),
  );
  const totalCredit = round2(
    (watchedLines ?? []).reduce(
      (sum: number, line: { credit: string }) => sum + Number(line.credit || 0),
      0,
    ),
  );

  const getLinesErrorMessage = (): string | null => {
    const err: unknown = form.formState.errors.lines;
    if (err && typeof err === 'object' && !Array.isArray(err)) {
      const { message } = err as { message?: unknown };
      if (typeof message === 'string' && message) return message;
    }
    return null;
  };

  /**
   * P1-2：把「科目必挂维度 → 输入值」转成后端入参（VoucherLineAuxDto[]）。
   * 只提交科目声明必挂的维度；空值不提交，由后端给出「要求填写辅助核算维度」的准确报错。
   */
  const buildLineAux = (
    accountId: string,
    aux: Record<string, string> | undefined,
  ): VoucherLineAuxDto[] | undefined => {
    const account = activeAccounts.find((a) => a.id === accountId);
    const items = (account?.auxRequired ?? [])
      .map((code) => ({
        dimensionCode: code,
        dimensionValue: (aux?.[code] ?? '').trim(),
      }))
      .filter((item) => item.dimensionValue.length > 0);
    return items.length > 0 ? items : undefined;
  };

  const onSubmit = form.handleSubmit(async (values) => {
    const lines: CreateVoucherLineDto[] = [];    for (let i = 0; i < values.lines.length; i += 1) {
      const line = values.lines[i];
      const debit = Number(line.debit || 0);
      const credit = Number(line.credit || 0);
      if (debit < 0 || credit < 0) {
        form.setError(`lines.${i}.debit`, { message: '金额不能为负数' });
        return;
      }
      if (debit > 0 && credit > 0) {
        form.setError(`lines.${i}.credit`, { message: '借方与贷方不能同时填写金额' });
        return;
      }
      if (debit === 0 && credit === 0) {
        form.setError(`lines.${i}.debit`, { message: '借方/贷方至少填写一个大于 0 的金额' });
        return;
      }
      lines.push({
        accountId: line.accountId,
        summary: line.summary || undefined,
        debit: debit > 0 ? round2(debit) : undefined,
        credit: credit > 0 ? round2(credit) : undefined,
        auxDimensions: buildLineAux(line.accountId, line.aux),
      });
    }
    if (Math.abs(totalDebit - totalCredit) > 0.001) {
      form.setError('lines', {
        type: 'manual',
        message: `借贷不平衡：借方合计 ${formatMoney(totalDebit)}，贷方合计 ${formatMoney(totalCredit)}`,
      });
      return;
    }
    const dto: CreateVoucherDto = {
      voucherDate: values.voucherDate,
      period: values.period,
      summary: values.summary,
      sourceType: 'manual',
      lines,
      remark: values.remark || undefined,
    };
    setOperating(true);
    setSubmitError(null);
    try {
      await voucherApi.createVoucher(dto);
      toast.success('手工凭证已创建');
      setCreateOpen(false);
      setPage(1);
      await reload();
    } catch (err) {
      // P1-3：原样透出后端 message，并在表单内单列一行「错误提示」
      const message = getApiErrorMessage(err, '创建凭证失败');
      setSubmitError(message);
      toast.error(message);
    } finally {
      setOperating(false);
    }
  });

  const handleExport = () => {
    const rows: VoucherItem[] = data?.items ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('凭证列表.xlsx', '凭证', VOUCHER_EXPORT_COLUMNS, rows);
  };

  const onConfirmAction = async () => {
    if (!confirmTarget) return;
    setOperating(true);
    try {
      await voucherApi.voucherAction(confirmTarget.voucher.id, confirmTarget.action);
      toast.success(
        confirmTarget.action === 'post' ? '凭证已过账' : '凭证已作废',
      );
      setConfirmTarget(null);
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    } finally {
      setOperating(false);
    }
  };

  const columns: TableColumnsType<VoucherItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '日期', dataIndex: 'voucherDate', width: 110, render: (v: string | null) => v ?? '-' },
    { title: '期间', dataIndex: 'period', width: 90 },
    { title: '摘要', dataIndex: 'summary', width: 200, render: (v: string | null) => v ?? '-' },
    {
      title: '来源类型',
      dataIndex: 'sourceType',
      width: 90,
      render: (v: string) => VOUCHER_SOURCE_LABELS[v] ?? v,
    },
    {
      title: '借方合计',
      dataIndex: 'totalDebit',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '贷方合计',
      dataIndex: 'totalCredit',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <VoucherStatusBadge status={v} />,
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 190,
      render: (_: unknown, record: VoucherItem) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => navigate(`/voucher/${record.id}`, { state: { item: record } })}>
            详情
          </Button>
          <CanCapabilityWrite capability="finance_write">
            {record.status === 'draft' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmTarget({ voucher: record, action: 'post' })}
              >
                过账
              </Button>
            ) : null}
            {record.status !== 'voided' ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => setConfirmTarget({ voucher: record, action: 'void' })}
              >
                作废
              </Button>
            ) : null}
          </CanCapabilityWrite>
        </div>
      ),
    },
  ];

  const lineColumns: TableColumnsType<VoucherLineItem> = [
    { title: '科目编码', dataIndex: 'accountCode', width: 120 },
    { title: '科目名称', dataIndex: 'accountName', width: 160 },
    { title: '摘要', dataIndex: 'summary', render: (v: string | null) => v ?? '-' },
    {
      title: '借方',
      dataIndex: 'debit',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '贷方',
      dataIndex: 'credit',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="voucher-status-filter">状态</Label>
            <Select
              value={statusFilter}
              onValueChange={(v: string) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger id="voucher-status-filter" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {Object.entries(VOUCHER_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="voucher-period-filter">期间</Label>
            <Select
              value={periodFilter}
              onValueChange={(v: string) => {
                setPeriodFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger id="voucher-period-filter" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部期间</SelectItem>
                {(periods ?? []).map((p: PeriodStatus) => (
                  <SelectItem key={p.period} value={p.period}>
                    {p.period}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="voucher-source-filter">来源类型</Label>
            <Select
              value={sourceFilter}
              onValueChange={(v: string) => {
                setSourceFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger id="voucher-source-filter" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部来源</SelectItem>
                {Object.entries(VOUCHER_SOURCE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleExport}>
            <Download className="h-4 w-4" />
            导出 Excel
          </Button>
          <CanCapabilityWrite capability="finance_write">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              新增手工凭证
            </Button>
          </CanCapabilityWrite>
        </div>
      </div>
      {error ? (
        <p className="text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reload()}>
            重试
          </Button>
        </p>
      ) : null}
      <Table
        columns={columns}
        dataSource={data?.items ?? []}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1300, y: 480 }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          onChange: (p: number) => setPage(p),
        }}
        locale={{ emptyText: '暂无凭证，手工新增或等待业务事件自动生成' }}
      />

      {/* 新增手工凭证 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>新增手工凭证</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="voucherDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        凭证日期 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <DateField value={field.value || undefined} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="period"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        期间 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="YYYY-MM" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="summary"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        摘要 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="请输入凭证摘要" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="remark"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>备注</FormLabel>
                      <FormControl>
                        <Input placeholder="请输入备注" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold">分录明细</span>
                  <span className="text-sm text-muted-foreground">
                    每行填写借方或贷方其一，提交前借贷合计必须相等
                  </span>
                </div>
                <div className="flex gap-2 text-sm text-muted-foreground">
                  <span className="w-56 shrink-0">科目</span>
                  <span className="flex-1">分录摘要</span>
                  <span className="w-28 shrink-0 text-right">借方</span>
                  <span className="w-28 shrink-0 text-right">贷方</span>
                  <span className="w-9 shrink-0" aria-hidden="true" />
                </div>
                {fields.map((field, index: number) => {
                  const account = activeAccounts.find(
                    (a: AccountItem) => a.id === (watchedLines[index]?.accountId ?? ''),
                  );
                  /** A-05：本行科目必挂的辅助核算维度 */
                  const requiredAux = account?.auxRequired ?? [];
                  return (
                  <React.Fragment key={field.id}>
                  <div className="flex items-start gap-2">
                    <FormField
                      control={form.control}
                      name={`lines.${index}.accountId`}
                      render={({ field: lineField }) => (
                        <FormItem className="w-56 shrink-0">
                          <Select onValueChange={lineField.onChange} value={lineField.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="请选择科目" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {activeAccounts.map((a: AccountItem) => (
                                <SelectItem key={a.id} value={a.id}>
                                  {a.code} {a.name}
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
                      name={`lines.${index}.summary`}
                      render={({ field: lineField }) => (
                        <FormItem className="flex-1">
                          <FormControl>
                            <Input placeholder="分录摘要（可选）" {...lineField} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`lines.${index}.debit`}
                      render={({ field: lineField }) => (
                        <FormItem className="w-28 shrink-0">
                          <FormControl>
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              placeholder="0.00"
                              {...lineField}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`lines.${index}.credit`}
                      render={({ field: lineField }) => (
                        <FormItem className="w-28 shrink-0">
                          <FormControl>
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              placeholder="0.00"
                              {...lineField}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="mt-0.5 shrink-0"
                      aria-label={`删除分录行 ${index + 1}`}
                      disabled={fields.length <= 2}
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  {/*
                    * P1-2：辅助核算维度输入。
                    * 科目在「科目表」声明了 auxRequired 时必须填写，否则后端直接 400；
                    * 这里按科目必挂维度渲染输入框，datalist 提供本期已在用的取值作为提示，
                    * 新期间无历史值时仍可手录。
                    */}
                  {requiredAux.length > 0 ? (
                    <div className="ml-0 flex flex-wrap items-center gap-2 pl-0">
                      {requiredAux.map((code) => {
                        const listId = `voucher-aux-hints-${index}-${code}`;
                        const hints = auxValueHints?.get(code) ?? [];
                        return (
                          <div key={code} className="flex items-center gap-1">
                            <Label
                              htmlFor={`voucher-aux-${index}-${code}`}
                              className="text-xs text-muted-foreground"
                            >
                              {auxNameByCode.get(code) ?? code}
                            </Label>
                            <Input
                              id={`voucher-aux-${index}-${code}`}
                              className="h-8 w-48"
                              list={hints.length > 0 ? listId : undefined}
                              placeholder={`请输入${auxNameByCode.get(code) ?? code}`}
                              value={watchedLines[index]?.aux?.[code] ?? ''}
                              onChange={(e) =>
                                form.setValue(
                                  `lines.${index}.aux.${code}`,
                                  e.target.value,
                                  { shouldDirty: true, shouldValidate: false },
                                )
                              }
                            />
                            {hints.length > 0 ? (
                              <datalist id={listId}>
                                {hints.map((hint) => (
                                  <option key={hint} value={hint} />
                                ))}
                              </datalist>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  </React.Fragment>
                  );
                })}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() =>
                    append({
                      accountId: '',
                      summary: '',
                      debit: '',
                      credit: '',
                      aux: {},
                    })
                  }
                >
                  <Plus className="h-4 w-4" />
                  添加分录行
                </Button>
                <p className="text-sm">
                  借方合计 <span className="font-medium">{formatMoney(totalDebit)}</span>
                  {'　'}贷方合计 <span className="font-medium">{formatMoney(totalCredit)}</span>
                  {Math.abs(totalDebit - totalCredit) > 0.001 ? (
                    <span className="ml-3 text-destructive">借贷不平衡</span>
                  ) : null}
                </p>
                {getLinesErrorMessage() ? (
                  <p className="text-sm text-destructive">{getLinesErrorMessage()}</p>
                ) : null}
                {submitError ? (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                  >
                    <span className="font-medium">错误提示：</span>
                    {submitError}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button type="submit" disabled={operating}>
                  创建凭证
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* 过账 / 作废确认 */}
      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setConfirmTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmTarget?.action === 'post' ? '确认过账' : '确认作废'}
            </DialogTitle>
            {confirmTarget ? (
              <DialogDescription>
                {confirmTarget.action === 'post'
                  ? `凭证 ${confirmTarget.voucher.code} 过账后将进入正式账簿，不可再修改分录。`
                  : `凭证 ${confirmTarget.voucher.code} 作废后将不再参与账簿汇总。`}
                确认继续吗？
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTarget(null)} disabled={operating}>
              取消
            </Button>
            <Button
              variant={confirmTarget?.action === 'void' ? 'destructive' : 'default'}
              disabled={operating}
              onClick={() => void onConfirmAction()}
            >
              {confirmTarget?.action === 'post' ? '确认过账' : '确认作废'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default VoucherPanel;
