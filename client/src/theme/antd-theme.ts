import type { ThemeConfig } from 'antd';
import { themeTokens } from './tokens';

/**
 * U-45：antd 主题从 theme/tokens.ts 派生，与 CSS Token 单源对齐。
 */
export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: themeTokens.primary,
    colorSuccess: themeTokens.success,
    colorWarning: themeTokens.warning,
    colorError: themeTokens.danger,
    colorText: themeTokens.foreground,
    colorTextSecondary: themeTokens.mutedForeground,
    colorBorder: themeTokens.border,
    colorBgContainer: themeTokens.background,
    colorBgLayout: themeTokens.background,
    borderRadius: 8,
    fontFamily:
      "'PingFang SC','Microsoft YaHei',system-ui,-apple-system,'Segoe UI',sans-serif",
    fontSize: 14,
    controlHeight: 36,
  },
  components: {
    Table: {
      headerBg: themeTokens.muted,
      headerColor: themeTokens.mutedForeground,
      headerSplitColor: themeTokens.border,
      rowHoverBg: themeTokens.muted,
      borderColor: themeTokens.border,
      cellPaddingBlock: 12,
      cellPaddingInline: 12,
      fontWeightStrong: 600,
      headerBorderRadius: 0,
    },
    Pagination: {
      itemActiveBg: themeTokens.primarySoft,
      borderRadius: 8,
    },
    Button: {
      borderRadius: 8,
      controlHeight: 36,
      controlHeightSM: 32,
    },
    Input: {
      borderRadius: 8,
      controlHeight: 36,
    },
  },
};
