/**
 * F1：ECharts **加载开关**（零依赖的极简模块）。
 *
 * ## 它解决什么
 *
 * 目标只有一句：**首屏不要预加载 `charts` chunk（实测 1,109 KB / gzip 377 KB）**。
 *
 * 但实测发现两个会让修复失效的打包器行为（rolldown / Vite 7，构建产物可复核）：
 *
 *   ① 用 `React.lazy(() => import('echarts-for-react'))` **不行** ——
 *      `lazy()` 的模块工厂会被识别为静态依赖，`charts` 仍进 `modulepreload`。
 *   ② 把组件写成普通函数、内部 `import(...)` 也**不行** —— 只要这个组件模块
 *      被入口依赖链**静态 import**（`ThemeSync` → `EChart`），
 *      打包器就会把 `EChart` chunk 与它动态引用的 `charts` chunk
 *      一并提升为入口预加载项。
 *
 * 结论：入口依赖链上**一个指向 ECharts 的 import 都不能有**，哪怕是动态的。
 *
 * ## 做法：回调注册 + 首帧后触发
 *
 * 本模块**只有几行状态管理，不 import 任何东西**，因此可以安全地出现在入口
 * 依赖链上：
 *   · `EChart.tsx`（业务侧）向这里**注册**加载器 `createEChart`；
 *   · `index.tsx`（入口）在**首帧渲染之后**调用 `warmUpEcharts()` 触发加载。
 *
 * 于是入口依赖链是：`index.tsx → echarts-loader`（空壳）与
 * `index.tsx → AppContainer → ThemeSync → EChart`（不含 ECharts 引用），
 * 真正的 `import('echarts-for-react')` 只存在于 `EChart` 的函数体内、
 * 且由**运行时**调用触发 —— 打包器不会把它算作入口依赖。
 *
 * 代价与收益：图表首帧会先渲染骨架屏（`Skeleton`）再切到图表。
 * 这是**预期行为**：只有真正打开含图表的页面才付出 ECharts 的下载成本。
 */
import type { ComponentType } from 'react';

/** 图表组件：属性与 `echarts-for-react` 的默认导出兼容（`theme` 由本侧注入） */
export type LoadedChart = ComponentType<Record<string, unknown>>;

type Loader = () => Promise<LoadedChart>;

let loader: Loader | null = null;
let ready = false;
let warming: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** 由 `EChart.tsx` 在模块求值时登记（仅登记函数引用，不触发任何 IO） */
export function registerEchartsLoader(fn: Loader): void {
  loader = fn;
}

/** 主题与加载器是否都已就绪（图表可立即挂载） */
export function isEchartsThemeReady(): boolean {
  return ready;
}

/** 订阅"就绪"事件；返回取消订阅函数 */
export function onEchartsThemeReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 预热：加载 ECharts 并广播就绪。
 *
 * 在 `index.tsx` 的**首帧之后**调用（`requestIdleCallback` / `setTimeout`），
 * 因此不阻塞首屏；加载完成前图表显示骨架屏。
 *
 * 失败处理：**不抛出**。图表是观感层，加载失败不应让应用崩掉；
 * 失败时保持未就绪，`EChart` 继续显示骨架屏（用户仍可正常使用其余功能）。
 */
export function warmUpEcharts(): void {
  if (ready || warming || !loader) return;
  warming = loader()
    .then(() => {
      ready = true;
      for (const listener of listeners) listener();
      listeners.clear();
    })
    .catch(() => {
      // 保持未就绪；下次调用可重试（warming 置空）
      warming = null;
    });
}
