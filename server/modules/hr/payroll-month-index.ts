/**
 * 工资个税累计减除费用使用的"任职月份数"。
 *
 * 国家税务总局公告 2018 年第 61 号：
 *   累计减除费用 = 5000 元/月 × 纳税人当年截至本月在本单位的任职受雇月份数。
 *
 * 例：2026-07 入职、计算 2026-10 工资 → 4 个月（7/8/9/10），不是 10 个月。
 * 入职年早于工资年 → 按自然月；入职年晚于工资年 → 属异常档案，保持自然月
 * 让 HR 先修正 hire_date，而不是静默少扣/多扣。
 */
export function employmentMonthIndex(
  period: string,
  hireDate: string | null | undefined,
): number {
  const year = Number(period.slice(0, 4));
  const calendarMonth = Number(period.slice(5, 7));
  if (!Number.isFinite(calendarMonth) || calendarMonth < 1 || calendarMonth > 12) {
    return 1;
  }
  const parts = (hireDate ?? '').split('-').map(Number);
  const hireYear = parts[0];
  const hireMonth = parts[1];
  if (hireYear !== year || !Number.isFinite(hireMonth) || hireMonth < 1 || hireMonth > 12) {
    return calendarMonth;
  }
  return Math.max(1, calendarMonth - hireMonth + 1);
}
