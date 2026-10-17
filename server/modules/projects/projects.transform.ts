import type {
  Project,
  ProjectStatus,
  ProjectStatusAction,
} from '@shared/api.interface';

export interface ProjectRowLike {
  id: string;
  code: string;
  name: string;
  contractId: string | null;
  wonQuotationId?: string | null;
  pm: string | null;
  pmUserId?: string | null;
  deptName: string | null;
  budget: string | null;
  estimatedTotalCost: string;
  startDate: string | null;
  endDate: string | null;
  progress: number | null;
  status: string | null;
  remark: string | null;
  closeSummary: string | null;
  satisfaction: number | null;
  retrospective: string | null;
  closedAt: string | null;
  createdAt: Date;
}

export interface ProjectQuoteExtra {
  wonQuotationCode?: string | null;
  wonQuotationTitle?: string | null;
  wonQuotationAmount?: number | null;
  opportunityId?: string | null;
  opportunityTitle?: string | null;
}

export function toProject(
  row: ProjectRowLike,
  contractName: string,
  extra: ProjectQuoteExtra = {},
): Project {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    contractId: row.contractId ?? '',
    contractName,
    wonQuotationId: row.wonQuotationId ?? null,
    wonQuotationCode: extra.wonQuotationCode ?? null,
    wonQuotationTitle: extra.wonQuotationTitle ?? null,
    wonQuotationAmount: extra.wonQuotationAmount ?? null,
    opportunityId: extra.opportunityId ?? null,
    opportunityTitle: extra.opportunityTitle ?? null,
    pm: row.pm,
    pmUserId: row.pmUserId ?? null,
    deptName: row.deptName,
    budget: Number(row.budget ?? 0),
    estimatedTotalCost: Number(row.estimatedTotalCost ?? 0),
    startDate: row.startDate,
    endDate: row.endDate,
    progress: row.progress ?? 0,
    status: (row.status ?? 'initiating') as ProjectStatus,
    remark: row.remark,
    closeSummary: row.closeSummary,
    satisfaction: row.satisfaction,
    retrospective: row.retrospective,
    closedAt: row.closedAt,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 项目状态机（**唯一权威**，前端按钮按本表渲染）。
 *
 * ## B6 修正：补齐退出路径（§7.2）
 *
 * 原表只有 4 条正向流转，`initiating / executing / delivering / accepting`
 * **全是死胡同** —— 没有任何出口。两个真实后果：
 *
 * ① **误建/取消的项目永远卡住**，且 `tryCompleteContract` 要求
 *    「同合同下**全部**项目 status = closed」，于是**一个卡住的项目
 *    让整个合同永远无法回写 completed**。
 * ② **已结项项目无法反结项**：结项会发结项报告通知、回写合同状态；
 *    之后发现结错了，系统里没有任何入口可以撤回 —— 而本轮 B7 又给
 *    交付物加了"结项即冻结"，两者叠加会让一个误结项的项目**彻底锁死**。
 *
 * ## 新增两条动作的设计
 *
 * ### `cancel`（取消/终止）—— 任意非终态 → `cancelled`
 *
 * `from` 覆盖 `initiating / executing / delivering`：
 *   · `accepting` **不在** `from` 里 —— 该状态意味着全部交付物已验收通过、
 *     只差结项，此时正确动作是 `close` 而不是取消（取消会让已验收的交付物
 *     失去归属）。这是一个有意的业务判断，不是遗漏。
 *
 * ### `reopen`（反结项）—— `closed` → `accepting`
 *
 * 回到 `accepting` 而不是别的状态，因为它正是 `close` 的前置状态，
 * 语义上"退回结项前一步"。选择它而不是 `executing`：结项时交付物
 * 已全部验收、里程碑已全部达成，退回 `executing` 会让这两个前置条件
 * 与实际数据矛盾（再结项时会被自己的校验拦住）。
 */
export const PROJECT_STATUS_FLOW: Record<
  ProjectStatusAction,
  { from: ProjectStatus[]; to: ProjectStatus }
> = {
  approve: { from: ['initiating'], to: 'executing' },
  deliver: { from: ['executing'], to: 'delivering' },
  accept: { from: ['delivering'], to: 'accepting' },
  close: { from: ['accepting'], to: 'closed' },
  /** B6：取消/终止 —— 给非终态一个出口，避免项目永久卡住并拖死合同回写 */
  cancel: { from: ['initiating', 'executing', 'delivering'], to: 'cancelled' },
  /** B6：反结项 —— 回到 close 的前置状态，让误结项可挽回 */
  reopen: { from: ['closed'], to: 'accepting' },
};
