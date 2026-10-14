import { seriesColor, type SeriesKey } from '@client/src/theme/tokens';

/**
 * 图表语义色：唯一入口 seriesColor(key)，禁止业务图裸写色值。
 */
export function chartSeriesColor(key: SeriesKey): string {
  return seriesColor(key);
}

/** 顺序：收入、成本、预算、预警、其他 */
export const CHART_COLORS: string[] = [
  seriesColor('revenue'),
  seriesColor('cost'),
  seriesColor('budget'),
  seriesColor('warning'),
  seriesColor('other'),
];

export const CHART_SEMANTIC_COLORS = {
  revenue: seriesColor('revenue'),
  primary: seriesColor('revenue'),
  cost: seriesColor('cost'),
  danger: seriesColor('cost'),
  budget: seriesColor('budget'),
  success: seriesColor('budget'),
  warning: seriesColor('warning'),
  other: seriesColor('other'),
  purple: seriesColor('other'),
} as const;
