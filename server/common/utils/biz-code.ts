import { getTableName, like, count, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from '@server/platform';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * 业务编码：前缀 + YYYYMM + 4 位流水。
 * 优先用 comp_biz_code_seq 单语句原子递增（需先执行迁移）。
 * 序号表不存在时回退为当月 count()+1，并打一次警告。
 */
let warnedMissingSeq = false;

export async function generateBizCode(
  db: PostgresJsDatabase,
  table: PgTable,
  codeColumn: PgColumn,
  prefix: string,
  now: Date = new Date()
): Promise<string> {
  const year: number = now.getFullYear();
  const month: string = String(now.getMonth() + 1).padStart(2, '0');
  const monthKey: string = `${prefix}${year}${month}`;
  const seq: number | null = await allocateFromSeqTable(
    db,
    table,
    codeColumn,
    monthKey
  );
  if (seq !== null) {
    return `${monthKey}${String(seq).padStart(4, '0')}`;
  }
  const total: number = await countMonth(db, table, codeColumn, monthKey);
  return `${monthKey}${String(total + 1).padStart(4, '0')}`;
}

async function allocateFromSeqTable(
  db: PostgresJsDatabase,
  table: PgTable,
  codeColumn: PgColumn,
  monthKey: string
): Promise<number | null> {
  const tableName: string = getTableName(table);
  const columnName: string = codeColumn.name;
  try {
    const rows: unknown = await db.execute(sql`
      WITH existing AS (
        SELECT count(*)::int AS total
        FROM ${sql.raw(`"${tableName}"`)}
        WHERE ${sql.raw(`"${columnName}"`)} LIKE ${`${monthKey}%`}
      )
      INSERT INTO comp_biz_code_seq (month_key, last_seq)
      SELECT ${monthKey}, existing.total + 1 FROM existing
      ON CONFLICT (month_key) DO UPDATE
      SET last_seq = comp_biz_code_seq.last_seq + 1
      RETURNING last_seq
    `);
    const list = Array.isArray(rows)
      ? (rows as { last_seq: number }[])
      : ((rows as { rows?: { last_seq: number }[] }).rows ?? []);
    const seq: number = Number(list[0]?.last_seq ?? 0);
    return seq > 0 ? seq : null;
  } catch (error: unknown) {
    if (isMissingRelation(error)) {
      if (!warnedMissingSeq) {
        warnedMissingSeq = true;
        console.warn(
          'comp_biz_code_seq 不存在，编号回退为 count()+1。请执行 server/database/migrations/2026-10-13-security.sql'
        );
      }
      return null;
    }
    throw error;
  }
}

async function countMonth(
  db: PostgresJsDatabase,
  table: PgTable,
  codeColumn: PgColumn,
  monthKey: string
): Promise<number> {
  const result: Array<{ total: number }> = await db
    .select({ total: count() })
    .from(table)
    .where(like(codeColumn, `${monthKey}%`));
  return Number(result[0]?.total ?? 0);
}

function isMissingRelation(error: unknown): boolean {
  const message: string = error instanceof Error ? error.message : String(error);
  return message.includes('comp_biz_code_seq') || message.includes('42P01');
}
