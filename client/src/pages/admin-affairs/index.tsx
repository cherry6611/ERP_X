import React, { useState } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
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
import { adminApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import AffairFormDialog from './components/AffairFormDialog';
import AffairStatusBadge from './components/AffairStatusBadge';
import DeleteConfirmDialog from './components/DeleteConfirmDialog';
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
  const [page, setPage] = useState<number>(1);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminAffairItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminAffairItem | null>(
    null,
  );
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData(() =>
    adminApi.listAdminAffairs({
      page,
      pageSize: PAGE_SIZE,
      affairType: typeFilter !== 'all' ? typeFilter : undefined,
      status: statusFilter !== 'all' ? statusFilter : undefined,
    }),
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
      toast.error(err instanceof Error ? err.message : '结清失败');
    } finally {
      setOperating(false);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    setOperating(true);
    try {
      await adminApi.deleteAdminAffair(deleteTarget.id);
      toast.success('事务已删除');
      setDeleteTarget(null);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
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
              <CanRole roles={['admin']}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEdit(record)}
                  aria-label={`编辑事务 ${record.code}`}
                >
                  编辑
                </Button>
              </CanRole>
              <CanRole roles={['admin']}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={operating}
                  onClick={() => void doSettle(record)}
                  aria-label={`结清事务 ${record.code}`}
                >
                  结清
                </Button>
              </CanRole>
            </>
          ) : null}
          <CanRole roles={['admin']}>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={() => setDeleteTarget(record)}
              aria-label={`删除事务 ${record.code}`}
            >
              删除
            </Button>
          </CanRole>
        </div>
      ),
    },
  ];

  return (
    <div className="p-6 flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">车辆与差旅</h1>
        <p className="text-sm text-muted-foreground mt-1">
          用车与差旅事务登记、费用结清管理
        </p>
      </div>
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
        <CanRole roles={['admin']}>
          <Button
            onClick={openCreate}
            className="ml-auto"
            aria-label="新建事务"
          >
            <Plus className="size-4" aria-hidden="true" />
            新建事务
          </Button>
        </CanRole>
      </div>
      {error ? (
        <div className="flex items-center gap-3 text-sm text-destructive">
          <span>加载失败：{error}</span>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            重试
          </Button>
        </div>
      ) : (
        <Table
          columns={columns}
          dataSource={items}
          loading={loading}
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
      )}
      <AffairFormDialog
        open={formOpen}
        target={editTarget}
        onOpenChange={setFormOpen}
        onSuccess={reload}
      />
      <DeleteConfirmDialog
        open={deleteTarget !== null}
        code={deleteTarget?.code ?? null}
        operating={operating}
        onConfirm={() => void doDelete()}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      />
    </div>
  );
};

export default AdminAffairsPage;
