import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { ThemeProvider, useTheme } from 'next-themes';
import { AuthProvider, useAuth } from './auth';
import { getDictionaryOptions } from '@client/src/api/system-config';
import { applyDictionarySnapshot } from '@client/src/utils/dict-labels';
import { refreshAntdTheme } from '@client/src/theme/antd-theme';
import '@client/src/theme/ui-stack';
import { ThemeSync } from '@client/src/components/ThemeSync';
import { ConfirmProvider } from '@client/src/components/ConfirmProvider';
import { Button } from '@client/src/components/ui/button';

const queryClient = new QueryClient();

function AntdThemeBridge({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const [theme, setTheme] = useState(() => refreshAntdTheme());
  useEffect(() => {
    setTheme(refreshAntdTheme());
  }, [resolvedTheme]);
  const memo = useMemo(() => theme, [theme]);
  return (
    <ConfigProvider locale={zhCN} theme={memo}>
      {children}
    </ConfigProvider>
  );
}

function DensityBootstrap() {
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('erp-density');
      const density = raw === 'compact' ? 'compact' : 'comfort';
      document.documentElement.setAttribute('data-density', density);
    } catch {
      document.documentElement.setAttribute('data-density', 'comfort');
    }
  }, []);
  return null;
}

/**
 * B-05：加载 `sys_dict` 快照，使业务状态标签以字典为唯一权威。
 *
 * 为什么放在这里而不是各页面各取一次：
 * `biz-labels.ts` 的常量是**模块级同步 Proxy**，全站共享同一份快照；
 * 每个页面各取一次既浪费请求，也会出现"这页已用字典措辞、那页还是旧文案"的不一致。
 *
 * 为什么等 `user` 非空再取：未登录时该接口返回 401，
 * 无谓的失败请求会污染错误监控。登出后不主动清空快照 ——
 * 下次登录会覆盖，保留旧值可避免登出瞬间界面文案跳变。
 */
function DictionaryBootstrap() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await getDictionaryOptions();
        if (!cancelled) applyDictionarySnapshot(snapshot);
      } catch {
        // 失败时保留兜底常量（界面显示不变），不打扰使用者：
        // 字典缺失只影响"文案可配置"，不影响任何功能可用性。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);
  return null;
}

export function AppContainer({
  children,
  defaultTheme = 'light',
}: {
  children: ReactNode;
  defaultTheme?: string;
}) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme={defaultTheme}
      enableSystem
      storageKey="erp-theme"
    >
      <AntdThemeBridge>
        <QueryClientProvider client={queryClient}>
          <ThemeSync />
          <DensityBootstrap />
          {/* B-05：字典快照（业务状态标签以 sys_dict 为唯一权威） */}
          <DictionaryBootstrap />
          <ConfirmProvider>
            <AuthProvider>{children}</AuthProvider>
          </ConfirmProvider>
        </QueryClientProvider>
      </AntdThemeBridge>
    </ThemeProvider>
  );
}

export function ErrorRender({
  error,
  resetErrorBoundary,
}: {
  error: Error;
  resetErrorBoundary?: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3">
      <p className="text-lg font-medium">页面出现错误</p>
      <p className="text-sm text-muted-foreground">{error.message}</p>
      {resetErrorBoundary ? (
        <Button type="button" variant="outline" onClick={resetErrorBoundary}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function NotFoundRender() {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2">
      <p className="text-lg font-medium">页面不存在</p>
      <Button variant="outline" asChild>
        <a href="/">返回首页</a>
      </Button>
    </div>
  );
}
