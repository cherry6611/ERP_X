import type { EChartsCoreOption } from 'echarts';

function cssColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return raw || fallback;
}

/**
 * ECharts `ud` 主题：色序严格 = 收入/成本/预算/预警/其他。
 */
export function udTheme(): EChartsCoreOption {
  const text = cssColor('--muted-foreground', 'hsl(220 12% 40%)');
  const border = cssColor('--border', 'hsl(220 16% 88%)');
  const foreground = cssColor('--foreground', 'hsl(222 30% 12%)');
  const card = cssColor('--card', 'hsl(0 0% 100%)');
  const font = cssColor(
    '--font-sans',
    "'PingFang SC','Microsoft YaHei',system-ui,sans-serif"
  );
  const colors = [
    cssColor('--chart-revenue', 'hsl(230 100% 62%)'),
    cssColor('--chart-cost', 'hsl(351 74% 53%)'),
    cssColor('--chart-budget', 'hsl(150 64% 38%)'),
    cssColor('--chart-warning', 'hsl(38 92% 50%)'),
    cssColor('--chart-other', 'hsl(262 70% 62%)'),
  ];
  const axis = {
    axisLine: { lineStyle: { color: border } },
    axisTick: { lineStyle: { color: border } },
    axisLabel: { color: text, fontSize: 12 },
    splitLine: { lineStyle: { color: border, type: 'dashed' as const } },
  };
  return {
    color: colors,
    backgroundColor: 'transparent',
    textStyle: { color: text, fontFamily: font, fontSize: 12 },
    title: { textStyle: { color: foreground, fontFamily: font, fontSize: 14 } },
    legend: {
      bottom: 0,
      textStyle: { color: text, fontSize: 12 },
    },
    tooltip: {
      backgroundColor: card,
      borderColor: border,
      borderWidth: 1,
      textStyle: { color: foreground, fontFamily: font, fontSize: 12 },
    },
    bar: {
      itemStyle: { borderRadius: [4, 4, 0, 0] },
    },
    categoryAxis: axis,
    valueAxis: axis,
    timeAxis: axis,
    logAxis: axis,
  };
}
