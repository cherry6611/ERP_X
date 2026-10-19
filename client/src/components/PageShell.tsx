import React from 'react';

interface PageShellProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** 标题行最右侧的页面说明，位于全部按钮之后 */
  help?: React.ReactNode;
  children: React.ReactNode;
}

const PageShell: React.FC<PageShellProps> = ({
  title,
  description,
  actions,
  help,
  children,
}) => (
  <div className="mx-auto flex min-h-full w-full min-w-0 max-w-[1440px] flex-col gap-4 px-6 py-5">
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions || help ? (
        <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
          {actions}
          {help}
        </div>
      ) : null}
    </div>
    {children}
  </div>
);

export default PageShell;

