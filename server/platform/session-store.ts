import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { sysLoginSession } from '@server/database/schema';
import { RAW_DATABASE } from './tokens';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const node = current as { code?: unknown; cause?: unknown };
    if (typeof node.code === 'string') return node.code;
    current = node.cause;
  }
  return undefined;
}

@Injectable()
export class SessionStore {
  private readonly logger = new Logger(SessionStore.name);

  constructor(@Inject(RAW_DATABASE) private readonly raw: PostgresJsDatabase) {}

  async record(userId: string, jti: string, expiresAt: Date, refreshTokenEnc?: string): Promise<void> {
    try {
      await this.raw.insert(sysLoginSession).values({
        userId,
        jti,
        expiresAt,
        refreshTokenEnc: refreshTokenEnc ?? null,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`登录会话未写入 jti=${jti} ${message}`);
    }
  }

  async isRevoked(jti: string): Promise<boolean> {
    try {
      const rows = await this.raw
        .select({ revokedAt: sysLoginSession.revokedAt })
        .from(sysLoginSession)
        .where(eq(sysLoginSession.jti, jti))
        .limit(1);
      if (rows.length === 0) return false;
      return rows[0].revokedAt !== null;
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code === '42P01') return false;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`会话吊销状态读取失败，拒绝本次登录态 jti=${jti} ${message}`);
      return true;
    }
  }

  async revoke(jti: string): Promise<void> {
    await this.raw
      .update(sysLoginSession)
      .set({ revokedAt: new Date() })
      .where(and(eq(sysLoginSession.jti, jti), isNull(sysLoginSession.revokedAt)));
  }

  async revokeUser(userId: string): Promise<void> {
    await this.raw
      .update(sysLoginSession)
      .set({ revokedAt: new Date() })
      .where(and(eq(sysLoginSession.userId, userId), isNull(sysLoginSession.revokedAt)));
  }

  async storeRefreshToken(jti: string, refreshTokenEnc: string): Promise<void> {
    await this.raw.execute(sql`
      update sys_login_session
      set refresh_token_enc = ${refreshTokenEnc}
      where jti = ${jti}
    `);
  }

  /** U-06：删除 30 天前已过期或已吊销的会话行 */
  async purgeExpired(olderThanDays = 30): Promise<number> {
    const result = await this.raw.execute(sql`
      DELETE FROM sys_login_session
      WHERE expires_at < CURRENT_TIMESTAMP - (${olderThanDays} * interval '1 day')
         OR (
           revoked_at IS NOT NULL
           AND revoked_at < CURRENT_TIMESTAMP - (${olderThanDays} * interval '1 day')
         )
    `);
    const count =
      typeof (result as { count?: number }).count === 'number'
        ? (result as { count: number }).count
        : Array.isArray(result)
          ? result.length
          : 0;
    this.logger.log(`会话清理完成 purged≈${count} days=${olderThanDays}`);
    return count;
  }
}
