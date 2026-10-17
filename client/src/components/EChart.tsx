import {
  useEffect,
  useState,
  type ComponentProps,
  type ComponentType,
} from 'react';
import { useTheme } from 'next-themes';
import { Skeleton } from '@client/src/components/ui/skeleton';
import {
  isEchartsThemeReady,
  onEchartsThemeReady,
  registerEchartsLoader,
} from './echarts-loader';

/**
 * F1：**ECharts 的唯一入口**（按需加载，且不进入入口依赖链）。
 *
 * ## 问题：首屏被迫预加载 1,109 KB 的 ECharts
 *
 * 原实现有三处各自 `import * as echarts from 'echarts'`：
 *   · `index.tsx:10`（入口，且**模块顶层**同步调 `echarts.registerTheme`）
 *   · `components/ThemeSync.tsx:3`（挂在 `AppContainer` 里，同样在入口依赖链上）
 *   · 各图表页 `import ReactECharts from 'echarts-for-react'`
 *
 * 命名空间导入让 ECharts 无法 tree-shake；更致命的是 `registerTheme` 在
 * **模块顶层**执行 → ECharts 成为入口的静态依赖 → 进入 `index.html` 的
 * `modulepreload`：
 *
 * ```html
 * <link rel="modulepreload" href="/assets/charts-B4j5KhsO.js">   <!-- 1,109 KB -->
 * ```
 *
 * 于是首屏为了渲染一张 dashboard 图表，要下载并解析 ECharts 的全部图表类型
 * （地图、雷达、关系图、3D 等）—— **54 条路由全部 `lazy()` 的收益被这一条抵消**。
 *
 * ## 修法：主题注册与加载解耦（关键是**不能有任何静态引用**）
 *
 * 两个陷阱，实测各踩过一次（构建产物可复核）：
 *
 *   ① **不能注册全局主题**：`echarts.registerTheme('ud', ...)` 是全局副作用，
 *      必须在入口某处执行，而任何在入口执行的注册代码都会把 `charts` 拖进首屏。
 *      解法：`echarts-for-react` 的 `theme` 属性同时接受**主题名与主题对象**，
 *      直接传对象 —— 免注册、类型安全，且不会有"忘记注册→静默退化默认配色"的坑。
 *
 *   ② **不能用 `React.lazy`，也不能对本文件做静态 import**：
 *      rolldown/Vite 会把 `lazy()` 的模块工厂与"被静态 import 的组件模块"
 *      标记为入口依赖并写进 `modulepreload`。本组件由 `ThemeSync` 静态引用，
 *      而它内部 `import('echarts-for-react')` → `EChart` chunk 与 `charts`
 *      chunk **双双进了首屏预加载列表**。
 *      解法见 `./echarts-loader`：本文件**不直接 import ECharts**，
 *      改为向那个小模块注册"加载器"，并由 `index.tsx` 在首帧后触发。
 *      于是入口依赖链上**没有任何**指向 `echarts` 的引用。
 *
 * ## 主题切换
 *
 * 主题对象在 `init` 时被读取并固化，所以亮/暗切换必须**重挂实例**。
 * 这里用 `key={resolvedTheme}` 做到 —— 一并取代了原 `ThemeSync.tsx` 的职责。
 */

type ReactEChartsModule = typeof import('echarts-for-react');

type ChartInnerProps = Omit<
  ComponentProps<ReactEChartsModule['default']>,
  'theme'
>;

/** 图表组件类型（由 `echarts-loader` 的工厂回调产出并登记） */
export type LoadedChart = ComponentType<ChartInnerProps>;

/** 已加载的图表组件（模块级缓存：同一页面多张图只加载一次） */
let cachedChart: LoadedChart | null = null;
let loading: Promise<LoadedChart> | null = null;

/**
 * 登记加载器：**只传函数引用，不做任何 IO**。
 *
 * 这一步是整个 F1 修复的关键 —— 入口（`index.tsx`）只与
 * `echarts-loader` 这个空壳模块交互，`echarts` 的 `import()` 调用
 * 留在下面的函数体内，打包器不会把它算作入口依赖。
 */
registerEchartsLoader(async () => (await createEChart()) as unknown as LoadedChart);

/**
 * 真正加载 ECharts 的工厂 —— **只有被 `echarts-loader` 在首帧后调用时才会执行**。
 *
 * 注意这里 `import(...)` 是**运行时**动态导入，且本模块被静态引用时
 * 打包器只会看到"一个函数体内的 import 调用"，不会把它提升为入口依赖。
 */
export async function createEChart(): Promise<LoadedChart> {
  if (cachedChart) return cachedChart;
  if (!loading) {
    loading = (async () => {
      const [mod, { udTheme }] = await Promise.all([
        import('echarts-for-react'),
        import('@client/src/theme/echarts-ud-theme'),
      ]);
      const ReactECharts = mod.default;
      /** 每次渲染重新取主题：`udTheme()` 读的是**当前** CSS 变量 */
      const ThemedChart = (props: ChartInnerProps) => (
        <ReactECharts theme={udTheme()} {...props} />
      );
      cachedChart = ThemedChart;
      return ThemedChart;
    })();
  }
  return loading;
}

export interface EChartProps extends ChartInnerProps {
  /** 加载骨架的高度（用 Tailwind class 表达，默认与常见图表一致） */
  skeletonClassName?: string;
}

/**
 * 图表容器：按需加载 ECharts + 主题随亮暗模式重建 + 骨架屏占位。
 *
 * `option` 的 memo 由**调用方**负责（`useMemo`）—— 本组件不做深比较：
 * ECharts 的 option 是深度嵌套对象，深比较的成本往往高于重绘。
 * 本组件把 `option` 的引用变化原样传给 `echarts-for-react`，
 * 保持"新引用 = `setOption` 全量 diff"的既有语义（与第三方库一致）。
 */
export function EChart({
  skeletonClassName = 'h-[300px] w-full',
  ...props
}: EChartProps) {
  const { resolvedTheme } = useTheme();
  const [Chart, setChart] = useState<LoadedChart | null>(() => cachedChart);

  useEffect(() => {
    if (Chart) return;
    let cancelled = false;
    const apply = () => {
      void createEChart().then((component) => {
        if (!cancelled) setChart(() => component);
      });
    };
    // 已就绪（入口预热完成）→ 立即挂载；否则等 `index.tsx` 的预热广播。
    if (isEchartsThemeReady()) apply();
    const off = onEchartsThemeReady(apply);
    return () => {
      cancelled = true;
      off();
    };
  }, [Chart]);

  if (!Chart) {
    return <Skeleton className={skeletonClassName} aria-label="图表加载中" />;
  }
  // 主题切换必须重挂：主题对象在 init 时被固化，不重挂则暗色下仍是亮色配色。
  return <Chart key={resolvedTheme ?? 'light'} {...props} />;
}
