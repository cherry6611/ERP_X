import React from 'react';
import { Info } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@client/src/components/ui/popover';

interface ItemHelpProps {
  /** 这一项的名字 */
  title: string;
  /** 这是什么、怎么填、留空或选错会怎样。不超过 4 行。 */
  content: React.ReactNode;
}

/**
 * 紧挨该项文字的小说明标记。只解释这一项。
 */
const ItemHelp: React.FC<ItemHelpProps> = ({ title, content }) => (
  <Popover>
    <PopoverTrigger asChild>
      <button
        type="button"
        className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
        aria-label={`查看「${title}」是什么意思`}
      >
        <Info className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="end"
      sideOffset={6}
      className="z-[60] w-[280px] space-y-1.5 p-3.5"
    >
      <p className="text-[13px] font-semibold leading-5">{title}</p>
      <div className="text-[12px] leading-[18px] text-muted-foreground">{content}</div>
    </PopoverContent>
  </Popover>
);

/** 说明标记紧跟标签文字，不推到控件最右边。 */
export const Explained: React.FC<ItemHelpProps & { children: React.ReactNode }> = ({
  title,
  content,
  children,
}) => (
  <div className="inline-flex items-center gap-1">
    {children}
    <ItemHelp title={title} content={content} />
  </div>
);

/** 表头行话列：标记紧跟列名，不出现在每一行。 */
export const ColumnHelpTitle: React.FC<ItemHelpProps> = ({ title, content }) => (
  <span className="inline-flex items-center gap-1">
    <span>{title}</span>
    <ItemHelp title={title} content={content} />
  </span>
);

export default ItemHelp;
