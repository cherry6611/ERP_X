import React from 'react';

interface PageShellProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

const PageShell: React.FC<PageShellProps> = ({
  title,
  description,
  actions,
  children,
}) => (
  <div className="flex min-w-0 flex-col gap-6 p-6">
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold leading-[30px] tracking-tight">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
    {children}
  </div>
);

export default PageShell;
