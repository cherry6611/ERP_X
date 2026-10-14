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
import { formatMoney } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import AffairFormDialog from './components/AffairFormDialog';
import AffairStatusBadge from './components/AffairStatusBadge';
import type { AdminAffairItem } from '@shared/api.interface';

const PAGE_SIZE = 20;

const TYPE_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'vehicle', label: '用车' },
  { value: 'travel', label: '差旅' },
] as const;

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'registered', label: '已登记' },
  { value: 'settled', label: '已结清' },
] as const;

const TYPE_LABELS: Record<string, string> = {
  vehicle: '用车',
  travel: '差旅',
};

const AdminAffairsPage: React.FC = () => {
  const { page, setPage } = useListQuery();
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminAffairItem | null>(null);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData(
    () =>
      adminApi.listAdminAffairs({
        page,
        pageSize: PAGE_SIZE,
        affairType: typeFilter !== 'all' ? typeFilter : undefined,
        status: statusFilter !== 'all' ? statusFilter : undefined,
      }),
    [page, typeFilter, statusFilter],
  );

  const items = data?.items ?? [];

  const openCreate = () => {
    setEditTarget(null);
    setFormOpen(true);
  };

  const openEdit = (item: AdminAffairItem) => {
    setEditTarget(item);
    setFormOpen(true);
  };

  const doSettle = async (item: AdminAffairItem) => {
    setOperating(true);
    try {
      await adminApi.adminAffairAction(item.id, 'settle');
      toast.success(`事务 ${item.code} 已结清`);
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '结清失败'));
    } finally {
      setOperating(false);
    }
  };

  const doDelete = async (record: AdminAffairItem) => {
    const ok = await confirmDanger(
      `确认删除事务 ${record.code}？此操作不可恢复。`,
      { title: '确认删除' },
    );
    if (!ok) return;
    setOperating(true);
    try {
      await adminApi.deleteAdminAffair(record.id);
      toast.success('事务已删除');
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '删除失败'));
    } finally {
      setOperating(false);
    }
  };

  const columns: TableColumnsType<AdminAffairItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 150 },
    {
      title: '类型',
      dataIndex: 'affairType',
      width: 90,
      render: (v: string) => TYPE_LABELS[v] ?? v,
    },
    { title: '事由', dataIndex: 'title', width: 200 },
    {
      title: '参与人',
      dataIndex: 'participants',
      width: 200,
      render: (v: string[]) =>
        v.length > 0 ? <UserDisplay value={v} size="small" /> : '-',
    },
    {
      title: '开始日期',
      dataIndex: 'startDate',
      width: 110,
    },
    {
      title: '结束日期',
      dataIndex: 'endDate',
      width: 110,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number | null) => (v == null ? '-' : formatMoney(v)),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: AdminAffairItem['status']) => <AffairStatusBadge status={v} />,
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 180,
      render: (_v: unknown, record) => (
        <div className="flex gap-1">
          {record.status === 'registered' ? (
            <>
              <CanCapabilityWrite capability="admin_ops">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEdit(record)}
                  aria-label={`编辑事务 ${record.code}`}
                >
                  编辑
                </Button>
              </CanCapabilityWrite>
              <CanCapabilityWrite capability="admin_ops">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={operating}
                  onClick={() => void doSettle(record)}
                  aria-label={`结清事务 ${record.code}`}
                >
                  结清
                </Button>
              </CanCapabilityWrite>
            </>
          ) : null}
          <CanCapabilityWrite capability="admin_ops">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={operating}
              onClick={() => void doDelete(record)}
              aria-label={`删除事务 ${record.code}`}
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
      title="车辆与差旅"
      description="用车与差旅事务登记、费用结清管理"
      actions={
        <CanCapabilityWrite capability="admin_ops">
          <Button onClick={openCreate} aria-label="新建事务">
            <Plus className="size-4" aria-hidden="true" />
            新建事务
          </Button>
        </CanCapabilityWrite>
      }
    >
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="affair-type-filter">类型</Label>
          <Select
            value={typeFilter}
            onValueChange={(v) => {
              setPage(1);
              setTypeFilter(v);
            }}
          >
            <SelectTrigger id="affair-type-filter" className="w-40">
              <SelectValue placeholder="全部类型" />
            </SelectTrigger>
            <SelectContent>
              {TYPE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="affair-status-filter">状态</Label>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setPage(1);
              setStatusFilter(v);
            }}
          >
            <SelectTrigger id="affair-status-filter" className="w-40">
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
          scroll={{ x: 1300, y: 500 }}
          locale={{ emptyText: '暂无事务记录，点击右上角新建事务' }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: data?.total ?? 0,
            onChange: (p: number) => setPage(p),
          }}
        />
      </DataState>
      <AffairFormDialog
        open={formOpen}
        target={editTarget}
        onOpenChange={setFormOpen}
        onSuccess={reload}
      />
    </PageShell>
  );
};

export default AdminAffairsPage;
