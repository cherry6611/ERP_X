import type { ThemeConfig } from 'antd';
import { getThemeTokens, themeTokens } from './tokens';

/**
 * 晟光：antd 从 CSS 变量派生（运行时 getThemeTokens；首帧用静态回退）。
 */
function buildAntdTheme(): ThemeConfig {
  const t =
    typeof document !== 'undefined' ? getThemeTokens() : { ...themeTokens };
  return {
    // L12：antd 走 CSS 变量轨道，与晟光/shadcn token 同源，避免双轨色值漂移
    cssVar: { key: 'ss' },
    hashed: false,
    token: {
      colorPrimary: t.primary,
      colorSuccess: t.success,
      colorWarning: t.warning,
      colorError: t.danger,
      colorText: t.foreground,
      colorTextSecondary: t.mutedForeground,
      colorBorder: t.border,
      colorBgContainer: t.card,
      colorBgLayout: t.background,
      borderRadius: 10,
      fontFamily:
        "'PingFang SC','Microsoft YaHei',system-ui,-apple-system,'Segoe UI',sans-serif",
      fontSize: 14,
      controlHeight: 36,
    },
    components: {
      Table: {
        headerBg: t.muted,
        headerColor: t.mutedForeground,
        headerSplitColor: t.border,
        rowHoverBg: t.muted,
        borderColor: t.border,
        cellPaddingBlock: 12,
        cellPaddingInline: 16,
        fontWeightStrong: 600,
        headerBorderRadius: 0,
      },
      Pagination: {
        itemActiveBg: t.primarySoft,
        borderRadius: 10,
      },
      Button: {
        borderRadius: 10,
        controlHeight: 36,
        controlHeightSM: 32,
      },
      Input: {
        borderRadius: 10,
        controlHeight: 36,
      },
    },
  };
}

export const antdTheme: ThemeConfig = buildAntdTheme();

export function refreshAntdTheme(): ThemeConfig {
  return buildAntdTheme();
}
