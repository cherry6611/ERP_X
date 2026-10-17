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
      /*
       * 尺寸修复：`Empty` 基类带 `flex-1` + `md:p-12`，当它的父容器是
       * `flex flex-col` 且还有剩余高度时（年结状态/留痕、看板通知中心等），
       * 空态会被**拉伸到几百像素高**，在一屏信息密集的后台里就是一大片空白 ——
       * 截图走查里最显眼的观感问题之一。
       *
       * 这里用 `flex-none` 取消拉伸（空态应按内容高度自适应，而不是撑满容器），
       * 并把内边距收到 24px。`Empty` 基类的 `md:p-12` 在同一层叠上下文里会赢过
       * 普通 `p-6`（实测 computed padding 仍是 48px），故用 `!p-6` 强制生效。
       */
      <Empty className="flex-none gap-3 border-dashed !p-6">
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
