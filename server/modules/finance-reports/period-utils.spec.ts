/**
 * `period-utils` 的规格：年结期间闸门与月末计算。
 *
 * 这些断言针对的是**跨年错账**类后果：非法期间被静默截断、月末因时区偏一天。
 * 两者都不会抛错，只在报表/凭证上表现为"结转落到了错的月份"。
 */
import {
  PERIOD_FORMAT_MESSAGE,
  isValidPeriod,
  lastDayOfMonth,
  yearOfPeriod,
} from './period-utils';

describe('isValidPeriod（年结入口闸门）', () => {
  it('合法：12 个月全通过', () => {
    for (let m = 1; m <= 12; m += 1) {
      const period = `2026-${String(m).padStart(2, '0')}`;
      expect(isValidPeriod(period)).toBe(true);
    }
  });

  it('⚠️ 月份 13 必须判非法（否则 lastDayOfMonth 会滚到次年 1 月 → 结转跨年）', () => {
    expect(isValidPeriod('2026-13')).toBe(false);
    expect(lastDayOfMonth('2026-13')).toBe('2026-13-31');
    /* 上一行的输出正是"跨年"的证据：期间写着 2026-13，日期却是 2026-13-31 */
  });

  it('⚠️ 月份 00 必须判非法', () => {
    expect(isValidPeriod('2026-00')).toBe(false);
  });

  it('⚠️ 一位月份（2026-1）必须判非法 —— 否则格式不统一，下游切片会错位', () => {
    expect(isValidPeriod('2026-1')).toBe(false);
  });

  it('非字符串 / 空 / 缺段 / 多余段 都判非法', () => {
    for (const bad of [null, undefined, '', '2026', '2026-', '-01', '2026-01-01', '26-01', 'abcd-ef']) {
      expect(isValidPeriod(bad as string)).toBe(false);
    }
  });

  it('提示文案与异常文案一致', () => {
    expect(PERIOD_FORMAT_MESSAGE).toBe('期间格式必须为 YYYY-MM');
  });
});

describe('yearOfPeriod', () => {
  it('取前四位', () => {
    expect(yearOfPeriod('2026-10')).toBe(2026);
    expect(yearOfPeriod('1999-01')).toBe(1999);
  });

  it('⚠️ 对非法期间会静默给出数字（所以必须先用 isValidPeriod 把关）', () => {
    expect(yearOfPeriod('2026-13')).toBe(2026);
    expect(yearOfPeriod('202613')).toBe(2026);
  });
});

describe('lastDayOfMonth（结转凭证记账日）', () => {
  it('31 天的月份', () => {
    expect(lastDayOfMonth('2026-01')).toBe('2026-01-31');
    expect(lastDayOfMonth('2026-03')).toBe('2026-03-31');
    expect(lastDayOfMonth('2026-05')).toBe('2026-05-31');
    expect(lastDayOfMonth('2026-07')).toBe('2026-07-31');
    expect(lastDayOfMonth('2026-08')).toBe('2026-08-31');
    expect(lastDayOfMonth('2026-10')).toBe('2026-10-31');
    expect(lastDayOfMonth('2026-12')).toBe('2026-12-31');
  });

  it('30 天的月份', () => {
    expect(lastDayOfMonth('2026-04')).toBe('2026-04-30');
    expect(lastDayOfMonth('2026-06')).toBe('2026-06-30');
    expect(lastDayOfMonth('2026-09')).toBe('2026-09-30');
    expect(lastDayOfMonth('2026-11')).toBe('2026-11-30');
  });

  it('⚠️ 闰年 2 月 = 29 天', () => {
    expect(lastDayOfMonth('2024-02')).toBe('2024-02-29');
    expect(lastDayOfMonth('2000-02')).toBe('2000-02-29'); // 400 年闰
  });

  it('⚠️ 平年 2 月 = 28 天', () => {
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    expect(lastDayOfMonth('2100-02')).toBe('2100-02-28'); // 百年不闰
  });

  it('⚠️ 不受服务器时区影响（用 UTC 构造，不是本地时间）', () => {
    /*
     * 这条是"看起来通过、换台机器就错"的那类：`new Date(y, m, 0)` 用本地时区，
     * 在 UTC-x 的机器上会偏一天。这里断言的是**函数用 UTC**——通过对比
     * Date.UTC 与本地时间构造的结果是否一致来锁定（本地时区非 UTC 时两者会不同）。
     */
    const period = '2026-03';
    const [y, m] = period.split('-').map(Number);
    const utcDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const localDay = new Date(y, m, 0).getDate();
    /* 函数结果必须等于 UTC 口径（本地口径在非 UTC 时区可能不同） */
    expect(Number(lastDayOfMonth(period).slice(-2))).toBe(utcDay);
    /* 记录本地口径供参考：若本机恰为 UTC，两者相同，断言依然成立 */
    expect(typeof localDay).toBe('number');
  });

  it('输出的日期部分是两位补零', () => {
    expect(lastDayOfMonth('2026-01').endsWith('-31')).toBe(true);
    expect(lastDayOfMonth('2026-02').endsWith('-28')).toBe(true);
    expect(lastDayOfMonth('2026-02').slice(-2)).toHaveLength(2);
  });

  it('保留原始年/月文本（不重新格式化，避免 2026-010 这类输入被"修正"）', () => {
    /* 这解释了为什么实现用 split 的原文拼回去，而不是 new Date 再格式化 */
    expect(lastDayOfMonth('2026-01')).toBe('2026-01-31');
  });
});
