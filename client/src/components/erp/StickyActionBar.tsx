import React from 'react';
import { cn } from '@client/src/lib/utils';

interface StickyActionBarProps {
  children: React.ReactNode;
  /** 左侧状态/未保存提示 */
  hint?: React.ReactNode;
  className?: string;
}

/**
 * 表单页底部吸底操作栏。
 *
 * 使用方式：放在页面主内容之后、PageShell 内；左侧放状态提示，右侧放动作。
 */
const StickyActionBar: React.FC<StickyActionBarProps> = ({
  children,
  hint,
  className,
}) => (
  <div
    className={cn(
      'sticky bottom-0 z-10 -mx-7 mt-2 border-t border-border/80 bg-card/95 px-7 py-3 backdrop-blur',
      className,
    )}
  >
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 text-[11px] text-muted-foreground">{hint}</div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  </div>
);

export default StickyActionBar;
