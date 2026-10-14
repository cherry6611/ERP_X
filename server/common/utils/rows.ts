/**
 * drizzle `db.execute(sql...)` 的返回类型在 postgres-js 驱动下既可能是数组，
 * 也可能是 `{ rows }` 包装对象。统一在这里收敛，避免各服务重复强转。
 */
export function unwrapRows<T>(rows: unknown): T[] {
  if (Array.isArray(rows)) return rows as T[];
  const candidate = (rows as { rows?: unknown } | null)?.rows;
  return Array.isArray(candidate) ? (candidate as T[]) : [];
}
