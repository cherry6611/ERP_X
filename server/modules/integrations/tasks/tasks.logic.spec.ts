/**
 * C-08 待办中心聚合逻辑单测（纯函数）。
 */
import {
  URGENCY_WEIGHT,
  URGENT_WINDOW_DAYS,
  dayDiff,
  normalizeUrgency,
  paginateTasks,
  sortTasks,
  summarizeTasks,
} from './tasks.logic';
import type { TaskItem } from '@shared/api.interface';

function task(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    bizType: 'quotation_approval',
    bizId: '11111111-1111-1111-1111-111111111111',
    bizCode: 'QUO2026100001',
    title: '报价单待审批',
    urgency: 'normal',
    dueAt: null,
    url: '/crm/quotations/11111111-1111-1111-1111-111111111111',
    moduleLabel: '报价单',
    detail: null,
    ...overrides,
  };
}

describe('C-08 紧急度归一', () => {
  it('过期 / 3 天内 / 其余', () => {
    expect(URGENT_WINDOW_DAYS).toBe(3);
    expect(normalizeUrgency('2026-10-09', '2026-10-10')).toBe('overdue');
    expect(normalizeUrgency('2026-10-10', '2026-10-10')).toBe('urgent');
    expect(normalizeUrgency('2026-10-13', '2026-10-10')).toBe('urgent');
    expect(normalizeUrgency('2026-10-14', '2026-10-10')).toBe('normal');
    expect(normalizeUrgency(null, '2026-10-10')).toBe('normal');
    expect(normalizeUrgency('非法日期', '2026-10-10')).toBe('normal');
  });

  it('dayDiff 计算真实天数差', () => {
    expect(dayDiff('2026-10-10', '2026-10-13')).toBe(3);
    expect(dayDiff('2026-10-10', '2026-09-30')).toBe(-10);
    expect(dayDiff('2026-01-01', '2026-12-31')).toBe(364);
  });

  it('排序权重：过期 < 紧急 < 普通', () => {
    expect(URGENCY_WEIGHT.overdue).toBeLessThan(URGENCY_WEIGHT.urgent);
    expect(URGENCY_WEIGHT.urgent).toBeLessThan(URGENCY_WEIGHT.normal);
  });
});

describe('C-08 待办排序', () => {
  const overdue = task({ bizId: 'a', urgency: 'overdue', dueAt: '2026-10-01' });
  const urgentLate = task({ bizId: 'b', urgency: 'urgent', dueAt: '2026-10-13' });
  const urgentSoon = task({
    bizId: 'c',
    urgency: 'urgent',
    dueAt: '2026-10-11',
    bizType: 'leave_approval',
  });
  const normal = task({ bizId: 'd', urgency: 'normal', dueAt: null });

  it('默认按紧急度 → 到期日排序', () => {
    const sorted = sortTasks([normal, urgentLate, overdue, urgentSoon]);
    expect(sorted.map((item) => item.bizId)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('按 dueAt 排序时无到期日的排最后', () => {
    const sorted = sortTasks([normal, urgentLate, overdue, urgentSoon], 'dueAt');
    expect(sorted.map((item) => item.bizId)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('同紧急度同到期日时按类型与单号稳定排序（多次调用结果一致）', () => {
    const first = task({ bizId: 'x', bizType: 'purchase_approval', bizCode: 'PUR2026100002', urgency: 'normal' });
    const second = task({ bizId: 'y', bizType: 'purchase_approval', bizCode: 'PUR2026100001', urgency: 'normal' });
    const sortedOnce = sortTasks([first, second]).map((item) => item.bizCode);
    const sortedTwice = sortTasks([second, first]).map((item) => item.bizCode);
    expect(sortedOnce).toEqual(['PUR2026100001', 'PUR2026100002']);
    expect(sortedTwice).toEqual(sortedOnce);
  });

  it('不修改原数组', () => {
    const input = [normal, overdue];
    sortTasks(input);
    expect(input.map((item) => item.bizId)).toEqual(['d', 'a']);
  });
});

describe('C-08 角标汇总', () => {
  it('总数、各紧急度数量与按类型分布', () => {
    const summary = summarizeTasks([
      task({ bizId: '1', urgency: 'overdue' }),
      task({ bizId: '2', urgency: 'urgent' }),
      task({ bizId: '3', urgency: 'urgent', bizType: 'leave_approval', moduleLabel: '请假' }),
      task({ bizId: '4', urgency: 'normal', bizType: 'leave_approval', moduleLabel: '请假' }),
    ]);
    expect(summary.total).toBe(4);
    expect(summary.overdue).toBe(1);
    expect(summary.urgent).toBe(2);
    expect(summary.normal).toBe(1);
    // 与列表数量一致
    expect(summary.overdue + summary.urgent + summary.normal).toBe(summary.total);
    expect(summary.byType).toEqual([
      { bizType: 'leave_approval', label: '请假', count: 2 },
      { bizType: 'quotation_approval', label: '报价单', count: 2 },
    ]);
  });

  it('空列表返回全 0', () => {
    expect(summarizeTasks([])).toEqual({
      total: 0,
      overdue: 0,
      urgent: 0,
      normal: 0,
      byType: [],
    });
  });
});

describe('C-08 分页切片', () => {
  const items = Array.from({ length: 25 }, (_, index) => task({ bizId: String(index + 1) }));
  it('第 2 页取第 11~20 条', () => {
    expect(paginateTasks(items, 2, 10).map((item) => item.bizId)).toEqual([
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19',
      '20',
    ]);
  });
  it('越界页码返回空数组', () => {
    expect(paginateTasks(items, 99, 10)).toEqual([]);
  });
});
