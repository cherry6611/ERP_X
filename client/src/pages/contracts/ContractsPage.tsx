import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Download, History, Plus, Upload } from 'lucide-react';
import { Table } from 'antd';
import ActionHelp from '@client/src/components/erp/ActionHelp';
import FilterBar from '@client/src/components/erp/FilterBar';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import DateField from '@client/src/components/erp/DateField';
import TaxEntityBanner from '@client/src/components/erp/TaxEntityBanner';
import { Button } from '@client/src/components/ui/button';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import { dialogSize } from '@client/src/theme/dialog-size';
import { useListQuery } from '@client/src/hooks/useListQuery';
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
import { exportRowsToXlsx } from '@client/src/components/excel/excel-utils';
import { contractsApi, feishuSyncApi, projectsApi } from '@client/src/api';
import FeishuSyncRecordsDialog from '@client/src/components/erp/FeishuSyncRecordsDialog';
import SimilarItemsDialog, {
  type SimilarTarget,
} from '@client/src/components/SimilarItemsDialog';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { CONTRACT_STATUS_LABELS } from '@client/src/utils/biz-labels';
import type {
  Contract,
  CreateProjectDto,
  PagedResult,
} from '@shared/api.interface';
import { contractListColumns } from './components/contract-list-columns';
import ContractQuickViewDrawer from './components/ContractQuickViewDrawer';
import ContractFormDialog from './ContractFormDialog';
/* §5.9：导出行定义与转项目表单模型已拆到独立模块（可单测） */
import { CONTRACT_EXPORT_COLUMNS } from './contract-export-columns';
import {
  EMPTY_TRANSFER_FORM,
  transferSchema,
  type TransferFormData,
} from './contract-transfer-form';

const PAGE_SIZE = 20;

const ContractsPage: React.FC = () => {
  const navigate = useNavigate();
  const { q, setQ, debouncedQ, page, setPage, debouncing } = useListQuery();
  const [statusFilter, setStatusFilter] = useState('all');
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE);
  const [transferTarget, setTransferTarget] = useState<Contract | null>(null);
  const [operating, setOperating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncConfirm, setSyncConfirm] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [similarTarget, setSimilarTarget] = useState<SimilarTarget | null>(null);
  /*
   * 「编辑合同」弹窗状态。
   *
   * `editTarget` 与 `editOpen` 分开（而不是只用 `editTarget !== null` 当开关）：
   * 关闭时**保留** editTarget，弹窗的 `key` 才不变，Radix 的退场动画（`data-[state=closed]:animate-out`）
   * 才有机会播完；若关闭即清空目标，组件会在同一帧被卸载，弹窗是"啪"地消失的。
   *
   * `editSeq` 每次打开自增并参与 `key`：**连点同一行的「编辑」也会重新挂载弹窗**，
   * 于是表单在该行现值上重新播种，而不是留着上次没保存的改动。
   * 详见 `ContractFormDialog.tsx` 文件头的「表单播种时机」。
   */
  const [editTarget, setEditTarget] = useState<Contract | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editSeq, setEditSeq] = useState(0);
  const [quickViewId, setQuickViewId] = useState<string | null>(null);

  /** 行内「编辑」的触发点：同一事件里写目标 + 递增 key + 打开，故首帧就是该行的值 */
  const openContractEdit = (record: Contract) => {
    setEditTarget(record);
    setEditSeq((n) => n + 1);
    setEditOpen(true);
  };

  const { data, loading, error, reload } = useAsyncData<PagedResult<Contract>>(
    () =>
      contractsApi.listContractsPaged(page, pageSize, {
        status: statusFilter !== 'all' ? statusFilter : undefined,
        keyword: debouncedQ || undefined,
      }),
    [page, pageSize, statusFilter, debouncedQ],
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
      toast.error(getApiErrorMessage(err, '合同转项目失败'));
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

  /*
   * §5.9（F8）：列定义已移到 `./components/contract-list-columns.tsx`（`render` 里是 JSX，
   * 故不能进零 React 依赖的模型模块）。
avigate`、两个 setter 与 `onEdit` 以**同名入参**
   * 传入，`render` 体除新增的「编辑」按钮外逐字未动。
   */
  const columns = contractListColumns({
    navigate,
    setSimilarTarget,
    setTransferTarget,
    onEdit: openContractEdit,
    onQuickView: (record) => setQuickViewId(record.id),
  });

  return (
    <PageShell
      title="合同管理"
      description="合同登记、审批状态机、里程碑、Call-off 下单与变更留痕"
      actions={
        /*
         * 三个会改变数据的动作归页头 `actions`：
         *   · 登记合同     —— 新建流程入口
         *   · 同步到多维表格 —— 写外部系统（飞书多维表格）
         *   · 同步记录     —— 同步动作的配套查看入口
         * 「导出 Excel」是对当前筛选结果的只读工具，留在筛选行。
         */
        <>
          <CanCapabilityWrite capability="projects_write">
            <Button onClick={() => navigate('/contracts/new')}>
              <Plus className="h-4 w-4" />
              登记合同
            </Button>
          </CanCapabilityWrite>
          <CanCapabilityWrite capability="projects_write">
            <Button
              variant="outline"
              disabled={syncing}
              onClick={() => setSyncConfirm(true)}
              aria-label="同步合同到多维表格"
            >
              <Upload className="h-4 w-4" />
              {syncing ? '同步中…' : '同步到多维表格'}
            </Button>
          </CanCapabilityWrite>
          <Button
            variant="outline"
            onClick={() => setRecordsOpen(true)}
            aria-label="查看同步记录"
          >
            <History className="h-4 w-4" />
            同步记录
          </Button>
          <ActionHelp title="同步与同步记录">
            同步会把合同写入飞书多维表格，已同步成功的记录自动跳过；同步记录可查看最近结果。
          </ActionHelp>
        </>
      }
    >
      <TaxEntityBanner />
      <FilterBar>
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
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {debouncing ? (
          <span className="text-xs text-muted-foreground">筛选中…</span>
        ) : null}
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
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
          dataSource={items}
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
      </DataState>
      <Dialog
        open={transferTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setTransferTarget(null);
        }}
      >
        <DialogContent className={dialogSize.lg}>
          <DialogHeader>
            <DialogTitle>合同转项目</DialogTitle>
            <DialogDescription>
              将合同 {transferTarget?.code ?? ''} 立项为项目，生成后可在项目模块继续跟进。
            </DialogDescription>
          </DialogHeader>
          <Form {...transferForm}>
            <form className="flex flex-col gap-4" onSubmit={onTransfer}>
              <Tabs defaultValue="base">
                <TabsList>
                  <TabsTrigger value="base">基本信息</TabsTrigger>
                  <TabsTrigger value="plan">周期与备注</TabsTrigger>
                </TabsList>
                <TabsContent value="base" className="flex flex-col gap-4">
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
                </TabsContent>
                <TabsContent value="plan" className="flex flex-col gap-4">
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
                </TabsContent>
              </Tabs>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setTransferTarget(null)} disabled={operating}>
                  取消
                </Button>
                <Button type="submit" disabled={operating}>
                  {operating ? '生成中…' : '生成项目'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={syncConfirm} onOpenChange={setSyncConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>同步到多维表格</AlertDialogTitle>
            <AlertDialogDescription>
              将把合同数据写入飞书多维表格。已同步成功的记录会跳过。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleSyncToBase()}>确认同步</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
          navigate(`/contracts/${item.id}`);
        }}
      />
      {/*
        * 「编辑合同」：`key` 里的 `editSeq` 保证每次打开都重新挂载并**按该行现值播种**表单
        * （不要删这个 key —— 否则编辑同一行两次会留着上次未保存的改动；理由见
        * `ContractFormDialog.tsx` 文件头）。
        * 新建仍走独立路由 `/contracts/new`（`ContractCreatePage`），此处只服务编辑。
        */}
      <ContractFormDialog
        key={`contract-edit-${editSeq}`}
        open={editOpen}
        editTarget={editTarget}
        onOpenChange={setEditOpen}
        onUpdated={() => {
          setEditOpen(false);
          void reload();
        }}
      />
      <ContractQuickViewDrawer
        contractId={quickViewId}
        open={quickViewId !== null}
        onOpenChange={(open) => {
          if (!open) setQuickViewId(null);
        }}
      />
    </PageShell>
  );
};

export default ContractsPage;




