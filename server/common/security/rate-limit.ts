import { HttpException, HttpStatus } from '@nestjs/common';
import type { Sql } from 'postgres';

const buckets = new Map<string, number[]>();
const MAX_BUCKETS = 10_000;

/** 多实例共享时由 bootstrap 注入 postgres 客户端 */
let sharedSql: Sql | null = null;

export function bindRateLimitSql(sql: Sql | null): void {
  sharedSql = sql;
}

function pruneExpired(now: number, windowMs: number): void {
  for (const [key, stamps] of buckets) {
    const recent = stamps.filter((ts) => now - ts < windowMs);
    if (recent.length === 0) buckets.delete(key);
    else if (recent.length !== stamps.length) buckets.set(key, recent);
  }
}

async function consumeRatePg(
  key: string,
  limit: number,
  windowMs: number
): Promise<void> {
  const sql = sharedSql;
  if (!sql) return consumeRateMemory(key, limit, windowMs);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS comp_rate_limit (
      bucket_key text PRIMARY KEY,
      hits integer NOT NULL DEFAULT 0,
      reset_at timestamptz NOT NULL
    )
  `);
  const full = `login:${key}`;
  // postgres.js 绑定参数需为 string/Buffer；Date 会触发 ERR_INVALID_ARG_TYPE
  const resetAtIso = new Date(Date.now() + windowMs).toISOString();
  const rows = await sql<{ hits: number }[]>`
    INSERT INTO comp_rate_limit (bucket_key, hits, reset_at)
    VALUES (${full}, 1, ${resetAtIso}::timestamptz)
    ON CONFLICT (bucket_key) DO UPDATE
    SET
      hits = CASE
        WHEN comp_rate_limit.reset_at <= CURRENT_TIMESTAMP THEN 1
        ELSE comp_rate_limit.hits + 1
      END,
      reset_at = CASE
        WHEN comp_rate_limit.reset_at <= CURRENT_TIMESTAMP THEN ${resetAtIso}::timestamptz
        ELSE comp_rate_limit.reset_at
      END
    RETURNING hits
  `;
  const hits = Number(rows[0]?.hits ?? 0);
  if (hits > limit) {
    throw new HttpException(
      '操作过于频繁，请稍后再试',
      HttpStatus.TOO_MANY_REQUESTS
    );
  }
}

function consumeRateMemory(
  key: string,
  limit: number,
  windowMs: number
): void {
  const now: number = Date.now();
  const recent: number[] = (buckets.get(key) ?? []).filter(
    (ts: number) => now - ts < windowMs
  );
  if (recent.length === 0) buckets.delete(key);
  if (recent.length >= limit) {
    if (recent.length > 0) buckets.set(key, recent);
    else buckets.delete(key);
    throw new HttpException(
      '操作过于频繁，请稍后再试',
      HttpStatus.TOO_MANY_REQUESTS
    );
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > MAX_BUCKETS) pruneExpired(now, windowMs);
}

/** 进程内滑动窗口限速；已绑定 PG 时跨实例共享。 */
export async function consumeRate(
  key: string,
  limit: number,
  windowMs: number
): Promise<void> {
  if (sharedSql) {
    await consumeRatePg(key, limit, windowMs);
    return;
  }
  consumeRateMemory(key, limit, windowMs);
}

export function resetRateLimitBuckets(): void {
  buckets.clear();
}
