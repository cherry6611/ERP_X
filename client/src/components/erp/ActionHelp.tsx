import React from 'react';
import { CircleHelp } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@client/src/components/ui/popover';
import { cn } from '@client/src/lib/utils';

interface ActionHelpProps {
  /** 浮层标题，通常是被解释的操作名 */
  title: string;
  /** 2~4 行说明；不要放大段规则 */
  children: React.ReactNode;
  /** 可选文档链接 */
  docsHref?: string;
  /** 触发器无障碍文案 */
  label?: string;
  className?: string;
}

/**
 * 操作组末尾的独立帮助按钮。
 *
 * 设计约定（v2.1）：
 * - 只给有后果/有前置条件的操作使用，保存/取消/新增不配置；
 * - 一个操作组最多一个；
 * - 视觉 16px，点击区域 32×32；
 * - 打开的是 320px Popover，不是弹窗。
 */
const ActionHelp: React.FC<ActionHelpProps> = ({
  title,
  children,
  docsHref,
  label,
  className,
}) => (
  <Popover>
    <PopoverTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          'size-8 shrink-0 text-muted-foreground hover:bg-muted/70 hover:text-foreground',
          className,
        )}
        aria-label={label ?? `查看「${title}」说明`}
      >
        <CircleHelp className="size-4" aria-hidden="true" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" sideOffset={6} className="w-80 space-y-2 p-3.5">
      <p className="text-[13px] font-semibold leading-5">{title}</p>
      <div className="text-[12px] leading-5 text-muted-foreground">
        {children}
      </div>
      {docsHref ? (
        <a
          href={docsHref}
          className="inline-flex text-[12px] font-medium text-primary hover:underline"
        >
          查看说明 →
        </a>
      ) : null}
    </PopoverContent>
  </Popover>
);

export default ActionHelp;
