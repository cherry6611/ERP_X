import React, { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Wallet, Hourglass, FileText } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import PageShell from '@client/src/components/PageShell';
import FilterBar from '@client/src/components/erp/FilterBar';
import { Button } from '@client/src/components/ui/button';
import StatCard from '@client/src/components/erp/StatCard';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { adminApi, notificationsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, formatNumber } from '@client/src/utils/format';
import AdminBillStatusBadge, {
  BILL_STATUS_LABELS,
  BILL_TYPE_LABELS,
} from './components/AdminBillMeta';
import AdminBillFormDialog from './components/AdminBillFormDialog';
import PayBillDialog from './components/PayBillDialog';
import RejectBillDialog from './components/RejectBillDialog';
import type {
  AdminBillItem,
  AdminRentContractItem,
  PagedResult,
} from '@shared/api.interface';

const PAGE_SIZE = 20;

const BILL_TYPE_FILTER_OPTIONS = [
  { value: 'all', label: '全部类型' },
  ...Object.entries(BILL_TYPE_LABELS).map(([value, label]) => ({
    value,
    label,
  })),
];

const BILL_STATUS_FILTER_OPTIONS = [
  { value: 'all', label: '全部状态' },
  ...Object.entries(BILL_STATUS_LABELS).map(([value, label]) => ({
    value,
    label,
  })),
];

const AdminBillsPage: React.FC = () => {
  const [page, setPage] = useState<number>(1);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [formOpen, setFormOpen] = useState<boolean>(false);
  const [editing, setEditing] = useState<AdminBillItem | null>(null);
  const [payTarget, setPayTarget] = useState<AdminBillItem | null>(null);
  const [rejectTarget, setRejectTarget] = useState<AdminBillItem | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsyncData<
    PagedResult<AdminBillItem>
  >(() =>
    adminApi.listAdminBills({
      page,
      pageSize: PAGE_SIZE,
      billType: typeFilter !== 'all' ? typeFilter : undefined,
      status: statusFilter !== 'all' ? statusFilter : undefined,
    }),
  [page, typeFilter, statusFilter]);

  const { data: stats, reload: reloadStats } = useAsyncData(() =>
    adminApi.getAdminBillStats(),
  []);

  const { data: rentContractsPaged } = useAsyncData<
    PagedResult<AdminRentContractItem>
  >(() => adminApi.listRentContracts({ pageSize: 100 }), []);

  const activeRentContracts = (rentContractsPaged?.items ?? []).filter(
    (contract: AdminRentContractItem) => contract.status === 'active',
  );

  const refreshAll = async () => {
    await Promise.all([reload(), reloadStats()]);
  };

  const doAction = async (
    item: AdminBillItem,
    action: 'submit' | 'approve',
  ) => {
    setActingId(item.id);
    try {
      const updated = await adminApi.adminBillAction(item.id, action);
      if (action === 'submit') {
        void notificationsApi.sendApprovalNotification({
          bizType: 'admin_bill',
          bizCode: updated.code,
          title: '行政缴费审批',
          content: `行政缴费单 ${updated.code} 待审批：${updated.title}，金额 ${updated.amount} 元，请及时处理。`,
        });
      }
      toast.success(action === 'submit' ? '已提交审批' : '已审批通过');
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setActingId(null);
    }
  };

  const items = data?.items ?? [];

  const columns: TableColumnsType<AdminBillItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '标题', dataIndex: 'title', width: 180 },
    {
      title: '类型',
      dataIndex: 'billType',
      width: 100,
      render: (v: string) => BILL_TYPE_LABELS[v] ?? v,
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '期间', dataIndex: 'period', width: 90 },
    {
      title: '收款方',
      dataIndex: 'payee',
      width: 140,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '关联合同',
      dataIndex: 'rentContractCode',
      width: 130,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: AdminBillItem['status']) => (
        <AdminBillStatusBadge status={v} />
      ),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 240,
      render: (_v: unknown, record: AdminBillItem) => (
        <div className="flex gap-1">
          {record.status === 'draft' || record.status === 'rejected' ? (
            <>
              <CanRole roles={['admin']}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(record);
                    setFormOpen(true);
                  }}
                  aria-label={`编辑缴费单 ${record.code}`}
                >
                  编辑
                </Button>
              </CanRole>
              <CanRole roles={['admin']}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={actingId === record.id}
                  onClick={() => void doAction(record, 'submit')}
                  aria-label={`提交缴费单 ${record.code}`}
                >
                  提交
                </Button>
              </CanRole>
            </>
          ) : null}
          {record.status === 'submitted' ? (
            <CanRole roles={['admin']}>
              <Button
                variant="ghost"
                size="sm"
                disabled={actingId === record.id}
                onClick={() => void doAction(record, 'approve')}
                aria-label={`审批通过缴费单 ${record.code}`}
              >
                审批通过
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => setRejectTarget(record)}
                aria-label={`驳回缴费单 ${record.code}`}
              >
                驳回
              </Button>
            </CanRole>
          ) : null}
          {record.status === 'approved' ? (
            <CanRole roles={['admin']}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPayTarget(record)}
                aria-label={`登记付款缴费单 ${record.code}`}
              >
                登记付款
              </Button>
            </CanRole>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title="行政缴费"
      description="房租、物业、水电等行政缴费单：提交 → 审批 → 付款"
      actions={
        <CanRole roles={['admin']}>
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
            data-ai-section-type="button"
          >
            <Plus className="mr-1 h-4 w-4" />
            新建缴费单
          </Button>
        </CanRole>
      }
    >

      <div
        className="grid grid-cols-3 gap-4"
        data-ai-section-type="card-stat"
      >
        <StatCard
          label="本月已缴金额"
          value={formatMoney(stats?.monthPaidAmount ?? 0)}
          icon={Wallet}
          tone="success"
        />
        <StatCard
          label="待审批数"
          value={formatNumber(stats?.submittedCount ?? 0)}
          icon={Hourglass}
          tone="warning"
        />
        <StatCard
          label="草稿数"
          value={formatNumber(stats?.draftCount ?? 0)}
          icon={FileText}
          tone="neutral"
        />
      </div>

      <FilterBar>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bill-type-filter">类型</Label>
          <Select
            value={typeFilter}
            onValueChange={(v: string) => {
              setPage(1);
              setTypeFilter(v);
            }}
          >
            <SelectTrigger id="bill-type-filter" className="w-40">
              <SelectValue placeholder="全部类型" />
            </SelectTrigger>
            <SelectContent>
              {BILL_TYPE_FILTER_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bill-status-filter">状态</Label>
          <Select
            value={statusFilter}
            onValueChange={(v: string) => {
              setPage(1);
              setStatusFilter(v);
            }}
          >
            <SelectTrigger id="bill-status-filter" className="w-40">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              {BILL_STATUS_FILTER_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </FilterBar>

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
        locale={{ emptyText: '暂无行政缴费单据，点击右上角新建缴费单' }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          onChange: (next: number) => setPage(next),
        }}
      />

      <AdminBillFormDialog
        open={formOpen}
        onOpenChange={(open: boolean) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
        editing={editing}
        rentContracts={activeRentContracts}
        onSuccess={refreshAll}
      />

      <PayBillDialog
        bill={payTarget}
        onOpenChange={(open: boolean) => {
          if (!open) setPayTarget(null);
        }}
        onSuccess={refreshAll}
      />

      <RejectBillDialog
        bill={rejectTarget}
        onOpenChange={(open: boolean) => {
          if (!open) setRejectTarget(null);
        }}
        onSuccess={refreshAll}
      />
    </PageShell>
  );
};

export default AdminBillsPage;


