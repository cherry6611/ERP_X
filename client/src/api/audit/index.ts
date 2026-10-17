import { axiosForBackend } from '@client/src/platform/request';
import type {
  AuditActorOption,
  AuditChainAnchor,
  AuditChainVerification,
  AuditImmutabilityProbe,
  AuditListParams,
  AuditLog,
  AuditLogExportResult,
  AuditLogListResult,
} from '@shared/api.interface';

export async function listAuditLogs(
  params?: AuditListParams,
): Promise<AuditLogListResult> {
  const resp = await axiosForBackend.get<AuditLogListResult | AuditLog[]>(
    '/api/audit/logs',
    { params },
  );
  /*
   * 过渡兼容：`GET /api/audit/logs` 原先返回裸数组，本轮改为
   * `{ items, total, returned }`（`total` 让「共 N 条」是筛选后的真实条数）。
   * 本机 3100 进程仍加载着**改前**的构建（本轮约定不重启它），
   * 若不做这一步归一化，审计页在旧后端上会显示成"暂无审计日志"——
   * 一个看起来像产品缺陷、实际只是版本错配的假象。
   * 服务端重启后这段分支自然不再命中，届时可删。
   */
  const data = resp.data;
  if (Array.isArray(data)) {
    return { items: data, total: data.length, returned: data.length };
  }
  return data;
}

/**
 * 导出筛选后的**全集**为 CSV（服务端生成，上限见 MAX_EXPORT_ROWS）。
 *
 * 不复用列表接口：列表一次最多 200 行，用它拼导出等于只导出当前几页。
 */
export async function exportAuditLogs(
  params?: AuditListParams,
): Promise<AuditLogExportResult> {
  const resp = await axiosForBackend.get<AuditLogExportResult>(
    '/api/audit/logs/export',
    { params },
  );
  return resp.data;
}

/** 操作人筛选下拉的数据源 */
export async function listAuditActors(): Promise<AuditActorOption[]> {
  const resp = await axiosForBackend.get<AuditActorOption[]>('/api/audit/actors');
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
