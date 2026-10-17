/**
 * 晟光 Token 单一数据源：优先从 CSS 变量读取，与 tailwind-theme.css 同步。
 * antd / echarts 一律从此派生，禁止再写裸 hex。
 */

export type SeriesKey = 'revenue' | 'cost' | 'budget' | 'warning' | 'alert' | 'other';

const FALLBACK: Record<string, string> = {
  '--primary': '#3B5BFF',
  '--success': '#23965A',
  '--warning': '#F59E0B',
  '--destructive': '#E11D48',
  '--foreground': '#151B2B',
  '--muted-foreground': '#5A6478',
  '--border': '#D8DEE8',
  '--card': '#FFFFFF',
  '--background': '#F5F7FA',
  '--muted': '#F0F2F5',
  '--primary-50': '#F0F3FF',
  '--chart-revenue': '#3B5BFF',
  '--chart-cost': '#E11D48',
  '--chart-budget': '#23965A',
  '--chart-warning': '#F59E0B',
  '--chart-other': '#8B5CF6',
};

/**
 * F2（§5.3）：**取色缓存** —— 消除每渲染数十次的强制同步布局。
 *
 * ## 原实现的开销（这是审计点名的 layout thrashing）
 *
 * `readThemeColor` 每次都 `document.createElement('span')` → 挂到 body →
 * `getComputedStyle` → 移除。`getComputedStyle` 会**强制浏览器同步重排**：
 * 样式必须是最新的，浏览器只能把此前排队的 DOM 变更全部 flush 掉。
 *
 * 而 `seriesColorMap` 的每个 `get` 都会调 `seriesColor` → `readThemeColor`。
 * 一个 681 行的 `DashboardPage` 内含 7 个 `useAsyncData` + 多个 `useState`，
 * 任何 state 变化都会重建 4 个 ECharts option，每个 option 里有多个系列
 * —— **每次渲染产生数十次强制同步布局**。
 *
 * ## 缓存策略：按"CSS 变量名"缓存，主题切换时整体失效
 *
 * 为什么可以安全缓存：这些变量只在**亮/暗主题切换**时变化，而那是一个
 * 低频的用户动作（`next-themes` 切 `documentElement.class`）。
 * `invalidateThemeColorCache()` 由 `ThemeSync` 在主题变化时调用，
 * 因此不存在"暗色下取到亮色"的脏读。
 *
 * 为什么按变量名而不是按 SeriesKey：同一个 CSS 变量可能被多个语义键引用
 * （如 `--chart-warning` 同时服务 `warning` 与 `alert`），按变量名缓存
 * 能让它们共享一次解析。
 */
const colorCache = new Map<string, string>();

/** 主题切换后必须调用：清空缓存，让下一次取色读到新的 CSS 变量值 */
export function invalidateThemeColorCache(): void {
  colorCache.clear();
}

/** 供 antd 等需要 computed color 的场景 */
export function readThemeColor(cssName: string, fallbackHex: string): string {
  if (typeof document === 'undefined') return fallbackHex;
  const cached = colorCache.get(cssName);
  if (cached !== undefined) return cached;
  const probe = document.createElement('span');
  probe.style.color = `var(${cssName})`;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  const resolved =
    computed && computed !== 'rgba(0, 0, 0, 0)' ? computed : fallbackHex;
  colorCache.set(cssName, resolved);
  return resolved;
}

export function getThemeTokens() {
  return {
    primary: readThemeColor('--primary', FALLBACK['--primary']),
    success: readThemeColor('--success', FALLBACK['--success']),
    warning: readThemeColor('--warning', FALLBACK['--warning']),
    danger: readThemeColor('--destructive', FALLBACK['--destructive']),
    foreground: readThemeColor('--foreground', FALLBACK['--foreground']),
    mutedForeground: readThemeColor(
      '--muted-foreground',
      FALLBACK['--muted-foreground']
    ),
    border: readThemeColor('--border', FALLBACK['--border']),
    background: readThemeColor('--background', FALLBACK['--background']),
    card: readThemeColor('--card', FALLBACK['--card']),
    muted: readThemeColor('--muted', FALLBACK['--muted']),
    primarySoft: readThemeColor('--primary-50', FALLBACK['--primary-50']),
  };
}

/** 静态回退（SSR / 首帧）；运行时请用 getThemeTokens() */
export const themeTokens = {
  primary: FALLBACK['--primary'],
  success: FALLBACK['--success'],
  warning: FALLBACK['--warning'],
  danger: FALLBACK['--destructive'],
  foreground: FALLBACK['--foreground'],
  mutedForeground: FALLBACK['--muted-foreground'],
  border: FALLBACK['--border'],
  background: FALLBACK['--background'],
  card: FALLBACK['--card'],
  muted: FALLBACK['--muted'],
  primarySoft: FALLBACK['--primary-50'],
} as const;

const SERIES_CSS: Record<SeriesKey, string> = {
  revenue: '--chart-revenue',
  cost: '--chart-cost',
  budget: '--chart-budget',
  warning: '--chart-warning',
  alert: '--chart-warning',
  other: '--chart-other',
};

/** 强映射：图表系列唯一取色入口 */
export function seriesColor(key: SeriesKey): string {
  const name = SERIES_CSS[key];
  return readThemeColor(name, FALLBACK[name] ?? '#3B5BFF');
}

/** 兼容旧属性访问（.revenueHex 等） */
export const seriesColorMap = {
  get revenue() {
    return seriesColor('revenue');
  },
  get cost() {
    return seriesColor('cost');
  },
  get budget() {
    return seriesColor('budget');
  },
  get alert() {
    return seriesColor('alert');
  },
  get other() {
    return seriesColor('other');
  },
  get revenueHex() {
    return seriesColor('revenue');
  },
  get costHex() {
    return seriesColor('cost');
  },
  get budgetHex() {
    return seriesColor('budget');
  },
  get alertHex() {
    return seriesColor('alert');
  },
  get otherHex() {
    return seriesColor('other');
  },
};
