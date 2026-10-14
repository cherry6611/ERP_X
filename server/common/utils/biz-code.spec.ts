import { buildDateSegment } from './biz-code';
import { shanghaiYearMonthForTest } from './biz-code-time';
import { invalidateCodeRuleCache } from './biz-code';

describe('biz code month key', () => {
  it('formats Asia/Shanghai year-month', () => {
    const { year, month } = shanghaiYearMonthForTest(
      new Date('2026-01-01T02:00:00.000Z'),
    );
    // UTC 02:00 = 上海 10:00，仍为 1 月
    expect(year).toBe(2026);
    expect(month).toBe('01');
  });

  it('crosses into next Shanghai day near UTC midnight boundary', () => {
    // UTC 2026-01-31 20:00 = 上海 2026-02-01 04:00 → 二月
    const { year, month } = shanghaiYearMonthForTest(
      new Date('2026-01-31T20:00:00.000Z'),
    );
    expect(year).toBe(2026);
    expect(month).toBe('02');
  });
});

describe('B-08 编号规则：日期段（buildDateSegment）', () => {
  const now = new Date('2026-10-14T02:00:00.000Z');

  it('YYYYMM 输出年月', () => {
    expect(buildDateSegment('YYYYMM', now)).toBe('202610');
  });

  it('YYYY 只输出年份', () => {
    expect(buildDateSegment('YYYY', now)).toBe('2026');
  });

  it('NONE 不输出日期段（编号连续）', () => {
    expect(buildDateSegment('NONE', now)).toBe('');
  });

  it('跨月/跨年时日期段随之变化（天然实现按期间重置流水）', () => {
    expect(buildDateSegment('YYYYMM', new Date('2026-10-31T20:00:00.000Z'))).toBe('202611');
    expect(buildDateSegment('YYYYMM', new Date('2026-12-31T20:00:00.000Z'))).toBe('202701');
    expect(buildDateSegment('YYYY', new Date('2026-12-31T20:00:00.000Z'))).toBe('2027');
  });
});

describe('B-08 编号规则缓存失效', () => {
  it('invalidateCodeRuleCache 可重复调用且不抛错', () => {
    expect(() => {
      invalidateCodeRuleCache();
      invalidateCodeRuleCache();
    }).not.toThrow();
  });
});
