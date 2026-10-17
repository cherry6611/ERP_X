import { axiosForBackend } from '@client/src/platform/request';
import type {
  BudgetCommitmentSummary,
  BudgetForecastResult,
  BudgetType,
  FullBudgetOverview,
  BudgetExecution,
  BudgetItem,
  BudgetListParams,
  CommitmentGapRow,
  CreateBudgetDto,
  PagedResult,
  UpdateBudgetDto,
} from '@shared/api.interface';

export async function listBudgets(
  params?: BudgetListParams,
): Promise<PagedResult<BudgetItem>> {
  const resp = await axiosForBackend.get<PagedResult<BudgetItem>>(
    '/api/fin-budget/budgets',
    { params },
  );
  return resp.data;
}

export async function createBudget(dto: CreateBudgetDto): Promise<BudgetItem> {
  const resp = await axiosForBackend.post<BudgetItem>(
    '/api/fin-budget/budgets',
    dto,
  );
  return resp.data;
}

export async function updateBudget(
  id: string,
  dto: UpdateBudgetDto,
): Promise<BudgetItem> {
  const resp = await axiosForBackend.patch<BudgetItem>(
    `/api/fin-budget/budgets/${id}`,
    dto,
  );
  return resp.data;
}

export async function getExecutions(): Promise<BudgetExecution[]> {
  const resp = await axiosForBackend.get<BudgetExecution[]>(
    '/api/fin-budget/executions',
  );
  return resp.data;
}

/* ========== C-09 预算承诺与三算对比 ========== */

export async function getCommitments(
  period?: string,
): Promise<BudgetCommitmentSummary> {
  const resp = await axiosForBackend.get<BudgetCommitmentSummary>(
    '/api/fin-budget/commitments',
    { params: period ? { period } : undefined },
  );
  return resp.data;
}

export async function getCommitmentGaps(
  period?: string,
): Promise<CommitmentGapRow[]> {
  const resp = await axiosForBackend.get<CommitmentGapRow[]>(
    '/api/fin-budget/commitment-gaps',
    { params: period ? { period } : undefined },
  );
  return resp.data;
}

/* ========== D-05 全面预算：滚动预测与差异分析 ========== */

/** 全面预算总览（三类预算 + 费用率联动 + 差异 + CAPEX 分析） */
export async function getFullBudgetOverview(params: {
  year: string;
  asOf?: string;
  projectId?: string;
  departmentId?: string;
}): Promise<FullBudgetOverview> {
  const resp = await axiosForBackend.get<FullBudgetOverview>(
    '/api/fin-budget/full-overview',
    { params },
  );
  return resp.data;
}

/** 单类型滚动预测 */
export async function getBudgetForecast(params: {
  year: string;
  budgetType: BudgetType;
  asOf?: string;
  projectId?: string;
  departmentId?: string;
}): Promise<BudgetForecastResult> {
  const resp = await axiosForBackend.get<BudgetForecastResult>(
    '/api/fin-budget/forecast',
    { params },
  );
  return resp.data;
}