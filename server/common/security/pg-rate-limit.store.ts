import type { Store, Options, ClientRateLimitInfo } from 'express-rate-limit';
import type { Sql } from 'postgres';

/**
 * L1：基于 PostgreSQL 的全局限速存储，多实例共享计数。
 * 表不存在时由 ensureTable 自动创建；失败则调用方应回退内存桶。
 */
export class PostgresRateLimitStore implements Store {
  prefix = 'erp_rl:';
  private windowMs = 60_000;
  private ready: Promise<void> | null = null;

  constructor(private readonly sql: Sql) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.ready = this.ensureTable();
  }

  private async ensureTable(): Promise<void> {
    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS comp_rate_limit (
        bucket_key text PRIMARY KEY,
        hits integer NOT NULL DEFAULT 0,
        reset_at timestamptz NOT NULL
      )
    `);
  }

  private async waitReady(): Promise<void> {
    if (!this.ready) this.ready = this.ensureTable();
    await this.ready;
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    await this.waitReady();
    const full = `${this.prefix}${key}`;
    const rows = await this.sql<{ hits: number; reset_at: Date }[]>`
      SELECT hits, reset_at FROM comp_rate_limit WHERE bucket_key = ${full}
    `;
    const row = rows[0];
    if (!row) return undefined;
    if (row.reset_at.getTime() <= Date.now()) return undefined;
    return {
      totalHits: row.hits,
      resetTime: row.reset_at,
    };
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    await this.waitReady();
    const full = `${this.prefix}${key}`;
    // postgres.js 绑定参数需为 string/Buffer；Date 会触发 ERR_INVALID_ARG_TYPE
    const resetAtIso = new Date(Date.now() + this.windowMs).toISOString();
    const rows = await this.sql<{ hits: number; reset_at: Date }[]>`
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
      RETURNING hits, reset_at
    `;
    const row = rows[0];
    return {
      totalHits: row.hits,
      resetTime: row.reset_at instanceof Date ? row.reset_at : new Date(row.reset_at),
    };
  }

  async decrement(key: string): Promise<void> {
    await this.waitReady();
    const full = `${this.prefix}${key}`;
    await this.sql`
      UPDATE comp_rate_limit
      SET hits = GREATEST(hits - 1, 0)
      WHERE bucket_key = ${full}
        AND reset_at > CURRENT_TIMESTAMP
    `;
  }

  async resetKey(key: string): Promise<void> {
    await this.waitReady();
    const full = `${this.prefix}${key}`;
    await this.sql`DELETE FROM comp_rate_limit WHERE bucket_key = ${full}`;
  }
}
