import React from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';

/**
 * 区块级错误边界（审计 §5.10 / P2-11）。
 *
 * ## 问题
 *
 * 全局只有**路由级**一个 `ErrorBoundary`（`app.tsx` 的 `RouteErrorBoundary`，
 * 包在 `<Layout />` 外层）。而 `ProjectDetailPage` 一个页面就挂了 **13 个
 * Section**（概览/文档/报价/收入/成本/发票/应收应付/工时/里程碑/交付物/
 * 变更/纪要/结项），每个 Section 各自独立取数。于是：
 *
 *   · 其中**任意一个** Section 在渲染期抛错 → 整个 `<Outlet/>` 子树被替换 →
 *     **13 个区块全部消失**，用户看到的是整页错误页；
 *   · 而这个错误很可能只来自一个次要区块（例如"纪要"里一条脏数据让
 *     `new Date(badValue).toISOString()` 抛 `RangeError`），
 *     其余 12 个区块的数据完好却一并不可见；
 *   · 用户失去的不只是那一块，而是**整个项目工作台的上下文** ——
 *     无法退而查看其他信息，只能整页重试。
 *
 * ## 修法
 *
 * 给每个 Section 套一层本组件。失败时只替换**那一块**，并把它降级成
 * 一张紧凑的卡片：说明哪个区块出错、错误原文（便于报障时截图）、
 * 以及一个**局部重试**按钮（`resetErrorBoundary` 只重挂这一块，
 * 不动其他区块，也不触发整页数据重取）。
 *
 * ## 与路由级边界的分工
 *
 * | | 路由级（`app.tsx`） | 区块级（本组件） |
 * |---|---|---|
 * | 兜住 | 页面级异常（页面本身写坏、路由参数非法） | 单个区块的渲染异常 |
 * | 呈现 | 整页错误页 + 「重试」 | 局部卡片 + 「重新加载此区块」 |
 * | 重置范围 | 整个页面子树 | 仅该区块 |
 *
 * 两层都需要：路由级是最后一道网（区块级自己也可能写坏），
 * 区块级则把"一个区块坏掉"的影响面从整页收敛到一格。
 *
 * ## 为什么标题作为 prop 必填
 *
 * 错误卡片上必须能说出"**哪一块**出了问题"。没有标题时用户只能看到
 * 一句技术错误，无法判断自己失去的是什么功能，也无法向开发描述。
 */
export interface SectionBoundaryProps {
  /** 区块中文名，用于错误卡片标题（如「成本」「纪要」） */
  title: string;
  children: React.ReactNode;
}

interface SectionErrorProps {
  title: string;
  error: unknown;
  resetErrorBoundary: () => void;
}

function SectionErrorRender({
  title,
  error,
  resetErrorBoundary,
}: SectionErrorProps) {
  const message =
    error instanceof Error ? error.message : String(error ?? '未知错误');
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="text-sm font-medium">
            「{title}」区块加载失败，其余区块不受影响
          </p>
          {/*
            错误原文必须展示（截断但不隐藏 title 属性）：
            没有它，用户只能反馈"某块坏了"，排障要从零复现。
            `break-words` 是为了让长堆栈/长 SQL 片段不撑破卡片。
          */}
          <p
            className="break-words text-xs text-muted-foreground"
            title={message}
          >
            {message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={resetErrorBoundary}
          >
            <RotateCw className="size-3" />
            重新加载此区块
          </Button>
        </div>
      </div>
    </div>
  );
}

const SectionBoundary: React.FC<SectionBoundaryProps> = ({
  title,
  children,
}) => {
  return (
    <ErrorBoundary
      /*
       * `resetKeys={[title]}`：切换项目/切换区块内容时自动重置。
       * 若不加，一个区块在项目 A 上失败后，切到项目 B 仍显示错误卡片 ——
       * 因为 ErrorBoundary 的失败状态会一直保留到显式 reset。
       */
      resetKeys={[title]}
      fallbackRender={({ error, resetErrorBoundary }) => (
        <SectionErrorRender
          title={title}
          error={error}
          resetErrorBoundary={resetErrorBoundary}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
};

export default SectionBoundary;
