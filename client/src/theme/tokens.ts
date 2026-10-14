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

/** 供 antd 等需要 computed color 的场景 */
export function readThemeColor(cssName: string, fallbackHex: string): string {
  if (typeof document === 'undefined') return fallbackHex;
  const probe = document.createElement('span');
  probe.style.color = `var(${cssName})`;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  return computed && computed !== 'rgba(0, 0, 0, 0)' ? computed : fallbackHex;
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
