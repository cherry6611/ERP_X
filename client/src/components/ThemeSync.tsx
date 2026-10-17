import { useEffect } from 'react';
import { useTheme } from 'next-themes';
import { invalidateThemeColorCache } from '@client/src/theme/tokens';

/**
 * 主题切换同步。
 *
 * ## F1：不再 import echarts
 *
 * 原实现直接 `import * as echarts from 'echarts'` 并调 `registerTheme`。
 * 本组件挂在 `AppContainer` 里，而 `AppContainer` 在**入口依赖链**上 ——
 * 于是 ECharts 成为入口的静态依赖，首屏被迫预加载整个 `charts` chunk
 * （实测 1,136 KB / gzip 377 KB），54 条路由的懒加载收益全部抵消。
 *
 * 现在主题改为**传对象**给图表实例（见 `components/EChart.tsx`），
 * 全局注册这一步从流程里消失了。
 *
 * ## F2：承担"取色缓存失效"的职责（这是它现在唯一的实际工作）
 *
 * `theme/tokens.ts` 的 `readThemeColor` 会缓存 CSS 变量的计算值
 * （原实现每次调用都 `document.createElement` + `getComputedStyle`，
 * 造成每渲染数十次强制同步布局）。缓存必须在主题切换时清空，
 * 否则暗色模式下会一直用亮色配色 —— 而这里正是**唯一**知道主题变了的地方。
 */
export function ThemeSync() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    invalidateThemeColorCache();
  }, [resolvedTheme]);
  return null;
}
