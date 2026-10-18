import React from 'react';
import { cn } from '@client/src/lib/utils';

interface ActionGroupProps {
  children: React.ReactNode;
  /** 操作帮助，放在组末尾，与按钮保持 4px 间距 */
  help?: React.ReactNode;
  className?: string;
}

/**
 * 次级操作组容器。
 *
 * 解决 `?` 被页面 flex 推到最右、与按钮失去视觉关系的问题。
 * 主操作放在组外，组内只放次级动作 + 一个 ActionHelp。
 */
const ActionGroup: React.FC<ActionGroupProps> = ({
  children,
  help,
  className,
}) => (
  <div
    className={cn(
      'inline-flex items-center gap-1 rounded-lg border border-border/70 bg-muted/35 p-0.5',
      className,
    )}
  >
    <div className="flex items-center gap-1">{children}</div>
    {help ? (
      <>
        <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
        {help}
      </>
    ) : null}
  </div>
);

export default ActionGroup;

