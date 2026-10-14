import { axiosForBackend } from '@client/src/platform/request';
import { logger } from '@client/src/platform/logger';
import type {
  DriveCreatedItem,
  DriveFolderChildrenResponse,
  FeishuDriveConfigResponse,
  UpdateFeishuDriveConfigRequest,
  WikiNodesResponse,
} from '@shared/api.interface';

export async function getDriveConfig(): Promise<FeishuDriveConfigResponse> {
  const resp = await axiosForBackend.get<FeishuDriveConfigResponse>(
    '/api/drive/config',
  );
  return resp.data;
}

export async function updateDriveConfig(
  body: UpdateFeishuDriveConfigRequest,
): Promise<FeishuDriveConfigResponse> {
  const resp = await axiosForBackend.put<FeishuDriveConfigResponse>(
    '/api/drive/config',
    body,
  );
  return resp.data;
}

export async function fetchDriveRoot(): Promise<{ folderToken: string }> {
  const resp = await axiosForBackend.get('/api/drive/root');
  return resp.data;
}

export async function fetchFolderChildren(
  folderToken: string,
  pageToken?: string | null,
): Promise<DriveFolderChildrenResponse> {
  const resp = await axiosForBackend.get(
    `/api/drive/folders/${folderToken}/children`,
    { params: pageToken ? { pageToken } : undefined },
  );
  return resp.data;
}

export async function createFolder(
  parentToken: string,
  name: string,
): Promise<DriveCreatedItem> {
  const resp = await axiosForBackend.post('/api/drive/folders', {
    parentToken,
    name,
  });
  return resp.data;
}

export async function createDocument(
  folderToken: string,
  title: string,
): Promise<DriveCreatedItem> {
  const resp = await axiosForBackend.post('/api/drive/documents', {
    folderToken,
    title,
  });
  return resp.data;
}

export async function uploadFile(
  folderToken: string,
  fileName: string,
  base64Content: string,
  size: number,
): Promise<DriveCreatedItem> {
  const resp = await axiosForBackend.post('/api/drive/files/upload', {
    folderToken,
    fileName,
    base64Content,
    size,
  });
  return resp.data;
}

export async function renameFile(
  fileToken: string,
  type: string,
  name: string,
): Promise<DriveCreatedItem> {
  const resp = await axiosForBackend.patch(
    `/api/drive/files/${fileToken}`,
    { name },
    { params: { type } },
  );
  return resp.data;
}

export async function deleteFile(
  fileToken: string,
  type: string,
): Promise<{ token: string; deleted: boolean }> {
  const resp = await axiosForBackend.delete(`/api/drive/files/${fileToken}`, {
    params: { type },
  });
  return resp.data;
}

export async function fetchWikiSpace(): Promise<{ spaceId: string }> {
  const resp = await axiosForBackend.get('/api/wiki/space');
  return resp.data;
}

export async function fetchWikiNodes(
  parentNodeToken?: string | null,
): Promise<WikiNodesResponse> {
  const resp = await axiosForBackend.get('/api/wiki/nodes', {
    params: parentNodeToken ? { parentNodeToken } : undefined,
  });
  return resp.data;
}

export async function syncToWiki(
  fileToken: string,
  fileType: string,
): Promise<{ taskId: string; wikiUrl: string | null }> {
  const resp = await axiosForBackend.post('/api/wiki/sync', {
    fileToken,
    fileType,
  });
  return resp.data;
}

import type { AxiosLikeError } from '@shared/api.interface';

export function toApiErrorMessage(error: unknown): string {
  const err = error as AxiosLikeError;
  return err?.response?.data?.error?.message ?? err?.message ?? '请求失败，请重试';
}

export function logFeishuError(action: string, error: unknown): void {
  logger.error(`飞书云空间操作失败: ${action}`, error);
}
