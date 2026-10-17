import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';

import { AppContainer } from '@client/src/platform/AppContainer';
import { ErrorRender } from '@client/src/platform/AppContainer';

import RoutesComponent from './app.tsx';
import { createPortal } from 'react-dom';
import { Toaster } from '@client/src/components/ui/sonner';
import { warmUpEcharts } from '@client/src/components/echarts-loader';
import './index.css';

/**
 * F1：入口**不得**静态引入 ECharts。
 *
 * 原实现是：
 * ```tsx
 * import * as echarts from 'echarts';
 * import { udTheme } from '@client/src/theme/echarts-ud-theme';
 * echarts.registerTheme('ud', udTheme());   // ← 模块顶层同步调用
 * ```
 * 命名空间导入让 ECharts 无法 tree-shake，而**模块顶层**的 `registerTheme`
 * 使它成为入口的静态依赖 → 进入 `index.html` 的 `modulepreload`。实测
 * `charts` chunk **1,109 KB（gzip 377 KB）**，首屏为了一张 dashboard 图表
 * 要下载 ECharts 的全部图表类型（地图/雷达/关系图/3D），
 * **54 条路由全部 `lazy()` 的收益被这一条抵消**。
 *
 * 现在主题注册由 `components/EChart.tsx` 的 `echartsThemeReady()` 负责，
 * 那里是**动态导入** —— 只在真正渲染图表时才拉取 `charts` chunk。
 * 本文件因此只保留 `createRoot`。
 */

const CLIENT_BASE_PATH = process.env.CLIENT_BASE_PATH || '/';

const MainApp = () => {
  return (
    <BrowserRouter basename={CLIENT_BASE_PATH}>
      <AppContainer defaultTheme="light">
        <ErrorBoundary
          fallbackRender={({ error, resetErrorBoundary }) => (
            <ErrorRender
              error={error as Error}
              resetErrorBoundary={resetErrorBoundary}
            />
          )}
        >
          <RoutesComponent />
          {createPortal(<Toaster />, document.body)}
        </ErrorBoundary>
      </AppContainer>
    </BrowserRouter>
  );
};

createRoot(document.getElementById('root')!).render(<MainApp />);

/*
 * F1：**首帧之后**预热 ECharts。
 *
 * 为什么不是入口同步 import：那会让 `charts` chunk（1,109 KB / gzip 377 KB）
 * 进入 `index.html` 的 `modulepreload`，首屏被迫下载 ECharts 的全部图表类型。
 * 这里改为在**首帧渲染完成后**通过 `requestIdleCallback` 触发动态加载，
 * 于是只有"真正打开含图表页面"的用户才付出这份成本（未加载完时显示骨架屏）。
 *
 * `warmUpEcharts` 内部只调用由 `components/EChart.tsx` 登记的加载器函数，
 * 因此本文件（入口）对 `echarts` **没有任何 import 语句**。
 * 详见 `components/echarts-loader.ts` 的文件头说明。
 */
const warm = () => warmUpEcharts();
if (typeof window.requestIdleCallback === 'function') {
  window.requestIdleCallback(warm, { timeout: 2000 });
} else {
  window.setTimeout(warm, 1);
}
