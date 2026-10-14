import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Download, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { CanCapability } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import FilterBar from '@client/src/components/erp/FilterBar';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Button } from '@client/src/components/ui/button';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { crmApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { QUOTATION_STATUS_LABELS } from '@client/src/utils/biz-labels';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import type {
  Opportunity,
  Quotation,
  QuotationStatus,
} from '@shared/api.interface';
import QuotationFormDialog from './QuotationFormDialog';
import QuotationDetailDialog from './QuotationDetailDialog';

const QuotationsTab: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const statusFilter = params.get('status') ?? 'all';
  const setStatusFilter = (v: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === 'all') next.delete('status');
        else next.set('status', v);
        return next;
      },
      { replace: true },
    );
  };
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Quotation | null>(null);
  const [detailTarget, setDetailTarget] = useState<Quotation | null>(null);

  const { data, loading, error, reload } = useAsyncData<Quotation[]>(
    () =>
      crmApi.listQuotations(
        statusFilter !== 'all'
          ? { status: statusFilter as QuotationStatus }
          : undefined,
      ),
    [statusFilter],
  );
  const { data: opportunities } = useAsyncData<Opportunity[]>(
    () => crmApi.listOpportunities(),
    [],
  );

  const oppTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const opp of opportunities ?? []) {
      map.set(opp.id, opp.title);
    }
    return map;
  }, [opportunities]);

  const exportColumns = useMemo<ExcelSheetColumn<Quotation>[]>(() => [
    { header: '编号', value: (row: Quotation) => row.code },
    { header: '客户', value: (row: Quotation) => row.customerName },
    {
      header: '商机标题',
      value: (row: Quotation) =>
        row.opportunityId ? (oppTitleMap.get(row.opportunityId) ?? '-') : '-',
    },
    { header: '标题', value: (row: Quotation) => row.title },
    { header: '报价总额', value: (row: Quotation) => row.totalAmount },
    { header: '预估成本', value: (row: Quotation) => row.estimatedCost },
    { header: '毛利率%', value: (row: Quotation) => row.marginPct },
    {
      header: '状态',
      value: (row: Quotation) => QUOTATION_STATUS_LABELS[row.status] ?? row.status,
    },
    { header: '有效期', value: (row: Quotation) => row.validUntil ?? '' },
  ], [oppTitleMap]);

  const openCreate = () => {
    setEditTarget(null);
    setFormOpen(true);
  };

  const openEdit = (quotation: Quotation) => {
    setEditTarget(quotation);
    setFormOpen(true);
  };

  const handleExport = () => {
    const rows: Quotation[] = data ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('报价单列表.xlsx', '报价单', exportColumns, rows);
  };

  const columns: TableColumnsType<Quotation> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '客户', dataIndex: 'customerName', width: 140 },
    {
      title: '标题',
      dataIndex: 'title',
      width: 220,
      render: (_: unknown, record: Quotation) => (
        <div>
          <div>{record.title}</div>
          {record.opportunityId ? (
            <div className="text-xs text-muted-foreground">
              {oppTitleMap.get(record.opportunityId) ?? '-'}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: '报价总额',
      dataIndex: 'totalAmount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '预估成本',
      dataIndex: 'estimatedCost',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '毛利率',
      dataIndex: 'marginPct',
      width: 100,
      align: 'right',
      render: (v: number) => (
        <span className={v < 20 ? 'text-destructive' : ''}>{formatPercent(v)}</span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={QUOTATION_STATUS_LABELS} />,
    },
    {
      title: '有效期',
      dataIndex: 'validUntil',
      width: 110,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 140,
      render: (_: unknown, record: Quotation) => (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setDetailTarget(record)}>
            详情
          </Button>
          <CanCapability capability="crm_write">
            {record.status === 'draft' ? (
              <Button variant="ghost" size="sm" onClick={() => openEdit(record)}>
                编辑
              </Button>
            ) : null}
          </CanCapability>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <FilterBar title="筛选">
        <div className="flex items-center gap-2">
          <Label htmlFor="quotation-status-filter">状态</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger id="quotation-status-filter" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {Object.entries(QUOTATION_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          新建报价
        </Button>
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
        </Button>
      </FilterBar>
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !error && (data?.length ?? 0) === 0}
        emptyTitle="暂无报价单"
        emptyText="点击上方「新建报价」按钮创建"
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          columns={columns}
          dataSource={data ?? []}
          rowKey="id"
          scroll={{ x: 1200, y: 500 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: ' ' }}
        />
      </DataState>

      <QuotationFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editTarget={editTarget}
        onSaved={() => {
          setFormOpen(false);
          void reload();
        }}
      />

      <QuotationDetailDialog
        quotation={detailTarget}
        onOpenChange={(open: boolean) => {
          if (!open) setDetailTarget(null);
        }}
        onChanged={() => void reload()}
      />
    </div>
  );
};

export default QuotationsTab;
