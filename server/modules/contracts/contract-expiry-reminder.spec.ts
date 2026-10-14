import { addDays, daysBetween } from '@server/modules/contracts/contract-expiry-reminder.service';

/**
 * C-10 合同到期提醒的日期运算单测。
 *
 * 为什么专门测这两行：提醒是**精确匹配目标日期**实现的
 * （`end_date = today + N`），因此日期运算错一天就意味着一份合同
 * 永远收不到提醒 —— 而且不会报错，只是静默漏掉。
 * 跨月/跨年/闰年是最容易写错的地方。
 */
describe('C-10 合同到期提醒日期运算', () => {
  describe('addDays', () => {
    it('月内加法', () => {
      expect(addDays('2026-10-14', 30)).toBe('2026-11-13');
      expect(addDays('2026-10-14', 3)).toBe('2026-10-17');
    });

    it('跨月', () => {
      expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
      expect(addDays('2026-10-31', 15)).toBe('2026-11-15');
    });

    it('跨年', () => {
      expect(addDays('2026-12-20', 15)).toBe('2027-01-04');
      expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    });

    it('闰年 2 月', () => {
      // 2028 是闰年
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
      expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
      // 2026 不是闰年
      expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    });

    it('加 0 天返回原日期（不改动）', () => {
      expect(addDays('2026-10-14', 0)).toBe('2026-10-14');
    });

    it('负数天数（往过去推）', () => {
      expect(addDays('2026-10-14', -14)).toBe('2026-09-30');
      expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    });

    it('结果始终为 YYYY-MM-DD 零填充格式（否则 SQL 精确匹配会失败）', () => {
      const result = addDays('2026-01-01', 5);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(addDays('2026-10-05', 1)).toBe('2026-10-06');
      expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    });
  });

  describe('daysBetween', () => {
    it('同日为 0', () => {
      expect(daysBetween('2026-10-14', '2026-10-14')).toBe(0);
    });

    it('到期日在未来为正数（剩余天数）', () => {
      expect(daysBetween('2026-10-14', '2026-11-13')).toBe(30);
    });

    it('已过期为负数（逾期天数）', () => {
      expect(daysBetween('2026-10-14', '2026-10-04')).toBe(-10);
    });

    it('跨年', () => {
      expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    });

    it('闰年跨度（2028-02-28 → 2028-03-01 = 2 天，因为有 2/29）', () => {
      expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
      // 非闰年同区间只有 1 天
      expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    });

    it('与 addDays 互逆（提醒的精确匹配依赖这一点）', () => {
      for (const days of [3, 15, 30]) {
        const today = '2026-10-14';
        expect(daysBetween(today, addDays(today, days))).toBe(days);
      }
    });
  });
});
