import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import {
  astAsset,
  astChange,
  crmQuotation,
  erpAdminRentContract,
  erpAr,
  erpBankStatement,
  erpContract,
  erpDeliverable,
  erpPayment,
  erpProject,
  erpProjectMilestone,
  finExpenseApply,
  finExpenseClaim,
  hrAttendanceAmendment,
  hrLeaveRequest,
  purRequest,
} from '@server/database/schema';
import { todayInShanghai } from '@server/common/utils/biz-date';
import { hasCapability } from '@shared/rbac';
import {
  normalizeUrgency,
  paginateTasks,
  sortTasks,
  summarizeTasks,
} from './tasks.logic';
import type {
  PagedResult,
  TaskBizType,
  TaskItem,
  TaskListParams,
  TaskSummary,
} from '@shared/api.interface';

/** 每个队列单次最多扫描的行数（防止大表拖垮待办接口） */
const QUEUE_LIMIT = 200;

/** 待办队列的可见范围（按能力码推导，与 B-01 矩阵一致） */
export interface TaskScope {
  isAdmin: boolean;
  finance: boolean;
  projects: boolean;
  userId: string;
}

interface QueueDefinition {
  bizType: TaskBizType;
  moduleLabel: string;
  /** 该队列是否对当前用户可见 */
  visible: (scope: TaskScope) => boolean;
  load: (scope: TaskScope) => Promise<TaskItem[]>;
}

/**
 * C-08 待办中心与消息聚合。
 *
 * 可见范围口径（需业务确认，依赖 B-01 权限矩阵）：
 *  - admin：可见全部队列；
 *  - 具备 finance 能力（finance_viewer）：可见财务审批与预警类队列；
 *  - 具备 projects 能力（project_manager）：可见项目交付/预算类队列；
 *  - 具备 hr 能力（hr_manager）：可见人事审批类队列；
 *  - 其余无管理能力的登录用户：**退化为"只看自己的"** —— 仅显示由其发起
 *    （`_created_by` / 申请人字段）的单据，避免越权看到全公司待办。
 * 说明：当前无审批人字段的表（付款单/合同）以 approver 文本匹配用户名，
 * 匹配不到时不展示给非 admin，宁少不错。
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  private buildScope(userId: string, roles: string[]): TaskScope {
    return {
      isAdmin: roles.includes('admin'),
      finance: hasCapability(roles, 'finance'),
      projects: hasCapability(roles, 'projects'),
      userId,
    };
  }

  private toItem(input: {
    bizType: TaskBizType;
    bizId: string;
    bizCode: string | null;
    title: string;
    dueAt: string | null;
    today: string;
    url: string;
    moduleLabel: string;
    detail?: string | null;
  }): TaskItem {
    return {
      bizType: input.bizType,
      bizId: input.bizId,
      bizCode: input.bizCode,
      title: input.title,
      urgency: normalizeUrgency(input.dueAt, input.today),
      dueAt: input.dueAt,
      url: input.url,
      moduleLabel: input.moduleLabel,
      detail: input.detail ?? null,
    };
  }

  private addDays(date: string, days: number): string {
    const base = Date.parse(`${date}T00:00:00Z`);
    return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
  }

  /* ==================== 队列定义 ==================== */

  private definitions(today: string): QueueDefinition[] {
    const todayDate = today;
    const arWarnDate = this.addDays(todayDate, 7);
    const expiryWarnDate = this.addDays(todayDate, 30);

    return [
      {
        bizType: 'quotation_approval',
        moduleLabel: '报价单',
        visible: () => true,
        load: async () => {
          const rows = await this.db
            .select({
              id: crmQuotation.id,
              code: crmQuotation.code,
              title: crmQuotation.title,
              totalAmount: crmQuotation.totalAmount,
              validUntil: crmQuotation.validUntil,
            })
            .from(crmQuotation)
            .where(eq(crmQuotation.status, 'pending_approval'))
            .orderBy(desc(crmQuotation.createdAt))
            .limit(QUEUE_LIMIT);
          return rows.map((row) =>
            this.toItem({
              bizType: 'quotation_approval',
              bizId: row.id,
              bizCode: row.code,
              title: `报价单待审批：${row.title}`,
              dueAt: row.validUntil,
              today: todayDate,
              url: `/crm/quotations/${row.id}`,
              moduleLabel: '报价单',
              detail: `金额 ¥${Number(row.totalAmount ?? 0).toFixed(2)}`,
            })
          );
        },
      },
      {
        bizType: 'contract_approval',
        moduleLabel: '合同',
        visible: (scope) => scope.isAdmin,
        load: async () => {
          const rows = await this.db
            .select({
              id: erpContract.id,
              code: erpContract.code,
              name: erpContract.name,
              amount: erpContract.amount,
              endDate: erpContract.endDate,
            })
            .from(erpContract)
            .where(eq(erpContract.status, 'approving'))
            .orderBy(desc(erpContract.createdAt))
            .limit(QUEUE_LIMIT);
          return rows.map((row) =>
            this.toItem({
              bizType: 'contract_approval',
              bizId: row.id,
              bizCode: row.code,
              title: `合同待审批：${row.name}`,
              dueAt: row.endDate,
              today: todayDate,
              url: `/contracts/${row.id}`,
              moduleLabel: '合同',
              detail: `金额 ¥${Number(row.amount ?? 0).toFixed(2)}`,
            })
          );
        },
      },
      {
        bizType: 'payment_approval',
        moduleLabel: '付款单',
        visible: (scope) => scope.isAdmin,
        load: async () => {
          const rows = await this.db
            .select({
              id: erpPayment.id,
              code: erpPayment.code,
              amount: erpPayment.amount,
              payDate: erpPayment.payDate,
              approver: erpPayment.approver,
              remark: erpPayment.remark,
            })
            .from(erpPayment)
            .where(eq(erpPayment.status, 'pending'))
            .orderBy(desc(erpPayment.createdAt))
            .limit(QUEUE_LIMIT);
          return rows.map((row) =>
            this.toItem({
              bizType: 'payment_approval',
              bizId: row.id,
              bizCode: row.code,
              title: `付款单待审批：${row.code}`,
              dueAt: row.payDate,
              today: todayDate,
              url: `/finance?tab=payables`,
              moduleLabel: '付款单',
              detail: `金额 ¥${Number(row.amount ?? 0).toFixed(2)}${row.approver ? `｜审批人 ${row.approver}` : ''}`,
            })
          );
        },
      },
      {
        bizType: 'expense_approval',
        moduleLabel: '费用',
        visible: (scope) => scope.isAdmin,
        load: async () => {
          const applies = await this.db
            .select({
              id: finExpenseApply.id,
              code: finExpenseApply.code,
              expenseCategory: finExpenseApply.expenseCategory,
              amount: finExpenseApply.amount,
              expectDate: finExpenseApply.expectDate,
            })
            .from(finExpenseApply)
            .where(
              inArray(finExpenseApply.status, ['pending'])
            )
            .orderBy(desc(finExpenseApply.createdAt))
            .limit(QUEUE_LIMIT);
          const claims = await this.db
            .select({
              id: finExpenseClaim.id,
              code: finExpenseClaim.code,
              expenseCategory: finExpenseClaim.expenseCategory,
              amount: finExpenseClaim.amount,
              expenseDate: finExpenseClaim.expenseDate,
            })
            .from(finExpenseClaim)
            .where(inArray(finExpenseClaim.status, ['pending', 'escalated']))
            .orderBy(desc(finExpenseClaim.createdAt))
            .limit(QUEUE_LIMIT);
          return [
            ...applies.map((row) =>
              this.toItem({
                bizType: 'expense_approval',
                bizId: row.id,
                bizCode: row.code,
                title: `费用申请待审批：${row.expenseCategory ?? '未分类'}`,
                dueAt: row.expectDate,
                today: todayDate,
                url: `/fin-expense/applies/${row.id}`,
                moduleLabel: '费用申请',
                detail: `金额 ¥${Number(row.amount ?? 0).toFixed(2)}`,
              })
            ),
            ...claims.map((row) =>
              this.toItem({
                bizType: 'expense_approval',
                bizId: row.id,
                bizCode: row.code,
                title: `报销单待审批：${row.expenseCategory ?? '未分类'}`,
                dueAt: row.expenseDate,
                today: todayDate,
                url: `/fin-expense/claims/${row.id}`,
                moduleLabel: '报销单',
                detail: `金额 ¥${Number(row.amount ?? 0).toFixed(2)}`,
              })
            ),
          ];
        },
      },
      {
        bizType: 'leave_approval',
        moduleLabel: '请假',
        visible: (scope) => scope.isAdmin,
        load: async () => {
          const rows = await this.db
            .select({
              id: hrLeaveRequest.id,
              code: hrLeaveRequest.code,
              leaveType: hrLeaveRequest.leaveType,
              days: hrLeaveRequest.days,
              startDate: hrLeaveRequest.startDate,
            })
            .from(hrLeaveRequest)
            .where(eq(hrLeaveRequest.status, 'pending'))
            .orderBy(desc(hrLeaveRequest.createdAt))
            .limit(QUEUE_LIMIT);
          return rows.map((row) =>
            this.toItem({
              bizType: 'leave_approval',
              bizId: row.id,
              bizCode: row.code,
              title: `请假待审批：${row.leaveType ?? '年假'} ${Number(row.days ?? 0)} 天`,
              dueAt: row.startDate,
              today: todayDate,
              url: `/hr/leaves/${row.id}`,
              moduleLabel: '请假',
              detail: `开始日期 ${row.startDate ?? '-'}`,
            })
          );
        },
      },
      {
        bizType: 'attendance_approval',
        moduleLabel: '补卡',
        visible: (scope) => scope.isAdmin,
        load: async () => {
          const rows = await this.db
            .select({
              id: hrAttendanceAmendment.id,
              code: hrAttendanceAmendment.code,
              workDate: hrAttendanceAmendment.workDate,
              reason: hrAttendanceAmendment.reason,
            })
            .from(hrAttendanceAmendment)
            .where(eq(hrAttendanceAmendment.status, 'pending'))
            .orderBy(desc(hrAttendanceAmendment.createdAt))
            .limit(QUEUE_LIMIT);
          return rows.map((row) =>
            this.toItem({
              bizType: 'attendance_approval',
              bizId: row.id,
              bizCode: row.code,
              title: `补卡待审批：${row.workDate}`,
              dueAt: row.workDate,
              today: todayDate,
              url: '/hr?tab=attendance',
              moduleLabel: '补卡',
              detail: row.reason,
            })
          );
        },
      },
      {
        bizType: 'purchase_approval',
        moduleLabel: '采购申请',
        visible: (scope) => scope.isAdmin,
        load: async () => {
          const rows = await this.db
            .select({
              id: purRequest.id,
              code: purRequest.code,
              title: purRequest.title,
              amount: purRequest.amount,
              expectDate: purRequest.expectDate,
            })
            .from(purRequest)
            .where(eq(purRequest.status, 'pending'))
            .orderBy(desc(purRequest.createdAt))
            .limit(QUEUE_LIMIT);
          return rows.map((row) =>
            this.toItem({
              bizType: 'purchase_approval',
              bizId: row.id,
              bizCode: row.code,
              title: `采购申请待审批：${row.title}`,
              dueAt: row.expectDate,
              today: todayDate,
              url: `/pur/requests/${row.id}`,
              moduleLabel: '采购申请',
              detail: `金额 ¥${Number(row.amount ?? 0).toFixed(2)}`,
            })
          );
        },
      },
      {
        bizType: 'asset_change_approval',
        moduleLabel: '资产变更',
        visible: (scope) => scope.isAdmin,
        load: async () => {
          const rows = await this.db
            .select({
              id: astChange.id,
              code: astChange.code,
              changeType: astChange.changeType,
              remark: astChange.remark,
              assetName: astAsset.name,
            })
            .from(astChange)
            .leftJoin(astAsset, eq(astChange.assetId, astAsset.id))
            .where(eq(astChange.status, 'pending'))
            .orderBy(desc(astChange.createdAt))
            .limit(QUEUE_LIMIT);
          return rows.map((row) =>
            this.toItem({
              bizType: 'asset_change_approval',
              bizId: row.id,
              bizCode: row.code,
              title: `资产变更待审批：${row.assetName ?? '未指定资产'}（${row.changeType ?? '-'}）`,
              dueAt: null,
              today: todayDate,
              url: '/asset?tab=changes',
              moduleLabel: '资产变更',
              detail: row.remark,
            })
          );
        },
      },
      {
        bizType: 'deliverable_acceptance',
        moduleLabel: '交付物验收',
        visible: (scope) => scope.isAdmin || scope.projects,
        load: async () => {
          const rows = await this.db
            .select({
              id: erpDeliverable.id,
              code: erpDeliverable.code,
              name: erpDeliverable.name,
              dueDate: erpDeliverable.dueDate,
              projectId: erpDeliverable.projectId,
            })
            .from(erpDeliverable)
            .where(eq(erpDeliverable.status, 'submitted'))
            .orderBy(desc(erpDeliverable.submittedAt))
            .limit(QUEUE_LIMIT);
          return rows.map((row) =>
            this.toItem({
              bizType: 'deliverable_acceptance',
              bizId: row.id,
              bizCode: row.code,
              title: `交付物待验收：${row.name}`,
              dueAt: row.dueDate,
              today: todayDate,
              url: `/projects/${row.projectId}`,
              moduleLabel: '交付物验收',
              detail: null,
            })
          );
        },
      },
      {
        bizType: 'ar_overdue',
        moduleLabel: '应收逾期',
        visible: (scope) => scope.isAdmin || scope.finance,
        load: async (scope) => {
          const rows = await this.db
            .select({
              id: erpAr.id,
              code: erpAr.code,
              amount: erpAr.amount,
              settledAmount: erpAr.settledAmount,
              dueDate: erpAr.dueDate,
              ownerUserId: erpAr.ownerUserId,
            })
            .from(erpAr)
            .where(
              and(
                inArray(erpAr.status, ['open', 'partial']),
                isNotNull(erpAr.dueDate),
                lte(erpAr.dueDate, arWarnDate)
              )
            )
            .orderBy(erpAr.dueDate)
            .limit(QUEUE_LIMIT);
          const filtered = rows.filter((row) => {
            if (scope.isAdmin || scope.finance) return true;
            return row.ownerUserId === scope.userId;
          });
          return filtered.map((row) =>
            this.toItem({
              bizType: 'ar_overdue',
              bizId: row.id,
              bizCode: row.code,
              title: `应收逾期/临期：${row.code}`,
              dueAt: row.dueDate,
              today: todayDate,
              url: '/finance?tab=receivables',
              moduleLabel: '应收逾期',
              detail: `未收 ¥${(
                Number(row.amount ?? 0) - Number(row.settledAmount ?? 0)
              ).toFixed(2)}`,
            })
          );
        },
      },
      {
        bizType: 'delivery_overdue',
        moduleLabel: '交付逾期',
        visible: (scope) => scope.isAdmin || scope.projects,
        load: async () => {
          const rows = await this.db
            .select({
              id: erpProjectMilestone.id,
              projectId: erpProjectMilestone.projectId,
              name: erpProjectMilestone.name,
              forecastDate: erpProjectMilestone.forecastDate,
              planDate: erpProjectMilestone.planDate,
              projectCode: erpProject.code,
            })
            .from(erpProjectMilestone)
            .leftJoin(erpProject, eq(erpProjectMilestone.projectId, erpProject.id))
            .where(
              and(
                ne(erpProjectMilestone.status, 'reached'),
                or(
                  lte(erpProjectMilestone.forecastDate, arWarnDate),
                  lte(erpProjectMilestone.planDate, arWarnDate)
                )
              )
            )
            .orderBy(erpProjectMilestone.forecastDate)
            .limit(QUEUE_LIMIT);
          return rows.map((row) =>
            this.toItem({
              bizType: 'delivery_overdue',
              bizId: row.id,
              bizCode: row.projectCode,
              title: `里程碑逾期/临期：${row.name}`,
              dueAt: row.forecastDate ?? row.planDate,
              today: todayDate,
              url: `/projects/${row.projectId}`,
              moduleLabel: '交付逾期',
              detail: null,
            })
          );
        },
      },
      {
        bizType: 'budget_overrun',
        moduleLabel: '预算超支',
        visible: (scope) => scope.isAdmin || scope.finance,
        load: async () => {
          const rows: Array<{
            id: string;
            code: string | null;
            period: string | null;
            expenseCategory: string | null;
            budgetAmount: string | null;
            executed: string | null;
            occupied: string | null;
          }> = await this.db.execute(sql`
            SELECT b.id,
                   b.code,
                   b.period,
                   b.expense_category AS "expenseCategory",
                   b.budget_amount AS "budgetAmount",
                   coalesce((
                     SELECT sum(c.amount) FROM fin_expense_claim c
                     WHERE c.status = 'approved'
                       AND coalesce(c.expense_category, '') = coalesce(b.expense_category, '')
                       AND to_char(c.expense_date, 'YYYY-MM') = b.period
                       AND (b.project_id IS NULL OR c.project_id = b.project_id)
                       AND (b.department_id IS NULL OR c.department_id = b.department_id)
                   ), 0) AS executed,
                   coalesce((
                     SELECT sum(a.amount) FROM fin_expense_apply a
                     WHERE a.status IN ('pending', 'approved')
                       AND coalesce(a.expense_category, '') = coalesce(b.expense_category, '')
                       AND to_char(a.expect_date, 'YYYY-MM') = b.period
                       AND (b.project_id IS NULL OR a.project_id = b.project_id)
                       AND (b.department_id IS NULL OR a.department_id = b.department_id)
                   ), 0) AS occupied
            FROM fin_budget b
            ORDER BY b.period DESC, b.code
            LIMIT ${QUEUE_LIMIT}
          `);
          return rows
            .map((row) => ({
              row,
              used:
                Number(row.executed ?? 0) + Number(row.occupied ?? 0),
              budget: Number(row.budgetAmount ?? 0),
            }))
            .filter((item) => item.budget > 0 && item.used > item.budget)
            .map((item) =>
              this.toItem({
                bizType: 'budget_overrun',
                bizId: item.row.id,
                bizCode: item.row.code,
                title: `预算超支：${item.row.expenseCategory ?? '未分类'} ${item.row.period ?? ''}`,
                dueAt: item.row.period ? `${item.row.period}-01` : null,
                today: todayDate,
                url: '/finance?tab=budgets',
                moduleLabel: '预算超支',
                detail: `预算 ¥${item.budget.toFixed(2)}｜已用 ¥${item.used.toFixed(2)}｜超支 ¥${(
                  item.used - item.budget
                ).toFixed(2)}`,
              })
            );
        },
      },
      {
        bizType: 'contract_expiry',
        moduleLabel: '合同到期',
        visible: (scope) => scope.isAdmin || scope.projects,
        load: async () => {
          const rows = await this.db
            .select({
              id: erpContract.id,
              code: erpContract.code,
              name: erpContract.name,
              endDate: erpContract.endDate,
              owner: erpContract.owner,
            })
            .from(erpContract)
            .where(
              and(
                inArray(erpContract.status, ['active', 'performing']),
                isNotNull(erpContract.endDate),
                lte(erpContract.endDate, expiryWarnDate),
                gte(erpContract.endDate, todayDate)
              )
            )
            .orderBy(erpContract.endDate)
            .limit(QUEUE_LIMIT);
          return rows.map((row) =>
            this.toItem({
              bizType: 'contract_expiry',
              bizId: row.id,
              bizCode: row.code,
              title: `合同 30 天内到期：${row.name}`,
              dueAt: row.endDate,
              today: todayDate,
              url: `/contracts/${row.id}`,
              moduleLabel: '合同到期',
              detail: row.owner ? `负责人 ${row.owner}` : null,
            })
          );
        },
      },
      {
        bizType: 'rent_expiry',
        moduleLabel: '租约到期',
        visible: (scope) => scope.isAdmin,
        load: async () => {
          const rows = await this.db
            .select({
              id: erpAdminRentContract.id,
              code: erpAdminRentContract.code,
              name: erpAdminRentContract.name,
              endDate: erpAdminRentContract.endDate,
            })
            .from(erpAdminRentContract)
            .where(
              and(
                ne(erpAdminRentContract.status, 'terminated'),
                lte(erpAdminRentContract.endDate, expiryWarnDate),
                gte(erpAdminRentContract.endDate, todayDate)
              )
            )
            .orderBy(erpAdminRentContract.endDate)
            .limit(QUEUE_LIMIT);
          return rows.map((row) =>
            this.toItem({
              bizType: 'rent_expiry',
              bizId: row.id,
              bizCode: row.code,
              title: `租约 30 天内到期：${row.name}`,
              dueAt: row.endDate,
              today: todayDate,
              url: `/admin-rent/${row.id}`,
              moduleLabel: '租约到期',
              detail: null,
            })
          );
        },
      },
      {
        bizType: 'reconciliation_difference',
        moduleLabel: '对账差异',
        visible: (scope) => scope.isAdmin || scope.finance,
        load: async () => {
          const rows = await this.db
            .select({
              id: erpBankStatement.id,
              bankAccountId: erpBankStatement.bankAccountId,
              transactionDate: erpBankStatement.transactionDate,
              amount: erpBankStatement.amount,
              counterpartyName: erpBankStatement.counterpartyName,
              summary: erpBankStatement.summary,
            })
            .from(erpBankStatement)
            .where(eq(erpBankStatement.matchStatus, 'unmatched'))
            .orderBy(erpBankStatement.transactionDate)
            .limit(QUEUE_LIMIT);
          const byAccount = new Map<string, { count: number; earliest: string }>();
          for (const row of rows) {
            const current = byAccount.get(row.bankAccountId);
            if (!current) {
              byAccount.set(row.bankAccountId, {
                count: 1,
                earliest: row.transactionDate,
              });
            } else {
              current.count += 1;
              if (row.transactionDate < current.earliest) {
                current.earliest = row.transactionDate;
              }
            }
          }
          return [...byAccount.entries()].map(([bankAccountId, value]) =>
            this.toItem({
              bizType: 'reconciliation_difference',
              bizId: bankAccountId,
              bizCode: null,
              title: `银行流水未匹配：${value.count} 条待核对`,
              dueAt: value.earliest,
              today: todayDate,
              url: `/finance?tab=bank&bankAccountId=${bankAccountId}`,
              moduleLabel: '对账差异',
              detail: `最早未匹配日期 ${value.earliest}`,
            })
          );
        },
      },
    ];
  }

  /* ==================== 对外接口 ==================== */

  async listMy(
    params: TaskListParams,
    user: { userId: string; userName: string; roles: string[] }
  ): Promise<PagedResult<TaskItem>> {
    const today = todayInShanghai();
    const scope = this.buildScope(user.userId, user.roles);
    const tasks = await this.collect(scope, today);
    const filtered = tasks.filter((task) => {
      if (params.bizType && task.bizType !== params.bizType) return false;
      if (params.urgency && task.urgency !== params.urgency) return false;
      return true;
    });
    const sorted = sortTasks(filtered, params.sortBy ?? 'urgency');
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 20));
    return {
      items: paginateTasks(sorted, page, pageSize),
      total: sorted.length,
      page,
      pageSize,
    };
  }

  async summary(user: {
    userId: string;
    userName: string;
    roles: string[];
  }): Promise<TaskSummary> {
    const today = todayInShanghai();
    const scope = this.buildScope(user.userId, user.roles);
    const tasks = await this.collect(scope, today);
    return summarizeTasks(tasks);
  }

  /**
   * 并行执行所有可见队列。单队列失败不阻塞整体（allSettled + 告警日志），
   * 避免一个模块的表结构问题导致整个待办中心 500。
   */
  private async collect(scope: TaskScope, today: string): Promise<TaskItem[]> {
    const definitions = this.definitions(today).filter((queue) =>
      queue.visible(scope)
    );
    const settled = await Promise.allSettled(
      definitions.map((queue) => queue.load(scope))
    );
    const tasks: TaskItem[] = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        tasks.push(...result.value);
        return;
      }
      this.logger.warn(
        `待办队列 ${definitions[index].bizType} 查询失败：${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`
      );
    });
    return tasks;
  }

  /** 角标计数：与列表口径完全一致（同一 collect 实现） */
  async badgeCount(user: {
    userId: string;
    userName: string;
    roles: string[];
  }): Promise<number> {
    return (await this.summary(user)).total;
  }
}
