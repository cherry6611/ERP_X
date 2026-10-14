import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { NAV_CAPABILITY, hasCapability, hasWriteCapability, type Capability } from '@shared/rbac';
import { Button } from '@client/src/components/ui/button';
import { useAuth } from '@client/src/platform/auth';
import { withBasePath } from '@client/src/utils/base-path';

/**
 * B-13 / B-01：前端路由层能力守卫。
 *
 * 背景：此前只有侧栏按能力隐藏入口，手输 URL 仍能进入无权限页面，
 * 结果 `finance_viewer` 打开 `/audit` 看到的是空白页（既不报错也不引导），
 * 用户在"页面坏了"和"我没权限"之间无法区分（见评估报告 P2-C15）。
 *
 * 本组件做两件事：
 *   1. 未登录 → 跳转登录页（保留来源路径，登录后可回跳）；
 *   2. 已登录但缺少能力 → 渲染明确的"无访问权限"提示（含当前角色与所需能力），
 *      而不是空白。
 *
 * 注意：前端守卫只是体验层，**真正的权限仍由后端 Guard 判定**；
 * 这里不承担安全职责（需求书 §2.2 B-02「在 SQL 层过滤，不能只在 UI 隐藏」同理）。
 */
export function RequireCapability({
  capability,
  children,
}: {
  /** 所需能力；缺省则从当前路由由 NAV_CAPABILITY 推导 */
  capability?: Capability;
  children: ReactNode;
}) {
  const location = useLocation();
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        正在校验访问权限…
      </div>
    );
  }

  if (!user) {
    const redirect = encodeURIComponent(location.pathname + location.search);
    window.location.assign(withBasePath(`/login?redirect=${redirect}`));
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        未登录，正在跳转登录页…
      </div>
    );
  }

  const required = capability ?? NAV_CAPABILITY[location.pathname];
  if (!required || hasCapability(user.roles, required)) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <ShieldAlert className="size-7" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">无访问权限</h2>
        <p className="text-sm text-muted-foreground">
          当前账号角色：{(user.roles ?? []).join('、') || '未分配角色'}
          <br />
          该页面需要能力：<code className="rounded bg-muted px-1">{required}</code>
        </p>
        <p className="text-sm text-muted-foreground">
          如需访问，请联系管理员在「设置 → 用户与角色」中分配对应角色。
        </p>
      </div>
      <Button variant="outline" size="sm" asChild>
        <Link to="/">返回经营看板</Link>
      </Button>
    </div>
  );
}

/**
 * 按能力码显隐（写入版）。
 *
 * 为什么需要单独的写入版本：MATRIX 中"可读"不等于"可写"
 * （例如 finance_viewer 对 finance 是 `r`）。仅用 `CanCapability` 显示写按钮
 * 会让只读角色看到点了必然 403 的按钮（需求书 B-01 验收标准②）。
 *
 * ⚠️ 实现已**上移到 `platform/auth.tsx`** 并从这里 re-export：
 * 写语义判定依赖 `useAuth().hasWriteCapability`，放在 auth 旁可与其
 * 读语义版本 `CanCapability` 并列对照，避免两处各写一份判定逻辑而慢慢分叉。
 * 保留本 re-export 是为了兼容既有 `@client/src/platform/RequireCapability` 引用。
 */
export { CanCapabilityWrite } from './auth';
