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

/**
 * TanStack Query 客户端。
 *
 * ## §5.6（F5）：审计建议"删掉 QueryClientProvider 与依赖"，**实测后否决**
 *
 * 报告的判据是「`useQuery` 4 处、`useMutation` 0 处、`useAsyncData` 62 处」，
 * 结论是"这个 provider 只服务 4 个平台组件"。**该判据数的是 hook 定义处，
 * 不是调用方** —— 实测（`grep` 全部引用点）：
 *
 * | hook | 定义 | 实际调用方 |
 * |---|---|---|
 * | `useUsersByIds` | 1 | **5 处**：`user-with-avatar`、`use-user-value`、`user-select/index` |
 * | `useChatsByIds` | 1 | 0（死代码） |
 * | `useDepartmentsByIds` | 1 | 0（死代码） |
 * | `useUserProfilesByIds` | 1 | 0（死代码） |
 *
 * 而 `useUsersByIds` 的消费链一路通到**应用顶栏**：
 * `Layout.tsx:279` → `<UserDisplay value={[userInfo.user_id]} />`
 * → `user-with-avatar.tsx:116` → `useUsersByIds(...)`。
 * 另外还有 `ArApSection`（应收负责人）、`EmployeePanel`、`AssetFormDialog`、
 * `AffairFormDialog`、`ProjectDocSection` 等 9 个页面/组件。
 *
 * **按报告的建议删除 provider，这些地方会在运行时抛
 * "No QueryClient set, use QueryClientProvider to set one"** ——
 * 顶栏当前用户名首当其冲。因此不采纳该建议。
 *
 * ## 那"两套并存"的真实情况是什么
 *
 * 不是"两套竞品"，而是**两个不同的问题**各用合适的工具：
 *
 * | 层 | 用途 | 为什么必须用它 |
 * |---|---|---|
 * | TanStack Query | **共享只读实体解析**（userId → 姓名/头像） | 同一个 userId 会出现在几十个组件里；缓存与**请求去重**直接消除 N+1。表格每行渲染一个 `UserDisplay` 时，去重是硬需求 |
 * | `useAsyncData` | **业务屏数据**（列表/详情/报表） | 每屏各自管理 `loading`/`error`/写后重取；**写后必须拿到新数据**，缓存的陈旧读在这里是 bug 而不是优化 |
 *
 * 判据可以压缩成一句：**同一个 id 在多个组件里被解析 → Query；
 * 一个屏幕读自己的数据且在写后要刷新 → `useAsyncData`。**
 *
 * 这个分工已写入 `AGENTS.md`，避免新人在 62:4 的数字对比里误判"哪个是正确默认"。
 *
 * ## 缓存策略：为什么不设过期时间
 *
 * 用户/部门是**低频变更的展示数据**：改名一天可能发生一次，而姓名被读几百次。
 * 设 `staleTime: 0` 会让每次挂载都重新请求（等于放弃去重收益）；
 * 设 `gcTime` 让离开页面后一段时间内复用。代价是"改名后要刷新页面才可见" ——
 * 这个代价可以接受，因为**没有任何业务判断依赖姓名的实时性**
 * （权限、审批、金额全部用 userId，不用姓名）。
 *
 * 反过来，如果哪天有业务真的需要"改名立即可见"，正确做法是**改名后显式
 * `invalidateQueries`**（`users/queries.ts` 已导出 `clearUserCache`），
 * 而不是把全局 `staleTime` 调成 0 去惩罚所有读取点。
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 展示型实体：5 分钟内视为新鲜（去重的关键；0 会让去重失效）
      staleTime: 5 * 60 * 1000,
      // 卸载后保留 10 分钟，Tab 来回切换不重复请求
      gcTime: 10 * 60 * 1000,
      // 实体解析失败不重试：失败时组件已回退显示 id 原文，重试无收益
      retry: false,
      // 窗口聚焦时静默刷新是面向"协作编辑"的默认值，本仓用不到：
      // 它会在用户切回浏览器时批量触发请求，与"无请求去重收益"叠加成噪声
      refetchOnWindowFocus: false,
    },
  },
});

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
