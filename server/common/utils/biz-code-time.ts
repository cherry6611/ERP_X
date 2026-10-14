/** 供 generateBizCode 与单测共用的上海年月计算 */
export function shanghaiYearMonth(now: Date = new Date()): {
  year: number;
  month: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = Number(
    parts.find((p) => p.type === 'year')?.value ?? now.getFullYear(),
  );
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  return { year, month };
}

export const shanghaiYearMonthForTest = shanghaiYearMonth;
