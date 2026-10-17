import { axiosForBackend } from '@client/src/platform/request';
import type {
  AdminAffairAction,
  AdminAffairItem,
  AdminAffairListParams,
  AdminAffairStatus,
  AdminAffairType,
  AdminAssetCategory,
  AdminAssetItem,
  AdminAssetListParams,
  AdminAssetStatus,
  AdminBillAction,
  AdminBillActionDto,
  AdminBillItem,
  AdminBillListParams,
  AdminBillStats,
  AdminBillType,
  AdminRentContractAction,
  AdminRentContractItem,
  AdminRentContractStats,
  AdminRentContractStatus,
  RentContractListParams,
  AutomationConfigItem,
  CreateAdminAffairDto,
  CreateAdminAssetDto,
  CreateAdminBillDto,
  CreateAdminRentContractDto,
  PagedResult,
  UpdateAdminAffairDto,
  UpdateAdminAssetDto,
  UpdateAdminBillDto,
  UpdateAdminRentContractDto,
} from '@shared/api.interface';

/* ========== 自动化任务开关 ========== */

export async function listAutomationConfig(): Promise<AutomationConfigItem[]> {
  const resp = await axiosForBackend.get<AutomationConfigItem[]>(
    '/api/admin/automation-config'
  );
  return resp.data;
}

export async function updateAutomationConfig(
  taskKey: string,
  enabled: boolean
): Promise<AutomationConfigItem> {
  const resp = await axiosForBackend.put<AutomationConfigItem>(
    `/api/admin/automation-config/${taskKey}`,
    { enabled }
  );
  return resp.data;
}

/* ========== 租房合同 ========== */

export async function listRentContracts(
  params?: RentContractListParams,
): Promise<PagedResult<AdminRentContractItem>> {
  const resp = await axiosForBackend.get<PagedResult<AdminRentContractItem>>(
    '/api/admin/rent-contracts',
    { params },
  );
  return resp.data;
}

export async function getRentContractStats(): Promise<AdminRentContractStats> {
  const resp = await axiosForBackend.get<AdminRentContractStats>(
    '/api/admin/rent-contracts/stats',
  );
  return resp.data;
}

export async function createRentContract(
  dto: CreateAdminRentContractDto,
): Promise<AdminRentContractItem> {
  const resp = await axiosForBackend.post<AdminRentContractItem>(
    '/api/admin/rent-contracts',
    dto,
  );
  return resp.data;
}

export async function updateRentContract(
  id: string,
  dto: UpdateAdminRentContractDto,
): Promise<AdminRentContractItem> {
  const resp = await axiosForBackend.patch<AdminRentContractItem>(
    `/api/admin/rent-contracts/${id}`,
    dto,
  );
  return resp.data;
}

export async function rentContractAction(
  id: string,
  action: AdminRentContractAction,
): Promise<AdminRentContractItem> {
  const resp = await axiosForBackend.post<AdminRentContractItem>(
    `/api/admin/rent-contracts/${id}/actions/${action}`,
  );
  return resp.data;
}

/* ========== 行政缴费单 ========== */

export async function listAdminBills(
  params?: AdminBillListParams,
): Promise<PagedResult<AdminBillItem>> {
  const resp = await axiosForBackend.get<PagedResult<AdminBillItem>>(
    '/api/admin/bills',
    { params },
  );
  return resp.data;
}

export async function getAdminBillStats(): Promise<AdminBillStats> {
  const resp = await axiosForBackend.get<AdminBillStats>(
    '/api/admin/bills/stats',
  );
  return resp.data;
}

export async function createAdminBill(
  dto: CreateAdminBillDto,
): Promise<AdminBillItem> {
  const resp = await axiosForBackend.post<AdminBillItem>(
    '/api/admin/bills',
    dto,
  );
  return resp.data;
}

export async function updateAdminBill(
  id: string,
  dto: UpdateAdminBillDto,
): Promise<AdminBillItem> {
  const resp = await axiosForBackend.patch<AdminBillItem>(
    `/api/admin/bills/${id}`,
    dto,
  );
  return resp.data;
}

export async function adminBillAction(
  id: string,
  action: AdminBillAction,
  dto?: AdminBillActionDto,
): Promise<AdminBillItem> {
  const resp = await axiosForBackend.post<AdminBillItem>(
    `/api/admin/bills/${id}/actions/${action}`,
    dto ?? {},
  );
  return resp.data;
}

/* ========== 行政资产 ========== */

export async function listAdminAssets(
  params?: AdminAssetListParams,
): Promise<PagedResult<AdminAssetItem>> {
  const resp = await axiosForBackend.get<PagedResult<AdminAssetItem>>(
    '/api/admin/assets',
    { params },
  );
  return resp.data;
}

export async function createAdminAsset(
  dto: CreateAdminAssetDto,
): Promise<AdminAssetItem> {
  const resp = await axiosForBackend.post<AdminAssetItem>(
    '/api/admin/assets',
    dto,
  );
  return resp.data;
}

export async function updateAdminAsset(
  id: string,
  dto: UpdateAdminAssetDto,
): Promise<AdminAssetItem> {
  const resp = await axiosForBackend.patch<AdminAssetItem>(
    `/api/admin/assets/${id}`,
    dto,
  );
  return resp.data;
}

export async function deleteAdminAsset(id: string): Promise<void> {
  const resp = await axiosForBackend.delete(`/api/admin/assets/${id}`);
}

/* ========== 车辆/差旅事务 ========== */

export async function listAdminAffairs(
  params?: AdminAffairListParams,
): Promise<PagedResult<AdminAffairItem>> {
  const resp = await axiosForBackend.get<PagedResult<AdminAffairItem>>(
    '/api/admin/affairs',
    { params },
  );
  return resp.data;
}

export async function createAdminAffair(
  dto: CreateAdminAffairDto,
): Promise<AdminAffairItem> {
  const resp = await axiosForBackend.post<AdminAffairItem>(
    '/api/admin/affairs',
    dto,
  );
  return resp.data;
}

export async function updateAdminAffair(
  id: string,
  dto: UpdateAdminAffairDto,
): Promise<AdminAffairItem> {
  const resp = await axiosForBackend.patch<AdminAffairItem>(
    `/api/admin/affairs/${id}`,
    dto,
  );
  return resp.data;
}

export async function adminAffairAction(
  id: string,
  action: AdminAffairAction,
): Promise<AdminAffairItem> {
  const resp = await axiosForBackend.post<AdminAffairItem>(
    `/api/admin/affairs/${id}/actions/${action}`,
  );
  return resp.data;
}

export async function deleteAdminAffair(id: string): Promise<void> {
  const resp = await axiosForBackend.delete(`/api/admin/affairs/${id}`);
}
