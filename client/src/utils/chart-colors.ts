/**
 * 图表色同源 Token（§3.1）：收入蓝 / 成本红 / 预算绿 / 预警橙 / 其他紫。
 * 禁止在业务图中裸写色值。
 */
function readChartVar(index: number, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const raw: string = getComputedStyle(document.documentElement)
    .getPropertyValue(`--chart-${index}`)
    .trim();
  if (!raw) return fallback;
  const match = raw.match(/^hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)$/);
  return match ? `hsl(${match[1]}, ${match[2]}%, ${match[3]}%)` : raw;
}

function readVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const raw: string = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!raw) return fallback;
  const match = raw.match(/^hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)$/);
  return match ? `hsl(${match[1]}, ${match[2]}%, ${match[3]}%)` : raw;
}

/** 顺序：收入、成本、预算执行、预警、其他 */
export const CHART_COLORS: string[] = [
  readChartVar(1, 'hsl(222, 82%, 56%)'),
  readChartVar(2, 'hsl(0, 72%, 51%)'),
  readChartVar(3, 'hsl(142, 70%, 38%)'),
  readChartVar(4, 'hsl(38, 92%, 50%)'),
  readChartVar(5, 'hsl(262, 60%, 60%)'),
];

export const CHART_SEMANTIC_COLORS = {
  /** 收入 / 主指标 */
  revenue: readChartVar(1, 'hsl(222, 82%, 56%)'),
  primary: readChartVar(1, 'hsl(222, 82%, 56%)'),
  /** 成本 / 负向 / 账龄风险 */
  cost: readChartVar(2, 'hsl(0, 72%, 51%)'),
  danger: readVar('--destructive', 'hsl(0, 72%, 51%)'),
  /** 预算执行 / 正向 */
  budget: readChartVar(3, 'hsl(142, 70%, 38%)'),
  success: readVar('--success', 'hsl(142, 70%, 38%)'),
  /** 预警 / 期间费用 / 待处理 */
  warning: readChartVar(4, 'hsl(38, 92%, 50%)'),
  /** 辅助 / 其他 */
  other: readChartVar(5, 'hsl(262, 60%, 60%)'),
  purple: readChartVar(5, 'hsl(262, 60%, 60%)'),
} as const;
