import type React from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * §5.9 / F8：经营看板「指标卡」的展示结构。
 *
 * 原先定义在 `DashboardPage.tsx` 内。拆分后「概览」与「财务」两个 Tab 都要按
 * 同一结构渲染 `StatCard`，故单独成文件 —— 子组件反向 import 父页面会形成
 * 循环依赖。字段与原先**逐字一致**，只在声明前加了 `export`。
 */
export type OverviewStat = {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  tone: 'primary' | 'success' | 'warning' | 'info' | 'neutral';
  delta?: React.ReactNode;
  help?: React.ReactNode;
};
