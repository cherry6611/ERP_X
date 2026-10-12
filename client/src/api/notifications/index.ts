import { logger } from '@client/src/platform/logger';
import { axiosForBackend } from '@client/src/platform/request';
import type { ApprovalNotifyPayload } from '@shared/api.interface';

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
