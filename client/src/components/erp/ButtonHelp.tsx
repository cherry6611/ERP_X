import React from 'react';
import { Info } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@client/src/components/ui/popover';

interface ButtonHelpProps {
  /** 浮层标题，通常是按钮名 */
  title: string;
  /** 点下去会发生什么、什么时候不会生效、能否撤销。不超过 4 行。 */
  content: React.ReactNode;
  /** 被解释的按钮 */
  children: React.ReactElement;
  label?: string;
}

/**
 * 按钮右上角的说明标记。
 *
 * 只给看名字无法判断后果的操作。保存、取消、新建不要使用。
 */
const ButtonHelp: React.FC<ButtonHelpProps> = ({
  title,
  content,
  children,
  label,
}) => (
  <span className="relative inline-flex">
    {children}
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="absolute -top-1.5 -right-1.5 z-10 size-7 rounded-full bg-background text-muted-foreground shadow-none hover:text-foreground"
          aria-label={label ?? `查看「${title}」说明`}
        >
          <Info className="size-3.5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="z-[60] w-80 space-y-1.5 p-3.5">
        <p className="text-[13px] font-semibold leading-5">{title}</p>
        <div className="text-[12px] leading-[18px] text-muted-foreground">{content}</div>
      </PopoverContent>
    </Popover>
  </span>
);

export default ButtonHelp;
