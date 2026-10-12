import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Download, History, Plus, Upload } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import PageShell from '@client/src/components/PageShell';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import DateField from '@client/src/components/erp/DateField';
import ContractFormDialog from './ContractFormDialog';
import ContractDetailDialog from './ContractDetailDialog';
import { Badge } from '@client/src/components/ui/badge';
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
import { Textarea } from '@client/src/components/ui/textarea';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { contractsApi, feishuSyncApi, projectsApi } from '@client/src/api';
import FeishuSyncRecordsDialog from '@client/src/components/erp/FeishuSyncRecordsDialog';
import SimilarItemsDialog, {
  type SimilarTarget,
} from '@client/src/components/SimilarItemsDialog';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import {
  BILLING_MODEL_LABELS,
  CONTRACT_STATUS_LABELS,
} from '@client/src/utils/biz-labels';
import type {
  Contract,
  CreateProjectDto,
  PagedResult,
} from '@shared/api.interface';

const PAGE_SIZE = 20;

const TRANSFERABLE_STATUSES = ['active', 'performing', 'completed'];

const CONTRACT_EXPORT_COLUMNS: ExcelSheetColumn<Contract>[] = [
  { header: '合同编号', value: (row: Contract) => row.code },
  { header: '客户名称', value: (row: Contract) => row.customerName },
  { header: '合同名称', value: (row: Contract) => row.name },
  {
    header: '计费模式',
    value: (row: Contract) => BILLING_MODEL_LABELS[row.billingModel] ?? row.billingModel,
  },
  { header: '金额', value: (row: Contract) => row.amount },
  {
    header: '状态',
    value: (row: Contract) => CONTRACT_STATUS_LABELS[row.status] ?? row.status,
  },
  { header: '签订日期', value: (row: Contract) => row.signDate ?? '' },
  { header: '开始日期', value: (row: Contract) => row.startDate ?? '' },
  { header: '结束日期', value: (row: Contract) => row.endDate ?? '' },
  { header: '负责人', value: (row: Contract) => row.owner ?? '' },
];

const transferSchema = z.object({
  name: z.string().min(1, '请输入项目名称'),
  budget: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  pm: z.string(),
  deptName: z.string(),
  remark: z.string(),
});

type TransferFormData = z.infer<typeof transferSchema>;

const EMPTY_TRANSFER_FORM: TransferFormData = {
  name: '',
  budget: '',
  startDate: '',
  endDate: '',
  pm: '',
  deptName: '',
  remark: '',
};

const ContractsPage: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE);
  const [formOpen, setFormOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<Contract | null>(null);
  const [operating, setOperating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [similarTarget, setSimilarTarget] = useState<SimilarTarget | null>(null);

  const { data, loading, error, reload } = useAsyncData<PagedResult<Contract>>(
    () =>
      contractsApi.listContractsPaged(page, pageSize, {
        status: statusFilter !== 'all' ? statusFilter : undefined,
        keyword: keyword || undefined,
      }),
    [page, pageSize, statusFilter, keyword],
  );
  const items: Contract[] = data?.items ?? [];

  const transferForm = useForm<TransferFormData>({
    resolver: zodResolver(transferSchema),
    defaultValues: EMPTY_TRANSFER_FORM,
  });

  useEffect(() => {
    if (transferTarget) {
      transferForm.reset({
        name: transferTarget.name,
        budget: String(transferTarget.amount),
        startDate: transferTarget.startDate ?? '',
        endDate: transferTarget.endDate ?? '',
        pm: '',
        deptName: '',
        remark: '',
      });
    }
  }, [transferTarget, transferForm]);

  const onTransfer = transferForm.handleSubmit(async (values) => {
    if (!transferTarget) return;
    const budget: number = Number(values.budget || 0);
    if (!Number.isFinite(budget) || budget < 0) {
      transferForm.setError('budget', { message: '预算需为不小于 0 的数字' });
      return;
    }
    const dto: CreateProjectDto = {
      name: values.name,
      contractId: transferTarget.id,
      pm: values.pm || undefined,
      deptName: values.deptName || undefined,
      budget: values.budget ? budget : undefined,
      startDate: values.startDate || undefined,
      endDate: values.endDate || undefined,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      const created = await projectsApi.createProject(dto);
      toast.success(`已生成项目 ${created.code}`);
      setTransferTarget(null);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '合同转项目失败');
    } finally {
      setOperating(false);
    }
  });

  const handleSyncToBase = async () => {
    setSyncing(true);
    try {
      const result = await feishuSyncApi.syncContractsToBase();
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
    if (items.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('合同列表.xlsx', '合同', CONTRACT_EXPORT_COLUMNS, items);
  };

  const columns: TableColumnsType<Contract> = [
    { title: '合同编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '名称', dataIndex: 'name', width: 220 },
    { title: '客户', dataIndex: 'customerName', width: 160 },
    {
      title: '计费模式',
      dataIndex: 'billingModel',
      width: 110,
      render: (m: string) => (
        <Badge variant="secondary">{BILLING_MODEL_LABELS[m] ?? m}</Badge>
      ),
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '税率', dataIndex: 'taxRate', width: 80, render: (v: number) => `${v}%` },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={CONTRACT_STATUS_LABELS} />,
    },
    { title: '负责人', dataIndex: 'owner', width: 100, render: (v) => v ?? '-' },
    { title: '签订日期', dataIndex: 'signDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 200,
      render: (_, record) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setDetailId(record.id)}>
            详情
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`查找与 ${record.name} 相似的合同`}
            onClick={() =>
              setSimilarTarget({ id: record.id, code: record.code, name: record.name })
            }
          >
            找相似
          </Button>
          <CanRole roles={['admin']}>
            {TRANSFERABLE_STATUSES.includes(record.status) ? (
              <Button variant="ghost" size="sm" onClick={() => setTransferTarget(record)}>
                转项目
              </Button>
            ) : null}
          </CanRole>
        </div>
      ),
    },
  ];

  return (
    <PageShell title="合同管理" description="合同登记、审批状态机、里程碑、Call-off 下单与变更留痕">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="contract-status-filter">状态</Label>
          <Select
            value={statusFilter}
            onValueChange={(v: string) => {
              setStatusFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger id="contract-status-filter" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {Object.entries(CONTRACT_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Input
          aria-label="搜索合同"
          placeholder="搜索合同名称或编号"
          className="w-64"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setPage(1);
          }}
        />
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
        </Button>
        <Button
          variant="outline"
          disabled={syncing}
          onClick={() => void handleSyncToBase()}
          aria-label="同步合同到多维表格"
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
        <CanRole roles={['admin']}>
          <Button onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4" />
            登记合同
          </Button>
        </CanRole>
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
        dataSource={items}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1300, y: 500 }}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showTotal: (t: number) => `共 ${t} 条`,
          onChange: (p: number, s: number) => {
            setPage(p);
            setPageSize(s);
          },
        }}
        locale={{ emptyText: '暂无合同，登记新合同后开始管理' }}
      />
      <ContractFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        onCreated={(id: string) => {
          setDetailId(id);
          void reload();
        }}
      />
      <ContractDetailDialog
        contractId={detailId}
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      />
      <Dialog
        open={transferTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setTransferTarget(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>合同转项目</DialogTitle>
            <DialogDescription>
              将合同 {transferTarget?.code ?? ''} 立项为项目，生成后可在项目模块继续跟进。
            </DialogDescription>
          </DialogHeader>
          <Form {...transferForm}>
            <form className="flex flex-col gap-4" onSubmit={onTransfer}>
              <FormField
                control={transferForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>项目名称</FormLabel>
                    <FormControl>
                      <Input placeholder="项目名称" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={transferForm.control}
                  name="budget"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>预算</FormLabel>
                      <FormControl>
                        <Input type="number" min={0} step="0.01" placeholder="0.00" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={transferForm.control}
                  name="pm"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>负责人</FormLabel>
                      <FormControl>
                        <Input placeholder="负责人（可选）" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={transferForm.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>开始日期</FormLabel>
                      <DateField value={field.value || null} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={transferForm.control}
                  name="endDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>结束日期</FormLabel>
                      <DateField value={field.value || null} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={transferForm.control}
                name="deptName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>部门</FormLabel>
                    <FormControl>
                      <Input placeholder="部门（可选）" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={transferForm.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Textarea placeholder="备注（可选）" rows={2} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setTransferTarget(null)} disabled={operating}>
                  取消
                </Button>
                <Button type="submit" disabled={operating}>
                  生成项目
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      <FeishuSyncRecordsDialog
        open={recordsOpen}
        onOpenChange={setRecordsOpen}
        direction="outbound"
        bizType="contract"
      />
      <SimilarItemsDialog
        open={similarTarget !== null}
        onClose={() => setSimilarTarget(null)}
        type="contract"
        target={similarTarget}
        onPick={(item) => {
          setSimilarTarget(null);
          setDetailId(item.id);
        }}
      />
    </PageShell>
  );
};

export default ContractsPage;
