import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, count, eq, inArray, or, sql, sum } from 'drizzle-orm';
import {
  erpApBill,
  erpProject,
  erpProjectCost,
  finBudget,
  finExpenseApply,
  finExpenseClaim,
  hrDepartment,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import {
  budgetMatchesDoc,
  docPeriodOf,
  sumMatchedRecords,
  type BudgetDims,
  type DocDims,
  type ExpenseRecordDims,
} from '../fin-budget/fin-budget.service';
import type {
  CreateExpenseApplyDto,
  CreateExpenseClaimDto,
  ExpenseApplyAction,
  ExpenseApplyItem,
  ExpenseApplyStatus,
  ExpenseClaimItem,
  ExpenseClaimStatus,
  ExpenseClaimAction,
  PagedResult,
} from '@shared/api.interface';

const APPLY_ACTIONS: readonly ExpenseApplyAction[] = ['approve', 'reject', 'close'];
const CLAIM_ACTIONS: readonly ExpenseClaimAction[] = ['approve', 'reject'];

/* 申请状态机：pending → approved/rejected；approved → closed */
const APPLY_TRANSITIONS: Record<string, Record<string, ExpenseApplyStatus>> = {
  approve: { pending: 'approved' },
  reject: { pending: 'rejected' },
  close: { approved: 'closed' },
};

interface BudgetCheckResult {
  hasBudget: boolean;
  budgetAmount: number;
  executed: number;
  occupied: number;
  exceeded: boolean;
}

interface ApplyRow {
  id: string;
  code: string;
  applyType: string | null;
  title: string;
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  expenseCategory: string | null;
  amount: string | null;
  expectDate: string | null;
  status: string | null;
  reason: string | null;
  remark: string | null;
  createdAt: Date;
}

interface ClaimRow {
  id: string;
  code: string;
  applyId: string | null;
  applyCode: string | null;
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  expenseCategory: string | null;
  amount: string | null;
  expenseDate: string | null;
  applicant: string | null;
  status: string | null;
  remark: string | null;
  createdAt: Date;
}

@Injectable()
export class FinExpenseService {
  private readonly logger = new Logger(FinExpenseService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService
  ) {}

  /* ========== 预算校验（事中） ========== */

  private async checkBudget(
    doc: DocDims & { amount: number }
  ): Promise<BudgetCheckResult> {
    const budgetRows: Array<{
      id: string;
      departmentId: string | null;
      projectId: string | null;
      expenseCategory: string | null;
      period: string | null;
      budgetAmount: string | null;
    }> = await this.db
      .select({
        id: finBudget.id,
        departmentId: finBudget.departmentId,
        projectId: finBudget.projectId,
        expenseCategory: finBudget.expenseCategory,
        period: finBudget.period,
        budgetAmount: finBudget.budgetAmount,
      })
      .from(finBudget)
      .where(eq(finBudget.period, doc.period));

    const matchedRows = budgetRows.filter((b: BudgetDims) =>
      budgetMatchesDoc(b, doc)
    );
    const matched: BudgetDims[] = matchedRows.map(
      (b: BudgetDims) => ({
        departmentId: b.departmentId,
        projectId: b.projectId,
        expenseCategory: b.expenseCategory,
        period: b.period,
      })
    );

    if (matched.length === 0) {
      return {
        hasBudget: false,
        budgetAmount: 0,
        executed: 0,
        occupied: 0,
        exceeded: false,
      };
    }

    const budgetAmount = matchedRows.reduce(
      (total: number, b: { budgetAmount: string | null }) =>
        total + Number(b.budgetAmount ?? 0),
      0
    );

    const [applyRows, claimRows] = await Promise.all([
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
        .from(finExpenseApply)
        .where(
          inArray(finExpenseApply.status, ['pending', 'approved'])
        ),
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
        .from(finExpenseClaim)
        .where(
          inArray(finExpenseClaim.status, [
            'pending',
            'escalated',
            'approved',
          ])
        ),
    ]);

    const occupiedApplies: ExpenseRecordDims[] = applyRows.map((r) => ({
      id: r.id,
      departmentId: r.departmentId,
      projectId: r.projectId,
      expenseCategory: r.expenseCategory,
      amount: r.amount,
      period: docPeriodOf(r.expectDate),
    }));
    const occupiedClaims: ExpenseRecordDims[] = claimRows
      .filter((r) => r.status === 'pending' || r.status === 'escalated')
      .map((r) => ({
        id: r.id,
        departmentId: r.departmentId,
        projectId: r.projectId,
        expenseCategory: r.expenseCategory,
        amount: r.amount,
        period: docPeriodOf(r.expenseDate),
      }));
    const executedClaims: ExpenseRecordDims[] = claimRows
      .filter((r) => r.status === 'approved')
      .map((r) => ({
        id: r.id,
        departmentId: r.departmentId,
        projectId: r.projectId,
        expenseCategory: r.expenseCategory,
        amount: r.amount,
        period: docPeriodOf(r.expenseDate),
      }));

    const occupied =
      sumMatchedRecords(occupiedApplies, matched) +
      sumMatchedRecords(occupiedClaims, matched);
    const executed = sumMatchedRecords(executedClaims, matched);

    return {
      hasBudget: true,
      budgetAmount,
      executed,
      occupied,
      exceeded: executed + occupied + doc.amount > budgetAmount,
    };
  }

  /** 项目基线：Σ erp_project_cost.amount + 本次 ≤ erp_project.budget */
  private async assertProjectBaseline(
    projectId: string | null | undefined,
    amount: number
  ): Promise<void> {
    if (!projectId) return;
    const projectRows: Array<{ budget: string | null }> = await this.db
      .select({ budget: erpProject.budget })
      .from(erpProject)
      .where(eq(erpProject.id, projectId))
      .limit(1);
    if (projectRows.length === 0) return;
    const costRows: Array<{ total: string | null }> = await this.db
      .select({ total: sum(erpProjectCost.amount) })
      .from(erpProjectCost)
      .where(eq(erpProjectCost.projectId, projectId));
    const totalCost = Number(costRows[0]?.total ?? 0);
    const budget = Number(projectRows[0].budget ?? 0);
    if (totalCost + amount > budget) {
      const over = totalCost + amount - budget;
      throw new BadRequestException(
        `超出项目预算基线：项目预算 ${budget} 元，已归集成本 ${totalCost} 元，` +
          `本次 ${amount} 元，超出 ${over} 元`
      );
    }
  }

  /* ========== 费用申请 ========== */

  async listApplies(
    page: number,
    pageSize: number,
    status?: string,
    projectId?: string,
    ownerUserId?: string
  ): Promise<PagedResult<ExpenseApplyItem>> {
    const conditions = [];
    if (status) conditions.push(eq(finExpenseApply.status, status));
    if (projectId) conditions.push(eq(finExpenseApply.projectId, projectId));
    if (ownerUserId) {
      conditions.push(
        sql`(${finExpenseApply.createdBy}).user_id = ${ownerUserId}`
      );
    }
    const where =
      conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(finExpenseApply)
      .where(where);
    const total = Number(totalRows[0]?.total ?? 0);

    const rows: ApplyRow[] = await this.db
      .select({
        id: finExpenseApply.id,
        code: finExpenseApply.code,
        applyType: finExpenseApply.applyType,
        title: finExpenseApply.title,
        departmentId: finExpenseApply.departmentId,
        departmentName: hrDepartment.name,
        projectId: finExpenseApply.projectId,
        projectName: erpProject.name,
        expenseCategory: finExpenseApply.expenseCategory,
        amount: finExpenseApply.amount,
        expectDate: finExpenseApply.expectDate,
        status: finExpenseApply.status,
        reason: finExpenseApply.reason,
        remark: finExpenseApply.remark,
        createdAt: finExpenseApply.createdAt,
      })
      .from(finExpenseApply)
      .leftJoin(hrDepartment, eq(finExpenseApply.departmentId, hrDepartment.id))
      .leftJoin(erpProject, eq(finExpenseApply.projectId, erpProject.id))
      .where(where)
      .orderBy(asc(finExpenseApply.code))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map((row: ApplyRow) => this.toApplyItem(row)),
      total,
      page,
      pageSize,
    };
  }

  private toApplyItem(row: ApplyRow): ExpenseApplyItem {
    return {
      id: row.id,
      code: row.code,
      applyType: (row.applyType ?? 'travel') as ExpenseApplyItem['applyType'],
      title: row.title,
      departmentId: row.departmentId,
      departmentName: row.departmentName,
      projectId: row.projectId,
      projectName: row.projectName,
      expenseCategory: row.expenseCategory ?? '',
      amount: Number(row.amount ?? 0),
      expectDate: row.expectDate,
      status: (row.status ?? 'pending') as ExpenseApplyStatus,
      reason: row.reason,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async getApplyById(id: string): Promise<ExpenseApplyItem> {
    const rows: ApplyRow[] = await this.db
      .select({
        id: finExpenseApply.id,
        code: finExpenseApply.code,
        applyType: finExpenseApply.applyType,
        title: finExpenseApply.title,
        departmentId: finExpenseApply.departmentId,
        departmentName: hrDepartment.name,
        projectId: finExpenseApply.projectId,
        projectName: erpProject.name,
        expenseCategory: finExpenseApply.expenseCategory,
        amount: finExpenseApply.amount,
        expectDate: finExpenseApply.expectDate,
        status: finExpenseApply.status,
        reason: finExpenseApply.reason,
        remark: finExpenseApply.remark,
        createdAt: finExpenseApply.createdAt,
      })
      .from(finExpenseApply)
      .leftJoin(hrDepartment, eq(finExpenseApply.departmentId, hrDepartment.id))
      .leftJoin(erpProject, eq(finExpenseApply.projectId, erpProject.id))
      .where(eq(finExpenseApply.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('费用申请不存在');
    return this.toApplyItem(rows[0]);
  }

  async createApply(dto: CreateExpenseApplyDto): Promise<ExpenseApplyItem> {
    const period = docPeriodOf(dto.expectDate);
    const doc: DocDims = {
      departmentId: dto.departmentId ?? null,
      projectId: dto.projectId ?? null,
      expenseCategory: dto.expenseCategory,
      period,
    };
    const check = await this.checkBudget({ ...doc, amount: dto.amount });
    if (check.exceeded) {
      throw new BadRequestException(
        `预算不足：预算总额 ${check.budgetAmount} 元，已执行 ${check.executed} 元，` +
          `在途占用 ${check.occupied} 元，本次申请 ${dto.amount} 元，` +
          `超出 ${check.executed + check.occupied + dto.amount - check.budgetAmount} 元`
      );
    }
    await this.assertProjectBaseline(dto.projectId, dto.amount);

    const code = await generateBizCode(
      this.db,
      finExpenseApply,
      finExpenseApply.code,
      'EXP'
    );
    const inserted = await this.db
      .insert(finExpenseApply)
      .values({
        code,
        applyType: dto.applyType,
        title: dto.title,
        departmentId: dto.departmentId ?? null,
        projectId: dto.projectId ?? null,
        expenseCategory: dto.expenseCategory,
        amount: String(dto.amount),
        expectDate: dto.expectDate ?? null,
        status: 'pending',
        reason: dto.reason ?? null,
        remark: dto.remark ?? null,
      })
      .returning({ id: finExpenseApply.id });
    return this.getApplyById(inserted[0].id);
  }

  async applyAction(
    id: string,
    action: ExpenseApplyAction
  ): Promise<ExpenseApplyItem> {
    if (!APPLY_ACTIONS.includes(action)) {
      throw new BadRequestException(`非法的申请操作：${action}`);
    }
    const rows: Array<{ id: string; status: string | null }> = await this.db
      .select({ id: finExpenseApply.id, status: finExpenseApply.status })
      .from(finExpenseApply)
      .where(eq(finExpenseApply.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('费用申请不存在');
    const current = rows[0].status ?? 'pending';
    const next = APPLY_TRANSITIONS[action][current];
    if (!next) {
      throw new BadRequestException(
        `非法的状态流转：${current} 状态不允许执行 ${action} 操作`
      );
    }
    const updated = await this.db
      .update(finExpenseApply)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(finExpenseApply.id, id))
      .returning({ id: finExpenseApply.id });
    if (updated.length === 0) {
      throw new NotFoundException('费用申请不存在');
    }
    return this.getApplyById(id);
  }

  /* ========== 报销单 ========== */

  async listClaims(
    page: number,
    pageSize: number,
    status?: string,
    projectId?: string,
    owner?: { userId: string; userName: string }
  ): Promise<PagedResult<ExpenseClaimItem>> {
    const conditions = [];
    if (status) conditions.push(eq(finExpenseClaim.status, status));
    if (projectId) conditions.push(eq(finExpenseClaim.projectId, projectId));
    if (owner) {
      conditions.push(
        or(
          eq(finExpenseClaim.applicant, owner.userId),
          eq(finExpenseClaim.applicant, owner.userName),
          sql`(${finExpenseClaim.createdBy}).user_id = ${owner.userId}`
        )
      );
    }
    const where =
      conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(finExpenseClaim)
      .where(where);
    const total = Number(totalRows[0]?.total ?? 0);

    const rows: ClaimRow[] = await this.db
      .select({
        id: finExpenseClaim.id,
        code: finExpenseClaim.code,
        applyId: finExpenseClaim.applyId,
        applyCode: finExpenseApply.code,
        departmentId: finExpenseClaim.departmentId,
        departmentName: hrDepartment.name,
        projectId: finExpenseClaim.projectId,
        projectName: erpProject.name,
        expenseCategory: finExpenseClaim.expenseCategory,
        amount: finExpenseClaim.amount,
        expenseDate: finExpenseClaim.expenseDate,
        applicant: finExpenseClaim.applicant,
        status: finExpenseClaim.status,
        remark: finExpenseClaim.remark,
        createdAt: finExpenseClaim.createdAt,
      })
      .from(finExpenseClaim)
      .leftJoin(
        finExpenseApply,
        eq(finExpenseClaim.applyId, finExpenseApply.id)
      )
      .leftJoin(
        hrDepartment,
        eq(finExpenseClaim.departmentId, hrDepartment.id)
      )
      .leftJoin(erpProject, eq(finExpenseClaim.projectId, erpProject.id))
      .where(where)
      .orderBy(asc(finExpenseClaim.code))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map((row: ClaimRow) => this.toClaimItem(row)),
      total,
      page,
      pageSize,
    };
  }

  private toClaimItem(row: ClaimRow): ExpenseClaimItem {
    return {
      id: row.id,
      code: row.code,
      applyId: row.applyId,
      applyCode: row.applyCode,
      departmentId: row.departmentId,
      departmentName: row.departmentName,
      projectId: row.projectId,
      projectName: row.projectName,
      expenseCategory: row.expenseCategory ?? '',
      amount: Number(row.amount ?? 0),
      expenseDate: row.expenseDate,
      applicant: row.applicant,
      status: (row.status ?? 'pending') as ExpenseClaimStatus,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async getClaimById(id: string): Promise<ExpenseClaimItem> {
    const rows: ClaimRow[] = await this.db
      .select({
        id: finExpenseClaim.id,
        code: finExpenseClaim.code,
        applyId: finExpenseClaim.applyId,
        applyCode: finExpenseApply.code,
        departmentId: finExpenseClaim.departmentId,
        departmentName: hrDepartment.name,
        projectId: finExpenseClaim.projectId,
        projectName: erpProject.name,
        expenseCategory: finExpenseClaim.expenseCategory,
        amount: finExpenseClaim.amount,
        expenseDate: finExpenseClaim.expenseDate,
        applicant: finExpenseClaim.applicant,
        status: finExpenseClaim.status,
        remark: finExpenseClaim.remark,
        createdAt: finExpenseClaim.createdAt,
      })
      .from(finExpenseClaim)
      .leftJoin(
        finExpenseApply,
        eq(finExpenseClaim.applyId, finExpenseApply.id)
      )
      .leftJoin(
        hrDepartment,
        eq(finExpenseClaim.departmentId, hrDepartment.id)
      )
      .leftJoin(erpProject, eq(finExpenseClaim.projectId, erpProject.id))
      .where(eq(finExpenseClaim.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('报销单不存在');
    return this.toClaimItem(rows[0]);
  }

  async createClaim(
    dto: CreateExpenseClaimDto,
    applicant: string
  ): Promise<ExpenseClaimItem> {
    if (dto.applyId) {
      const applyRows: Array<{
        status: string | null;
        amount: string | null;
      }> = await this.db
        .select({ status: finExpenseApply.status, amount: finExpenseApply.amount })
        .from(finExpenseApply)
        .where(eq(finExpenseApply.id, dto.applyId))
        .limit(1);
      if (applyRows.length === 0) {
        throw new NotFoundException('关联的费用申请不存在');
      }
      if ((applyRows[0].status ?? 'pending') !== 'approved') {
        throw new BadRequestException('仅已批准的费用申请可关联报销');
      }
      const applyAmount = Number(applyRows[0].amount ?? 0);
      if (dto.amount > applyAmount) {
        throw new BadRequestException(
          `报销金额超过申请金额：申请 ${applyAmount} 元，本次报销 ${dto.amount} 元`
        );
      }
    }

    const period = docPeriodOf(dto.expenseDate);
    const doc: DocDims = {
      departmentId: dto.departmentId ?? null,
      projectId: dto.projectId ?? null,
      expenseCategory: dto.expenseCategory,
      period,
    };
    await this.assertProjectBaseline(dto.projectId, dto.amount);
    const check = await this.checkBudget({ ...doc, amount: dto.amount });
    const status: ExpenseClaimStatus = check.exceeded
      ? 'escalated'
      : 'pending';

    const code = await generateBizCode(
      this.db,
      finExpenseClaim,
      finExpenseClaim.code,
      'EXP'
    );
    const inserted = await this.db
      .insert(finExpenseClaim)
      .values({
        code,
        applyId: dto.applyId ?? null,
        departmentId: dto.departmentId ?? null,
        projectId: dto.projectId ?? null,
        expenseCategory: dto.expenseCategory,
        amount: String(dto.amount),
        expenseDate: dto.expenseDate ?? null,
        applicant,
        status,
        remark: dto.remark ?? null,
      })
      .returning({ id: finExpenseClaim.id });
    return this.getClaimById(inserted[0].id);
  }

  async claimAction(
    id: string,
    action: ExpenseClaimAction
  ): Promise<ExpenseClaimItem> {
    if (!CLAIM_ACTIONS.includes(action)) {
      throw new BadRequestException(`非法的报销操作：${action}`);
    }
    const rows: Array<{
      code: string;
      projectId: string | null;
      amount: string | null;
      expenseDate: string | null;
      status: string | null;
    }> = await this.db
      .select({
        code: finExpenseClaim.code,
        projectId: finExpenseClaim.projectId,
        amount: finExpenseClaim.amount,
        expenseDate: finExpenseClaim.expenseDate,
        status: finExpenseClaim.status,
      })
      .from(finExpenseClaim)
      .where(eq(finExpenseClaim.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('报销单不存在');
    const claim = rows[0];
    const current = claim.status ?? 'pending';
    if (current !== 'pending' && current !== 'escalated') {
      throw new BadRequestException(
        `非法的状态流转：${current} 状态不允许执行 ${action} 操作`
      );
    }

    if (action === 'reject') {
      const updated = await this.db
        .update(finExpenseClaim)
        .set({ status: 'rejected', updatedAt: new Date() })
        .where(eq(finExpenseClaim.id, id))
        .returning({ id: finExpenseClaim.id });
      if (updated.length === 0) throw new NotFoundException('报销单不存在');
      return this.getClaimById(id);
    }

    /* 审批通过：事务内两写 —— 应付账单 + 项目成本 */
    const amount = Number(claim.amount ?? 0);
    const expenseDate =
      claim.expenseDate ?? new Date().toISOString().slice(0, 10);
    const apCode = await generateBizCode(
      this.db,
      erpApBill,
      erpApBill.code,
      'APB'
    );
    const costCode = await generateBizCode(
      this.db,
      erpProjectCost,
      erpProjectCost.code,
      'CST'
    );

    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(finExpenseClaim)
        .set({ status: 'approved', updatedAt: new Date() })
        .where(eq(finExpenseClaim.id, id))
        .returning({ id: finExpenseClaim.id });
      if (updated.length === 0) {
        throw new NotFoundException('报销单不存在');
      }
      await tx.insert(erpApBill).values({
        code: apCode,
        supplierId: null,
        projectId: claim.projectId,
        amount: String(amount),
        paidAmount: '0',
        dueDate: expenseDate,
        status: 'pending',
        source: 'expense',
        remark: `报销单${claim.code}`,
      });
      if (claim.projectId) {
        await tx.insert(erpProjectCost).values({
          code: costCode,
          projectId: claim.projectId,
          costType: 'travel',
          amount: String(amount),
          period: expenseDate.slice(0, 7),
          occurredDate: expenseDate,
          sourceRef: `expense:${claim.code}`,
          remark: `报销单${claim.code} 归集差旅成本`,
        });
      }
    });

    /* 报销审批通过 → 生成凭证草稿：借 管理费用(6602) / 贷 银行存款(1001) */
    try {
      await this.voucherHookService.generateVoucherDraft({
        sourceType: 'expense',
        sourceRef: `expense:${claim.code}`,
        voucherDate: expenseDate,
        summary: `报销付款 ${claim.code}`,
        lines: [
          { accountCode: '6602', debit: amount },
          { accountCode: '1001', credit: amount },
        ],
      });
    } catch (error) {
      this.logger.error(
        `报销凭证草稿生成失败：expense:${claim.code}`,
        error instanceof Error ? error.stack : String(error)
      );
    }

    return this.getClaimById(id);
  }
}
