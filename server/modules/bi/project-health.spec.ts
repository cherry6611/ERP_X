import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  ACTIVE_PROJECT_STATUSES,
  bizStartOfDay,
  classifyProjectHealth,
  isActiveProjectStatus,
  projectedFinalCost,
  remainingMonthsUntil,
} from './project-health';

dayjs.extend(utc);

/** 全部 ProjectStatus（与 shared/api.interface.ts 的联合类型逐字一致） */
const ALL_PROJECT_STATUSES = [
  'initiating',
  'executing',
  'delivering',
  'accepting',
  'closed',
  'cancelled',
] as const;

describe('project-health：在管项目状态白名单', () => {
  it('恰好覆盖四个非终态，且不含 closed / cancelled', () => {
    expect([...ACTIVE_PROJECT_STATUSES].sort()).toEqual(
      ['accepting', 'delivering', 'executing', 'initiating'].sort()
    );
    expect(ACTIVE_PROJECT_STATUSES).not.toContain('closed');
    expect(ACTIVE_PROJECT_STATUSES).not.toContain('cancelled');
  });

  it('每个 ProjectStatus 的归类都不漏（白名单 ∪ 终态 = 全量）', () => {
    const covered = new Set<string>([
      ...ACTIVE_PROJECT_STATUSES,
      'closed',
      'cancelled',
    ]);
    expect([...covered].sort()).toEqual([...ALL_PROJECT_STATUSES].sort());
  });

  it('⚠️ 回归：不得把合同状态 active 当成项目状态', () => {
    // 这正是本轮修掉的缺陷：指标中心内联 ('active','delivering','accepting')，
    // 'active' 在 erp_project.status 里从不出现 → 指标恒为 0。
    expect(ACTIVE_PROJECT_STATUSES).not.toContain('active');
    expect(isActiveProjectStatus('active')).toBe(false);
  });

  it('isActiveProjectStatus 对四个在管状态为真、终态为假、空值为假', () => {
    for (const status of ACTIVE_PROJECT_STATUSES) {
      expect(isActiveProjectStatus(status)).toBe(true);
    }
    expect(isActiveProjectStatus('closed')).toBe(false);
    expect(isActiveProjectStatus('cancelled')).toBe(false);
    expect(isActiveProjectStatus(null)).toBe(false);
    expect(isActiveProjectStatus(undefined)).toBe(false);
  });
});

describe('project-health：业务时区日期解析（不得随进程 TZ 漂移）', () => {
  it('bizStartOfDay 把 YYYY-MM-DD 解释为 +08 当天零点', () => {
    const parsed = bizStartOfDay('2027-04-15');
    expect(parsed.format('YYYY-MM-DDTHH:mm:ssZ')).toBe('2027-04-15T00:00:00+08:00');
    expect(parsed.toISOString()).toBe('2027-04-14T16:00:00.000Z');
  });

  it('⚠️ 回归：与"朴素串按进程时区解释"的旧写法不同（容器 TZ=UTC 时差 8 小时）', () => {
    // 旧实现 `dayjs(str).utcOffset(8)`：在 TZ=Asia/Shanghai 下等于本函数结果，
    // 但在 TZ=UTC 下会晚 8 小时 → remainingMonths 偏大、外推成本偏高。
    const fixed = bizStartOfDay('2027-04-15');
    const explicitBizMidnight = dayjs('2027-04-15T00:00:00+08:00');
    expect(fixed.valueOf()).toBe(explicitBizMidnight.valueOf());
    // 断言"按 UTC 解释"的那个瞬间**不等于**本函数结果（时间点确实不同）
    const asIfUtc = dayjs('2027-04-15T00:00:00Z');
    expect(fixed.valueOf()).not.toBe(asIfUtc.valueOf());
  });
});

describe('project-health：剩余月份与外推完工成本', () => {
  const now = dayjs('2026-10-17T03:00:00+08:00');

  it('endDate 为 null → 0 个月', () => {
    expect(remainingMonthsUntil(null, now)).toBe(0);
  });

  it('已过期的 endDate → 0（不返回负数）', () => {
    expect(remainingMonthsUntil('2026-01-01', now)).toBe(0);
  });

  it('未到期的 endDate → 正的小数月数', () => {
    const months = remainingMonthsUntil('2027-04-15', now);
    expect(months).toBeGreaterThan(5.9);
    expect(months).toBeLessThan(6);
  });

  it('外推完工成本 = 已发生 + 月均 × 剩余月，且以已发生为下界', () => {
    expect(projectedFinalCost(12000, 4000, 5)).toBe(32000);
    expect(projectedFinalCost(12000, 4000, 0)).toBe(12000);
    // 月均为 0（近 3 月无成本）时不应低于已发生成本
    expect(projectedFinalCost(5000, 0, 10)).toBe(5000);
  });

  it('组合口径：12k 已发生 + 4k/月 + 6 个月 = 36k', () => {
    const months = remainingMonthsUntil('2027-04-15', now);
    const projected = projectedFinalCost(12000, 4000, months);
    expect(projected).toBeGreaterThan(35000);
    expect(projected).toBeLessThan(36000);
  });
});

describe('project-health：健康等级优先级 unreachable > over_budget > watch > healthy', () => {
  it('healthy：预算充裕且成本远离预算', () => {
    expect(
      classifyProjectHealth({
        budget: 80000,
        estimatedTotalCost: 56000,
        actualCost: 12000,
        projectedFinalCost: 35724,
      })
    ).toEqual({ level: 'healthy', reason: null, overBudget: false, watch: false });
  });

  it('watch：已发生成本 > 预算 × 0.9', () => {
    const v = classifyProjectHealth({
      budget: 10000,
      estimatedTotalCost: 0,
      actualCost: 9500,
      projectedFinalCost: 9500,
    });
    expect(v.level).toBe('watch');
    expect(v.watch).toBe(true);
    expect(v.overBudget).toBe(false);
  });

  it('over_budget：外推完工成本 > 预算', () => {
    const v = classifyProjectHealth({
      budget: 10000,
      estimatedTotalCost: 50000,
      actualCost: 2000,
      projectedFinalCost: 12000,
    });
    expect(v.level).toBe('over_budget');
    expect(v.overBudget).toBe(true);
    expect(v.watch).toBe(false);
  });

  it('⚠️ 优先级：unreachable 与 over_budget 同时成立时取 unreachable', () => {
    const v = classifyProjectHealth({
      budget: 1000,
      estimatedTotalCost: 500,
      actualCost: 2000,
      projectedFinalCost: 9000,
    });
    expect(v.level).toBe('unreachable');
    // 目标不可达**不**计入"预计超支项目"汇总，避免两个统计口径重复报同一件事
    expect(v.overBudget).toBe(false);
    expect(v.watch).toBe(false);
    expect(v.reason).toBe('预计总成本低于已发生成本');
  });

  it('⚠️ 优先级：unreachable 优于 watch', () => {
    const v = classifyProjectHealth({
      budget: 1000,
      estimatedTotalCost: 500,
      actualCost: 2000,
      projectedFinalCost: 2000,
    });
    expect(v.level).toBe('unreachable');
  });

  it('⚠️ 优先级：over_budget 优于 watch（已发生 95% 预算但外推超预算）', () => {
    const v = classifyProjectHealth({
      budget: 10000,
      estimatedTotalCost: 0,
      actualCost: 9500,
      projectedFinalCost: 13000,
    });
    expect(v.level).toBe('over_budget');
  });

  it('未设预算（budget = 0）时不判 watch / over_budget', () => {
    expect(
      classifyProjectHealth({
        budget: 0,
        estimatedTotalCost: 0,
        actualCost: 999999,
        projectedFinalCost: 999999,
      }).level
    ).toBe('healthy');
  });

  it('未填预计总成本（estimatedTotalCost = 0）时不判 unreachable', () => {
    expect(
      classifyProjectHealth({
        budget: 100000,
        estimatedTotalCost: 0,
        actualCost: 5000,
        projectedFinalCost: 5000,
      }).level
    ).toBe('healthy');
  });

  it('边界：actualCost 恰等于 budget × 0.9 时不算 watch（严格大于）', () => {
    expect(
      classifyProjectHealth({
        budget: 10000,
        estimatedTotalCost: 0,
        actualCost: 9000,
        projectedFinalCost: 9000,
      }).level
    ).toBe('healthy');
  });
});
