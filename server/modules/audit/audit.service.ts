import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { compAuditLog } from '@server/database/schema';
import type {
  AuditActorOption,
  AuditListParams,
  AuditLog,
  AuditLogExportResult,
  AuditLogListResult,
} from '@shared/api.interface';
import { toAuditCsv } from './audit-csv';

/** 单页最多取多少行（防止一次拉爆浏览器） */
const MAX_LIMIT = 200;
/** 导出最多包含多少行（超出只导出最新的一段，并在响应里标 truncated） */
export const MAX_EXPORT_ROWS = 5000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

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

  /**
   * 把筛选条件编译成 SQL `where`。
   *
   * ⚠️ **全部条件都必须在 SQL 里**。原实现把 `action` 写成
   * `rows.filter(...)`（在 `.limit()` **之后**），于是：
   *   · `action=update&limit=100` 只回 2 行，`limit=200` 回 12 行，
   *     而库里实际有 93 条 —— 同一个问题换个分页大小就换个答案；
   *   · 「共 N 条」显示的是"最新 N 行里恰好命中的条数"，不是真实条数。
   * 审计查询给出不确定的数字，比慢或报错都危险（会让人得出"没有异常操作"）。
   */
  private buildWhere(params: AuditListParams) {
    const conditions = [];
    if (params.objectType) {
      conditions.push(eq(compAuditLog.objectType, params.objectType));
    }
    if (params.action) {
      conditions.push(eq(compAuditLog.action, params.action));
    }
    if (params.actor) {
      conditions.push(eq(compAuditLog.actor, params.actor));
    }
    /*
     * 日期按**业务时区**比较：`created_at` 是 timestamptz，
     * 直接 `created_at::date = '2026-10-17'` 会按服务器时区截断，
     * 在 UTC 容器里会把当天 00:00–08:00 的记录算到前一天。
     * 统一 `AT TIME ZONE 'Asia/Shanghai'` 再截日期，与界面显示口径一致。
     */
    if (params.dateFrom && DATE_ONLY.test(params.dateFrom)) {
      conditions.push(
        sql`(${compAuditLog.createdAt} AT TIME ZONE 'Asia/Shanghai')::date >= ${params.dateFrom}::date`
      );
    }
    if (params.dateTo && DATE_ONLY.test(params.dateTo)) {
      conditions.push(
        sql`(${compAuditLog.createdAt} AT TIME ZONE 'Asia/Shanghai')::date <= ${params.dateTo}::date`
      );
    }
    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  private clampLimit(limit?: number): number {
    return Math.min(Math.max(limit ?? 50, 1), MAX_LIMIT);
  }

  async listLogs(params: AuditListParams = {}): Promise<AuditLogListResult> {
    const safeLimit = this.clampLimit(params.limit);
    const where = this.buildWhere(params);
    const rows = await this.db
      .select()
      .from(compAuditLog)
      .where(where)
      .orderBy(desc(compAuditLog.createdAt))
      .limit(safeLimit);
    const totalRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(compAuditLog)
      .where(where);
    const items = rows.map((row) => this.toAuditLog(row));
    return {
      items,
      total: Number(totalRows[0]?.total ?? 0),
      returned: items.length,
    };
  }

  /**
   * 导出筛选结果（CSV）。
   *
   * 导出的是**筛选后的全集**（上限 `MAX_EXPORT_ROWS`），不是当前页 ——
   * 否则"导出"与"截图"没有区别，审计人员拿到的永远是残缺的一份。
   */
  async exportCsv(params: AuditListParams = {}): Promise<AuditLogExportResult> {
    const where = this.buildWhere(params);
    const totalRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(compAuditLog)
      .where(where);
    const total = Number(totalRows[0]?.total ?? 0);
    const rows = await this.db
      .select()
      .from(compAuditLog)
      .where(where)
      .orderBy(desc(compAuditLog.createdAt))
      .limit(MAX_EXPORT_ROWS);
    const csv = toAuditCsv(rows.map((row) => this.toAuditLog(row)));
    return {
      csv,
      rowCount: rows.length,
      truncated: total > rows.length,
      total,
    };
  }

  /** 筛选下拉用的操作人清单（按出现次数倒序） */
  async listActors(): Promise<AuditActorOption[]> {
    const rows = await this.db
      .select({
        actor: compAuditLog.actor,
        count: sql<number>`count(*)::int`,
      })
      .from(compAuditLog)
      .groupBy(compAuditLog.actor)
      .orderBy(desc(sql`count(*)`))
      .limit(200);
    return rows.map((row) => ({
      actor: row.actor ?? 'anonymous',
      count: Number(row.count ?? 0),
    }));
  }

  private toAuditLog(row: typeof compAuditLog.$inferSelect): AuditLog {
    return {
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
    };
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
