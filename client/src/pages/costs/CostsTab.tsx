import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import type { LucideIcon } from 'lucide-react';
import {
  Briefcase,
  Clock,
  Cpu,
  Download,
  HardDrive,
  History,
  Paperclip,
  Plane,
  Plus,
  Sigma,
  Upload,
  Users,
  Wrench,
} from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import DateField from '@client/src/components/erp/DateField';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import { DataState } from '@client/src/components/DataState';
import FilterBar from '@client/src/components/erp/FilterBar';
import StatCard from '@client/src/components/erp/StatCard';
import { Button } from '@client/src/components/ui/button';
import { dialogSize } from '@client/src/theme/dialog-size';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@client/src/components/ui/alert-dialog';
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
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { costsApi, feishuSyncApi, projectsApi } from '@client/src/api';
import FeishuSyncRecordsDialog from '@client/src/components/erp/FeishuSyncRecordsDialog';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { useListQuery } from '@client/src/hooks/useListQuery';
import { formatMoney } from '@client/src/utils/format';
import { COST_TYPE_LABELS } from '@client/src/utils/biz-labels';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import type { CostItem, CostType, CreateCostDto, Project } from '@shared/api.interface';

const COST_TYPE_ICONS: Record<string, LucideIcon> = {
  labor: Users,
  outsource: Briefcase,
  compute: Cpu,
  storage: HardDrive,
  tool: Wrench,
  travel: Plane,
  flex_labor: Clock,
};

const COST_TYPE_TONES: Record<string, 'primary' | 'success' | 'warning' | 'info' | 'neutral'> = {
  labor: 'primary',
  flex_labor: 'primary',
  outsource: 'info',
  compute: 'info',
  tool: 'info',
  storage: 'neutral',
  travel: 'warning',
};

const COST_EXPORT_COLUMNS: ExcelSheetColumn<CostItem>[] = [
  { header: '成本编号', value: (row: CostItem) => row.code },
  { header: '项目', value: (row: CostItem) => row.projectName },
  {
    header: '成本类型',
    value: (row: CostItem) => COST_TYPE_LABELS[row.costType] ?? row.costType,
  },
  { header: '金额', value: (row: CostItem) => row.amount },
  { header: '期间', value: (row: CostItem) => row.period },
  { header: '发生日期', value: (row: CostItem) => row.occurredDate ?? '' },
  { header: '来源摘要', value: (row: CostItem) => row.sourceRef },
  { header: '供应商', value: (row: CostItem) => row.supplierName ?? '' },
];

const costSchema = z.object({
  projectId: z.string().min(1, '请选择项目'),
  costType: z.string().min(1, '请选择成本类型'),
  amount: z.coerce.number().min(1, '金额必须大于 0'),
  sourceRef: z.string().min(1, '请填写来源摘要'),
  remark: z.string(),
});

type CostFormData = z.output<typeof costSchema>;
type CostFormInput = z.input<typeof costSchema>;

const CostsTab: React.FC = () => {
  const { q, setQ, debouncedQ, debouncing } = useListQuery();
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncConfirm, setSyncConfirm] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [attachmentTarget, setAttachmentTarget] = useState<CostItem | null>(null);

  const { data, loading, error, reload } = useAsyncData<CostItem[]>(
    () =>
      costsApi.listCosts(
        projectFilter !== 'all' ? projectFilter : undefined,
        typeFilter !== 'all' ? typeFilter : undefined,
      ),
    [projectFilter, typeFilter],
  );
  const filteredData = React.useMemo(() => {
    const rows = data ?? [];
    const needle = debouncedQ.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => {
      const haystack = [
        row.code,
        row.projectName,
        row.sourceRef,
        row.supplierName,
        row.remark,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [data, debouncedQ]);
  const { data: summary } = useAsyncData(() => costsApi.getCostSummary(), []);
  const { data: projects } = useAsyncData<Project[]>(() => projectsApi.listProjects(), []);

  const form = useForm<CostFormInput, unknown, CostFormData>({
    resolver: zodResolver(costSchema),
    defaultValues: { projectId: '', costType: 'compute', amount: 0, sourceRef: '', remark: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateCostDto = {
      projectId: values.projectId,
      costType: values.costType as CostType,
      amount: values.amount,
      sourceRef: values.sourceRef,
      remark: values.remark || undefined,
    };
    try {
      await costsApi.createCost(dto);
      toast.success('成本已归集');
      setCreateOpen(false);
      form.reset({ projectId: '', costType: 'compute', amount: 0, sourceRef: '', remark: '' });
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '归集失败'));
    }
  });

  const handleSyncToBase = async () => {
    setSyncing(true);
    try {
      const result = await feishuSyncApi.syncCostsToBase();
      if (result.failed > 0) {
        toast.error(result.message);
      } else {
        toast.success(result.message);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, '同步多维表格失败'));
    } finally {
      setSyncing(false);
    }
  };

  const handleExport = () => {
    const rows: CostItem[] = filteredData;
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('成本列表.xlsx', '成本', COST_EXPORT_COLUMNS, rows);
  };

  const columns: TableColumnsType<CostItem> = [
    { title: '成本编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '项目', dataIndex: 'projectName', width: 180 },
    {
      title: '成本类型',
      dataIndex: 'costType',
      width: 100,
      render: (t: string) => COST_TYPE_LABELS[t] ?? t,
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 140,
      align: 'right',
      render: (v: number, record) => (
        <div className="text-right">
          <div>{formatMoney(v)}</div>
          <div className="text-xs text-muted-foreground">
            {record.costType === 'labor' || record.costType === 'flex_labor'
              ? '不含税'
              : '含税'}
          </div>
        </div>
      ),
    },
    { title: '期间', dataIndex: 'period', width: 90 },
    { title: '发生日期', dataIndex: 'occurredDate', width: 110, render: (v) => v ?? '-' },
    { title: '来源摘要', dataIndex: 'sourceRef', width: 200 },
    { title: '供应商', dataIndex: 'supplierName', width: 140, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 90,
      render: (_, record) => (
        <Button variant="ghost" size="sm" onClick={() => setAttachmentTarget(record)}>
          <Paperclip className="h-4 w-4" />
          凭证
        </Button>
      ),
    },
  ];

  const totalAmount = (summary ?? []).reduce((acc: number, item) => acc + item.amount, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-4 gap-4">
        {(summary ?? []).map((item) => {
          const Icon = COST_TYPE_ICONS[item.costType];
          return (
            <StatCard
              key={item.costType}
              label={COST_TYPE_LABELS[item.costType] ?? item.costType}
              value={formatMoney(item.amount)}
              icon={Icon}
              tone={COST_TYPE_TONES[item.costType] ?? 'neutral'}
            />
          );
        })}
        <StatCard
          label="合计"
          value={formatMoney(totalAmount)}
          icon={Sigma}
          tone="neutral"
          hint="全部成本类型汇总"
        />
      </div>
      <FilterBar>
        <div className="flex items-center gap-2">
          <Label htmlFor="cost-project-filter">项目</Label>
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger id="cost-project-filter" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部项目</SelectItem>
              {(projects ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="cost-keyword">搜索</Label>
          <Input
            id="cost-keyword"
            className="w-56"
            placeholder="编号 / 项目 / 摘要…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {debouncing ? (
            <span className="text-xs text-muted-foreground">筛选中…</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="cost-type-filter">类型</Label>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger id="cost-type-filter" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              {Object.entries(COST_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CanCapabilityWrite capability="projects_write">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            归集成本
          </Button>
        </CanCapabilityWrite>
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
        </Button>
        <Button
          variant="outline"
          disabled={syncing}
          onClick={() => setSyncConfirm(true)}
          aria-label="同步成本到多维表格"
        >
          <Upload className="h-4 w-4" />
          {syncing ? '同步中…' : '同步到多维表格'}
        </Button>
        <Button
          variant="outline"
          onClick={() => setRecordsOpen(true)}
          aria-label="查看同步记录"
        >
          <History className="h-4 w-4" />
          同步记录
        </Button>
      </FilterBar>
      <DataState
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          columns={columns}
          dataSource={filteredData}
          rowKey="id"
          scroll={{ x: 1200, y: 500 }}
          pagination={{
            pageSize: 10,
            showTotal: (total: number) => `共 ${total} 条`,
          }}
          locale={{ emptyText: '暂无成本，点击右上角「归集成本」创建' }}
        />
      </DataState>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className={dialogSize.md}>
          <DialogHeader>
            <DialogTitle>归集成本</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="projectId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      项目 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
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
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="costType"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        成本类型 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(COST_TYPE_LABELS).map(([value, label]) => (
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
                  render={({ field }) => {
                    const costType = form.watch('costType');
                    const isLabor =
                      costType === 'labor' || costType === 'flex_labor';
                    return (
                      <FormItem className="flex-1">
                        <FormLabel>
                          {isLabor ? '金额（不含税）' : '金额（含税）'}{' '}
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
                    );
                  }}
                />
              </div>
              <FormField
                control={form.control}
                name="sourceRef"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      来源摘要 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：10 月云资源账单" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
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

      <FeishuSyncRecordsDialog
        open={recordsOpen}
        onOpenChange={setRecordsOpen}
        direction="outbound"
        bizType="cost"
      />

      <Dialog
        open={attachmentTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setAttachmentTarget(null);
        }}
      >
        <DialogContent className={dialogSize.md}>
          <DialogHeader>
            <DialogTitle>
              成本凭证 -{' '}
              {attachmentTarget
                ? `${formatMoney(attachmentTarget.amount)} · ${
                    COST_TYPE_LABELS[attachmentTarget.costType] ?? attachmentTarget.costType
                  }`
                : ''}
            </DialogTitle>
          </DialogHeader>
          {attachmentTarget ? (
            <AttachmentField
              resourceType="erp_project_cost"
              resourceId={attachmentTarget.id}
              usageHint="发票、结算单、成本明细表格等凭证"
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <AlertDialog open={syncConfirm} onOpenChange={setSyncConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>同步到多维表格</AlertDialogTitle>
            <AlertDialogDescription>
              将把成本数据写入飞书多维表格。已同步成功的记录会跳过。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleSyncToBase()}>确认同步</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default CostsTab;
