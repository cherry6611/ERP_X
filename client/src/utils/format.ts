export function formatMoney(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  return n.toLocaleString('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatNumber(value: number | null | undefined): string {
  return Number(value ?? 0).toLocaleString('zh-CN');
}

export function formatPercent(value: number | null | undefined): string {
  return `${Number(value ?? 0).toFixed(2)}%`;
}

/**
 * 业务时区：全系统会计日历统一按 Asia/Shanghai 计算。
 *
 * 与 `server/common/utils/biz-date.ts` 保持同一口径，避免出现"客户端算一天、
 * 服务端算另一天"的账期分裂。
 */
export const BIZ_TIMEZONE = 'Asia/Shanghai';

/**
 * 业务时区（Asia/Shanghai）今天的日期，格式 YYYY-MM-DD。
 *
 * 为什么不能直接取本地时区：`new Date().getFullYear()` 等走的是**浏览器本地时区**，
 * 而服务端所有期间闸门（月结/年结 `assertPeriodOpen`）与报表口径都按 Asia/Shanghai。
 * 跨时区用户（如 UTC）在北京时间 00:00–08:00 之间会拿到**前一天**，
 * 与服务端判定不一致 —— 表现为"今天开的凭证被判到上个月"这类账期漂移。
 * 这里统一用 `Intl.DateTimeFormat('en-CA', { timeZone })` 输出 YYYY-MM-DD。
 */
export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BIZ_TIMEZONE,
  }).format(new Date());
}

/** 业务时区当前月份，格式 YYYY-MM（同上，统一 Shanghai 口径） */
export function currentPeriod(): string {
  return todayIso().slice(0, 7);
}

/**
 * 业务时区当前年份，格式 `YYYY`（同上，统一 Shanghai 口径）。
 *
 * ## 为什么必须用它而不是 `new Date().getFullYear()`
 *
 * 与 `todayIso` / `recentPeriods` 同一类问题，但**后果更具体**：
 * `getFullYear()` 走浏览器本地时区，跨时区用户在**元旦前后**会拿到上一年
 * 或下一年。而这些年的值会被送到服务端做**按年分档**的写入：
 *
 *   · `hrApi.initLeaveBalances(year)` —— 年假余额是 `hr_leave_balance`
 *     里按 `(员工, 假期类型, 年)` 唯一的一行。传错年份会**给错的年份建余额**，
 *     而正确年份仍然为空 → 员工请年假时"余额记录不存在"，审批直接失败
 *     （`handleLeaveRequestAction` 里 `balanceRows.length === 0` 抛错）。
 *     更麻烦的是错误年份那一行已经落库，需要人工清理。
 *   · 预算年 / 考勤年同理：页面默认年与服务端口径不一致，
 *     表现为"默认选中的年份查不到数据"。
 *
 * 元旦是唯一会出错的时间窗，因此这类缺陷**一年只出现一次、且极难复现** ——
 * 正是必须靠 `Intl` 显式指定时区、而不是靠人记住的那种。
 */
export function currentBizYear(now: Date = new Date()): string {
  return todayIsoAt(now).slice(0, 4);
}

/**
 * `todayIso` 的**可注入时刻**版本。
 *
 * 抽出来是为了让依赖"今天"的逻辑可被单测覆盖 —— `todayIso()` 直接读
 * `new Date()`，测试无法控制它，于是跨时区/跨年的分支只能靠人工在特定时刻验证。
 * 生产代码继续用 `todayIso()`（无参），测试用 `todayIsoAt(fixed)`。
 */
export function todayIsoAt(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BIZ_TIMEZONE,
  }).format(now);
}

/** `currentPeriod` 的可注入时刻版本（同上，便于测试） */
export function currentPeriodAt(now: Date): string {
  return todayIsoAt(now).slice(0, 7);
}

/**
 * 近 N 个月（含当月）的期间选项，格式 `YYYY-MM`，**最新在前**。
 *
 * ## 为什么必须锚定业务时区（这里原先有个真实 bug）
 *
 * 原实现内联在 `ApTab.tsx` 里，用的是**浏览器本地时区**：
 * ```ts
 * const now = new Date();
 * new Date(now.getFullYear(), now.getMonth() - i, 1)   // ← 本地时区
 * ```
 * 而服务端的期间闸门（月结 / 年结 `assertPeriodOpen`）与报表口径全按
 * Asia/Shanghai。两者在**月初/月末的时区差窗口**内会落在不同月份：
 *
 * | 场景 | 本地时区 | 本地月份 | 上海月份 | 后果 |
 * |---|---|---|---|---|
 * | 上海 11-01 00:30 | UTC-5（纽约） | **10 月** | 11 月 | 列表头是 10 月，**缺当前 11 月** |
 * | 上海 10-31 23:30 | UTC+9（东京） | **11 月** | 10 月 | 列表头是 11 月，而服务端说 10 月未结 |
 *
 * 第一种情形最糟：**当前月份根本不在选项里**，使用者无法选到本月。
 *
 * ## 实现：用 `Intl` 在业务时区取"年-月"，再按月做字符串算术
 *
 * 不用 `new Date(y, m - i, 1)` 做减法 —— 那需要先把上海的年月塞进本地
 * `Date`，而跨时区时"塞进去"这一步本身就会偏。改为在**上海时区**读出
 * 当前年月，然后用纯整数运算回退月份（月份只有 12 个，取模即可），
 * 全程不经过 `Date` 的时区转换。这样结果与浏览器所在时区**完全无关**。
 *
 * @param count 需要多少个月（含当月）；传 0 返回空数组
 * @param now   基准时刻，仅测试注入用；缺省为当前时间
 */
export function recentPeriods(count: number, now: Date = new Date()): string[] {
  // 在业务时区读出 "YYYY-MM"
  const current = new Intl.DateTimeFormat('en-CA', {
    timeZone: BIZ_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  })
    .format(now)
    .slice(0, 7);
  const year = Number(current.slice(0, 4));
  const month = Number(current.slice(5, 7));

  const periods: string[] = [];
  for (let i = 0; i < count; i += 1) {
    /*
     * 纯整数回退：把 "年*12 + (月-1)" 当作绝对月序号再做减法。
     * 直接对 month 做减法需要处理跨年借位与 0 月，容易写错。
     */
    const absolute = year * 12 + (month - 1) - i;
    const y = Math.floor(absolute / 12);
    const m = (absolute % 12) + 1;
    periods.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return periods;
}
