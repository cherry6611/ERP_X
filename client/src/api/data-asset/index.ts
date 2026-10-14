import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  CreateDatasetDto,
  CreateGrantDto,
  DatasetAction,
  DatasetItem,
  DatasetFieldItem,
  DatasetListParams,
  GrantItem,
  GrantRevokeLogItem,
  MaskLevelOption,
  MaskPreviewResult,
  GrantListParams,
  GrantWarningItem,
  PagedResult,
  RevokeGrantDto,
  RevokeGrantResult,
  UpdateDatasetDto,
  UpsertDatasetFieldDto,
} from '@shared/api.interface';

/* ========== 数据集目录 ========== */

export async function listDatasets(
  params?: DatasetListParams,
): Promise<PagedResult<DatasetItem>> {
  const resp = await axiosForBackend.get<PagedResult<DatasetItem>>(
    '/api/data-asset/datasets',
    { params },
  );
  return resp.data;
}

export async function createDataset(dto: CreateDatasetDto): Promise<DatasetItem> {
  const resp = await axiosForBackend.post<DatasetItem>(
    '/api/data-asset/datasets',
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function updateDataset(
  id: string,
  dto: UpdateDatasetDto,
): Promise<DatasetItem> {
  const resp = await axiosForBackend.patch<DatasetItem>(
    `/api/data-asset/datasets/${id}`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function datasetAction(
  id: string,
  action: DatasetAction,
): Promise<DatasetItem> {
  const resp = await axiosForBackend.post<DatasetItem>(
    `/api/data-asset/datasets/${id}/actions/${action}`,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

/* ========== 授权记录 ========== */

export async function listGrants(
  params?: GrantListParams,
): Promise<PagedResult<GrantItem>> {
  const resp = await axiosForBackend.get<PagedResult<GrantItem>>(
    '/api/data-asset/grants',
    { params },
  );
  return resp.data;
}

export async function createGrant(dto: CreateGrantDto): Promise<GrantItem> {
  const resp = await axiosForBackend.post<GrantItem>(
    '/api/data-asset/grants',
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function expireGrant(id: string): Promise<GrantItem> {
  const resp = await axiosForBackend.post<GrantItem>(
    `/api/data-asset/grants/${id}/actions/expire`,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

/* ========== 到期预警 ========== */

export async function listGrantWarnings(): Promise<GrantWarningItem[]> {
  const resp = await axiosForBackend.get<GrantWarningItem[]>(
    '/api/data-asset/grant-warnings',
  );
  return resp.data;
}

/* ========== C-13 脱敏等级与授权回收审计 ========== */

export async function listMaskLevels(): Promise<MaskLevelOption[]> {
  const resp = await axiosForBackend.get<MaskLevelOption[]>(
    '/api/data-asset/mask-levels',
  );
  return resp.data;
}

export async function listDatasetFields(
  datasetId: string,
): Promise<DatasetFieldItem[]> {
  const resp = await axiosForBackend.get<DatasetFieldItem[]>(
    `/api/data-asset/datasets/${datasetId}/fields`,
  );
  return resp.data;
}

export async function upsertDatasetField(
  datasetId: string,
  dto: UpsertDatasetFieldDto,
): Promise<DatasetFieldItem> {
  const resp = await axiosForBackend.post<DatasetFieldItem>(
    `/api/data-asset/datasets/${datasetId}/fields`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function deleteDatasetField(
  datasetId: string,
  columnName: string,
): Promise<{ ok: true }> {
  const resp = await axiosForBackend.post<{ ok: true }>(
    `/api/data-asset/datasets/${datasetId}/fields/${encodeURIComponent(columnName)}/delete`,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function previewMasking(
  datasetId: string,
  sample: Record<string, unknown>,
): Promise<MaskPreviewResult> {
  const resp = await axiosForBackend.post<MaskPreviewResult>(
    `/api/data-asset/datasets/${datasetId}/mask-preview`,
    { sample },
  );
  return resp.data;
}

export async function revokeGrant(
  id: string,
  dto: RevokeGrantDto,
): Promise<RevokeGrantResult> {
  const resp = await axiosForBackend.post<RevokeGrantResult>(
    `/api/data-asset/grants/${id}/actions/revoke`,
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function listRevokeLogs(params?: {
  grantId?: string;
  datasetId?: string;
  page?: number;
  pageSize?: number;
}): Promise<PagedResult<GrantRevokeLogItem>> {
  const resp = await axiosForBackend.get<PagedResult<GrantRevokeLogItem>>(
    '/api/data-asset/grant-revoke-logs',
    { params },
  );
  return resp.data;
}