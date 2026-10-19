import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { AlertTriangle, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import DateField from '@client/src/components/erp/DateField';
import { SectionTitle } from '@client/src/components/SectionTitle';
import ButtonHelp from '@client/src/components/erp/ButtonHelp';
import { Explained } from '@client/src/components/erp/ItemHelp';
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
} from '@client/src/components/ui/form';
import { Input } from '@client/src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import {
  dataAssetApi,
  masterDataApi,
  projectsApi,
} from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import {
  EMPTY_GRANT_FORM as EMPTY_FORM,
  grantSchema,
  type GrantFormData,
  type GrantFormInput,
} from './grant-form';
import type {
  CreateGrantDto,
  Customer,
  DatasetItem,
  GrantItem,
  GrantWarningItem,
  Project,
} from '@shared/api.interface';
import DataAssetBadge, {
  GRANT_STATUS_LABELS,
  WarningBadge,
} from './DataAssetBadge';

const PAGE_SIZE = 20;

const GrantPanel: React.FC = () => {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('all');
  const [datasetFilter, setDatasetFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
    const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData(
    () =>
      dataAssetApi.listGrants({
        datasetId: datasetFilter !== 'all' ? datasetFilter : undefined,
        status: statusFilter !== 'all' ? statusFilter : undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    [statusFilter, datasetFilter, page],
  );
  const { data: warnings, reload: reloadWarnings } = useAsyncData<
    GrantWarningItem[]
  >(() => dataAssetApi.listGrantWarnings(), []);
  const { data: datasetResult } = useAsyncData(
    () => dataAssetApi.listDatasets({ pageSize: 100 }),
    [],
  );
  const { data: customers } = useAsyncData<Customer[]>(
    () => masterDataApi.listCustomers(),
    [],
  );
  const { data: projects } = useAsyncData<Project[]>(
    () => projectsApi.listProjects(),
    [],
  );

  const datasets: DatasetItem[] = datasetResult?.items ?? [];
  const activeDatasets = datasets.filter((d: DatasetItem) => d.status === 'active');

  const form = useForm<GrantFormInput, unknown, GrantFormData>({
    resolver: zodResolver(grantSchema),
    defaultValues: EMPTY_FORM,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateGrantDto = {
      datasetId: values.datasetId,
      customerId: values.customerId || undefined,
      projectId: values.projectId || undefined,
      scope: values.scope || undefined,
      startDate: values.startDate,
      endDate: values.endDate,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      const created = await dataAssetApi.createGrant(dto);
      toast.success('授权记录已创建');
      setCreateOpen(false);
      navigate(`/data-asset/grants/${created.id}`, { state: { item: created } });
      form.reset(EMPTY_FORM);
      await reload();
      await reloadWarnings();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setOperating(false);
    }
  });

  const doExpire = async (item: GrantItem) => {
    try {
      await dataAssetApi.expireGrant(item.id);
      toast.success('授权已失效');
      await reload();
      await reloadWarnings();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const warningColumns: TableColumnsType<GrantWarningItem> = [
    { title: '授权编号', dataIndex: 'grantCode', width: 150 },
    { title: '数据集', dataIndex: 'datasetName', width: 200 },
    {
      title: '客户',
      dataIndex: 'customerName',
      width: 160,
      render: (v) => v ?? '-',
    },
    { title: '到期日', dataIndex: 'endDate', width: 110 },
    {
      title: '到期预警',
      dataIndex: 'daysLeft',
      width: 130,
      render: (v: number) => <WarningBadge daysLeft={v} />,
    },
  ];

  const grantColumns: TableColumnsType<GrantItem> = [
    { title: '授权编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '数据集', dataIndex: 'datasetName', width: 180 },
    {
      title: '客户',
      dataIndex: 'customerName',
      width: 160,
      render: (v) => v ?? '-',
    },
    {
      title: '项目',
      dataIndex: 'projectName',
      width: 160,
      render: (v) => v ?? '-',
    },
    { title: '授权范围', dataIndex: 'scope', width: 180, render: (v) => v ?? '-' },
    { title: '开始日期', dataIndex: 'startDate', width: 110, render: (v) => v ?? '-' },
    { title: '结束日期', dataIndex: 'endDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => (
        <DataAssetBadge status={s} labels={GRANT_STATUS_LABELS} />
      ),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 100,
      render: (_: unknown, record: GrantItem) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => navigate(`/data-asset/grants/${record.id}`, { state: { item: record } })}>
            详情
          </Button>
          {record.status === 'active' ? (
            <CanCapabilityWrite capability="projects_write">
              <Button variant="ghost" size="sm" onClick={() => void doExpire(record)}>
                失效
              </Button>
            </CanCapabilityWrite>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <SectionTitle>
          <span className="inline-flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
            授权到期预警（30 天内到期 / 已过期）
          </span>
        </SectionTitle>
        <Table
          columns={warningColumns}
          dataSource={warnings ?? []}
          rowKey="grantId"
          scroll={{ x: 800, y: 240 }}
          pagination={{
            pageSize: 10,
            showTotal: (total: number) => `共 ${total} 条`,
          }}
          size="small"
          locale={{ emptyText: '暂无 30 天内到期或已过期的授权' }}
        />
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">数据集</span>
            <Select
              value={datasetFilter}
              onValueChange={(v: string) => {
                setDatasetFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-48" aria-label="按数据集筛选授权">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                {datasets.map((d: DatasetItem) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.code} {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm">状态</span>
            <Select
              value={statusFilter}
              onValueChange={(v: string) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-32" aria-label="授权状态筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                {Object.entries(GRANT_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <CanCapabilityWrite capability="projects_write">
            <ButtonHelp
              title="新增授权"
              content="授权决定谁能访问哪份数据集，以及有效期。到期后自动失效，失效后需要重新授权。"
            >
              <Button
                onClick={() => {
                  form.reset(EMPTY_FORM);
                  setCreateOpen(true);
                }}
              >
                <Plus className="h-4 w-4" />
                新增授权
              </Button>
            </ButtonHelp>
          </CanCapabilityWrite>
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
          columns={grantColumns}
          dataSource={data?.items ?? []}
          loading={loading}
          rowKey="id"
          scroll={{ x: 1300, y: 420 }}
          pagination={{
            current: data?.page ?? page,
            pageSize: data?.pageSize ?? PAGE_SIZE,
            total: data?.total ?? 0,
            showTotal: (total: number) => `共 ${total} 条`,
            onChange: (p: number) => setPage(p),
          }}
          locale={{ emptyText: '暂无授权记录，点击右上角「新增授权」创建' }}
        />
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新增授权</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="datasetId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      数据集{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择数据集" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {activeDatasets.map((d: DatasetItem) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.code} {d.name}
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
                  name="customerId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>客户</FormLabel>
                      <Select
                        value={field.value || 'none'}
                        onValueChange={(v: string) =>
                          field.onChange(v === 'none' ? '' : v)
                        }
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择客户" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">不指定</SelectItem>
                          {(customers ?? []).map((c: Customer) => (
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
                <FormField
                  control={form.control}
                  name="projectId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>项目</FormLabel>
                      <Select
                        value={field.value || 'none'}
                        onValueChange={(v: string) =>
                          field.onChange(v === 'none' ? '' : v)
                        }
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择项目" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">不指定</SelectItem>
                          {(projects ?? []).map((p: Project) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.code} {p.name}
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
                name="scope"
                render={({ field }) => (
                  <FormItem>
                    <Explained
                      title="授权范围"
                      content="写明对方能看哪些字段、能不能调用接口。到期后授权自动失效，不会沿用原来的范围，需要重新授权。"
                    >
                      <FormLabel>授权范围</FormLabel>
                    </Explained>
                    <FormControl>
                      <Input placeholder="如：字段级读取、API 调用" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        开始日期{' '}
                        <span aria-hidden="true" className="text-destructive">
                          *
                        </span>
                      </FormLabel>
                      <DateField value={field.value || null} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="endDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <Explained
                        title="结束日期"
                        content="授权到这一天为止。到期后自动失效，失效后需要重新授权。"
                      >
                        <FormLabel>
                          结束日期{' '}
                          <span aria-hidden="true" className="text-destructive">
                            *
                          </span>
                        </FormLabel>
                      </Explained>
                      <DateField value={field.value || null} onChange={field.onChange} />
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
                      <Input placeholder="备注" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <AttachmentHint text="保存后将自动打开详情，可在其中上传授权协议、审批文件等附件" />
              <DialogFooter>
                <Button type="submit" disabled={operating}>
                  保存
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

    </div>
  );
};

export default GrantPanel;


