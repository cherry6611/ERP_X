import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { desc, eq, sql } from 'drizzle-orm';
import { compAuditLog } from '@server/database/schema';
import type { AuditLog } from '@shared/api.interface';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  async record(entry: {
    actor: string;
    action: string;
    objectType: string;
    objectId?: string | null;
    objectCode?: string | null;
    detail?: string | null;
  }): Promise<void> {
    try {
      await this.db.insert(compAuditLog).values({
        actor: entry.actor,
        action: entry.action,
        objectType: entry.objectType,
        objectId: entry.objectId ?? null,
        objectCode: entry.objectCode ?? null,
        detail: entry.detail ?? null,
      });
    } catch (error: unknown) {
      const message: string =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`审计写入失败 action=${entry.action} ${message}`);
    }
  }

  async countDemoResidue(): Promise<{ projects: number; contracts: number }> {
    const projects = await this.countLike('erp_project');
    const contracts = await this.countLike('erp_contract');
    return { projects, contracts };
  }

  async listLogs(
    objectType?: string,
    action?: string,
    limit?: number
  ): Promise<AuditLog[]> {
    const safeLimit = Math.min(Math.max(limit ?? 50, 1), 200);
    const rows = await this.db
      .select()
      .from(compAuditLog)
      .where(objectType ? eq(compAuditLog.objectType, objectType) : undefined)
      .orderBy(desc(compAuditLog.createdAt))
      .limit(safeLimit);
    const filtered = action
      ? rows.filter((row) => (row.action ?? '') === action)
      : rows;
    return filtered.map((row) => ({
      id: row.id,
      actor: row.actor ?? 'anonymous',
      action: row.action ?? '',
      objectType: row.objectType ?? '',
      objectId: row.objectId,
      objectCode: row.objectCode,
      statusBefore: row.statusBefore,
      statusAfter: row.statusAfter,
      detail: row.detail,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async countLike(tableName: 'erp_project' | 'erp_contract'): Promise<number> {
    const rows: unknown = await this.db.execute(
      sql`SELECT count(*)::int AS total FROM ${sql.raw(`"${tableName}"`)} WHERE name LIKE '[API_TEST]%'`
    );
    const list = Array.isArray(rows)
      ? (rows as { total: number }[])
      : ((rows as { rows?: { total: number }[] }).rows ?? []);
    return Number(list[0]?.total ?? 0);
  }
}
