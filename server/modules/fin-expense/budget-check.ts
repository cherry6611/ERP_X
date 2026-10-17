/**
 * 费用申请/报销的**预算闸门**（从 `fin-expense.service.ts` 的 `checkBudget` 抽出，§5.9）。
 *
 * ## 为什么必须能单测
 *
 * 这段代码决定"这笔费用能不能提"。判据写错有两个方向的后果，都很难在界面上发现：
 *
 * · **多算占用（在途被重复计入）** → 明明有预算却驳回申请，业务被卡住；
 * · **少算占用（该计的不计）** → 超预算也能通过，**预算控制形同虚设**。
 *
 * 具体有三处容易写错、且错了不报错的判据：
 *
 * ① **`approved` 的申请不计入"在途占用"**（只 `pending` + `approved` 里，
 *    `approved` 在申请侧仍算占用？—— 见 `occupiedApplies` 的来源：
 *    申请侧取 `pending | approved` 全部计入占用）。
 *    ⚠️ 而**报销侧**只把 `pending | escalated` 计入占用，`approved` 归入**已执行**。
 *    两侧口径不同是刻意的：申请的 `approved` 只是"同意花钱"（钱还没花出去），
 *    报销的 `approved` 才代表**费用已发生**。若把报销 `approved` 也计入在途，
 *    会与已执行**重复计数**。
 * ② **金额用 `Number(x ?? 0)`**：`numeric` 列经 pg 驱动返回的是**字符串**，
 *    直接相加会变成字符串拼接（`'100' + '200' = '100200'`），闸门恒不超额。
 * ③ **无匹配预算 = 不拦**（`hasBudget:false`、`exceeded:false`）：
 *    这是"没编预算就不管"的口径，不是"没预算就拒绝"。写反会让所有无预算部门无法报销。
 */

import { round2 } from '@shared/number';

/** 单据维度（与 `fin-budget` 的 `DocDims` 对齐） */
export interface DocDims {
  period: string;
  expenseCategory: string;
  departmentId: string | null;
  projectId: string | null;
}

/** 预算行维度 */
export interface BudgetDims {
  departmentId: string | null;
  projectId: string | null;
  expenseCategory: string | null;
  period: string | null;
}

/** 费用记录维度（申请或报销） */
export interface ExpenseRecordDims {
  id: string;
  departmentId: string | null;
  projectId: string | null;
  expenseCategory: string | null;
  amount: string | null;
  /** 归属期间（由 `docPeriodOf` 从日期算出） */
  period: string;
}

export interface BudgetCheckResult {
  hasBudget: boolean;
  budgetAmount: number;
  executed: number;
  occupied: number;
  exceeded: boolean;
}

/** 费用申请状态（决定计入"在途"还是"已执行"） */
export type ExpenseApplyStatusForBudget = 'pending' | 'approved';
/** 费用报销状态（决定计入"在途"还是"已执行"） */
export type ExpenseClaimStatusForBudget = 'pending' | 'escalated' | 'approved';

/** 维度是否匹配（与 `fin-budget` 的 `budgetMatchesDoc` 同判据，此处按需内联以保持纯函数自洽） */
function matches(budget: BudgetDims, doc: DocDims): boolean {
  if (budget.period !== doc.period) return false;
  if ((budget.expenseCategory ?? '') !== doc.expenseCategory) return false;
  /* null = 不限该维度（通配），非 null 才要求相等 */
  if (budget.departmentId !== null && budget.departmentId !== doc.departmentId) return false;
  if (budget.projectId !== null && budget.projectId !== doc.projectId) return false;
  return true;
}

/**
 * 汇总"命中某维度"的记录金额，**同一 id 只算一次**。
 *
 * 去重是必要的：同一张单据可能同时被多条预算命中（例如"部门预算"与"项目预算"各一条），
 * 若按命中次数重复相加，占用会被放大若干倍 → 有预算也报超支。
 */
export function sumMatchedRecords(
  records: ExpenseRecordDims[],
  budgets: BudgetDims[],
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const record of records) {
    if (seen.has(record.id)) continue;
    const doc: DocDims = {
      period: record.period,
      expenseCategory: record.expenseCategory ?? '',
      departmentId: record.departmentId,
      projectId: record.projectId,
    };
    if (budgets.some((budget) => matches(budget, doc))) {
      total += Number(record.amount ?? 0);
      seen.add(record.id);
    }
  }
  return round2(total);
}

/** 预算行（维度 + 金额） */
export interface MatchedBudgetRow extends BudgetDims {
  budgetAmount: string | null;
}

/**
 * 计算预算检查结果（与 `checkBudget` 的纯计算部分逐字一致）。
 *
 * 入参已由调用方查好（本函数不碰数据库），因此可完整断言。
 */
export function computeBudgetCheck(params: {
  /** 与该单据维度匹配的预算行（**已过滤**） */
  matchedBudgets: MatchedBudgetRow[];
  /** 费用申请（调用方已按 `pending | approved` 过滤） */
  applies: ExpenseRecordDims[];
  /** 费用报销（**未过滤**，本函数内按状态分流） */
  claims: Array<ExpenseRecordDims & { status: ExpenseClaimStatusForBudget }>;
  /** 本次单据金额 */
  docAmount: number;
}): BudgetCheckResult {
  const { matchedBudgets, applies, claims, docAmount } = params;

  /* ② 无匹配预算 → 不拦（口径："没编预算就不管"，不是"没预算就拒绝"） */
  if (matchedBudgets.length === 0) {
    return { hasBudget: false, budgetAmount: 0, executed: 0, occupied: 0, exceeded: false };
  }

  /* ③ 金额一律过 Number：numeric 经 pg 驱动返回字符串 */
  const budgetAmount = round2(
    matchedBudgets.reduce((total, b) => total + Number(b.budgetAmount ?? 0), 0),
  );

  /* 只保留维度字段用于匹配（金额不参与匹配判据） */
  const matched: BudgetDims[] = matchedBudgets.map((b) => ({
    departmentId: b.departmentId,
    projectId: b.projectId,
    expenseCategory: b.expenseCategory,
    period: b.period,
  }));

  /*
   * ① 两侧口径不同（见文件头）：
   *    · 申请：`pending | approved` **全部**计入在途占用；
   *    · 报销：`pending | escalated` 计入在途，`approved` 计入**已执行**。
   */
  const occupiedApplies = applies;
  const occupiedClaims = claims.filter(
    (r) => r.status === 'pending' || r.status === 'escalated',
  );
  const executedClaims = claims.filter((r) => r.status === 'approved');

  const occupied = round2(
    sumMatchedRecords(occupiedApplies, matched) + sumMatchedRecords(occupiedClaims, matched),
  );
  const executed = sumMatchedRecords(executedClaims, matched);

  return {
    hasBudget: true,
    budgetAmount,
    executed,
    occupied,
    exceeded: round2(executed + occupied + docAmount) > budgetAmount,
  };
}

/**
 * 超预算时的提示文案（与 `fin-expense.service.ts` 的 400 文案逐字一致）。
 *
 * 抽出来是为了让"超出金额"的口径可断言 —— 它是**三个数相加再减预算**，
 * 少加一项（例如漏了在途占用）会让提示金额与实际拦截不一致，使用者会以为系统算错。
 */
export function budgetExceededMessage(
  check: BudgetCheckResult,
  docAmount: number,
): string {
  return (
    `预算不足：预算总额 ${check.budgetAmount} 元，已执行 ${check.executed} 元，` +
    `在途占用 ${check.occupied} 元，本次申请 ${docAmount} 元，` +
    `超出 ${round2(check.executed + check.occupied + docAmount - check.budgetAmount)} 元`
  );
}
