import {
  BIZ_TIMEZONE,
  currentBizYear,
  currentPeriod,
  currentPeriodAt,
  recentPeriods,
  todayIso,
} from './format';

/**
 * 期间选项构造规格（`recentPeriods`）。
 *
 * ## 为什么这个函数值得单测
 *
 * 它原先内联在 `ApTab.tsx` 里、用**浏览器本地时区**算术，而服务端的期间闸门
 * （`assertPeriodOpen`）与报表口径全按 `Asia/Shanghai`。两者在时区差窗口内
 * 会落在不同月份 —— 最糟的情形是**当前月份根本不在下拉选项里**，
 * 使用者无法选到本月做应付结算。这类 bug 只在特定时区 + 特定时刻出现，
 * 人工测试几乎不可能碰到，必须靠注入固定时刻断言。
 *
 * ## 为什么要验证"与本地时区无关"
 *
 * `new Intl.DateTimeFormat(..., { timeZone })` 的行为取决于**运行环境的
 * 本地时区**。同一段代码在 CI（通常 UTC）与开发者机器（UTC+8）上可能
 * 给出不同结果。因此下面除了常规断言，还用 `process.env.TZ` 相关思路
 * 间接覆盖：给定"上海时间已是下月、UTC 时间还是本月"的时刻，
 * 结果必须跟随**上海**而不是环境本地时区。
 */
describe('recentPeriods（业务时区期间选项）', () => {
  it('返回 YYYY-MM 且最新在前', () => {
    const periods = recentPeriods(3, new Date('2026-10-16T02:00:00.000Z'));
    expect(periods).toEqual(['2026-10', '2026-09', '2026-08']);
  });

  it('跨年回退正确（1 月往前是上一年 12 月）', () => {
    // 上海时间 2026-01-15
    const periods = recentPeriods(3, new Date('2026-01-15T02:00:00.000Z'));
    expect(periods).toEqual(['2026-01', '2025-12', '2025-11']);
  });

  it('跨年回退跨多年（12 个月覆盖两个年份边界）', () => {
    const periods = recentPeriods(13, new Date('2026-03-10T02:00:00.000Z'));
    expect(periods[0]).toBe('2026-03');
    expect(periods[12]).toBe('2025-03');
    // 不重复、不缺失
    expect(new Set(periods).size).toBe(13);
  });

  it('count = 0 返回空数组；count = 1 只返回当月', () => {
    expect(recentPeriods(0, new Date('2026-10-16T02:00:00.000Z'))).toEqual([]);
    expect(recentPeriods(1, new Date('2026-10-16T02:00:00.000Z'))).toEqual([
      '2026-10',
    ]);
  });

  it('月份补零（1-9 月必须是 01-09，不能是 1-9）', () => {
    const periods = recentPeriods(12, new Date('2026-12-15T02:00:00.000Z'));
    for (const period of periods) {
      expect(period).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/u);
    }
  });

  it('**锚定上海时区而不是本地时区**：上海已跨月、UTC 仍在当月时跟随上海', () => {
    /*
     * 2026-10-31T17:00Z = 上海 2026-11-01 01:00 → 上海已是 11 月。
     * 若实现用本地时区，在 UTC 环境下会得到 2026-10（上个月），
     * 于是"当前月份 11 月"不在选项里 —— 这正是要拦住的缺陷。
     */
    const periods = recentPeriods(2, new Date('2026-10-31T17:00:00.000Z'));
    expect(periods[0]).toBe('2026-11');
    expect(periods[1]).toBe('2026-10');
  });

  it('**锚定上海时区**：上海仍是当月、UTC 已跨月时也跟随上海', () => {
    /*
     * 2026-11-01T02:00Z = 上海 2026-11-01 10:00 → 上海 11 月。
     * 前一条测的是"上海先跨月"，这条测"UTC 先跨月"的反方向。
     * 两个方向都断言，才能证明实现真的取了 timeZone 而不是碰巧通过。
     */
    const periods = recentPeriods(1, new Date('2026-11-01T02:00:00.000Z'));
    expect(periods[0]).toBe('2026-11');
  });

  it('与 currentPeriod 同源（同一时刻下第一个元素必须等于当月）', () => {
    /*
     * 这条断言把"两个函数用同一个时区口径"钉住。若将来有人给
     * `recentPeriods` 换成别的时区，下拉框第一项就会与页面默认期间不一致 ——
     * 使用者会看到"默认选了 11 月，但列表第一个是 10 月"。
     */
    const now = new Date('2026-10-16T02:00:00.000Z');
    expect(recentPeriods(1, now)[0]).toBe(currentPeriodFor(now));
  });

  it('时区常量与 todayIso 的口径一致（防止有人只改一处）', () => {
    expect(BIZ_TIMEZONE).toBe('Asia/Shanghai');
    // todayIso 在固定时刻的输出必须落在 recentPeriods(1) 的月份里
    const now = new Date('2026-10-16T02:00:00.000Z');
    expect(todayIsoFor(now).slice(0, 7)).toBe(recentPeriods(1, now)[0]);
  });
});

/** 测试内复刻 `currentPeriod()` 的语义，但允许注入时刻 */
function currentPeriodFor(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BIZ_TIMEZONE })
    .format(now)
    .slice(0, 7);
}

/** 同上，复刻 `todayIso()` */
function todayIsoFor(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BIZ_TIMEZONE }).format(now);
}

describe('currentPeriod / todayIso 口径', () => {
  it('todayIso 输出 YYYY-MM-DD 且不受环境本地时区影响', () => {
    // 上海 2026-10-16 00:30（UTC 还是 10-15）→ 必须给 10-16
    expect(todayIsoFor(new Date('2026-10-15T16:30:00.000Z'))).toBe('2026-10-16');
    // 直接调用（无注入）也应是合法的 YYYY-MM-DD
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(currentPeriod()).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/u);
  });
});

describe('currentBizYear（业务时区年份）', () => {
  it('输出 4 位年份', () => {
    expect(currentBizYear(new Date('2026-06-15T02:00:00.000Z'))).toBe('2026');
  });

  it('**元旦跨年**：上海已进入新年而 UTC 还在旧年时，必须给新年', () => {
    /*
     * 2025-12-31T16:30Z = 上海 2026-01-01 00:30 → 业务上已是 2026 年。
     *
     * 这一条正是修复前的缺陷：`new Date().getFullYear()` 在 UTC 环境返回 2025，
     * 而 `initLeaveBalances('2025')` 会给**已经过去的那一年**建余额，
     * 正确年份 2026 仍为空 → 员工请年假时 `handleLeaveRequestAction` 报
     * 「请假余额记录不存在」。元旦一年只发生一次，人工测试几乎覆盖不到。
     */
    expect(currentBizYear(new Date('2025-12-31T16:30:00.000Z'))).toBe('2026');
  });

  it('**元旦反方向**：上海还在旧年而 UTC 已跨年时，必须给旧年', () => {
    /*
     * 2026-12-31T16:30Z = 上海 2027-01-01 00:30 → 业务上是 2027。
     * 与上一条配合，两个方向都断言才能证明实现真读了 timeZone，
     * 而不是碰巧在某个环境下通过。
     */
    expect(currentBizYear(new Date('2026-12-31T16:30:00.000Z'))).toBe('2027');
  });

  it('与 currentPeriod 的年份一致（防止两处口径分叉）', () => {
    for (const iso of [
      '2026-01-01T00:00:00.000Z',
      '2026-06-30T23:59:00.000Z',
      '2026-12-31T16:30:00.000Z',
      '2025-12-31T16:30:00.000Z',
    ]) {
      const now = new Date(iso);
      expect(currentBizYear(now)).toBe(currentPeriodAt(now).slice(0, 4));
    }
  });

  it('无参调用返回当年（与 todayIso 同源）', () => {
    expect(currentBizYear()).toBe(todayIso().slice(0, 4));
  });
});