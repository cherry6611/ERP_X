import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import {
  AssetStatusBadge,
  ASSET_CATEGORY_LABELS,
  ASSET_STATUS_LABELS,
} from './AssetStatusBadge';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { Textarea } from '@client/src/components/ui/textarea';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import DateField from '@client/src/components/erp/DateField';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import { assetApi, hrApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, formatNumber } from '@client/src/utils/format';
import type {
  AssetItem,
  AssetOverview,
  CreateAssetChangeDto,
  CreateAssetDto,
  Department,
  Project,
} from '@shared/api.interface';

const assetFormSchema = z.object({
  name: z.string().min(1, '请填写资产名称'),
  category: z.string().min(1, '请选择资产类别'),
  originalValue: z.coerce.number().positive('原值必须大于 0'),
  residualValue: z.coerce.number().min(0, '残值不能为负'),
  usefulMonths: z.coerce.number().int().min(1, '折旧月数至少为 1'),
  departmentId: z.string(),
  projectId: z.string(),
  purchaseDate: z.string(),
  remark: z.string(),
});

const changeFormSchema = z.object({
  assetId: z.string().min(1, '请选择资产'),
  changeType: z.string().min(1, '请选择变更类型'),
  afterValue: z.string(),
  remark: z.string(),
});

const EMPTY_ASSET_FORM = {
  name: '',
  category: 'server_gpu',
  originalValue: 0,
  residualValue: 0,
  usefulMonths: 36,
  departmentId: '',
  projectId: '',
  purchaseDate: '',
  remark: '',
};

const EMPTY_CHANGE_FORM = {
  assetId: '',
  changeType: '',
  afterValue: '',
  remark: '',
};

const PAGE_SIZE = 20;

const StatCard: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <div className="rounded-lg border bg-card p-4">
    <p className="text-sm text-muted-foreground">{label}</p>
    <p className="text-lg font-semibold">{value}</p>
  </div>
);

const AssetPanel: React.FC = () => {
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData(
    () =>
      assetApi.listAssets({
        page,
        pageSize: PAGE_SIZE,
        status: statusFilter !== 'all' ? statusFilter : undefined,
        category: categoryFilter !== 'all' ? categoryFilter : undefined,
        projectId: projectFilter !== 'all' ? projectFilter : undefined,
      }),
    [page, statusFilter, categoryFilter, projectFilter],
  );

  const {
    data: overview,
    reload: reloadOverview,
  } = useAsyncData<AssetOverview>(() => assetApi.getOverview(), []);

  const { data: departments } = useAsyncData<Department[]>(
    () => hrApi.listDepartments(),
    [],
  );
  const { data: projects } = useAsyncData<Project[]>(
    () => projectsApi.listProjects(),
    [],
  );

  const createForm = useForm<
    z.input<typeof assetFormSchema>,
    unknown,
    z.output<typeof assetFormSchema>
  >({
    resolver: zodResolver(assetFormSchema),
    defaultValues: EMPTY_ASSET_FORM,
  });

  const changeForm = useForm<
    z.input<typeof changeFormSchema>,
    unknown,
    z.output<typeof changeFormSchema>
  >({
    resolver: zodResolver(changeFormSchema),
    defaultValues: EMPTY_CHANGE_FORM,
  });

  const onCreateSubmit = createForm.handleSubmit(async (values) => {
    const dto: CreateAssetDto = {
      name: values.name,
      category: values.category as CreateAssetDto['category'],
      originalValue: values.originalValue,
      residualValue: values.residualValue,
      usefulMonths: values.usefulMonths,
      departmentId: values.departmentId || undefined,
      projectId: values.projectId || undefined,
      purchaseDate: values.purchaseDate || undefined,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      await assetApi.createAsset(dto);
      toast.success('资产已创建');
      setCreateOpen(false);
      createForm.reset(EMPTY_ASSET_FORM);
      setPage(1);
      await Promise.all([reload(), reloadOverview()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建资产失败');
    } finally {
      setOperating(false);
    }
  });

  const onChangeSubmit = changeForm.handleSubmit(async (values) => {
    const dto: CreateAssetChangeDto = {
      assetId: values.assetId,
      changeType: values.changeType as CreateAssetChangeDto['changeType'],
      afterValue: values.afterValue || undefined,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      await assetApi.createChange(dto);
      toast.success('变更单已提交，等待审批');
      setChangeOpen(false);
      changeForm.reset(EMPTY_CHANGE_FORM);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '发起变更失败');
    } finally {
      setOperating(false);
    }
  });

  const openChangeDialog = (asset: AssetItem) => {
    changeForm.reset({
      ...EMPTY_CHANGE_FORM,
      assetId: asset.id,
      changeType: asset.status === 'idle' ? 'receive' : '',
    });
    setChangeOpen(true);
  };

  const items: AssetItem[] = data?.items ?? [];

  const columns: TableColumnsType<AssetItem> = [
    { title: '资产编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '资产名称', dataIndex: 'name', width: 160 },
    {
      title: '类别',
      dataIndex: 'category',
      width: 100,
      render: (v: string) => ASSET_CATEGORY_LABELS[v] ?? v,
    },
    {
      title: '原值',
      dataIndex: 'originalValue',
      width: 110,
      render: (v: number) => formatMoney(v),
    },
    {
      title: '残值',
      dataIndex: 'residualValue',
      width: 100,
      render: (v: number) => formatMoney(v),
    },
    {
      title: '净值',
      dataIndex: 'netValue',
      width: 110,
      render: (v: number) => (
        <span className="font-medium">{formatMoney(v)}</span>
      ),
    },
    {
      title: '归属部门',
      dataIndex: 'departmentName',
      width: 120,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '归属项目',
      dataIndex: 'projectName',
      width: 140,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '采购日期',
      dataIndex: 'purchaseDate',
      width: 110,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '折旧月数',
      dataIndex: 'usefulMonths',
      width: 90,
      render: (v: number) => `${v} 个月`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <AssetStatusBadge status={s} />,
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 110,
      render: (_: unknown, record: AssetItem) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openChangeDialog(record)}
        >
          发起变更
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-5 gap-4" data-ai-section-type="card-stat">
        <StatCard
          label="资产原值合计"
          value={formatMoney(overview?.totalOriginalValue)}
        />
        <StatCard
          label="资产净值合计"
          value={formatMoney(overview?.totalNetValue)}
        />
        <StatCard
          label="在用资产"
          value={formatNumber(overview?.inUseCount)}
        />
        <StatCard
          label="已报废资产"
          value={formatNumber(overview?.scrappedCount)}
        />
        <StatCard label="GPU 服务器" value={formatNumber(overview?.gpuCount)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="asset-status-filter">状态</Label>
            <Select
              value={statusFilter}
              onValueChange={(v: string) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger id="asset-status-filter" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {Object.entries(ASSET_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="asset-category-filter">类别</Label>
            <Select
              value={categoryFilter}
              onValueChange={(v: string) => {
                setCategoryFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger id="asset-category-filter" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类别</SelectItem>
                {Object.entries(ASSET_CATEGORY_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="asset-project-filter">项目</Label>
            <Select
              value={projectFilter}
              onValueChange={(v: string) => {
                setProjectFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger id="asset-project-filter" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部项目</SelectItem>
                {(projects ?? []).map((p: Project) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <CanRole roles={['admin']}>
          <Button onClick={() => setCreateOpen(true)} data-ai-section-type="button">
            <Plus className="mr-1 h-4 w-4" />
            新增资产
          </Button>
        </CanRole>
      </div>

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
        dataSource={items}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1400, y: 500 }}
        locale={{ emptyText: '暂无资产数据，点击右上角新增资产' }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          onChange: (p: number) => setPage(p),
        }}
      />

      {/* 新增资产 Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>新增资产</DialogTitle>
            <DialogDescription>
              净值初始为原值减残值，状态默认在用
            </DialogDescription>
          </DialogHeader>
          <Form {...createForm}>
            <form
              onSubmit={onCreateSubmit}
              className="flex flex-col gap-4"
            >
              <div className="flex flex-wrap gap-4">
                <FormField
                  control={createForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        资产名称{' '}
                        <span aria-hidden="true" className="text-destructive">
                          *
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="请输入资产名称" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="category"
                  render={({ field }) => (
                    <FormItem className="w-44">
                      <FormLabel>
                        资产类别{' '}
                        <span aria-hidden="true" className="text-destructive">
                          *
                        </span>
                      </FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(ASSET_CATEGORY_LABELS).map(
                            ([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex flex-wrap gap-4">
                <FormField
                  control={createForm.control}
                  name="originalValue"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        原值（元）{' '}
                        <span aria-hidden="true" className="text-destructive">
                          *
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          value={String(field.value ?? '')}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="residualValue"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>残值（元）</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          value={String(field.value ?? '')}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="usefulMonths"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>折旧月数</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          value={String(field.value ?? '')}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex flex-wrap gap-4">
                <FormField
                  control={createForm.control}
                  name="departmentId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>归属部门</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || undefined}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="不归属部门" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(departments ?? []).map((d: Department) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="projectId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>归属项目</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || undefined}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="不归属项目" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(projects ?? []).map((p: Project) => (
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
                  control={createForm.control}
                  name="purchaseDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>采购日期</FormLabel>
                      <DateField value={field.value} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={createForm.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Textarea placeholder="选填" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <AttachmentHint text="保存后可在发起变更时上传资产照片、采购凭证、验收单等附件" />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCreateOpen(false)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={operating}>
                  保存
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* 发起变更 Dialog */}
      <Dialog open={changeOpen} onOpenChange={setChangeOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>发起资产变更</DialogTitle>
            <DialogDescription>
              领用仅限闲置资产；报废审批通过后将终止后续折旧
            </DialogDescription>
          </DialogHeader>
          <Form {...changeForm}>
            <form onSubmit={onChangeSubmit} className="flex flex-col gap-4">
              <FormField
                control={changeForm.control}
                name="assetId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      资产{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value || undefined}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择资产" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {items.map((asset: AssetItem) => (
                          <SelectItem key={asset.id} value={asset.id}>
                            {asset.code} {asset.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={changeForm.control}
                name="changeType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      变更类型{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value || undefined}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择变更类型" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="receive">领用</SelectItem>
                        <SelectItem value="transfer">调拨</SelectItem>
                        <SelectItem value="scrap">报废</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={changeForm.control}
                name="afterValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>变更说明</FormLabel>
                    <FormControl>
                      <Input placeholder="如调拨去向、领用人等" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={changeForm.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Textarea placeholder="选填" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {changeForm.watch('assetId') ? (
                <div className="border-t pt-4">
                  <AttachmentField
                    resourceType="ast_asset"
                    resourceId={changeForm.watch('assetId')}
                    usageHint="资产照片、采购凭证、验收单等"
                  />
                </div>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setChangeOpen(false)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={operating}>
                  提交
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AssetPanel;
