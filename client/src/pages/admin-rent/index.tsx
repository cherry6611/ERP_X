import React, { useState } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import PageShell from '@client/src/components/PageShell';
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
import RentStatsCards from './components/RentStatsCards';
import RentStatusBadge from './components/RentStatusBadge';
import RentContractFormDialog from './components/RentContractFormDialog';
import RentContractDetailDialog from './components/RentContractDetailDialog';
import type {
  AdminPaymentCycle,
  AdminRentContractAction,
  AdminRentContractItem,
} from '@shared/api.interface';

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'draft', label: '草稿' },
  { value: 'active', label: '生效中' },
  { value: 'expired', label: '已到期' },
  { value: 'terminated', label: '已终止' },
] as const;

const PAYMENT_CYCLE_LABELS: Record<AdminPaymentCycle, string> = {
  monthly: '月付',
  quarterly: '季付',
  half_yearly: '半年付',
  yearly: '年付',
};

const AdminRentPage: React.FC = () => {
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminRentContractItem | null>(
    null,
  );
  const [detailTarget, setDetailTarget] =
    useState<AdminRentContractItem | null>(null);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData(() =>
    adminApi.listRentContracts({
      page,
      pageSize: PAGE_SIZE,
      status: statusFilter !== 'all' ? statusFilter : undefined,
    }),
    [page, statusFilter],
  );

  const { data: stats, loading: statsLoading, reload: reloadStats } =
    useAsyncData(() => adminApi.getRentContractStats());

  const items = data?.items ?? [];

  const refreshAll = async () => {
    await Promise.all([reload(), reloadStats()]);
  };

  const openCreate = () => {
    setEditTarget(null);
    setFormOpen(true);
  };

  const openEdit = (item: AdminRentContractItem) => {
    setEditTarget(item);
    setFormOpen(true);
  };

  const doAction = async (
    item: AdminRentContractItem,
    action: AdminRentContractAction,
  ) => {
    setOperating(true);
    try {
      await adminApi.rentContractAction(item.id, action);
      toast.success(
        action === 'activate'
          ? `合同 ${item.code} 已生效`
          : `合同 ${item.code} 已终止`,
      );
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setOperating(false);
    }
  };

  const columns: TableColumnsType<AdminRentContractItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 150 },
    {
      title: '合同名称',
      dataIndex: 'name',
      width: 180,
      render: (v: string, record) => (
        <Button
          variant="ghost"
          size="sm"
          className="h-auto p-0 text-primary underline-offset-2 hover:underline"
          onClick={() => setDetailTarget(record)}
          aria-label={`查看租房合同详情 ${record.code}`}
        >
          {v}
        </Button>
      ),
    },
    {
      title: '房产地址',
      dataIndex: 'propertyAddress',
      width: 200,
      render: (v: string) => v ?? '-',
    },
    {
      title: '出租方',
      dataIndex: 'lessor',
      width: 150,
      render: (v: string) => v ?? '-',
    },
    {
      title: '月租金',
      dataIndex: 'monthlyRent',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '租期',
      key: 'rentPeriod',
      width: 200,
      render: (_v: unknown, record) =>
        `${record.startDate} ~ ${record.endDate}`,
    },
    {
      title: '付款方式',
      dataIndex: 'paymentCycle',
      width: 100,
      render: (v: AdminPaymentCycle) =>
        PAYMENT_CYCLE_LABELS[v] ?? v,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: AdminRentContractItem['status']) => (
        <RentStatusBadge status={v} />
      ),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 160,
      render: (_v: unknown, record) => (
        <div className="flex gap-1">
          {record.status === 'draft' ? (
            <>
              <CanRole roles={['admin']}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEdit(record)}
                  aria-label={`编辑租房合同 ${record.code}`}
                >
                  编辑
                </Button>
              </CanRole>
              <CanRole roles={['admin']}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={operating}
                  onClick={() => void doAction(record, 'activate')}
                  aria-label={`生效租房合同 ${record.code}`}
                >
                  生效
                </Button>
              </CanRole>
            </>
          ) : null}
          {record.status === 'active' ? (
            <CanRole roles={['admin']}>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                disabled={operating}
                onClick={() => void doAction(record, 'terminate')}
                aria-label={`终止租房合同 ${record.code}`}
              >
                终止
              </Button>
            </CanRole>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title="租房合同"
      description="房产租赁合同登记、生效与终止管理"
      actions={
        <CanRole roles={['admin']}>
          <Button onClick={openCreate} aria-label="新建租房合同">
            <Plus className="size-4" aria-hidden="true" />
            新建合同
          </Button>
        </CanRole>
      }
    >
      <RentStatsCards stats={stats} loading={statsLoading} />
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rent-status-filter">状态</Label>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setPage(1);
              setStatusFilter(v);
            }}
          >
            <SelectTrigger id="rent-status-filter" className="w-40">
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
          scroll={{ x: 1400, y: 500 }}
          locale={{ emptyText: '暂无租房合同，点击右上角新建合同' }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: data?.total ?? 0,
            onChange: (p: number) => setPage(p),
          }}
        />
      )}
      <RentContractFormDialog
        open={formOpen}
        target={editTarget}
        onOpenChange={setFormOpen}
        onSuccess={refreshAll}
      />
      <RentContractDetailDialog
        contract={detailTarget}
        onOpenChange={(open) => {
          if (!open) setDetailTarget(null);
        }}
      />
    </PageShell>
  );
};

export default AdminRentPage;
