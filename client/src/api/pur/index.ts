import { axiosForBackend } from '@client/src/platform/request';
import type {
  AcceptPurOrderDto,
  CreatePurOrderDto,
  CreatePurRequestDto,
  PagedResult,
  PurChainSummary,
  PurOrderListParams,
  PurOrderItem,
  PurRequestAction,
  PurRequestItem,
  PurRequestListParams,
} from '@shared/api.interface';

/* ========== 采购申请 ========== */

export async function listRequests(
  params?: PurRequestListParams,
): Promise<PagedResult<PurRequestItem>> {
  const resp = await axiosForBackend.get<PagedResult<PurRequestItem>>(
    '/api/pur/requests',
    { params },
  );
  return resp.data;
}

export async function createRequest(
  dto: CreatePurRequestDto,
): Promise<PurRequestItem> {
  const resp = await axiosForBackend.post<PurRequestItem>(
    '/api/pur/requests',
    dto,
  );
  return resp.data;
}

export async function requestAction(
  id: string,
  action: PurRequestAction,
): Promise<PurRequestItem> {
  const resp = await axiosForBackend.post<PurRequestItem>(
    `/api/pur/requests/${id}/actions/${action}`,
  );
  return resp.data;
}

/* ========== 采购订单 ========== */

export async function listOrders(
  params?: PurOrderListParams,
): Promise<PagedResult<PurOrderItem>> {
  const resp = await axiosForBackend.get<PagedResult<PurOrderItem>>(
    '/api/pur/orders',
    { params },
  );
  return resp.data;
}

export async function createOrder(
  dto: CreatePurOrderDto,
): Promise<PurOrderItem> {
  const resp = await axiosForBackend.post<PurOrderItem>(
    '/api/pur/orders',
    dto,
  );
  return resp.data;
}

export async function acceptOrder(
  id: string,
  dto: AcceptPurOrderDto,
): Promise<PurOrderItem> {
  const resp = await axiosForBackend.post<PurOrderItem>(
    `/api/pur/orders/${id}/accept`,
    dto,
  );
  return resp.data;
}

export async function cancelOrder(id: string): Promise<PurOrderItem> {
  const resp = await axiosForBackend.post<PurOrderItem>(
    `/api/pur/orders/${id}/actions/cancel`,
  );
  return resp.data;
}

/* ========== 采购链路看板 ========== */

export async function getChainSummary(): Promise<PurChainSummary> {
  const resp = await axiosForBackend.get<PurChainSummary>(
    '/api/pur/chain-summary',
  );
  return resp.data;
}
