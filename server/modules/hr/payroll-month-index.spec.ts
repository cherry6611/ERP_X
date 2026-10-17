import { employmentMonthIndex } from './payroll-month-index';

describe('employmentMonthIndex：累计减除费用的任职月份数', () => {
  it('年中入职：7 月入职算 10 月工资 → 4 个月', () => {
    expect(employmentMonthIndex('2026-10', '2026-07-01')).toBe(4);
    expect(employmentMonthIndex('2026-07', '2026-07-15')).toBe(1);
    expect(employmentMonthIndex('2026-12', '2026-07-31')).toBe(6);
  });

  it('入职年早于工资年 → 按自然月', () => {
    expect(employmentMonthIndex('2026-10', '2025-03-01')).toBe(10);
    expect(employmentMonthIndex('2026-01', '2024-12-01')).toBe(1);
  });

  it('入职年晚于工资年：异常档案，保持自然月（由 HR 先修正）', () => {
    expect(employmentMonthIndex('2026-10', '2027-01-01')).toBe(10);
  });

  it('缺少/非法 hire_date → 自然月，不抛错', () => {
    expect(employmentMonthIndex('2026-10', null)).toBe(10);
    expect(employmentMonthIndex('2026-10', undefined)).toBe(10);
    expect(employmentMonthIndex('2026-10', '')).toBe(10);
    expect(employmentMonthIndex('2026-10', 'not-a-date')).toBe(10);
  });

  it('非法期间 → 至少 1，不产生 0/NaN', () => {
    expect(employmentMonthIndex('bad', null)).toBe(1);
    expect(employmentMonthIndex('2026-00', null)).toBe(1);
  });
});
