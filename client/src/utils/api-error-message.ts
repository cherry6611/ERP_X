/**
 * 从 axios 错误中提取后端真实错误信息。
 * 后端全局异常过滤器返回 { error: { code, message } }，优先取该 message；
 * 兜底用 Error.message，最后用 fallback。
 */
export function getApiErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null) {
    const resp = (err as {
      response?: { data?: { error?: { message?: unknown } } };
    }).response;
    const msg = resp?.data?.error?.message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
