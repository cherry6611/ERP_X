/** 业务时区（Asia/Shanghai）今天的日期，格式 YYYY-MM-DD */
export function todayInShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
  }).format(new Date());
}
