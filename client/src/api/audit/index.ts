import { axiosForBackend } from '@client/src/platform/request';
import type { AuditListParams, AuditLog } from '@shared/api.interface';

export async function listAuditLogs(params?: AuditListParams): Promise<AuditLog[]> {
  const resp = await axiosForBackend.get<AuditLog[]>('/api/audit/logs', { params });
  return resp.data;
}
