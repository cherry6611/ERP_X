import type { EChartsCoreOption } from 'echarts';

function cssColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw || fallback;
}

/**
 * ECharts `ud` 主题：配色/字体/轴线全部来自 CSS Token（§6）。
 * color 顺序：收入蓝、成本红、预算绿、预警橙、其他紫。
 */
export function udTheme(): EChartsCoreOption {
  const text = cssColor('--muted-foreground', 'hsl(218 11% 46%)');
  const border = cssColor('--border', 'hsl(220 14% 89%)');
  const foreground = cssColor('--foreground', 'hsl(220 14% 14%)');
  const card = cssColor('--card', 'hsl(0 0% 100%)');
  const font = cssColor(
    '--font-sans',
    "'PingFang SC','Microsoft YaHei',system-ui,sans-serif"
  );
  const colors = [
    cssColor('--chart-1', 'hsl(222 82% 56%)'),
    cssColor('--chart-2', 'hsl(0 72% 51%)'),
    cssColor('--chart-3', 'hsl(142 70% 38%)'),
    cssColor('--chart-4', 'hsl(38 92% 50%)'),
    cssColor('--chart-5', 'hsl(262 60% 60%)'),
  ];
  const axis = {
    axisLine: { lineStyle: { color: border } },
    axisTick: { lineStyle: { color: border } },
    axisLabel: { color: text, fontSize: 12 },
    splitLine: { lineStyle: { color: border } },
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
    categoryAxis: axis,
    valueAxis: axis,
    timeAxis: axis,
    logAxis: axis,
  };
}
