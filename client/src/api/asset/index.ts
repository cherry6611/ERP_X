import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  AssetChangeAction,
  AssetChangeItem,
  AssetChangeListParams,
  AssetDepreciationItem,
  AssetDepreciationListParams,
  AssetItem,
  AssetListParams,
  AssetOverview,
  CreateAssetChangeDto,
  CreateAssetDto,
  DepreciatePeriodDto,
  DepreciateResult,
  PagedResult,
} from '@shared/api.interface';

/* ========== 资产 ========== */

export async function listAssets(
  params?: AssetListParams,
): Promise<PagedResult<AssetItem>> {
  const resp = await axiosForBackend.get<PagedResult<AssetItem>>(
    '/api/asset/assets',
    { params },
  );
  return resp.data;
}

export async function createAsset(dto: CreateAssetDto): Promise<AssetItem> {
  const resp = await axiosForBackend.post<AssetItem>(
    '/api/asset/assets',
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function getOverview(): Promise<AssetOverview> {
  const resp = await axiosForBackend.get<AssetOverview>(
    '/api/asset/overview',
  );
  return resp.data;
}

/* ========== 资产变更 ========== */

export async function listChanges(
  params?: AssetChangeListParams,
): Promise<PagedResult<AssetChangeItem>> {
  const resp = await axiosForBackend.get<PagedResult<AssetChangeItem>>(
    '/api/asset/changes',
    { params },
  );
  return resp.data;
}

export async function createChange(
  dto: CreateAssetChangeDto,
): Promise<AssetChangeItem> {
  const resp = await axiosForBackend.post<AssetChangeItem>(
    '/api/asset/changes',
    dto,
  );
  return resp.data;
}

export async function changeAction(
  id: string,
  action: AssetChangeAction,
): Promise<AssetChangeItem> {
  const resp = await axiosForBackend.post<AssetChangeItem>(
    `/api/asset/changes/${id}/actions/${action}`,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

/* ========== 折旧 ========== */

export async function listDepreciations(
  params?: AssetDepreciationListParams,
): Promise<PagedResult<AssetDepreciationItem>> {
  const resp = await axiosForBackend.get<PagedResult<AssetDepreciationItem>>(
    '/api/asset/depreciations',
    { params },
  );
  return resp.data;
}

export async function depreciate(
  dto: DepreciatePeriodDto,
): Promise<DepreciateResult> {
  const resp = await axiosForBackend.post<DepreciateResult>(
    '/api/asset/depreciate',
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}
