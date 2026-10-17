import { axiosForBackend } from '@client/src/platform/request';
import type {
  CreateExpenseApplyDto,
  CreateExpenseClaimDto,
  ExpenseApplyAction,
  ExpenseApplyItem,
  ExpenseClaimAction,
  ExpenseClaimItem,
  ExpenseListParams,
  PagedResult,
} from '@shared/api.interface';

/* ========== 费用申请 ========== */

export async function listApplies(
  params?: ExpenseListParams,
): Promise<PagedResult<ExpenseApplyItem>> {
  const resp = await axiosForBackend.get<PagedResult<ExpenseApplyItem>>(
    '/api/fin-expense/applies',
    { params },
  );
  return resp.data;
}

export async function createApply(
  dto: CreateExpenseApplyDto,
): Promise<ExpenseApplyItem> {
  const resp = await axiosForBackend.post<ExpenseApplyItem>(
    '/api/fin-expense/applies',
    dto,
  );
  return resp.data;
}

export async function applyAction(
  id: string,
  action: ExpenseApplyAction,
): Promise<ExpenseApplyItem> {
  const resp = await axiosForBackend.post<ExpenseApplyItem>(
    `/api/fin-expense/applies/${id}/actions/${action}`,
  );
  return resp.data;
}

/* ========== 报销单 ========== */

export async function listClaims(
  params?: ExpenseListParams,
): Promise<PagedResult<ExpenseClaimItem>> {
  const resp = await axiosForBackend.get<PagedResult<ExpenseClaimItem>>(
    '/api/fin-expense/claims',
    { params },
  );
  return resp.data;
}

export async function createClaim(
  dto: CreateExpenseClaimDto,
): Promise<ExpenseClaimItem> {
  const resp = await axiosForBackend.post<ExpenseClaimItem>(
    '/api/fin-expense/claims',
    dto,
  );
  return resp.data;
}

export async function claimAction(
  id: string,
  action: ExpenseClaimAction,
): Promise<ExpenseClaimItem> {
  const resp = await axiosForBackend.post<ExpenseClaimItem>(
    `/api/fin-expense/claims/${id}/actions/${action}`,
  );
  return resp.data;
}
