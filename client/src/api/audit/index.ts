import { axiosForBackend } from '@client/src/platform/request';
import type {
  AuditChainAnchor,
  AuditChainVerification,
  AuditImmutabilityProbe,
  AuditListParams,
  AuditLog,
} from '@shared/api.interface';

export async function listAuditLogs(params?: AuditListParams): Promise<AuditLog[]> {
  const resp = await axiosForBackend.get<AuditLog[]>('/api/audit/logs', { params });
  return resp.data;
}

/* ========== D-09 / NFR-S8：防篡改校验 ========== */

/** 在线校验审计链：回答"日志有没有被改过" */
export async function verifyAuditChain(
  limit?: number,
): Promise<AuditChainVerification> {
  const resp = await axiosForBackend.get<AuditChainVerification>(
    '/api/audit/chain-verification',
    { params: limit ? { limit } : undefined },
  );
  return resp.data;
}

/** 导出链锚点：应定期外发到独立系统，用于证明"日志未被整体重写" */
export async function getAuditChainAnchor(): Promise<AuditChainAnchor> {
  const resp = await axiosForBackend.get<AuditChainAnchor>(
    '/api/audit/chain-anchor',
  );
  return resp.data;
}

/** 只追加约束自检：UPDATE 与 DELETE 都必须被数据库拒绝 */
export async function probeAuditImmutability(): Promise<AuditImmutabilityProbe> {
  const resp = await axiosForBackend.get<AuditImmutabilityProbe>(
    '/api/audit/immutability-probe',
  );
  return resp.data;
}
