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
        {/*
          P2-4（§5.10）：标题字号统一到规范值 `text-2xl`（24px）。
          
          原实现是 `text-[22px] leading-[30px]`，而 `AGENTS.md` 的排版规范写的是
          「页面标题 `text-2xl font-semibold`」。2px 的差异本身无关紧要，
          真正的问题是**规范与实现不一致**：这让"规范可 grep 验证"这件事失效 ——
          按规范搜 `text-2xl` 会得出"没有一个页面符合规范"的错误结论，
          而按 `text-[22px]` 搜又会得出"规范写错了"。
          
          Tailwind 的 `text-2xl` 自带 `line-height: 2rem`(32px)，比原来的 30px
          略松，与 `text-2xl` + `tracking-tight` 的观感更一致。
        */}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
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
