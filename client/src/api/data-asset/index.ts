import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  CreateDatasetDto,
  CreateGrantDto,
  DatasetAction,
  DatasetItem,
  DatasetListParams,
  GrantItem,
  GrantListParams,
  GrantWarningItem,
  PagedResult,
  UpdateDatasetDto,
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
