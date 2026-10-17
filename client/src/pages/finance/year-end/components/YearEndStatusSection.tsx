/**
 * 「年结状态」区块：按年度列出已年结 / 未年结记录，并在 `closed` 行提供「反年结」。
 *
 * §5.9（F8）：从 `YearEndPage.tsx` 的 return 中**整段搬出**（缩进未动）。
 *
 * ⚠️ **行为零变更**：文案、`DataBoundary` 参数（含 `empty` 的判据与 `emptyText`）、
 * 表格的 `rowKey` / `scroll` / `pagination` 全部逐字未动。只把原先闭包捕获的
 * 页面值改成 props（`data` / `loading` / `error` / `onRetry` / `openReverse`）。
 *
 * ⚠️ 「操作」列只对 `status === 'closed'` 行渲染「反年结」按钮 —— 这是**服务端口径**：
 * `YearEndService.reverseYearEnd` 查到记录后先判 `record.status !== 'closed'`，
 * 非 `closed` 直接拒绝。两侧条件当前一致，改其一必须同步。
 *
 * ⚠️ `statusColumns` 仍在 `useMemo` 里构造，依赖与拆分前**逐项相同**
 * （`[navigate, openReverse]`）—— `navigate` 同样来自 `useNavigate()`，
 * `openReverse` 仍是父组件 `useCallback` 出来的稳定引用（父组件注释有说明）。
 */
import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Table, type TableColumnsType } from 'antd';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { buildStatusColumns } from './year-end-columns';
import type { YearEndStatusItem } from '@shared/api.interface';

interface YearEndStatusSectionProps {
  data: YearEndStatusItem[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** 打开「反年结」确认弹窗（父组件的 `useCallback`，引用必须稳定） */
  openReverse: (fiscalYear: number) => void;
}

const YearEndStatusSection: React.FC<YearEndStatusSectionProps> = ({
  data,
  loading,
  error,
  onRetry,
  openReverse,
}) => {
  const navigate = useNavigate();

  /** §5.5（F4）：年结记录列定义 */
  const statusColumns = useMemo<TableColumnsType<YearEndStatusItem>>(
    () => buildStatusColumns({ navigate, openReverse }),
    [navigate, openReverse],
  );

  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>年结状态</SectionTitle>
      <DataBoundary
        loading={loading}
        error={error}
        empty={!loading && !error && (data ?? []).length === 0}
        emptyText="暂无年结记录：执行年结结转后这里会出现对应年度的状态"
        onRetry={onRetry}
      >
        <div className="rounded-lg border bg-card">
          {/*
            §5.5（F4）：年结记录改 antd `<Table>`。
            `scroll.x` + 固定「年度」列保证横向滚动时仍能定位到是哪个年度。
          */}
          <Table<YearEndStatusItem>
            columns={statusColumns}
            dataSource={data ?? []}
            loading={loading}
            rowKey={(row) => `${row.fiscalYear}-${row.taxEntityId ?? 'all'}`}
            size="small"
            scroll={{ x: 1200 }}
            pagination={{
              pageSize: 20,
              showSizeChanger: false,
              showTotal: (total: number) => `共 ${total} 个年度`,
            }}
            locale={{ emptyText: '暂无年结记录：执行年结结转后这里会出现对应年度的状态' }}
          />
        </div>
      </DataBoundary>
    </div>
  );
};

export default YearEndStatusSection;
