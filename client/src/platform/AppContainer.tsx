import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { ThemeProvider, useTheme } from 'next-themes';
import { AuthProvider } from './auth';
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
