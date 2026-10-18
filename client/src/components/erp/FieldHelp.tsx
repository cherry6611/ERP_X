import React from 'react';
import { CircleHelp } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@client/src/components/ui/popover';
import { cn } from '@client/src/lib/utils';

interface FieldHelpProps {
  /** 字段名，用于无障碍文案 */
  label: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * 字段口径帮助。
 *
 * 紧邻字段 label 使用，点击打开 280px 浮层；不要把长说明直接铺在表单顶部。
 */
const FieldHelp: React.FC<FieldHelpProps> = ({
  label,
  children,
  className,
}) => (
  <Popover>
    <PopoverTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          'size-6 text-muted-foreground/70 hover:bg-transparent hover:text-foreground',
          className,
        )}
        aria-label={`查看「${label}」口径说明`}
      >
        <CircleHelp className="size-3.5" aria-hidden="true" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" sideOffset={4} className="w-72 space-y-1.5 p-3">
      <p className="text-[12px] font-semibold leading-5">{label}</p>
      <div className="text-[11px] leading-5 text-muted-foreground">
        {children}
      </div>
    </PopoverContent>
  </Popover>
);

export default FieldHelp;
