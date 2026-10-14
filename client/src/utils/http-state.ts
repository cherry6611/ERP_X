/**
 * HTTP 层面的状态判定：页面需要用 403 区分「无权限」与「暂无数据」，
 * 避免把接口鉴权失败渲染成空态（需求书 B-14 / AGENTS.md 错误处理约定）。
 */

/** 页面级 403 提示文案，与 utils/api-error.ts 的写接口提示保持一致口径 */
export const REQUEST_FORBIDDEN_MESSAGE = '无访问权限，请联系管理员分配角色';

export function isForbiddenError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { response?: { status?: number } }).response?.status;
  return status === 403;
}
