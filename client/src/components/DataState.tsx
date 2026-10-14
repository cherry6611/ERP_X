import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@client/src/components/ui/empty';
import { Skeleton } from '@client/src/components/ui/skeleton';

interface DataStateProps {
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyText?: string;
  emptyTitle?: string;
  emptyAction?: ReactNode;
  /** table = 多行骨架；card = 指标卡脉冲块 */
  skeleton?: 'table' | 'card' | 'default';
  onRetry?: () => void;
  children?: ReactNode;
}

function LoadingSkeleton({ variant }: { variant: DataStateProps['skeleton'] }) {
  if (variant === 'card') {
    return (
      <div
        className="grid grid-cols-12 gap-4"
        aria-busy="true"
        aria-live="polite"
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="col-span-12 h-24 md:col-span-6 xl:col-span-3" />
        ))}
      </div>
    );
  }
  if (variant === 'table') {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
        <Skeleton className="h-10 w-full" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-3/4" />
    </div>
  );
}

export function DataState({
  loading,
  error,
  empty,
  emptyText = '暂无数据',
  emptyTitle,
  emptyAction,
  skeleton = 'default',
  onRetry,
  children,
}: DataStateProps) {
  if (loading) {
    return <LoadingSkeleton variant={skeleton} />;
  }
  if (error) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-12 text-center"
      >
        <p className="text-sm text-destructive">{error}</p>
        {onRetry ? (
          <Button variant="outline" size="sm" type="button" onClick={onRetry}>
            重试
          </Button>
        ) : null}
      </div>
    );
  }
  if (empty) {
    return (
      <Empty className="py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <span className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-brand">
              <Inbox className="size-6" aria-hidden="true" />
            </span>
          </EmptyMedia>
          <EmptyTitle>{emptyTitle ?? emptyText}</EmptyTitle>
          {emptyTitle ? (
            <EmptyDescription>{emptyText}</EmptyDescription>
          ) : null}
        </EmptyHeader>
        {emptyAction}
      </Empty>
    );
  }
  return <>{children}</>;
}

export function AsyncBoundary(props: DataStateProps) {
  return <DataState {...props} />;
}
