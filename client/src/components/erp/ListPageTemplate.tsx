import type { ReactNode } from 'react';
import { DataState } from '@client/src/components/DataState';
import PageShell from '@client/src/components/PageShell';

interface ListPageTemplateProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** 筛选条（搜索/状态下拉等） */
  filters?: ReactNode;
  /** 批量操作条 */
  bulkBar?: ReactNode;
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyText?: string;
  onRetry?: () => void;
  children: ReactNode;
}

/**
 * P2/T10：列表页统一骨架（筛选 + 批量 + DataState + 内容区）。
 * 存量页可渐进迁移；新建列表优先使用本模板。
 */
export function ListPageTemplate({
  title,
  description,
  actions,
  filters,
  bulkBar,
  loading,
  error,
  empty,
  emptyText,
  onRetry,
  children,
}: ListPageTemplateProps) {
  return (
    <PageShell title={title} description={description} actions={actions}>
      {filters ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">{filters}</div>
      ) : null}
      {bulkBar}
      <DataState
        loading={loading}
        error={error}
        empty={empty}
        emptyText={emptyText}
        onRetry={onRetry}
        skeleton="table"
      >
        <div className="min-w-0 overflow-x-auto">{children}</div>
      </DataState>
    </PageShell>
  );
}
