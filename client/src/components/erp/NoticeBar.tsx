import React from 'react';
import { AlertTriangle, Info, XCircle } from 'lucide-react';
import { cn } from '@client/src/lib/utils';

type NoticeTone = 'info' | 'warning' | 'danger';

interface NoticeBarProps {
  tone?: NoticeTone;
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

const TONE_CLASS: Record<NoticeTone, string> = {
  info: 'border-primary/20 bg-primary/[0.04] text-foreground',
  warning: 'border-warning/30 bg-warning/[0.07] text-foreground',
  danger: 'border-destructive/30 bg-destructive/[0.05] text-foreground',
};

const ICON_CLASS: Record<NoticeTone, string> = {
  info: 'text-primary',
  warning: 'text-warning',
  danger: 'text-destructive',
};

const ICONS = {
  info: Info,
  warning: AlertTriangle,
  danger: XCircle,
} as const;

/**
 * 页面级提示条。
 *
 * 只用于“不处理就不能继续”的持续可见信息；成功/失败结果请用 toast。
 * 同一页面最多一条。
 */
const NoticeBar: React.FC<NoticeBarProps> = ({
  tone = 'warning',
  children,
  action,
  className,
}) => {
  const Icon = ICONS[tone];

  return (
    <div
      role="status"
      className={cn(
        'flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2',
        TONE_CLASS[tone],
        className,
      )}
    >
      <Icon
        className={cn('size-4 shrink-0', ICON_CLASS[tone])}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 text-[12px] leading-5">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
};

export default NoticeBar;
