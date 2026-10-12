import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, count, eq } from 'drizzle-orm';
import {
  erpProject,
  finBudget,
  finExpenseApply,
  finExpenseClaim,
  hrDepartment,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import type {
  BudgetExecution,
  BudgetItem,
  CreateBudgetDto,
  PagedResult,
  UpdateBudgetDto,
} from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const PAGE_MAX = 100;

/* ========== 预算维度匹配（fin-budget / fin-expense 共用） ========== */

/** 业务时区月份（Asia/Shanghai 与沙箱本地一致，直接取本地年月） */
export function currentMonthPeriod(now: Date = new Date()): string {
  const y: number = now.getFullYear();
  const m: string = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** 单据期间：expectDate/expenseDate 所在 YYYY-MM，无日期用当前月 */
export function docPeriodOf(date: string | null | undefined): string {
  if (date && date.length >= 7) return date.slice(0, 7);
  return currentMonthPeriod();
}

export interface BudgetDims {
  departmentId: string | null;
  projectId: string | null;
  expenseCategory: string | null;
  period: string | null;
}

export interface DocDims {
  departmentId: string | null;
  projectId: string | null;
  expenseCategory: string;
  period: string;
}

/**
 * 维度匹配：period / expenseCategory 相等；
 * budget.departmentId 为 NULL 表示不限部门（projectId 同理）。
 */
export function budgetMatchesDoc(budget: BudgetDims, doc: DocDims): boolean {
  if (budget.period !== doc.period) return false;
  if ((budget.expenseCategory ?? '') !== doc.expenseCategory) return false;
  if (budget.departmentId !== null && budget.departmentId !== doc.departmentId) {
    return false;
  }
  if (budget.projectId !== null && budget.projectId !== doc.projectId) {
    return false;
  }
  return true;
}

export interface ExpenseRecordDims {
  id: string;
  departmentId: string | null;
  projectId: string | null;
  expenseCategory: string | null;
  amount: string | null;
  period: string;
}

/** 汇总与预算集合匹配的单据金额（按 id 去重，避免一条单据匹配多条预算被重复累计） */
export function sumMatchedRecords(
  records: ExpenseRecordDims[],
  budgets: BudgetDims[],
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const record of records) {
    if (seen.has(record.id)) continue;
    const doc: DocDims = {
      departmentId: record.departmentId,
      projectId: record.projectId,
      expenseCategory: record.expenseCategory ?? '',
      period: record.period,
    };
    if (budgets.some((budget: BudgetDims) => budgetMatchesDoc(budget, doc))) {
      seen.add(record.id);
      total += Number(record.amount ?? 0);
    }
  }
  return total;
}

interface BudgetRow {
  id: string;
  code: string;
  departmentId: string | null;
  projectId: string | null;
  expenseCategory: string | null;
  period: string | null;
  budgetAmount: string | null;
  remark: string | null;
  createdAt: Date;
  departmentName: string | null;
  projectName: string | null;
}

interface ApplyAggRow {
  id: string;
  departmentId: string | null;
  projectId: string | null;
  expenseCategory: string | null;
  amount: string | null;
  expectDate: string | null;
  status: string | null;
}

interface ClaimAggRow {
  id: string;
  departmentId: string | null;
  projectId: string | null;
  expenseCategory: string | null;
  amount: string | null;
  expenseDate: string | null;
  status: string | null;
}

@Injectable()
export class FinBudgetService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  /* ========== 聚合数据加载 ========== */

  private async loadApplyAggregates(): Promise<ApplyAggRow[]> {
    return this.db
      .select({
        id: finExpenseApply.id,
        departmentId: finExpenseApply.departmentId,
        projectId: finExpenseApply.projectId,
        expenseCategory: finExpenseApply.expenseCategory,
        amount: finExpenseApply.amount,
        expectDate: finExpenseApply.expectDate,
        status: finExpenseApply.status,
      })
      .from(finExpenseApply);
  }

  private async loadClaimAggregates(): Promise<ClaimAggRow[]> {
    return this.db
      .select({
        id: finExpenseClaim.id,
        departmentId: finExpenseClaim.departmentId,
        projectId: finExpenseClaim.projectId,
        expenseCategory: finExpenseClaim.expenseCategory,
        amount: finExpenseClaim.amount,
        expenseDate: finExpenseClaim.expenseDate,
        status: finExpenseClaim.status,
      })
      .from(finExpenseClaim);
  }

  private toBudgetItem(
    row: BudgetRow,
    occupied: number,
    executed: number
  ): BudgetItem {
    const budgetAmount = Number(row.budgetAmount ?? 0);
    return {
      id: row.id,
      code: row.code,
      departmentId: row.departmentId,
      departmentName: row.departmentName,
      projectId: row.projectId,
      projectName: row.projectName,
      expenseCategory: row.expenseCategory ?? '',
      period: row.period ?? '',
      budgetAmount,
      occupiedAmount: occupied,
      executedAmount: executed,
      availableAmount: budgetAmount - occupied - executed,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /* ========== 预算 CRUD ========== */

  async listBudgets(
    page: number,
    pageSize: number,
    period?: string,
    projectId?: string,
    departmentId?: string
  ): Promise<PagedResult<BudgetItem>> {
    const conditions = [];
    if (period) conditions.push(eq(finBudget.period, period));
    if (projectId) conditions.push(eq(finBudget.projectId, projectId));
    if (departmentId) {
      conditions.push(eq(finBudget.departmentId, departmentId));
    }
    const where =
      conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(finBudget)
      .where(where);
    const total = Number(totalRows[0]?.total ?? 0);

    const rows: BudgetRow[] = await this.db
      .select({
        id: finBudget.id,
        code: finBudget.code,
        departmentId: finBudget.departmentId,
        projectId: finBudget.projectId,
        expenseCategory: finBudget.expenseCategory,
        period: finBudget.period,
        budgetAmount: finBudget.budgetAmount,
        remark: finBudget.remark,
        createdAt: finBudget.createdAt,
        departmentName: hrDepartment.name,
        projectName: erpProject.name,
      })
      .from(finBudget)
      .leftJoin(hrDepartment, eq(finBudget.departmentId, hrDepartment.id))
      .leftJoin(erpProject, eq(finBudget.projectId, erpProject.id))
      .where(where)
      .orderBy(asc(finBudget.period), asc(finBudget.code))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const [applies, claims] = await Promise.all([
      this.loadApplyAggregates(),
      this.loadClaimAggregates(),
    ]);
    const occupiedApplies = applies
      .filter((r: ApplyAggRow) => r.status === 'pending' || r.status === 'approved')
      .map((r: ApplyAggRow) => this.toRecordDims(r, r.expectDate));
    const occupiedClaims = claims
      .filter((r: ClaimAggRow) => r.status === 'pending' || r.status === 'escalated')
      .map((r: ClaimAggRow) => this.toRecordDims(r, r.expenseDate));
    const executedClaims = claims
      .filter((r: ClaimAggRow) => r.status === 'approved')
      .map((r: ClaimAggRow) => this.toRecordDims(r, r.expenseDate));

    const items: BudgetItem[] = rows.map((row: BudgetRow) => {
      const dims: BudgetDims = {
        departmentId: row.departmentId,
        projectId: row.projectId,
        expenseCategory: row.expenseCategory,
        period: row.period,
      };
      const occupied =
        sumMatchedRecords(occupiedApplies, [dims]) +
        sumMatchedRecords(occupiedClaims, [dims]);
      const executed = sumMatchedRecords(executedClaims, [dims]);
      return this.toBudgetItem(row, occupied, executed);
    });

    return { items, total, page, pageSize };
  }

  private toRecordDims(
    row: ApplyAggRow | ClaimAggRow,
    date: string | null
  ): ExpenseRecordDims {
    return {
      id: row.id,
      departmentId: row.departmentId,
      projectId: row.projectId,
      expenseCategory: row.expenseCategory,
      amount: row.amount,
      period: docPeriodOf(date),
    };
  }

  async createBudget(dto: CreateBudgetDto): Promise<BudgetItem> {
    if (!PERIOD_PATTERN.test(dto.period)) {
      throw new BadRequestException('期间格式必须为 YYYY-MM');
    }
    const code = await generateBizCode(
      this.db,
      finBudget,
      finBudget.code,
      'BGT'
    );
    const inserted = await this.db
      .insert(finBudget)
      .values({
        code,
        departmentId: dto.departmentId ?? null,
        projectId: dto.projectId ?? null,
        expenseCategory: dto.expenseCategory,
        period: dto.period,
        budgetAmount: String(dto.budgetAmount),
        remark: dto.remark ?? null,
      })
      .returning({ id: finBudget.id });
    return this.getBudgetById(inserted[0].id);
  }

  async updateBudget(
    id: string,
    dto: UpdateBudgetDto
  ): Promise<BudgetItem> {
    const patch: Partial<typeof finBudget.$inferInsert> = {};
    if (dto.budgetAmount !== undefined) {
      patch.budgetAmount = String(dto.budgetAmount);
    }
    if (dto.remark !== undefined) patch.remark = dto.remark;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }
    patch.updatedAt = new Date();
    const rows = await this.db
      .update(finBudget)
      .set(patch)
      .where(eq(finBudget.id, id))
      .returning({ id: finBudget.id });
    if (rows.length === 0) throw new NotFoundException('预算记录不存在');
    return this.getBudgetById(id);
  }

  async getBudgetById(id: string): Promise<BudgetItem> {
    const rows: BudgetRow[] = await this.db
      .select({
        id: finBudget.id,
        code: finBudget.code,
        departmentId: finBudget.departmentId,
        projectId: finBudget.projectId,
        expenseCategory: finBudget.expenseCategory,
        period: finBudget.period,
        budgetAmount: finBudget.budgetAmount,
        remark: finBudget.remark,
        createdAt: finBudget.createdAt,
        departmentName: hrDepartment.name,
        projectName: erpProject.name,
      })
      .from(finBudget)
      .leftJoin(hrDepartment, eq(finBudget.departmentId, hrDepartment.id))
      .leftJoin(erpProject, eq(finBudget.projectId, erpProject.id))
      .where(eq(finBudget.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('预算记录不存在');
    const row = rows[0];
    const [applies, claims] = await Promise.all([
      this.loadApplyAggregates(),
      this.loadClaimAggregates(),
    ]);
    const dims: BudgetDims = {
      departmentId: row.departmentId,
      projectId: row.projectId,
      expenseCategory: row.expenseCategory,
      period: row.period,
    };
    const occupiedApplies = applies
      .filter((r: ApplyAggRow) => r.status === 'pending' || r.status === 'approved')
      .map((r: ApplyAggRow) => this.toRecordDims(r, r.expectDate));
    const occupiedClaims = claims
      .filter((r: ClaimAggRow) => r.status === 'pending' || r.status === 'escalated')
      .map((r: ClaimAggRow) => this.toRecordDims(r, r.expenseDate));
    const executedClaims = claims
      .filter((r: ClaimAggRow) => r.status === 'approved')
      .map((r: ClaimAggRow) => this.toRecordDims(r, r.expenseDate));
    const occupied =
      sumMatchedRecords(occupiedApplies, [dims]) +
      sumMatchedRecords(occupiedClaims, [dims]);
    const executed = sumMatchedRecords(executedClaims, [dims]);
    return this.toBudgetItem(row, occupied, executed);
  }

  /* ========== 预算执行率（BI） ========== */

  async listExecutions(): Promise<BudgetExecution[]> {
    const budgets: Array<{
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
      .orderBy(asc(finBudget.period));

    if (budgets.length === 0) return [];

    const [applies, claims] = await Promise.all([
      this.loadApplyAggregates(),
      this.loadClaimAggregates(),
    ]);
    const occupiedApplies = applies
      .filter((r: ApplyAggRow) => r.status === 'pending' || r.status === 'approved')
      .map((r: ApplyAggRow) => this.toRecordDims(r, r.expectDate));
    const occupiedClaims = claims
      .filter((r: ClaimAggRow) => r.status === 'pending' || r.status === 'escalated')
      .map((r: ClaimAggRow) => this.toRecordDims(r, r.expenseDate));
    const executedClaims = claims
      .filter((r: ClaimAggRow) => r.status === 'approved')
      .map((r: ClaimAggRow) => this.toRecordDims(r, r.expenseDate));

    const periods = [...new Set(budgets.map((b) => b.period ?? ''))].sort();
    return periods.map((period: string) => {
      const periodBudgets = budgets.filter((b) => (b.period ?? '') === period);
      const budgetAmount = periodBudgets.reduce(
        (sum: number, b) => sum + Number(b.budgetAmount ?? 0),
        0
      );
      const occupied =
        sumMatchedRecords(occupiedApplies, periodBudgets) +
        sumMatchedRecords(occupiedClaims, periodBudgets);
      const executed = sumMatchedRecords(executedClaims, periodBudgets);
      return {
        period,
        budgetAmount,
        occupiedAmount: occupied,
        executedAmount: executed,
        availableAmount: budgetAmount - occupied - executed,
      };
    });
  }
}
