import { useEffect } from 'react';
import { useTheme } from 'next-themes';
import * as echarts from 'echarts';
import { udTheme } from '@client/src/theme/echarts-ud-theme';

/** 主题切换后重建 ECharts ud 主题（读最新 CSS 变量） */
export function ThemeSync() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    echarts.registerTheme('ud', udTheme());
  }, [resolvedTheme]);
  return null;
}
