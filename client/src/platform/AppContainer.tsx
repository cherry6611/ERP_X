import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AuthProvider } from './auth';
import { antdTheme } from '@client/src/theme/antd-theme';
import { Button } from '@client/src/components/ui/button';

const queryClient = new QueryClient();

export function AppContainer({ children }: { children: ReactNode; defaultTheme?: string }) {
  return (
    <ConfigProvider locale={zhCN} theme={antdTheme}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </ConfigProvider>
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
