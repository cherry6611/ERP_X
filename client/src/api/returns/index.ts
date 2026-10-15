import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  CreatePurchaseReturnDto,
  CreateSalesReturnDto,
  PagedResult,
  PurchaseReturnItem,
  PurchaseReturnListParams,
  ReturnAction,
  ReturnRegisterResult,
  ReturnableQuantityResult,
  SalesReturnItem,
  SalesReturnListParams,
} from '@shared/api.interface';

/* ========== C-05：采购/销售退货闭环 ========== */

/** 状态与动作字典：前端据此渲染按钮，不硬编码状态机 */
export async function getReturnDictionaries(): Promise<{
  statuses: Array<{ value: string; label: string }>;
  actions: Array<{ value: ReturnAction; label: string; target: string }>;
}> {
  const resp = await axiosForBackend.get<{
    statuses: Array<{ value: string; label: string }>;
    actions: Array<{ value: ReturnAction; label: string; target: string }>;
  }>('/api/returns/dictionaries');
  return resp.data;
}

export async function getReturnRegister(): Promise<ReturnRegisterResult> {
  const resp = await axiosForBackend.get<ReturnRegisterResult>(
    '/api/returns/register',
  );
  return resp.data;
}

/**
 * 可退数量查询。**建单前必须先调这个**：
 * 可退 = 已验收 − 已退，未验收的货不可退；不查就会超退。
 */
export async function getPurchaseReturnable(
  orderId: string,
): Promise<ReturnableQuantityResult> {
  const resp = await axiosForBackend.get<ReturnableQuantityResult>(
    `/api/returns/purchase-returnable/${orderId}`,
  );
  return resp.data;
}

export async function listPurchaseReturns(
  params?: PurchaseReturnListParams,
): Promise<PagedResult<PurchaseReturnItem>> {
  const resp = await axiosForBackend.get<PagedResult<PurchaseReturnItem>>(
    '/api/returns/purchase',
    { params },
  );
  return resp.data;
}

export async function createPurchaseReturn(
  dto: CreatePurchaseReturnDto,
): Promise<PurchaseReturnItem> {
  const resp = await axiosForBackend.post<PurchaseReturnItem>(
    '/api/returns/purchase',
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function purchaseReturnAction(
  id: string,
  action: ReturnAction,
  remark?: string,
): Promise<PurchaseReturnItem> {
  const resp = await axiosForBackend.post<PurchaseReturnItem>(
    `/api/returns/purchase/${id}/actions`,
    { action, remark },
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function listSalesReturns(
  params?: SalesReturnListParams,
): Promise<PagedResult<SalesReturnItem>> {
  const resp = await axiosForBackend.get<PagedResult<SalesReturnItem>>(
    '/api/returns/sales',
    { params },
  );
  return resp.data;
}

export async function createSalesReturn(
  dto: CreateSalesReturnDto,
): Promise<SalesReturnItem> {
  const resp = await axiosForBackend.post<SalesReturnItem>(
    '/api/returns/sales',
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function salesReturnAction(
  id: string,
  action: ReturnAction,
  remark?: string,
  disposalType?: 'restock' | 'scrap',
): Promise<SalesReturnItem> {
  const resp = await axiosForBackend.post<SalesReturnItem>(
    `/api/returns/sales/${id}/actions`,
    { action, remark, disposalType },
  );
  ensureNotForbidden(resp);
  return resp.data;
}

/** 项目退货影响（采购退货应冲减项目成本，供项目页提示） */
export async function getReturnProjectImpact(projectId: string): Promise<{
  purchaseReturnedAmount: number;
  salesReturnedAmount: number;
  costAmount: number;
}> {
  const resp = await axiosForBackend.get<{
    purchaseReturnedAmount: number;
    salesReturnedAmount: number;
    costAmount: number;
  }>(`/api/returns/project-impact/${projectId}`);
  return resp.data;
}
