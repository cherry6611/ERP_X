import React from 'react';
import { Info } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@client/src/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@client/src/components/ui/sheet';

export interface HelpSection {
  title: string;
  body: React.ReactNode;
}

interface PageHelpProps {
  /** 说明标题，同时用于无障碍名称 */
  title: string;
  /** 这一页在做什么，一句 */
  summary: string;
  sections?: HelpSection[];
  docsHref?: string;
  /**
   * page：右侧 360px 抽屉，用于列表、详情、报表。
   * dialog：320px 浮层；超过 6 节时自动改为抽屉，避免浮层装不下。
   */
  placement?: 'page' | 'dialog';
}

const HelpBody: React.FC<Pick<PageHelpProps, 'sections' | 'docsHref'>> = ({
  sections,
  docsHref,
}) => (
  <div className="space-y-4">
    {sections && sections.length > 0 ? (
      <div className="space-y-3">
        <p className="text-[13px] font-semibold leading-5">需要知道的口径</p>
        {sections.map((section) => (
          <section key={section.title} className="space-y-1">
            <h3 className="text-[13px] font-medium leading-5">{section.title}</h3>
            <div className="text-[12px] leading-[18px] text-muted-foreground">
              {section.body}
            </div>
          </section>
        ))}
      </div>
    ) : null}
    {docsHref ? (
      <a
        href={docsHref}
        className="inline-flex text-[12px] font-medium text-primary hover:underline"
      >
        查看说明 →
      </a>
    ) : null}
  </div>
);

const HelpTrigger = React.forwardRef<
  HTMLButtonElement,
  { title: string } & React.ComponentProps<typeof Button>
>(({ title, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    variant="ghost"
    className="h-7 gap-1 px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground"
    aria-label={`查看「${title}」说明`}
    {...props}
  >
    <Info className="size-4" aria-hidden="true" />
    说明
  </Button>
));
HelpTrigger.displayName = 'HelpTrigger';

/**
 * 页面或弹窗右上角的唯一说明入口。
 * 字段口径收在这里，不要再放到字段标签旁边。
 */
const PageHelp: React.FC<PageHelpProps> = ({
  title,
  summary,
  sections,
  docsHref,
  placement = 'page',
}) => {
  const useSheet = placement === 'page' || (sections?.length ?? 0) > 6;

  if (useSheet) {
    return (
      <Sheet>
        <SheetTrigger asChild>
          <HelpTrigger title={title} />
        </SheetTrigger>
        <SheetContent className="w-[360px] gap-5 sm:max-w-[360px]">
          <SheetHeader className="p-0 pr-8">
            <SheetTitle className="text-base">{title}</SheetTitle>
            <SheetDescription className="text-[13px] leading-5 text-foreground">
              {summary}
            </SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto">
            <HelpBody sections={sections} docsHref={docsHref} />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <HelpTrigger title={title} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="z-[60] max-h-[min(420px,70vh)] w-80 space-y-3 overflow-y-auto p-3.5"
      >
        <div className="space-y-1">
          <p className="text-[13px] font-semibold leading-5">{title}</p>
          <p className="text-[12px] leading-[18px] text-foreground">{summary}</p>
        </div>
        <HelpBody sections={sections} docsHref={docsHref} />
      </PopoverContent>
    </Popover>
  );
};

export default PageHelp;
