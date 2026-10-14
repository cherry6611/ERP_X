/**
 * C-08 待办中心：紧急度归一、排序与角标汇总（纯函数，可单测）。
 *
 * 紧急度口径（需业务确认）：
 *  - overdue：已过期（dueAt < 今天）
 *  - urgent ：3 天内到期（含今天）
 *  - normal ：其余（含无到期日）
 */

import type { TaskItem, TaskSummary, TaskUrgency } from '@shared/api.interface';

/** 紧急度排序权重：过期 → 紧急 → 普通 */
export const URGENCY_WEIGHT: Record<TaskUrgency, number> = {
  overdue: 0,
  urgent: 1,
  normal: 2,
};

/** 3 天内到期视为 urgent */
export const URGENT_WINDOW_DAYS = 3;

/** 两个 YYYY-MM-DD 相差天数（b - a） */
export function dayDiff(a: string, b: string): number {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
  return Math.round((right - left) / 86_400_000);
}

/** 按到期日与今天（业务时区）归一紧急度 */
export function normalizeUrgency(dueAt: string | null, today: string): TaskUrgency {
  if (!dueAt) return 'normal';
  const diff = dayDiff(today, dueAt);
  if (!Number.isFinite(diff)) return 'normal';
  if (diff < 0) return 'overdue';
  if (diff <= URGENT_WINDOW_DAYS) return 'urgent';
  return 'normal';
}

/**
 * 待办排序：紧急度 → 到期日（近的在前）→ 类型 → 单号。
 * 排序完全确定（无随机、无 locale 依赖），保证同一数据多次请求结果一致。
 */
export function sortTasks(
  tasks: TaskItem[],
  sortBy: 'urgency' | 'dueAt' | 'bizType' = 'urgency'
): TaskItem[] {
  const copy = [...tasks];
  copy.sort((a, b) => {
    if (sortBy === 'dueAt') {
      const left = a.dueAt ?? '9999-12-31';
      const right = b.dueAt ?? '9999-12-31';
      if (left !== right) return left < right ? -1 : 1;
    }
    if (sortBy === 'urgency') {
      const weight = URGENCY_WEIGHT[a.urgency] - URGENCY_WEIGHT[b.urgency];
      if (weight !== 0) return weight;
      const left = a.dueAt ?? '9999-12-31';
      const right = b.dueAt ?? '9999-12-31';
      if (left !== right) return left < right ? -1 : 1;
    }
    if (a.bizType !== b.bizType) return a.bizType < b.bizType ? -1 : 1;
    const leftCode = a.bizCode ?? a.bizId;
    const rightCode = b.bizCode ?? b.bizId;
    if (leftCode !== rightCode) return leftCode < rightCode ? -1 : 1;
    return a.bizId < b.bizId ? -1 : a.bizId > b.bizId ? 1 : 0;
  });
  return copy;
}

/** 角标汇总：总数 + 各紧急度数量 + 按类型分布（按类型名排序，稳定输出） */
export function summarizeTasks(tasks: TaskItem[]): TaskSummary {
  const summary: TaskSummary = {
    total: tasks.length,
    overdue: 0,
    urgent: 0,
    normal: 0,
    byType: [],
  };
  const byType = new Map<string, { label: string; count: number }>();
  for (const task of tasks) {
    summary[task.urgency] += 1;
    const entry = byType.get(task.bizType) ?? { label: task.moduleLabel, count: 0 };
    entry.count += 1;
    byType.set(task.bizType, entry);
  }
  summary.byType = [...byType.entries()]
    .map(([bizType, value]) => ({
      bizType: bizType as TaskItem['bizType'],
      label: value.label,
      count: value.count,
    }))
    .sort((a, b) => (a.bizType < b.bizType ? -1 : a.bizType > b.bizType ? 1 : 0));
  return summary;
}

/** 分页切片（page 从 1 起） */
export function paginateTasks<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (Math.max(1, page) - 1) * Math.max(1, pageSize);
  return items.slice(start, start + Math.max(1, pageSize));
}
