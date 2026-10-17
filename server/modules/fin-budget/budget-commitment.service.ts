import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import {
  erpContract,
  erpProject,
  finBudget,
  finExpenseApply,
  finExpenseClaim,
  hrDepartment,
  purOrder,
} from '@server/database/schema';
import { round2 } from '@server/common/utils/number';
import type {
  BudgetCommitmentSummary,
  BudgetCommitmentSummaryRow,
  BudgetCommitmentRow,
  CommitmentGapRow,
} from '@shared/api.interface';
import {
  budgetMatchesDoc,
  currentMonthPeriod,
  docPeriodOf,
  type BudgetDims,
  type DocDims,
  type ExpenseRecordDims,
  sumMatchedRecords,
} from './fin-budget.service';

/**
 * C-09：预算承诺与「三算对比」。
 *
 * ## 为什么需要承诺（Commitment）这一层
 *
 * 既有 `fin-budget` 只区分【预算】与【已执行】（报销审批通过）。
 * 但已签合同/已下采购单的钱**虽然还没花，却已经不能再花了** ——
 * 只看"已执行"会让预算看起来还有余额，实际一付款就超支。
 * 需求书 C-09 要求的「预算 − 承诺 − 实际」三算表正是为了暴露这个缺口。
 *
 * ## 承诺的口径（本次实现采用，需业务确认）
 *
 * | 来源 | 计入承诺的条件 | 金额 |
 * |---|---|---|
 * | 采购订单 `pur_order` | `status ∈ (approved, ordered, accepted)`（已批准未完成） | `amount`（含税） |
 * | 合同 `erp_contract` | `status ∈ (active, performing)`（已生效未完结） | `netAmount`（不含税） |
 * | 费用申请 `fin_expense_apply` | `status ∈ (pending, approved)` | `amount`，区分：`approved` 同时计入承诺与实际 |
 * | 报销单 `fin_expense_claim` | `status = approved` | `amount` 全额计入**实际** |
 *
 * 关键规则：
 * - 同一单据只计一次（按 id 去重，与既有 `sumMatchedRecords` 一致）；
 * - 费用申请 `approved` 时既占承诺也要在实际中体现 —— 为避免重复，
 *   本实现把 `approved` 的申请归入**实际**（已批准即视为已发生），
 *   `pending` 才归入承诺。这比"两边都算"更保守，不会虚增占用。
 * - 合同承诺按 `projectId` 匹配；采购订单按 `projectId` 匹配；
 *   两者都不挂项目时不参与按项目的三算，只在汇总里体现。
 */

interface ApplyRow {
  id: string;
  departmentId: string | null;
  projectId: string | null;
  expenseCategory: string | null;
  amount: string | null;
  expectDate: string | null;
  status: string | null;
}

interface ClaimRow {
  id: string;
  departmentId: string | null;
  projectId: string | null;
  expenseCategory: string | null;
  amount: string | null;
  expenseDate: string | null;
  status: string | null;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

@Injectable()
export class BudgetCommitmentService {
  private readonly logger = new Logger(BudgetCommitmentService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  /**
   * 三算对比（按维度分组：期间 × 部门 × 项目 × 费用类别）。
   *
   * 返回每一组的 预算 / 承诺 / 实际 / 可用余额 以及 `overCommitted` 标记。
   * 前端据此渲染三算表并用红色标出"承诺已超预算但尚未付款"的行 ——
   * 这是本功能存在的核心价值。
   */
  async summary(params?: { period?: string }): Promise<BudgetCommitmentSummary> {
    const periodFilter = params?.period;

    const budgets: Array<{
      id: string;
      departmentId: string | null;
      projectId: string | null;
      expenseCategory: string | null;
      period: string | null;
      budgetAmount: string | null;
      departmentName: string | null;
      projectName: string | null;
    }> = await this.db
      .select({
        id: finBudget.id,
        departmentId: finBudget.departmentId,
        projectId: finBudget.projectId,
        expenseCategory: finBudget.expenseCategory,
        period: finBudget.period,
        budgetAmount: finBudget.budgetAmount,
        departmentName: hrDepartment.name,
        projectName: erpProject.name,
      })
      .from(finBudget)
      .leftJoin(hrDepartment, eq(finBudget.departmentId, hrDepartment.id))
      .leftJoin(erpProject, eq(finBudget.projectId, erpProject.id))
      .orderBy(asc(finBudget.period));

    const scopedBudgets = periodFilter
      ? budgets.filter((row) => (row.period ?? '') === periodFilter)
      : budgets;

    const [applies, claims, purchaseOrders, contracts] = await Promise.all([
      this.db
        .select({
          id: finExpenseApply.id,
          departmentId: finExpenseApply.departmentId,
          projectId: finExpenseApply.projectId,
          expenseCategory: finExpenseApply.expenseCategory,
          amount: finExpenseApply.amount,
          expectDate: finExpenseApply.expectDate,
          status: finExpenseApply.status,
        })
        .from(finExpenseApply),
      this.db
        .select({
          id: finExpenseClaim.id,
          departmentId: finExpenseClaim.departmentId,
          projectId: finExpenseClaim.projectId,
          expenseCategory: finExpenseClaim.expenseCategory,
          amount: finExpenseClaim.amount,
          expenseDate: finExpenseClaim.expenseDate,
          status: finExpenseClaim.status,
        })
        .from(finExpenseClaim),
      this.db
        .select({
          id: purOrder.id,
          code: purOrder.code,
          projectId: purOrder.projectId,
          itemName: purOrder.itemName,
          amount: purOrder.amount,
          orderDate: purOrder.orderDate,
          status: purOrder.status,
        })
        .from(purOrder)
        .where(
          inArray(purOrder.status, ['approved', 'ordered', 'accepted'])
        ),
      this.db
        .select({
          id: erpContract.id,
          code: erpContract.code,
          name: erpContract.name,
          amount: erpContract.amount,
          netAmount: erpContract.netAmount,
          signDate: erpContract.signDate,
          status: erpContract.status,
        })
        .from(erpContract)
        .where(inArray(erpContract.status, ['active', 'performing'])),
    ]);

    // 承诺明细（逐条列出，便于前端下钻到具体单据）
    const commitments: BudgetCommitmentRow[] = [
      ...purchaseOrders.map((row) => ({
        sourceType: 'purchase_order' as const,
        sourceId: row.id,
        sourceCode: row.code ?? '',
        sourceTitle: row.itemName ?? '采购订单',
        projectId: row.projectId,
        /** 采购订单不挂部门/费用类别，三算匹配时按项目维度生效 */
        departmentId: null as string | null,
        expenseCategory: null as string | null,
        period: docPeriodOf(row.orderDate),
        amount: round2(toNumber(row.amount)),
        status: row.status ?? '',
        signedAt: row.orderDate,
      })),
      ...contracts.map((row) => ({
        sourceType: 'contract' as const,
        sourceId: row.id,
        sourceCode: row.code ?? '',
        sourceTitle: row.name ?? '合同',
        // erp_contract 无 project_id 列，因此合同承诺只在「按期间/类别」维度参与三算，
        // 不参与「按项目」维度（项目级预算的承诺需通过采购订单/费用申请体现）。
        projectId: null as string | null,
        departmentId: null as string | null,
        expenseCategory: null as string | null,
        period: docPeriodOf(row.signDate),
        // 合同用不含税净额，与预算口径（通常不含税）一致
        amount: round2(
          row.netAmount === null
            ? toNumber(row.amount)
            : toNumber(row.netAmount)
        ),
        status: row.status ?? '',
        signedAt: row.signDate,
      })),
      ...applies
        .filter((row) => row.status === 'pending')
        .map((row) => ({
          sourceType: 'expense_apply' as const,
          sourceId: row.id,
          sourceCode: '',
          sourceTitle: '费用申请（待批）',
          projectId: row.projectId,
          departmentId: row.departmentId,
          expenseCategory: row.expenseCategory,
          period: docPeriodOf(row.expectDate),
          amount: round2(toNumber(row.amount)),
          status: row.status ?? '',
          signedAt: row.expectDate,
        })),
    ];

    const actualClaims: ExpenseRecordDims[] = claims
      .filter((row: ClaimRow) => row.status === 'approved')
      .map((row: ClaimRow) => this.claimDims(row));
    // 已批准的费用申请视为已发生（保守口径：不重复计入承诺）
    const actualApprovedApplies: ExpenseRecordDims[] = applies
      .filter((row: ApplyRow) => row.status === 'approved')
      .map((row: ApplyRow) => this.applyDims(row));

    const rows: BudgetCommitmentSummaryRow[] = [];
    for (const budget of scopedBudgets) {
      const dims = this.budgetDims(budget);
      const budgetAmount = round2(toNumber(budget.budgetAmount));
      // 承诺：只统计与预算维度匹配的明细
      const matchedCommitments = commitments.filter((item) =>
        budgetMatchesDoc(dims, {
          departmentId: item.departmentId,
          projectId: item.projectId,
          expenseCategory: item.expenseCategory ?? '',
          period: item.period,
        })
      );
      const committedAmount = round2(
        matchedCommitments.reduce((sum, item) => sum + item.amount, 0)
      );
      const actualAmount = round2(
        sumMatchedRecords(actualClaims, [dims]) +
          sumMatchedRecords(actualApprovedApplies, [dims])
      );
      const availableAmount = round2(
        budgetAmount - committedAmount - actualAmount
      );
      rows.push({
        period: budget.period ?? '',
        departmentId: budget.departmentId,
        departmentName: budget.departmentName,
        projectId: budget.projectId,
        projectName: budget.projectName,
        expenseCategory: budget.expenseCategory ?? '',
        budgetAmount,
        committedAmount,
        actualAmount,
        availableAmount,
        /** 承诺+实际 已超预算：即使钱还没付出去，也必须立刻暴露 */
        overCommitted: committedAmount + actualAmount > budgetAmount,
        /** 仅承诺就已超预算（最紧急，说明在签合同时就失控了） */
        commitmentAloneExceedsBudget: committedAmount > budgetAmount,
      });
    }

    rows.sort((a, b) =>
      a.period < b.period ? -1 : a.period > b.period ? 1 : 0
    );

    return {
      generatedAt: new Date().toISOString(),
      period: periodFilter ?? null,
      totals: {
        budgetAmount: round2(rows.reduce((sum, r) => sum + r.budgetAmount, 0)),
        committedAmount: round2(
          rows.reduce((sum, r) => sum + r.committedAmount, 0)
        ),
        actualAmount: round2(rows.reduce((sum, r) => sum + r.actualAmount, 0)),
        availableAmount: round2(
          rows.reduce((sum, r) => sum + r.availableAmount, 0)
        ),
      },
      rows,
    };
  }

  /**
   * 承诺缺口：**没有预算覆盖**的承诺明细（孤儿承诺）。
   *
   * 这是三算表最容易被忽略、风险却最高的一类：签了合同/下了采购单，
   * 但系统里根本没有对应维度的预算行，因此三算表里看不到它。
   * 单独列出以便业务补录预算或调整承诺。
   */
  async gaps(params?: { period?: string }): Promise<CommitmentGapRow[]> {
    const summary = await this.summary(params);
    const budgets: BudgetDims[] = summary.rows.map((row) => ({
      departmentId: row.departmentId,
      projectId: row.projectId,
      expenseCategory: row.expenseCategory,
      period: row.period,
    }));
    const all = await this.allCommitments();
    const scoped = params?.period
      ? all.filter((item) => item.period === params.period)
      : all;
    return scoped
      .filter((item) => {
        const doc: DocDims = {
          departmentId: item.departmentId,
          projectId: item.projectId,
          expenseCategory: item.expenseCategory ?? '',
          period: item.period,
        };
        return !budgets.some((budget) => budgetMatchesDoc(budget, doc));
      })
      .sort((a, b) => b.amount - a.amount);
  }

  private async allCommitments(): Promise<BudgetCommitmentRow[]> {
    const [purchaseOrders, contracts, pendingApplies] = await Promise.all([
      this.db
        .select({
          id: purOrder.id,
          code: purOrder.code,
          projectId: purOrder.projectId,
          itemName: purOrder.itemName,
          amount: purOrder.amount,
          orderDate: purOrder.orderDate,
          status: purOrder.status,
        })
        .from(purOrder)
        .where(inArray(purOrder.status, ['approved', 'ordered', 'accepted'])),
      this.db
        .select({
          id: erpContract.id,
          code: erpContract.code,
          name: erpContract.name,
          amount: erpContract.amount,
          netAmount: erpContract.netAmount,
          signDate: erpContract.signDate,
          status: erpContract.status,
        })
        .from(erpContract)
        .where(inArray(erpContract.status, ['active', 'performing'])),
      this.db
        .select({
          id: finExpenseApply.id,
          projectId: finExpenseApply.projectId,
          departmentId: finExpenseApply.departmentId,
          expenseCategory: finExpenseApply.expenseCategory,
          amount: finExpenseApply.amount,
          expectDate: finExpenseApply.expectDate,
          status: finExpenseApply.status,
        })
        .from(finExpenseApply)
        .where(eq(finExpenseApply.status, 'pending')),
    ]);
    return [
      ...purchaseOrders.map((row) => ({
        sourceType: 'purchase_order' as const,
        sourceId: row.id,
        sourceCode: row.code ?? '',
        sourceTitle: row.itemName ?? '采购订单',
        projectId: row.projectId,
        departmentId: null as string | null,
        expenseCategory: null as string | null,
        period: docPeriodOf(row.orderDate),
        amount: round2(toNumber(row.amount)),
        status: row.status ?? '',
        signedAt: row.orderDate,
      })),
      ...contracts.map((row) => ({
        sourceType: 'contract' as const,
        sourceId: row.id,
        sourceCode: row.code ?? '',
        sourceTitle: row.name ?? '合同',
        projectId: null as string | null,
        departmentId: null as string | null,
        expenseCategory: null as string | null,
        period: docPeriodOf(row.signDate),
        amount: round2(
          row.netAmount === null ? toNumber(row.amount) : toNumber(row.netAmount)
        ),
        status: row.status ?? '',
        signedAt: row.signDate,
      })),
      ...pendingApplies.map((row) => ({
        sourceType: 'expense_apply' as const,
        sourceId: row.id,
        sourceCode: '',
        sourceTitle: '费用申请（待批）',
        projectId: row.projectId,
        departmentId: row.departmentId,
        expenseCategory: row.expenseCategory,
        period: docPeriodOf(row.expectDate),
        amount: round2(toNumber(row.amount)),
        status: row.status ?? '',
        signedAt: row.expectDate,
      })),
    ];
  }

  private budgetDims(row: {
    departmentId: string | null;
    projectId: string | null;
    expenseCategory: string | null;
    period: string | null;
  }): BudgetDims {
    return {
      departmentId: row.departmentId,
      projectId: row.projectId,
      expenseCategory: row.expenseCategory,
      period: row.period,
    };
  }

  private applyDims(row: ApplyRow): ExpenseRecordDims {
    return {
      id: row.id,
      departmentId: row.departmentId,
      projectId: row.projectId,
      expenseCategory: row.expenseCategory,
      amount: row.amount,
      period: docPeriodOf(row.expectDate),
    };
  }

  private claimDims(row: ClaimRow): ExpenseRecordDims {
    return {
      id: row.id,
      departmentId: row.departmentId,
      projectId: row.projectId,
      expenseCategory: row.expenseCategory,
      amount: row.amount,
      period: docPeriodOf(row.expenseDate),
    };
  }
}
