import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
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
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import { contractsApi, dataAssetApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import type {
  Contract,
  CreateDatasetDto,
  DatasetItem,
  UpdateDatasetDto,
} from '@shared/api.interface';
import DataAssetBadge, {
  DATASET_STATUS_LABELS,
  MASK_LEVEL_OPTIONS,
} from './DataAssetBadge';

const PAGE_SIZE = 20;

const datasetSchema = z.object({
  name: z.string().min(1, '请填写数据集名称'),
  source: z.string(),
  maskLevel: z.string(),
  contractId: z.string(),
  remark: z.string(),
});

type DatasetFormData = z.output<typeof datasetSchema>;
type DatasetFormInput = z.input<typeof datasetSchema>;

const EMPTY_FORM: DatasetFormData = {
  name: '',
  source: '',
  maskLevel: 'L1',
  contractId: '',
  remark: '',
};

const DatasetPanel: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<DatasetItem | null>(null);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData(
    () =>
      dataAssetApi.listDatasets({
        status: statusFilter !== 'all' ? statusFilter : undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    [statusFilter, page],
  );
  const { data: contracts } = useAsyncData<Contract[]>(
    () => contractsApi.listContracts(),
    [],
  );

  const form = useForm<DatasetFormInput, unknown, DatasetFormData>({
    resolver: zodResolver(datasetSchema),
    defaultValues: EMPTY_FORM,
  });

  const openCreate = () => {
    setEditTarget(null);
    form.reset(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (item: DatasetItem) => {
    setEditTarget(item);
    form.reset({
      name: item.name,
      source: item.source ?? '',
      maskLevel: item.maskLevel,
      contractId: item.contractId ?? '',
      remark: item.remark ?? '',
    });
    setDialogOpen(true);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setOperating(true);
    try {
      if (editTarget) {
        const dto: UpdateDatasetDto = {
          name: values.name,
          source: values.source || undefined,
          maskLevel: values.maskLevel || undefined,
          remark: values.remark || undefined,
        };
        await dataAssetApi.updateDataset(editTarget.id, dto);
        toast.success('数据集已更新');
        setDialogOpen(false);
        setEditTarget(null);
        form.reset(EMPTY_FORM);
      } else {
        const dto: CreateDatasetDto = {
          name: values.name,
          source: values.source || undefined,
          maskLevel: values.maskLevel || undefined,
          contractId: values.contractId || undefined,
          remark: values.remark || undefined,
        };
        const created = await dataAssetApi.createDataset(dto);
        toast.success('数据集已创建');
        setEditTarget(created);
        form.reset({
          name: created.name,
          source: created.source ?? '',
          maskLevel: created.maskLevel,
          contractId: created.contractId ?? '',
          remark: created.remark ?? '',
        });
      }
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setOperating(false);
    }
  });

  const doAction = async (item: DatasetItem, action: 'offline' | 'activate') => {
    try {
      await dataAssetApi.datasetAction(item.id, action);
      toast.success(action === 'offline' ? '数据集已下线' : '数据集已上线');
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const columns: TableColumnsType<DatasetItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '数据集名称', dataIndex: 'name', width: 200 },
    { title: '来源', dataIndex: 'source', width: 160, render: (v) => v ?? '-' },
    { title: '脱敏等级', dataIndex: 'maskLevel', width: 90 },
    {
      title: '关联合同',
      dataIndex: 'contractName',
      width: 200,
      render: (v) => v ?? '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => (
        <DataAssetBadge status={s} labels={DATASET_STATUS_LABELS} />
      ),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 180,
      render: (_: unknown, record: DatasetItem) => (
        <div className="flex gap-1">
          <CanCapabilityWrite capability="crm_write">
            <Button variant="ghost" size="sm" onClick={() => openEdit(record)}>
              编辑
            </Button>
            {record.status === 'active' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void doAction(record, 'offline')}
              >
                下线
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void doAction(record, 'activate')}
              >
                上线
              </Button>
            )}
          </CanCapabilityWrite>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">状态</span>
          <Select
            value={statusFilter}
            onValueChange={(v: string) => {
              setStatusFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-32" aria-label="数据集状态筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {Object.entries(DATASET_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CanCapabilityWrite capability="crm_write">
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            新建数据集
          </Button>
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
        columns={columns}
        dataSource={data?.items ?? []}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1100, y: 480 }}
        pagination={{
          current: data?.page ?? page,
          pageSize: data?.pageSize ?? PAGE_SIZE,
          total: data?.total ?? 0,
          showTotal: (total: number) => `共 ${total} 条`,
          onChange: (p: number) => setPage(p),
        }}
        locale={{ emptyText: '暂无数据集，点击右上角「新建数据集」创建' }}
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editTarget ? '编辑数据集' : '新建数据集'}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      数据集名称{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="数据集名称" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="source"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>来源</FormLabel>
                      <FormControl>
                        <Input placeholder="数据来源" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="maskLevel"
                  render={({ field }) => (
                    <FormItem className="w-32">
                      <FormLabel>脱敏等级</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {MASK_LEVEL_OPTIONS.map((level: string) => (
                            <SelectItem key={level} value={level}>
                              {level}
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
                name="contractId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>关联合同</FormLabel>
                    <Select
                      value={field.value || 'none'}
                      onValueChange={(v: string) => field.onChange(v === 'none' ? '' : v)}
                      disabled={!!editTarget}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择关联合同" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">不关联</SelectItem>
                        {(contracts ?? []).map((c: Contract) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.code} {c.name}
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
              {editTarget ? (
                <div className="border-t pt-4">
                  <AttachmentField
                    resourceType="da_dataset"
                    resourceId={editTarget.id}
                    usageHint="数据说明文档、schema 文件等"
                  />
                </div>
              ) : (
                <AttachmentHint text="保存后可在本弹窗上传数据说明文档、schema 文件等附件" />
              )}
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

export default DatasetPanel;
