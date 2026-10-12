import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AuthProvider } from './auth';

const queryClient = new QueryClient();

export function AppContainer({ children }: { children: ReactNode; defaultTheme?: string }) {
  return (
    <ConfigProvider locale={zhCN}>
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
        <button className="rounded border px-3 py-1 text-sm" type="button" onClick={resetErrorBoundary}>
          重试
        </button>
      ) : null}
    </div>
  );
}

export function NotFoundRender() {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2">
      <p className="text-lg font-medium">页面不存在</p>
      <a className="text-sm text-primary" href="/">
        返回首页
      </a>
    </div>
  );
}
