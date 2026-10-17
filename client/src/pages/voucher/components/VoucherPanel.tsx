import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import {
  VoucherStatusBadge,
  VOUCHER_SOURCE_LABELS,
} from './VoucherBadges';
import {
  PAGE_SIZE,
  // 本文件沿用旧名，避免改动组件体内多处引用
  voucherExportColumns as VOUCHER_EXPORT_COLUMNS,
} from './voucher-form';
import CreateVoucherDialog from './CreateVoucherDialog';
import ConfirmVoucherActionDialog, {
  type ConfirmTarget,
} from './ConfirmVoucherActionDialog';
import VoucherFilterBar from './VoucherFilterBar';
import { Button } from '@client/src/components/ui/button';
import { exportRowsToXlsx } from '@client/src/components/excel/excel-utils';
import { voucherApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import type {
  PeriodStatus,
  VoucherItem,
  VoucherLineItem,
} from '@shared/api.interface';

/*
 * §5.9（F8）：上一轮把**纯声明**（schema / 借贷汇总 / 校验 / 导出列）搬到了
 * `./voucher-form`，文件从 841 行降到 796 行 —— 但占体量的从来不是那 100 行
 * 声明，而是末尾的弹窗 JSX 与筛选区（实测：新增弹窗 259 行、筛选区 79 行、
 * 确认弹窗 33 行）。本轮把这三段**整体**搬走，本文件只剩「页面级编排」：
 * 数据查询、两张表的列定义、错误重试与弹窗挂载 —— 796 → 241 行。
 *
 * ## 三个必须保住的语义（搬迁时逐条核对）
 *
 * ① **三个子组件全部无条件挂载**，不能写成 `{createOpen && <CreateVoucherDialog/>}`。
 *    `useVoucherCreateForm` 里的 2 个 `useAsyncData`（科目 / 辅助维度）与
 *    2 个 `useEffect`（日期→期间、打开时重置）在原实现中是**面板顶层无条件
 *    求值**的；条件挂载会改变副作用触发时机（科目列表变成每次打开才取），
 *    并让"打开时重置"所需的表单实例在首次打开时才创建。弹窗组件内部用
 *    `<Dialog open={…}>` 自行控制显隐，与拆分的 `ApTab` 四个弹窗同一模式。
 *
 * ② **重置时机逐字保持**：`CreateVoucherDialog` → `useVoucherCreateForm` 里
 *    仍是「`createOpen` 由 false 变 true 时 `form.reset(createEmptyVoucherForm(
 *    todayIso(), currentPeriod()))`」。`todayIso()` / `currentPeriod()` 依然是
 *    在**打开弹窗那一刻**求值（不是模块加载时、也不是本文件渲染时），
 *    长驻页面跨零点后新建凭证的默认日期仍是当天。
 *    **原实现没有别的重置**（关闭不重置、提交成功也不重置），本轮没有新增。
 *
 * ③ **`createOpen` / `confirmTarget` 这两个 state 仍留在本文件**：它们是
 *    子组件副作用的**触发点**（弹窗开关、确认弹窗的 open 判据）。若把它们搬进
 *    子组件，触发点就从"父组件状态变化"变成"子组件内部状态变化"，
 *    "打开时重置"与"关闭即清空"的时机就有了第二个真源。
 */

const VoucherPanel: React.FC = () => {
  const navigate = useNavigate();
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [periodFilter, setPeriodFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
    const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);

  const { data, loading, error, reload } = useAsyncData(
    () =>
      voucherApi.listVouchers({
        page,
        pageSize: PAGE_SIZE,
        status: statusFilter !== 'all' ? statusFilter : undefined,
        period: periodFilter !== 'all' ? periodFilter : undefined,
        sourceType: sourceFilter !== 'all' ? sourceFilter : undefined,
      }),
    [page, statusFilter, periodFilter, sourceFilter],
  );

  const { data: periods } = useAsyncData<PeriodStatus[]>(
    () => voucherApi.listPeriods(),
    [],
  );

  const handleExport = () => {
    const rows: VoucherItem[] = data?.items ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('凭证列表.xlsx', '凭证', VOUCHER_EXPORT_COLUMNS, rows);
  };

  const columns: TableColumnsType<VoucherItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '日期', dataIndex: 'voucherDate', width: 110, render: (v: string | null) => v ?? '-' },
    { title: '期间', dataIndex: 'period', width: 90 },
    { title: '摘要', dataIndex: 'summary', width: 200, render: (v: string | null) => v ?? '-' },
    {
      title: '来源类型',
      dataIndex: 'sourceType',
      width: 90,
      render: (v: string) => VOUCHER_SOURCE_LABELS[v] ?? v,
    },
    {
      title: '借方合计',
      dataIndex: 'totalDebit',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '贷方合计',
      dataIndex: 'totalCredit',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <VoucherStatusBadge status={v} />,
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 190,
      render: (_: unknown, record: VoucherItem) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => navigate(`/voucher/${record.id}`, { state: { item: record } })}>
            详情
          </Button>
          <CanCapabilityWrite capability="finance_write">
            {record.status === 'draft' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmTarget({ voucher: record, action: 'post' })}
              >
                过账
              </Button>
            ) : null}
            {record.status !== 'voided' ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => setConfirmTarget({ voucher: record, action: 'void' })}
              >
                作废
              </Button>
            ) : null}
          </CanCapabilityWrite>
        </div>
      ),
    },
  ];

  const lineColumns: TableColumnsType<VoucherLineItem> = [
    { title: '科目编码', dataIndex: 'accountCode', width: 120 },
    { title: '科目名称', dataIndex: 'accountName', width: 160 },
    { title: '摘要', dataIndex: 'summary', render: (v: string | null) => v ?? '-' },
    {
      title: '借方',
      dataIndex: 'debit',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '贷方',
      dataIndex: 'credit',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <VoucherFilterBar
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        periodFilter={periodFilter}
        setPeriodFilter={setPeriodFilter}
        sourceFilter={sourceFilter}
        setSourceFilter={setSourceFilter}
        periods={periods}
        resetPage={() => setPage(1)}
        onExport={handleExport}
        onCreate={() => setCreateOpen(true)}
      />
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
        scroll={{ x: 1300, y: 480 }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          onChange: (p: number) => setPage(p),
        }}
        locale={{ emptyText: '暂无凭证，手工新增或等待业务事件自动生成' }}
      />

      {/* 新增手工凭证 */}
      <CreateVoucherDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async () => {
          setPage(1);
          await reload();
        }}
      />

      {/* 过账 / 作废确认 */}
      <ConfirmVoucherActionDialog
        confirmTarget={confirmTarget}
        onOpenChange={(open: boolean) => {
          if (!open) setConfirmTarget(null);
        }}
        onConfirmed={reload}
      />
    </div>
  );
};

export default VoucherPanel;
