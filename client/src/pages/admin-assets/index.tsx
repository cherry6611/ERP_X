import React, { useState } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import { Button } from '@client/src/components/ui/button';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import { adminApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { useListQuery } from '@client/src/hooks/useListQuery';
import { formatMoney, formatNumber } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import AssetFormDialog from './components/AssetFormDialog';
import AssetStatusBadge from './components/AssetStatusBadge';
import type { AdminAssetItem } from '@shared/api.interface';

const PAGE_SIZE = 20;

const CATEGORY_OPTIONS = [
  { value: 'all', label: '全部类别' },
  { value: 'office_equipment', label: '办公设备' },
  { value: 'office_furniture', label: '办公家具' },
  { value: 'other', label: '其他' },
] as const;

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'in_use', label: '在用' },
  { value: 'idle', label: '闲置' },
  { value: 'scrapped', label: '已报废' },
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  office_equipment: '办公设备',
  office_furniture: '办公家具',
  other: '其他',
};

const AdminAssetsPage: React.FC = () => {
  const { page, setPage } = useListQuery();
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminAssetItem | null>(null);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData(
    () =>
      adminApi.listAdminAssets({
        page,
        pageSize: PAGE_SIZE,
        category: categoryFilter !== 'all' ? categoryFilter : undefined,
        status: statusFilter !== 'all' ? statusFilter : undefined,
      }),
    [page, categoryFilter, statusFilter],
  );

  const items = data?.items ?? [];

  const openCreate = () => {
    setEditTarget(null);
    setFormOpen(true);
  };

  const openEdit = (item: AdminAssetItem) => {
    setEditTarget(item);
    setFormOpen(true);
  };

  const doDelete = async (record: AdminAssetItem) => {
    const ok = await confirmDanger(
      `确认删除资产 ${record.code}？此操作不可恢复。`,
      { title: '确认删除' },
    );
    if (!ok) return;
    setOperating(true);
    try {
      await adminApi.deleteAdminAsset(record.id);
      toast.success('资产已删除');
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '删除失败'));
    } finally {
      setOperating(false);
    }
  };

  const columns: TableColumnsType<AdminAssetItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '名称', dataIndex: 'name', width: 160 },
    {
      title: '类别',
      dataIndex: 'category',
      width: 110,
      render: (v: string) => CATEGORY_LABELS[v] ?? v,
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      width: 90,
      render: (v: number) => formatNumber(v),
    },
    {
      title: '单价',
      dataIndex: 'unitPrice',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '位置',
      dataIndex: 'location',
      width: 130,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '责任人',
      dataIndex: 'owner',
      width: 130,
      render: (v: string | null) =>
        v ? <UserDisplay value={[v]} size="small" /> : '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: AdminAssetItem['status']) => <AssetStatusBadge status={v} />,
    },
    {
      title: '购买日期',
      dataIndex: 'purchaseDate',
      width: 110,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 140,
      render: (_v: unknown, record) => (
        <div className="flex gap-1">
          <CanCapabilityWrite capability="admin_ops">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openEdit(record)}
              aria-label={`编辑资产 ${record.code}`}
            >
              编辑
            </Button>
          </CanCapabilityWrite>
          <CanCapabilityWrite capability="admin_ops">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={operating}
              onClick={() => void doDelete(record)}
              aria-label={`删除资产 ${record.code}`}
            >
              删除
            </Button>
          </CanCapabilityWrite>
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title="行政资产"
      description="办公设备、家具等固定资产登记与状态管理"
      actions={
        <CanCapabilityWrite capability="admin_ops">
          <Button onClick={openCreate} aria-label="新建资产">
            <Plus className="size-4" aria-hidden="true" />
            新建资产
          </Button>
        </CanCapabilityWrite>
      }
    >
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="asset-category-filter">类别</Label>
          <Select
            value={categoryFilter}
            onValueChange={(v) => {
              setPage(1);
              setCategoryFilter(v);
            }}
          >
            <SelectTrigger id="asset-category-filter" className="w-40">
              <SelectValue placeholder="全部类别" />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="asset-status-filter">状态</Label>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setPage(1);
              setStatusFilter(v);
            }}
          >
            <SelectTrigger id="asset-status-filter" className="w-40">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
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
          scroll={{ x: 1500, y: 500 }}
          locale={{ emptyText: '暂无资产记录，点击右上角新建资产' }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: data?.total ?? 0,
            onChange: (p: number) => setPage(p),
          }}
        />
      </DataState>
      <AssetFormDialog
        open={formOpen}
        target={editTarget}
        onOpenChange={setFormOpen}
        onSuccess={reload}
      />
    </PageShell>
  );
};

export default AdminAssetsPage;
