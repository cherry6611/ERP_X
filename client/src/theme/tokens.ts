/**
 * U-45：设计 Token 的 JS 可读值（与 tailwind-theme.css :root 同源）。
 * antd / echarts 系列色从此派生，禁止再写裸 hex。
 */
export const themeTokens = {
  primary: '#2563eb',
  success: '#1f9d57',
  warning: '#f59e0b',
  danger: '#dc2626',
  foreground: '#1f2430',
  mutedForeground: '#6b7280',
  border: '#e2e5ea',
  background: '#ffffff',
  muted: '#f1f3f6',
  primarySoft: '#eff6ff',
} as const;

/** U-10：图表语义色强映射（与 --chart-1..5 一致） */
export const seriesColor = {
  revenue: 'var(--chart-1)',
  cost: 'var(--chart-2)',
  budget: 'var(--chart-3)',
  alert: 'var(--chart-4)',
  other: 'var(--chart-5)',
  revenueHex: '#3b6ef5',
  costHex: '#e11d48',
  budgetHex: '#1f9d57',
  alertHex: '#f59e0b',
  otherHex: '#8b5cf6',
} as const;
