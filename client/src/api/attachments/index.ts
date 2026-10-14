import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  Attachment,
  CreateAttachmentDto,
  ParsedFeishuDocLink,
} from '@shared/api.interface';

export async function listAttachments(
  resourceType: string,
  resourceId: string,
): Promise<Attachment[]> {
  const resp = await axiosForBackend.get<Attachment[]>('/api/attachments', {
    params: { resourceType, resourceId },
  });
  return resp.data;
}

export async function createAttachment(
  dto: CreateAttachmentDto,
): Promise<Attachment> {
  const resp = await axiosForBackend.post<Attachment>(
    '/api/attachments',
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function parseFeishuDocUrl(
  url: string,
): Promise<ParsedFeishuDocLink> {
  const resp = await axiosForBackend.post<ParsedFeishuDocLink>(
    '/api/attachments/parse-feishu-url',
    { url },
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function deleteAttachment(id: string): Promise<void> {
  const resp = await axiosForBackend.delete<void>(`/api/attachments/${id}`);
  ensureNotForbidden(resp);
}
