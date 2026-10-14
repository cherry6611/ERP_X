import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  BudgetCommitmentSummary,
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
  ensureNotForbidden(resp);
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
  ensureNotForbidden(resp);
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
