import type { ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { DataState } from '@client/src/components/DataState';
import {
  REQUEST_FORBIDDEN_MESSAGE,
  isForbiddenError,
} from '@client/src/utils/http-state';

interface DataBoundaryProps {
  loading?: boolean;
  /** 页面级错误：优先传 useAsyncData 暴露的 Error 对象，便于识别 403 */
  error?: string | Error | null;
  empty?: boolean;
  emptyText?: string;
  emptyTitle?: string;
  emptyAction?: ReactNode;
  skeleton?: 'table' | 'card' | 'default';
  onRetry?: () => void;
  children?: ReactNode;
}

function resolveMessage(error?: string | Error | null): string | null {
  if (!error) return null;
  if (typeof error === 'string') return error;
  return error.message || '加载失败，请重试';
}

/**
 * 在 DataState 之上补一层 403 判定。
 * 后端鉴权失败与「真的没有数据」必须区分展示（AGENTS.md 错误处理约定），
 * 否则财务页会把权限问题伪装成空账。
 */
const DataBoundary: React.FC<DataBoundaryProps> = ({
  loading,
  error,
  empty,
  emptyText,
  emptyTitle,
  emptyAction,
  skeleton = 'table',
  onRetry,
  children,
}) => {
  const message = resolveMessage(error);
  const forbidden = isForbiddenError(error) || message === REQUEST_FORBIDDEN_MESSAGE;

  if (forbidden) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-12 text-center"
      >
        <ShieldAlert className="size-8 text-destructive" />
        <p className="text-sm text-destructive">{REQUEST_FORBIDDEN_MESSAGE}</p>
      </div>
    );
  }

  return (
    <DataState
      loading={loading}
      error={message}
      empty={empty}
      emptyText={emptyText}
      emptyTitle={emptyTitle}
      emptyAction={emptyAction}
      skeleton={skeleton}
      onRetry={onRetry}
    >
      {children}
    </DataState>
  );
};

export default DataBoundary;
