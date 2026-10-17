import React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Download, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
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
import { OPP_STAGE_LABELS } from '@client/src/utils/biz-labels';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type { Opportunity } from '@shared/api.interface';

const OPP_EXPORT_COLUMNS: ExcelSheetColumn<Opportunity>[] = [
  { header: '编号', value: (row: Opportunity) => row.code },
  { header: '客户', value: (row: Opportunity) => row.customerName },
  { header: '商机名称', value: (row: Opportunity) => row.title },
  {
    header: '阶段',
    value: (row: Opportunity) => OPP_STAGE_LABELS[row.stage] ?? row.stage,
  },
  { header: '预计金额', value: (row: Opportunity) => row.amount },
  { header: '赢单率（%）', value: (row: Opportunity) => row.winRate },
  { header: '报价轮次', value: (row: Opportunity) => row.quotationCount },
  {
    header: '最终成交报价',
    value: (row: Opportunity) => row.wonQuotationCode ?? '',
  },
  { header: '负责人', value: (row: Opportunity) => row.owner ?? '' },
  { header: '预计成交', value: (row: Opportunity) => row.expectedDate ?? '' },
];

const OpportunitiesTab: React.FC = () => {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const stageFilter = params.get('stage') ?? 'all';
  const setStageFilter = (v: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === 'all') next.delete('stage');
        else next.set('stage', v);
        return next;
      },
      { replace: true },
    );
  };

  const { data, loading, error, reload } = useAsyncData<Opportunity[]>(
    () => crmApi.listOpportunities(stageFilter !== 'all' ? stageFilter : undefined),
    [stageFilter],
  );

  const convert = async (opp: Opportunity) => {
    const ok = await confirmDanger(
      `确认将商机 ${opp.code} 转为合同草稿？`,
      { title: '确认转合同', confirmLabel: '确认转换' },
    );
    if (!ok) return;
    try {
      const contract = await crmApi.convertOpportunity(opp.id);
      toast.success(`已生成合同草稿 ${contract.code}`);
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '转合同失败'));
    }
  };

  const handleExport = () => {
    const rows: Opportunity[] = data ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('商机列表.xlsx', '商机', OPP_EXPORT_COLUMNS, rows);
  };

  const columns: TableColumnsType<Opportunity> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '客户', dataIndex: 'customerName', width: 160 },
    {
      title: '商机名称',
      dataIndex: 'title',
      width: 220,
      render: (v: string, record: Opportunity) => (
        <Link
          to={`/crm/opportunities/${record.id}`}
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          {v}
        </Link>
      ),
    },
    {
      title: '阶段',
      dataIndex: 'stage',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={OPP_STAGE_LABELS} />,
    },
    {
      title: '预计金额',
      dataIndex: 'amount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '赢单率',
      dataIndex: 'winRate',
      width: 90,
      render: (v: number) => formatPercent(v),
    },
    {
      title: '报价轮次',
      dataIndex: 'quotationCount',
      width: 90,
      render: (v: number) => `${v} 轮`,
    },
    {
      title: '最终成交报价',
      key: 'won',
      width: 160,
      render: (_, row) =>
        row.wonQuotationCode ? (
          <Link
            to={`/crm/quotations/${row.wonQuotationId}`}
            className="text-primary underline-offset-2 hover:underline"
          >
            {row.wonQuotationCode}
          </Link>
        ) : (
          '-'
        ),
    },
    { title: '负责人', dataIndex: 'owner', width: 100, render: (v) => v ?? '-' },
    { title: '预计成交', dataIndex: 'expectedDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 160,
      render: (_, record) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/crm/opportunities/${record.id}`)}
          >
            详情
          </Button>
          <CanCapabilityWrite capability="crm_write">
            {record.stage === 'won' && !record.contractId ? (
              <Button variant="ghost" size="sm" onClick={() => void convert(record)}>
                转合同
              </Button>
            ) : null}
          </CanCapabilityWrite>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/*
        * 工具行与筛选卡片分离：见 `LeadsTab` 同一处注释
        * （写操作不进 FilterBar，这是 `AGENTS.md` 对 FilterBar 的定位）。
        */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
        </Button>
        <Button onClick={() => navigate('/crm/opportunities/new')}>
          <Plus className="h-4 w-4" />
          新建商机
        </Button>
      </div>
      <FilterBar title="筛选">
        <div className="flex items-center gap-2">
          <Label htmlFor="opp-stage-filter">阶段</Label>
          <Select value={stageFilter} onValueChange={setStageFilter}>
            <SelectTrigger id="opp-stage-filter" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {Object.entries(OPP_STAGE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </FilterBar>
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !error && (data?.length ?? 0) === 0}
        emptyTitle="暂无商机"
        emptyText="点击上方「新建商机」进入整页创建"
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          columns={columns}
          dataSource={data ?? []}
          rowKey="id"
          scroll={{ x: 1400, y: 500 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: ' ' }}
        />
      </DataState>
    </div>
  );
};

export default OpportunitiesTab;
