/**
 * §5.9 拆分：把「历史申报底稿」从 `TaxDeclarationPage` 抽出。
 *
 * 抽出的收益：这一块自带 `loading/error/empty` 三态与分页文案（"共 N 份底稿"），
 * 抽走后主文件不再需要同时持有"当前底稿"和"历史底稿"两套边界状态。
 *
 * ⚠️ 保留两条刻意的实现选择（改的人容易误改回去）：
 *   ① `ellipsis` 而不是 `truncate` —— 差异说明是财务复核时最需要读全的一段文本，
 *      `truncate` 是静默截断、没有 tooltip；`ellipsis` 溢出时可悬停看全文。
 *   ② `rowKey` 用 `period + taxEntityId` 复合键 —— 同一期间不同主体会有多份底稿，
 *      只用 `period` 会让 React 复用错行。
 */
import { Table } from 'antd';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import { SectionTitle } from '@client/src/components/SectionTitle';
import type { VatDeclarationHistoryItem } from '@shared/api.interface';
import { vatHistoryColumns } from '../tax-declaration-columns';

interface Props {
  items: VatDeclarationHistoryItem[];
  loading: boolean;
  error: string | Error | null;
  onRetry: () => void;
}

const VatHistorySection: React.FC<Props> = ({ items, loading, error, onRetry }) => (
  <div className="flex flex-col gap-4">
    <SectionTitle>历史申报底稿</SectionTitle>
    <DataBoundary
      loading={loading}
      error={error}
      empty={!loading && !error && items.length === 0}
      emptyText="暂无已生成或已确认的申报底稿记录"
      onRetry={onRetry}
    >
      <div className="rounded-lg border bg-card">
        {/*
          §5.5（F4）：申报历史改 antd `<Table>`。
          差异说明列原先用 `max-w-[260px] truncate`（静默截断、无 tooltip），
          改用 `ellipsis` 后溢出时可悬停看全文 —— 底稿的差异说明是
          **财务复核时最需要读全的一段文本**。
        */}
        <Table<VatDeclarationHistoryItem>
          columns={vatHistoryColumns}
          dataSource={items}
          loading={loading}
          rowKey={(row) => `${row.period}-${row.taxEntityId ?? 'all'}`}
          size="small"
          scroll={{ x: 1300 }}
          pagination={{
            pageSize: 20,
            showSizeChanger: false,
            showTotal: (total: number) => `共 ${total} 份底稿`,
          }}
          locale={{ emptyText: '暂无已生成或已确认的申报底稿记录' }}
        />
      </div>
    </DataBoundary>
  </div>
);

export default VatHistorySection;
