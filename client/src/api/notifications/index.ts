import { logger } from '@client/src/platform/logger';
import { axiosForBackend } from '@client/src/platform/request';
import type {
  ApprovalNotifyPayload,
  ListInboxMessagesResult,
  MarkInboxMessageReadResult,
} from '@shared/api.interface';

export async function sendApprovalNotification(
  payload: ApprovalNotifyPayload
): Promise<void> {
  try {
    const response = await axiosForBackend({
      url: '/api/notifications/approval',
      method: 'POST',
      data: payload,
    });
    if (response.status === 403) {
      logger.warn('无权限发送审批通知');
      return;
    }
  } catch (error) {
    logger.error('审批通知发送失败', error);
  }
}

/** B8：当前用户站内信 */
export async function listInbox(
  unreadOnly = false
): Promise<ListInboxMessagesResult> {
  const resp = await axiosForBackend.get<ListInboxMessagesResult>(
    '/api/notifications/inbox',
    { params: unreadOnly ? { unreadOnly: '1' } : undefined }
  );
  return resp.data;
}

export async function markInboxRead(
  id: string
): Promise<MarkInboxMessageReadResult> {
  const resp = await axiosForBackend.patch<MarkInboxMessageReadResult>(
    `/api/notifications/inbox/${id}/read`
  );
  return resp.data;
}
