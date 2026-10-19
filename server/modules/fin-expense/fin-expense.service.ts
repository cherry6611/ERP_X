import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, count, eq, inArray, ne, or, sql, sum } from 'drizzle-orm';
import { resolveDocumentTaxEntity } from '@server/common/tax/document-tax-entity';
import { moneyText } from '@shared/number';
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
  type BudgetDims,
  type DocDims,
  type ExpenseRecordDims,
} from '../fin-budget/fin-budget.service';
import { computeBudgetCheck } from './budget-check';
import { decideProjectBaseline } from './project-baseline';
import { todayInShanghai } from '@server/common/utils/biz-date';
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
const CLAIM_ACTIONS: readonly ExpenseClaimAction[] = [
  'approve',
  'reject',
  // B12：补齐出口 —— 原实现 approved 是死胡同
  'pay',
  'void',
];

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
  taxEntityId: string | null;
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
  taxEntityId: string | null;
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
    doc: DocDims & { amount: number },
    scope?: {
      db?: PostgresJsDatabase;
      excludeApplyId?: string;
      excludeClaimId?: string;
    },
  ): Promise<BudgetCheckResult> {
    const conn = scope?.db ?? this.db;
    const budgetRows: Array<{
      id: string;
      departmentId: string | null;
      projectId: string | null;
      expenseCategory: string | null;
      period: string | null;
      budgetAmount: string | null;
    }> = await conn
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

    /*
     * ⚠️ 顺序要求：必须先判"无匹配预算"（直接用 budgetRows 的长度），
     * 再查申请/报销去算占用 —— 否则无预算部门会白跑两次全表查询。
     * 这里消费 `computeBudgetCheck` 的纯计算部分，查询仍在本方法内。
     */
    const [applyRowsRaw, claimRowsRaw] = await Promise.all([
      conn
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
      conn
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
    const applyRows = applyRowsRaw.filter(
      (row) => row.id !== scope?.excludeApplyId,
    );
    const claimRows = claimRowsRaw.filter(
      (row) => row.id !== scope?.excludeClaimId,
    );

    /*
     * §5.9：闸门计算（占用/已执行/超额判据 + 提示文案）已抽到 `./budget-check`
     * （纯函数 + 16 条断言）。本方法只负责查数据并把维度映射成该模块的入参。
     */
    const toRecord = (
      r: {
        id: string;
        departmentId: string | null;
        projectId: string | null;
        expenseCategory: string | null;
        amount: string | null;
      },
      period: string,
    ): ExpenseRecordDims => ({
      id: r.id,
      departmentId: r.departmentId,
      projectId: r.projectId,
      expenseCategory: r.expenseCategory,
      amount: r.amount,
      period,
    });

    return computeBudgetCheck({
      matchedBudgets: matchedRows,
      applies: applyRows.map((r) => toRecord(r, docPeriodOf(r.expectDate))),
      claims: claimRows.map((r) => ({
        ...toRecord(r, docPeriodOf(r.expenseDate)),
        status: r.status as 'pending' | 'escalated' | 'approved',
      })),
      docAmount: doc.amount,
    });
  }

  /**
   * 项目基线（R3 创建即占用）。调用方须已对项目行 FOR UPDATE。
   * 占用 = 已归集成本 + 在途报销 + 未被有效报销引用的在途申请。
   * exclude 掉当前单据，避免创建报销时把关联申请算两次、审批时把当前报销算两次。
   */
  private async assertProjectOccupancy(
    db: PostgresJsDatabase,
    projectId: string | null | undefined,
    amount: number,
    exclude: { applyId?: string; claimId?: string },
  ): Promise<void> {
    if (!projectId) return;
    const rows = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM erp_project WHERE id = ${projectId})::int AS project_count,
        (SELECT budget::text FROM erp_project WHERE id = ${projectId}) AS budget,
        (
          coalesce((SELECT sum(amount) FROM erp_project_cost WHERE project_id = ${projectId}), 0)
          + coalesce((
            SELECT sum(amount) FROM fin_expense_claim
            WHERE project_id = ${projectId}
              AND status IN ('pending', 'escalated')
              AND (${exclude.claimId ?? null}::uuid IS NULL OR id <> ${exclude.claimId ?? null}::uuid)
          ), 0)
          + coalesce((
            SELECT sum(a.amount) FROM fin_expense_apply a
            WHERE a.project_id = ${projectId}
              AND a.status IN ('pending', 'approved')
              AND (${exclude.applyId ?? null}::uuid IS NULL OR a.id <> ${exclude.applyId ?? null}::uuid)
              AND NOT EXISTS (
                SELECT 1 FROM fin_expense_claim c
                WHERE c.apply_id = a.id
                  AND coalesce(c.status, '') NOT IN ('rejected', 'voided')
                  AND (${exclude.claimId ?? null}::uuid IS NULL OR c.id <> ${exclude.claimId ?? null}::uuid)
              )
          ), 0)
        )::text AS occupied
    `);
    const list = Array.isArray(rows)
      ? (rows as Array<Record<string, string | number | null>>)
      : ((rows as { rows?: Array<Record<string, string | number | null>> }).rows ?? []);
    const row = list[0];
    if (!row || Number(row.project_count ?? 0) === 0) {
      throw new BadRequestException('项目不存在，不能挂到费用单据上');
    }
    const decision = decideProjectBaseline({
      projectExists: true,
      budget: row.budget == null ? null : String(row.budget),
      occupied: String(row.occupied ?? '0'),
      amount: amount.toFixed(2),
    });
    if (!decision.ok) throw new BadRequestException(decision.reason);
  }

  private async lockProjectAndPeriodBudgets(
    db: PostgresJsDatabase,
    projectId: string | null | undefined,
    period: string,
  ): Promise<void> {
    if (projectId) {
      await db
        .select({ id: erpProject.id })
        .from(erpProject)
        .where(eq(erpProject.id, projectId))
        .for('update');
    }
    await db
      .select({ id: finBudget.id })
      .from(finBudget)
      .where(eq(finBudget.period, period))
      .orderBy(asc(finBudget.id))
      .for('update');
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
        taxEntityId: finExpenseApply.taxEntityId,
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
      taxEntityId: row.taxEntityId,
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
        taxEntityId: finExpenseApply.taxEntityId,
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
    if (!(dto.amount > 0)) {
      throw new BadRequestException('费用申请金额必须大于 0');
    }
    const period = docPeriodOf(dto.expectDate);
    const doc: DocDims = {
      departmentId: dto.departmentId ?? null,
      projectId: dto.projectId ?? null,
      expenseCategory: dto.expenseCategory,
      period,
    };
    const taxEntityId = await resolveDocumentTaxEntity(this.db, {
      projectId: dto.projectId,
      taxEntityId: dto.taxEntityId,
      kind: 'expense',
    });
    const code = await generateBizCode(
      this.db,
      finExpenseApply,
      finExpenseApply.code,
      'EXP'
    );
    const insertedId = await this.db.transaction(async (tx) => {
      const conn = tx as unknown as PostgresJsDatabase;
      await this.lockProjectAndPeriodBudgets(conn, dto.projectId, period);
      await this.assertProjectOccupancy(conn, dto.projectId, dto.amount, {});
      const check = await this.checkBudget(
        { ...doc, amount: dto.amount },
        { db: conn },
      );
      if (check.exceeded) {
        throw new BadRequestException(
          `预算不足：预算总额 ${check.budgetAmount} 元，已执行 ${check.executed} 元，` +
            `在途占用 ${check.occupied} 元，本次申请 ${dto.amount} 元，` +
            `超出 ${check.executed + check.occupied + dto.amount - check.budgetAmount} 元`
        );
      }
      const inserted = await conn
        .insert(finExpenseApply)
        .values({
          code,
          applyType: dto.applyType,
          title: dto.title,
          departmentId: dto.departmentId ?? null,
          projectId: dto.projectId ?? null,
          taxEntityId,
          expenseCategory: dto.expenseCategory,
          amount: storedMoney(dto.amount),
          expectDate: dto.expectDate ?? null,
          status: 'pending',
          reason: dto.reason ?? null,
          remark: dto.remark ?? null,
        })
        .returning({ id: finExpenseApply.id });
      return inserted[0].id;
    });
    return this.getApplyById(insertedId);
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
        taxEntityId: finExpenseClaim.taxEntityId,
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
      taxEntityId: row.taxEntityId,
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
        taxEntityId: finExpenseClaim.taxEntityId,
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
    if (!(dto.amount > 0)) {
      throw new BadRequestException('报销金额必须大于 0');
    }
    let linkedApply: {
      status: string | null;
      amount: string | null;
      projectId: string | null;
      taxEntityId: string | null;
    } | undefined;
    if (dto.applyId) {
      const applyRows: Array<{
        status: string | null;
        amount: string | null;
        projectId: string | null;
        taxEntityId: string | null;
      }> = await this.db
        .select({
          status: finExpenseApply.status,
          amount: finExpenseApply.amount,
          projectId: finExpenseApply.projectId,
          taxEntityId: finExpenseApply.taxEntityId,
        })
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
      linkedApply = applyRows[0];
    }

    const period = docPeriodOf(dto.expenseDate);
    const doc: DocDims = {
      departmentId: dto.departmentId ?? null,
      projectId: dto.projectId ?? null,
      expenseCategory: dto.expenseCategory,
      period,
    };
    const projectId = dto.projectId ?? linkedApply?.projectId ?? null;
    doc.projectId = projectId;
    const taxEntityId = await resolveDocumentTaxEntity(this.db, {
      projectId,
      taxEntityId: dto.taxEntityId ?? linkedApply?.taxEntityId ?? undefined,
      kind: 'expense',
    });
    const code = await generateBizCode(
      this.db,
      finExpenseClaim,
      finExpenseClaim.code,
      'EXP'
    );
    const insertedId = await this.db.transaction(async (tx) => {
      const conn = tx as unknown as PostgresJsDatabase;
      await this.lockProjectAndPeriodBudgets(conn, projectId, period);
      await this.assertProjectOccupancy(conn, projectId, dto.amount, {
        applyId: dto.applyId,
      });
      const check = await this.checkBudget(
        { ...doc, amount: dto.amount },
        { db: conn, excludeApplyId: dto.applyId },
      );
      const status: ExpenseClaimStatus = check.exceeded ? 'escalated' : 'pending';
      const inserted = await conn
        .insert(finExpenseClaim)
        .values({
          code,
          applyId: dto.applyId ?? null,
          departmentId: dto.departmentId ?? null,
          projectId,
          taxEntityId,
          expenseCategory: dto.expenseCategory,
          amount: storedMoney(dto.amount),
          expenseDate: dto.expenseDate ?? null,
          applicant,
          status,
          remark: dto.remark ?? null,
        })
        .returning({ id: finExpenseClaim.id });
      return inserted[0].id;
    });
    return this.getClaimById(insertedId);
  }

  /**
   * 报销单动作（B12，§7.2）。
   *
   * ## 状态机（本轮补齐出口）
   *
   * ```
   *   pending / escalated ──approve──▶ approved ──pay──▶ paid（终态）
   *          │                             │
   *          ├──reject──▶ rejected         └──void──▶ voided（终态）
   * ```
   *
   * 原实现只有 `approve` / `reject`，于是：
   *   · `approved` 是**死胡同** —— 误批准的报销单无法撤销，
   *     只能去作废它生成的应付单，而作废应付单**不会**同步报销单状态，
   *     两者从此不一致（报销台账显示"已批准"、应付台账显示"已作废"）；
   *   · "这笔报销到底付了没有"在报销台账里查不到，必须去应付台账反查。
   *
   * ## 各动作的前置条件（不是形式校验）
   *
   * · `pay`：须为 `approved`，且**其应付单已 paid** —— 否则是在账上
   *   标记"已付"而钱还没出，比不标记更糟。
   * · `void`：须为 `approved`，且**其应付单未支付**（`paidAmount = 0`）。
   *   已付款的报销作废涉及资金追回，不是系统能单方面决定的事。
   *   作废同时**作废对应的应付单**，保持两边一致。
   */
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

    /* ── B12：pay / void 走独立分支（前置状态是 approved，不是 pending）── */
    if (action === 'pay' || action === 'void') {
      if (current !== 'approved') {
        throw new BadRequestException(
          `仅已批准的报销单可${action === 'pay' ? '标记支付' : '作废'}（当前状态 ${current}）`
        );
      }
      const apRows = await this.db
        .select({
          id: erpApBill.id,
          code: erpApBill.code,
          status: erpApBill.status,
          paidAmount: erpApBill.paidAmount,
        })
        .from(erpApBill)
        .where(eq(erpApBill.sourceRef, `expense:${claim.code}`))
        .limit(1);
      const ap = apRows[0];

      if (action === 'pay') {
        /*
         * 前置条件：应付单必须已付款。
         *
         * 反过来（报销单标记已付但应付单还是 pending）会在账上产生
         * "报销已付、应付未付"的矛盾，月末对账时两边都不对。
         * 这里不做"顺带把应付单也标记已付"—— 付款动作属于出纳，
         * 必须由付款审批流程驱动，不能在报销单上一步到位。
         */
        if (!ap) {
          throw new BadRequestException(
            '未找到该报销单对应的应付单，无法标记支付；请先确认应付单是否已生成'
          );
        }
        if (ap.status !== 'paid') {
          throw new BadRequestException(
            `对应的应付单 ${ap.code} 尚未支付（状态 ${ap.status ?? 'pending'}、` +
              `已付 ${Number(ap.paidAmount ?? 0)}）；请先在「财务 → 应付」完成付款后再标记`
          );
        }
        const updated = await this.db
          .update(finExpenseClaim)
          .set({ status: 'paid', updatedAt: new Date() })
          .where(
            and(eq(finExpenseClaim.id, id), eq(finExpenseClaim.status, 'approved'))
          )
          .returning({ id: finExpenseClaim.id });
        if (updated.length === 0) {
          throw new ConflictException('该报销单状态已变更，请刷新后重试');
        }
        return this.getClaimById(id);
      }

      // action === 'void'
      if (ap && Number(ap.paidAmount ?? 0) > 0) {
        throw new BadRequestException(
          `对应的应付单 ${ap.code} 已有付款金额 ${Number(ap.paidAmount ?? 0)}，` +
            `不能作废报销单；已付款的作废涉及资金追回，请先处理付款`
        );
      }
      /*
       * 作废必须**同时作废应付单 + 红冲凭证 + 冲回项目成本**（同事务）。
       *
       * 只改报销单会出现"报销已作废、应付还挂着" —— 现金流预测按应付单算流出，
       * 于是这笔已经取消的钱**仍会占用未来的资金计划**。
       * 反过来（只作废应付单）则会让报销台账与应付台账不一致。
       * 两者必须一起变，这也是`source_ref` 这个关联键存在的意义。
       *
       * 另外两件事同样不能省：
       *   · 审批通过时生成的「借 6602 / 贷 2202」必须红冲，否则总账仍挂费用与应付；
       *   · 审批通过时插入的 erp_project_cost 必须冲回（负数行 + offset_of），
       *     否则项目毛利永久偏低。原实现只改状态，属于"业务作废、账还活着"。
       */
      const amount = Number(claim.amount ?? 0);
      const reverseDate = todayInShanghai();
      const reversePeriod = reverseDate.slice(0, 7);
      const originalCostRows = claim.projectId
        ? await this.db
            .select({
              id: erpProjectCost.id,
              costType: erpProjectCost.costType,
            })
            .from(erpProjectCost)
            .where(
              and(
                eq(erpProjectCost.sourceRef, `expense:${claim.code}`),
                eq(erpProjectCost.projectId, claim.projectId),
              ),
            )
            .limit(1)
        : [];
      const originalCost = originalCostRows[0];
      const voidCostCode = claim.projectId
        ? await generateBizCode(this.db, erpProjectCost, erpProjectCost.code, 'CST')
        : null;

      await this.db.transaction(async (tx) => {
        const updated = await tx
          .update(finExpenseClaim)
          .set({ status: 'voided', updatedAt: new Date() })
          .where(
            and(eq(finExpenseClaim.id, id), eq(finExpenseClaim.status, 'approved'))
          )
          .returning({ id: finExpenseClaim.id });
        if (updated.length === 0) {
          throw new ConflictException('该报销单状态已变更，请刷新后重试');
        }
        if (ap) {
          await tx
            .update(erpApBill)
            .set({ status: 'voided', updatedAt: new Date() })
            .where(and(eq(erpApBill.id, ap.id), ne(erpApBill.status, 'voided')));
        }
        if (claim.projectId && voidCostCode) {
          await tx.insert(erpProjectCost).values({
            code: voidCostCode,
            projectId: claim.projectId,
            costType: originalCost?.costType ?? 'travel',
            amount: storedMoney(-amount),
            period: reversePeriod,
            occurredDate: reverseDate,
            sourceRef: `expense-void:${claim.code}`,
            offsetOf: originalCost?.id ?? null,
            remark: `报销单${claim.code} 作废冲回`,
          });
        }
        if (amount !== 0) {
          await this.voucherHookService.reserveCompensation(
            tx as unknown as PostgresJsDatabase,
            {
              sourceType: 'expense',
              sourceRef: `expense-void:${claim.code}`,
              voucherDate: reverseDate,
              summary: `报销作废 ${claim.code}`,
              lines: [
                { accountCode: '6602', credit: amount },
                { accountCode: '2202', debit: amount },
              ],
            },
            '报销作废红字凭证待生成',
          );
        }
      });

      /*
       * 红字凭证在事务外生成（与审批分支一致：外部/凭证写入失败不能把
       * 已提交的业务回滚成半状态）。失败时登记补偿队列，不能静默。
       */
      if (amount !== 0) {
        const reverseLines = [
          { accountCode: '6602', credit: amount },
          { accountCode: '2202', debit: amount },
        ];
        try {
          const result = await this.voucherHookService.generateVoucherDraft({
            sourceType: 'expense',
            sourceRef: `expense-void:${claim.code}`,
            voucherDate: reverseDate,
            summary: `报销作废 ${claim.code}`,
            lines: reverseLines,
          });
          if (result === 'failed') {
            this.logger.error(`报销作废红字凭证生成失败：expense-void:${claim.code}`);
            await this.voucherHookService.recordCompensation(
              'expense',
              `expense-void:${claim.code}`,
              '报销作废红字凭证生成失败',
              reverseLines,
              reverseDate,
            );
          }
        } catch (error) {
          this.logger.error(
            `报销作废红字凭证生成异常：expense-void:${claim.code}`,
            error instanceof Error ? error.stack : String(error),
          );
          await this.voucherHookService.recordCompensation(
            'expense',
            `expense-void:${claim.code}`,
            error instanceof Error ? error.message : String(error),
            reverseLines,
            reverseDate,
          );
        }
      }
      return this.getClaimById(id);
    }

    /* ── 原有分支：approve / reject（前置状态是 pending / escalated）── */
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
      claim.expenseDate ?? todayInShanghai();
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
      const conn = tx as unknown as PostgresJsDatabase;
      if (claim.projectId) {
        await this.lockProjectAndPeriodBudgets(conn, claim.projectId, expenseDate.slice(0, 7));
        await this.assertProjectOccupancy(conn, claim.projectId, amount, {
          claimId: id,
        });
      }
      // F4X-9：CAS 状态流转，防双击重复入账
      const updated = await tx
        .update(finExpenseClaim)
        .set({ status: 'approved', updatedAt: new Date() })
        .where(
          and(
            eq(finExpenseClaim.id, id),
            inArray(finExpenseClaim.status, ['pending', 'escalated']),
          ),
        )
        .returning({ id: finExpenseClaim.id });
      if (updated.length === 0) {
        throw new ConflictException('该报销单已被处理，请刷新后重试');
      }
      await tx.insert(erpApBill).values({
        code: apCode,
        supplierId: null,
        projectId: claim.projectId,
        amount: storedMoney(amount),
        paidAmount: '0',
        dueDate: expenseDate,
        status: 'pending',
        source: 'expense',
        sourceRef: `expense:${claim.code}`,
        remark: `报销单${claim.code}`,
      });
      if (claim.projectId) {
        await tx.insert(erpProjectCost).values({
          code: costCode,
          projectId: claim.projectId,
          costType: 'travel',
          amount: storedMoney(amount),
          period: expenseDate.slice(0, 7),
          occurredDate: expenseDate,
          sourceRef: `expense:${claim.code}`,
          remark: `报销单${claim.code} 归集差旅成本`,
        });
      }
    });

    /* A1：挂应付，贷 2202；付款审批再借 2202 / 贷 1001，避免银行重复出账 */
    // P1-9：把分录取出为常量，失败登记补偿队列时**必须带上分录**，否则队列里是一条
    // 永远无法重放、只会被判 dead 的空记录（等于没登记）。
    const expenseLines = [
      { accountCode: '6602', debit: amount },
      { accountCode: '2202', credit: amount },
    ];
    try {
      await this.voucherHookService.generateVoucherDraft({
        sourceType: 'expense',
        sourceRef: `expense:${claim.code}`,
        voucherDate: expenseDate,
        summary: `报销挂账 ${claim.code}`,
        lines: expenseLines,
      });
    } catch (error) {
      this.logger.error(
        `报销凭证草稿生成失败：expense:${claim.code}`,
        error instanceof Error ? error.stack : String(error)
      );
      await this.voucherHookService.recordCompensation(
        'expense',
        `expense:${claim.code}`,
        error instanceof Error ? error.message : String(error),
        expenseLines,
        expenseDate
      );
    }

    return this.getClaimById(id);
  }
}

function storedMoney(value: number): string {
  const text = moneyText(value);
  if (text == null) {
    throw new BadRequestException('金额无法换算到分');
  }
  return text;
}
