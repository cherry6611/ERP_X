/**
 * 期末年结的**期间工具**（从 `year-end.service.ts` 抽出，§5.9）。
 *
 * ## 为什么这三行值得单独成文件
 *
 * 它们是年结的**入口闸门**，错了会造成"跨年错账"这类不可逆后果：
 *
 * ① `assertPeriod`：期间格式是 `YYYY-MM`。若不校验，`'2026-13'` / `'2026-1'`
 *    会被 `yearOf` 静默截成 `2026`，于是**非法期间也能过闸门**，
 *    结转凭证落到一个不存在的月份上（`Date.UTC(2026, 13, 0)` 会滚到 2027-01）。
 *
 * ② `lastDayOfMonth`：结转凭证的记账日取"该月最后一天"。
 *    用 `Date.UTC(year, month, 0)` 取上个月末是**刻意**的写法（月份从 0 起算，
 *    传入 `month` 即下月，第 0 天 = 本月最后一天）。它顺带正确处理闰年 2 月。
 *    若写成 `new Date(year, month, 0)`（本地时间），服务器时区非东八区时
 *    会偏一天 —— 年结凭证的记账日落到上月最后一天或次月 1 号，**跨期**。
 *
 * ③ `yearOf`：只取前 4 位。这里依赖 ① 已保证格式，所以两个函数必须一起用
 *    （单独用 `yearOf('2026')` 会得到 2026 而毫无提示）。
 *
 * 三者都是纯字符串/日期运算，可被完全断言。
 */

/** 期间格式：`YYYY-MM`，月份 01–12 */
export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 期间格式不合法时的提示（与 `year-end.service.ts` 的 `assertPeriod` 文案一致）。
 *
 * ⚠️ **实测结论（2026-10-17）**：走 HTTP 请求时，非法期间在 **DTO 层**
 * （`@Matches(/^\d{4}-(0[1-9]|1[0-2])$/)`）就被拦下，返回的是
 * `period 必填且格式为 YYYY-MM`，**根本走不到 service 的 `assertPeriod`**。
 * 我用 4 个非法期间（`2026-13` / `2026-1` / `2026` / `abcd-ef`）打过接口，
 * 全部是 `[DTO(@Matches)]` 拦截。
 *
 * 所以这条 service 侧守卫当前是**纵深防御**（供内部调用/未来接入点使用），
 * 不是 HTTP 路径上的第一道闸门。两层都用同一个正则，避免口径分叉 ——
 * 这也解释了为什么本文件导出的 `PERIOD_PATTERN` 必须与 DTO 的 `@Matches` 一致。
 */
export const PERIOD_FORMAT_MESSAGE = '期间格式必须为 YYYY-MM';

/**
 * 期间是否合法。
 *
 * ⚠️ 只认 `YYYY-MM` 且月份两位 01–12：`'2026-1'`（一位）与 `'2026-13'` 都判非法。
 * 放行 `'2026-13'` 会让 `lastDayOfMonth` 滚到次年 1 月，结转凭证跨年。
 */
export function isValidPeriod(period: string | null | undefined): boolean {
  return typeof period === 'string' && PERIOD_PATTERN.test(period);
}

/** 取期间所属年度（**调用前必须已确认格式合法**，见文件头 ③） */
export function yearOfPeriod(period: string): number {
  return Number(period.slice(0, 4));
}

/**
 * 期间的最后一天，返回 `YYYY-MM-DD`。
 *
 * 用 UTC 构造避免服务器时区影响（详见文件头 ②）：
 * `Date.UTC(y, m, 0)` —— 月份从 0 起算，第 `m` 月的第 0 天 = 第 `m-1` 月最后一天。
 * 闰年 2 月会自动得 29。
 */
export function lastDayOfMonth(period: string): string {
  const [yearText, monthText] = period.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${yearText}-${monthText}-${String(lastDay).padStart(2, '0')}`;
}
