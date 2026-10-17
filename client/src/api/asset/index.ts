import { axiosForBackend } from '@client/src/platform/request';
import type {
  AssetChangeAction,
  AssetChangeItem,
  AssetChangeListParams,
  AssetDepreciationItem,
  AssetDepreciationListParams,
  AssetDisposalItem,
  AssetDisposalPreview,
  AssetDisposalType,
  AssetImpairmentItem,
  AssetItem,
  AssetLifecycleResult,
  AssetListParams,
  AssetOverview,
  CreateAssetChangeDto,
  CreateAssetDisposalDto,
  CreateAssetDto,
  CreateAssetImpairmentDto,
  DepreciatePeriodDto,
  DepreciateResult,
  DisposalAction,
  ImpairmentTestPreview,
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
  return resp.data;
}

/* ========== D-08 全生命周期 / 减值 / 处置 ========== */

export async function getLifecycle(
  assetId: string,
): Promise<AssetLifecycleResult> {
  const resp = await axiosForBackend.get<AssetLifecycleResult>(
    `/api/asset/assets/${assetId}/lifecycle`,
  );
  return resp.data;
}

export async function getOwnership(assetId: string) {
  const resp = await axiosForBackend.get<{
    departmentId: string | null;
    departmentName: string | null;
    projectId: string | null;
    projectName: string | null;
    keeperName: string | null;
  }>(`/api/asset/assets/${assetId}/ownership`);
  return resp.data;
}

export async function previewImpairmentTest(
  assetId: string,
  recoverableAmount: number,
): Promise<ImpairmentTestPreview> {
  const resp = await axiosForBackend.get<ImpairmentTestPreview>(
    '/api/asset/impairment-test',
    { params: { assetId, recoverableAmount } },
  );
  return resp.data;
}

export async function listImpairments(params?: {
  assetId?: string;
  period?: string;
  page?: number;
  pageSize?: number;
}): Promise<PagedResult<AssetImpairmentItem>> {
  const resp = await axiosForBackend.get<PagedResult<AssetImpairmentItem>>(
    '/api/asset/impairments',
    { params },
  );
  return resp.data;
}

export async function createImpairment(
  dto: CreateAssetImpairmentDto,
): Promise<AssetImpairmentItem> {
  const resp = await axiosForBackend.post<AssetImpairmentItem>(
    '/api/asset/impairments',
    dto,
  );
  return resp.data;
}

export async function deleteImpairment(id: string): Promise<{ ok: true }> {
  const resp = await axiosForBackend.post<{ ok: true }>(
    `/api/asset/impairments/${id}/delete`,
  );
  return resp.data;
}

export async function previewDisposal(params: {
  assetId: string;
  disposalType: AssetDisposalType;
  disposalIncome?: number;
  taxRate?: number;
}): Promise<AssetDisposalPreview> {
  const resp = await axiosForBackend.get<AssetDisposalPreview>(
    '/api/asset/disposal-preview',
    { params },
  );
  return resp.data;
}

export async function listDisposals(params?: {
  assetId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<PagedResult<AssetDisposalItem>> {
  const resp = await axiosForBackend.get<PagedResult<AssetDisposalItem>>(
    '/api/asset/disposals',
    { params },
  );
  return resp.data;
}

export async function createDisposal(
  dto: CreateAssetDisposalDto,
): Promise<AssetDisposalItem> {
  const resp = await axiosForBackend.post<AssetDisposalItem>(
    '/api/asset/disposals',
    dto,
  );
  return resp.data;
}

export async function disposalAction(
  id: string,
  action: DisposalAction,
): Promise<AssetDisposalItem> {
  const resp = await axiosForBackend.post<AssetDisposalItem>(
    `/api/asset/disposals/${id}/actions/${action}`,
  );
  return resp.data;
}
