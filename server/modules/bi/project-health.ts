import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import type { ProjectHealthLevel, ProjectStatus } from '@shared/api.interface';

dayjs.extend(utc);

/**
 * BI 看板 / 指标中心共用的**项目口径与项目财务健康判定**（纯函数，可单测）。
 *
 * ## 为什么要把这三件事从 service 里搬出来
 *
 * 1. **状态白名单曾经有两份、且其中一份是错的**。`bi.service.ts` 用
 *    `['initiating','executing']`、`bi-metrics.service.ts` 内联
 *    `('active','delivering','accepting')` —— 后者里的 `'active'` 是**合同**状态，
 *    不是项目状态（`ProjectStatus` 的取值见 shared/api.interface.ts）。
 *    后果：指标中心「在管项目数」「超预算项目数」**恒为 0**，而同一屏的经营看板
 *    「活跃项目」显示 2 —— 两个数出自同一份数据却互相矛盾，且不报错、不留痕
 *    （SQL `IN` 里出现不存在的枚举值不会报错，只是永远匹配不到）。
 *    现在两个 service 共用同一个常量，**白名单只有一处**。
 *
 * 2. **外推完工成本曾随服务器 TZ 环境变量漂移**。原实现
 *    `dayjs(project.endDate).utcOffset(8).diff(now, 'month', true)` 里的
 *    `dayjs('2027-04-15')` 按**进程本地时区**解释这个朴素日期串，而
 *    `.utcOffset(8)` 只改显示偏移、**不改时间点**。于是：
 *      · 服务器 TZ=Asia/Shanghai（本地开发）→ 解释为 2027-04-15T00:00+08；
 *      · 服务器 TZ=UTC（容器默认）→ 解释为 2027-04-15T00:00Z = 08:00+08，
 *        整整晚 8 小时 → `remainingMonths` 偏大 0.011 个月 → 单个项目的
 *        `projectedFinalCost` 偏大约 43 元（成本均价 4000/月时）。
 *    金额漂移本身还只是噪声，真正危险的是它**落在预算边界上**：
 *    `projectedFinalCost > budget` 的判定会随部署环境翻转，
 *    于是"超预算项目"的数量在同一份数据上因环境而异。
 *    修法：把日期串显式按业务时区补全成 `YYYY-MM-DDT00:00:00+08:00` 再解析，
 *    **完全不读进程 TZ**（见 `bizStartOfDay`）。
 *
 * 3. **健康等级优先级**（`unreachable > over_budget > watch > healthy`）是一条
 *    业务规则，不是实现细节：一个"预计总成本已低于已发生成本"的项目，即便
 *    外推也超预算，也必须报"目标不可达"（前者说的是**目标本身不成立**，
 *    后者只是**成本进度**问题，两者给管理层的动作完全不同）。
 *    判定顺序抽成纯函数后可以逐条断言，不再依赖生产库里恰好有样本。
 */

/**
 * 「在管项目」= `ProjectStatus` 里**尚未进入终态**的四个值。
 *
 * 终态只有 `closed`（已结项）与 `cancelled`（取消/终止）—— 见
 * `shared/api.interface.ts` 的 `ProjectStatus` 与
 * `server/modules/projects/projects.transform.ts` 的 `PROJECT_STATUS_FLOW`。
 *
 * ⚠️ 不加 `'active'`：那是 `ContractStatus` 的取值。写进来不会报错，
 * 只会让 `IN (...)` 永远匹配不到项目行 —— 这正是本轮修掉的缺陷。
 */
export const ACTIVE_PROJECT_STATUSES: readonly ProjectStatus[] = [
  'initiating',
  'executing',
  'delivering',
  'accepting',
];

/** 项目是否在管（未进入 closed / cancelled 终态） */
export function isActiveProjectStatus(
  status: string | null | undefined
): boolean {
  return ACTIVE_PROJECT_STATUSES.some((item: ProjectStatus) => item === status);
}

/**
 * 把 `YYYY-MM-DD` 的**业务日**解析成业务时区（Asia/Shanghai, +08）当天零点。
 *
 * 关键点：`dayjs(str)` 会按**进程时区**解释朴素日期串，因此这里显式拼接
 * `T00:00:00+08:00`，让解析结果与 `TZ` 环境变量无关（容器里通常是 UTC）。
 *
 * 传入 `Date` 或带时间的字符串时退回 dayjs 默认解析，避免制造新的分叉。
 */
export function bizStartOfDay(date: string | Date): dayjs.Dayjs {
  if (date instanceof Date) return dayjs(date);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(date);
  return dateOnly ? dayjs(`${date}T00:00:00+08:00`) : dayjs(date);
}

/**
 * 距 `endDate` 还剩几个月（可为小数），已过期记 0。
 *
 * `now` 必须由调用方传入（已按业务时区偏移构造），避免本函数内部再取一次
 * `new Date()` 导致同一次计算里出现两个"现在"。
 */
export function remainingMonthsUntil(
  endDate: string | Date | null,
  now: dayjs.Dayjs
): number {
  if (endDate === null) return 0;
  return Math.max(0, bizStartOfDay(endDate).diff(now, 'month', true));
}

/**
 * 按"近 3 月成本线性外推"估算完工成本。
 *
 * 已发生成本是**下界**：即便项目已过期（remainingMonths = 0）也不能低于它。
 */
export function projectedFinalCost(
  actualCost: number,
  monthlyAvgCost: number,
  remainingMonths: number
): number {
  return Math.max(actualCost, actualCost + monthlyAvgCost * remainingMonths);
}

export interface ProjectHealthInput {
  /** 项目预算（0 表示未设预算，不参与超支判定） */
  budget: number;
  /** 预计总成本（0 表示未填，不参与"目标不可达"判定） */
  estimatedTotalCost: number;
  /** 已发生成本 */
  actualCost: number;
  /** 外推完工成本 */
  projectedFinalCost: number;
}

export interface ProjectHealthVerdict {
  level: ProjectHealthLevel;
  reason: string | null;
  /** 计入汇总「预计超支项目」 */
  overBudget: boolean;
  /** 计入汇总「成本关注项目」 */
  watch: boolean;
}

/**
 * 健康等级判定，**优先级 unreachable > over_budget > watch > healthy**。
 *
 * - `unreachable`：预计总成本已经低于已发生成本 —— 目标自相矛盾，先修目标；
 * - `over_budget`：外推完工成本将超过预算 —— 成本进度问题；
 * - `watch`：已发生成本超过预算 90%；
 * - `healthy`：其余。
 *
 * 前两者互斥且 `unreachable` 优先：目标本身不成立时，"会不会超预算"已经没有
 * 讨论意义，把这类项目降级成 `over_budget` 会让管理层去砍成本而不是去改目标。
 */
export function classifyProjectHealth(
  input: ProjectHealthInput
): ProjectHealthVerdict {
  const { budget, estimatedTotalCost, actualCost, projectedFinalCost: projected } = input;
  if (estimatedTotalCost > 0 && estimatedTotalCost < actualCost) {
    return {
      level: 'unreachable',
      reason: '预计总成本低于已发生成本',
      overBudget: false,
      watch: false,
    };
  }
  if (budget > 0 && projected > budget) {
    return {
      level: 'over_budget',
      reason: '按当前成本进度外推将超出预算',
      overBudget: true,
      watch: false,
    };
  }
  if (budget > 0 && actualCost > budget * 0.9) {
    return {
      level: 'watch',
      reason: '已发生成本接近预算',
      overBudget: false,
      watch: true,
    };
  }
  return { level: 'healthy', reason: null, overBudget: false, watch: false };
}
