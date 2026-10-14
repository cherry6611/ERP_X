/**
 * L12 · UI 双体系收敛策略（antd Table + radix/shadcn 表单）
 *
 * 原则：
 * 1. 色值/圆角/字号一律来自 `theme/tokens`（晟光 CSS 变量），antd 通过
 *    `antd-theme.ts` 的 `cssVar: true` 派生，禁止在业务页硬编码色值。
 * 2. 复杂数据表格继续用 antd `Table`（滚动、固定列、分页成熟）。
 * 3. 表单、弹窗、按钮、输入框优先用 `@client/src/components/ui/*`（radix/shadcn）。
 * 4. 新页面不得再引入第二套组件库；评审时以本文件为验收口径。
 */
export const UI_STACK_POLICY = {
  table: 'antd',
  form: 'shadcn',
  tokenSource: 'theme/tokens + CSS variables',
} as const;
