/** 业务时区（Asia/Shanghai）今天的日期，格式 YYYY-MM-DD */
export function todayInShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
  }).format(new Date());
}

/** 业务时区当前月份，格式 YYYY-MM */
export function monthInShanghai(): string {
  return todayInShanghai().slice(0, 7);
}

/**
 * 在业务时区日期上加减天数，返回 YYYY-MM-DD。
 *
 * 为什么不用 `new Date()` + `setDate()`：那走服务器本地时区，再用 `toISOString()`
 * 转 UTC 会在 UTC+8 的 00:00–08:00 之间把日期减掉一天（账期/到期日漂移一天，
 * 直接污染账龄分桶与逾期标记）。这里以日期字符串做纯 UTC 日期算术，不引入时区。
 */
export function addDaysInShanghai(days: number, base = todayInShanghai()): string {
  const [year, month, day] = base.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
