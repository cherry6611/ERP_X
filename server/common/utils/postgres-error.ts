/**
 * 从嵌套的 unknown error 中提取 PostgreSQL 错误码（如 `'23505'` 唯一约束冲突）。
 *
 * 兼容 drizzle / postgres.js / 原生 Error 等多种形态：
 * - postgres.js 把 `code` 放在错误对象上；
 * - drizzle 把底层驱动错误包在 `cause` 上，需逐层下钻。
 *
 * 原先在 costs / feishu-sync / hr-core / hr-self-service / voucher 五处各复制一份
 * （见代码检查报告 L2），现统一收敛到此，避免口径漂移。
 */
export function extractPostgresErrorCode(
  error: unknown,
): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current !== 'object') break;
    const { code, cause } = current as {
      code?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}
