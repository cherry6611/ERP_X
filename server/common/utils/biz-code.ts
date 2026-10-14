import { getTableName, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from '@server/platform';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { shanghaiYearMonth } from './biz-code-time';

/**
 * 业务编码生成（B-08 可配置化 + B-09 作废不重用）。
 *
 * 编码结构：`prefix + dateSegment + seq`，其中
 *   - prefix：来自 `sys_code_rule.prefix`（缺省用调用方传入的 fallback）；
 *   - dateSegment：按 `date_pattern` 取 YYYYMM / YYYY / 空；
 *   - seq：位数由 `seq_length` 决定，是否跨期重置由 `reset_policy` 决定
 *     （重置语义通过"分桶键"天然实现：bucketKey 变了就是新桶，从 1 开始）。
 *
 * 并发安全：
 *   ① 首选 `comp_biz_code_seq` 单语句原子递增（INSERT ... ON CONFLICT DO UPDATE RETURNING）；
 *   ② 序号表不存在时回退为 `pg_advisory_xact_lock` + **MAX(seq)+1**（B-09 要求：
 *      禁止用 count()+1，因为删除/作废记录后 count 会回退导致编号重复）。
 *
 * 作废不重用（B-09）：
 *   - 编号一律基于"历史最大流水号 + 1"，删除记录不会把编号回填给新单据；
 *   - 财务类单据（凭证/发票/收付款/工资单/应付/应收）由
 *     `SystemConfigService.NO_REUSE_BIZ_TYPES` 在配置层硬约束 `allow_reuse = 0`。
 */

export type DatePattern = 'YYYYMM' | 'YYYY' | 'NONE';
export type ResetPolicy = 'never' | 'yearly' | 'monthly';

export interface CodeRuleSpec {
  bizType: string;
  prefix: string;
  datePattern: DatePattern;
  seqLength: number;
  resetPolicy: ResetPolicy;
}

interface CachedRules {
  at: number;
  specs: Map<string, CodeRuleSpec>;
}

const RULE_CACHE_TTL_MS = 60_000;
let ruleCache: CachedRules | null = null;
let warnedMissingRuleTable = false;
let warnedMissingSeq = false;

/** 由 SystemConfigService 在编号规则被修改后调用，强制下次读取重载 */
export function invalidateCodeRuleCache(): void {
  ruleCache = null;
}

interface RawRuleRow {
  biz_type: string;
  prefix: string;
  date_pattern: string;
  seq_length: number;
  reset_policy: string;
}

function unwrap<T>(rows: unknown): T[] {
  if (Array.isArray(rows)) return rows as T[];
  const candidate = (rows as { rows?: unknown } | null)?.rows;
  return Array.isArray(candidate) ? (candidate as T[]) : [];
}

async function loadRules(
  db: PostgresJsDatabase
): Promise<Map<string, CodeRuleSpec>> {
  if (ruleCache && Date.now() - ruleCache.at < RULE_CACHE_TTL_MS) {
    return ruleCache.specs;
  }
  const specs = new Map<string, CodeRuleSpec>();
  try {
    const rows = await db.execute(sql`
      SELECT biz_type, prefix, date_pattern, seq_length, reset_policy
      FROM sys_code_rule
      WHERE enabled = 1
    `);
    for (const row of unwrap<RawRuleRow>(rows)) {
      specs.set(row.biz_type, {
        bizType: row.biz_type,
        prefix: row.prefix,
        datePattern: (row.date_pattern ?? 'YYYYMM') as DatePattern,
        seqLength: Number(row.seq_length ?? 4),
        resetPolicy: (row.reset_policy ?? 'monthly') as ResetPolicy,
      });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('sys_code_rule') || message.includes('42P01')) {
      if (!warnedMissingRuleTable) {
        warnedMissingRuleTable = true;
        console.warn(
          'sys_code_rule 不存在，编号规则回退为调用方传入的前缀。请执行迁移 2026-10-15-upgrade-batch1-system-config.sql'
        );
      }
    } else {
      throw error;
    }
  }
  ruleCache = { at: Date.now(), specs };
  return specs;
}

export interface GenerateBizCodeOptions {
  /** 业务类型，对应 sys_code_rule.biz_type；缺省则只用 prefix 与默认格式 */
  bizType?: string;
  /** 强制前缀（优先级高于规则表） */
  prefix?: string;
}

/**
 * @param db              数据库句柄
 * @param table           业务表（用于统计同前缀历史最大流水号）
 * @param codeColumn      编号列
 * @param fallbackPrefix  规则表缺失时的前缀（保持既有调用方零改动）
 * @param now             业务时间（默认当前时间，测试可注入）
 * @param options         B-08 扩展项：bizType / 强制 prefix
 */
export async function generateBizCode(
  db: PostgresJsDatabase,
  table: PgTable,
  codeColumn: PgColumn,
  fallbackPrefix: string,
  now: Date = new Date(),
  options: GenerateBizCodeOptions = {}
): Promise<string> {
  const specs = await loadRules(db);
  // 先按显式 bizType 找，再按 fallback 前缀反查规则表：
  // 反查让 30+ 处既有调用点无需改动即可获得"前缀/日期段/流水位数"的可配置能力（B-08）。
  const spec =
    (options.bizType ? specs.get(options.bizType) : undefined) ??
    (fallbackPrefix ? findByPrefix(specs, fallbackPrefix) : undefined);
  const prefix = options.prefix ?? spec?.prefix ?? fallbackPrefix;
  const datePattern: DatePattern = spec?.datePattern ?? 'YYYYMM';
  const seqLength = spec?.seqLength ?? 4;

  const bucketKey = `${prefix}${buildDateSegment(datePattern, now)}`;
  const seq: number | null = await allocateFromSeqTable(
    db,
    table,
    codeColumn,
    bucketKey
  );
  if (seq !== null) {
    return `${bucketKey}${String(seq).padStart(seqLength, '0')}`;
  }
  // B-09：回退路径用 advisory lock + MAX(seq)+1，禁止 count()+1
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${`bizcode:${bucketKey}`}))
    `);
    const next = await nextSeqFromMax(
      tx as unknown as PostgresJsDatabase,
      table,
      codeColumn,
      bucketKey
    );
    return `${bucketKey}${String(next).padStart(seqLength, '0')}`;
  });
}

/** 按前缀反查规则（同前缀多条时取字典序最小的 bizType，保证结果稳定） */
function findByPrefix(
  specs: Map<string, CodeRuleSpec>,
  prefix: string
): CodeRuleSpec | undefined {
  const matches = [...specs.values()]
    .filter((spec) => spec.prefix === prefix)
    .sort((a, b) => a.bizType.localeCompare(b.bizType));
  return matches[0];
}

/** 按规则生成日期段；导出供单测断言 */
export function buildDateSegment(pattern: DatePattern, now: Date): string {
  if (pattern === 'NONE') return '';
  const { year, month } = shanghaiYearMonth(now);
  if (pattern === 'YYYY') return String(year);
  return `${year}${month}`;
}

async function allocateFromSeqTable(
  db: PostgresJsDatabase,
  table: PgTable,
  codeColumn: PgColumn,
  bucketKey: string
): Promise<number | null> {
  const tableName: string = getTableName(table);
  const columnName: string = codeColumn.name;
  try {
    const rows: unknown = await db.execute(sql`
      WITH existing AS (
        SELECT coalesce(
                 max(substring(${sql.raw(`"${columnName}"`)} from ${`^${bucketKey}(\\d+)$`})::int),
                 0
               ) AS max_seq
        FROM ${sql.raw(`"${tableName}"`)}
        WHERE ${sql.raw(`"${columnName}"`)} LIKE ${`${bucketKey}%`}
      )
      INSERT INTO comp_biz_code_seq (month_key, last_seq)
      SELECT ${bucketKey}, greatest(existing.max_seq + 1, 1) FROM existing
      ON CONFLICT (month_key) DO UPDATE
      SET last_seq = comp_biz_code_seq.last_seq + 1
      RETURNING last_seq
    `);
    const list = unwrap<{ last_seq: number }>(rows);
    const seq = Number(list[0]?.last_seq ?? 0);
    return seq > 0 ? seq : null;
  } catch (error: unknown) {
    if (isMissingRelation(error)) {
      if (!warnedMissingSeq) {
        warnedMissingSeq = true;
        console.warn(
          'comp_biz_code_seq 不存在，编号回退为锁内 MAX(seq)+1。请执行 server/database/migrations/2026-10-13-security.sql'
        );
      }
      return null;
    }
    throw error;
  }
}

/**
 * B-09：以"已存在的最大流水号 + 1"为下一个编号，而不是 count()+1。
 * 这样删除/作废记录后不会把编号回填给新单据（审计红线）。
 */
async function nextSeqFromMax(
  db: PostgresJsDatabase,
  table: PgTable,
  codeColumn: PgColumn,
  bucketKey: string
): Promise<number> {
  const tableName: string = getTableName(table);
  const columnName: string = codeColumn.name;
  const result = await db.execute(sql`
    SELECT coalesce(
             max(substring(${sql.raw(`"${columnName}"`)} from ${`^${bucketKey}(\\d+)$`})::int),
             0
           ) AS max_seq
    FROM ${sql.raw(`"${tableName}"`)}
    WHERE ${sql.raw(`"${columnName}"`)} LIKE ${`${bucketKey}%`}
  `);
  const list = unwrap<{ max_seq: number | null }>(result);
  return Number(list[0]?.max_seq ?? 0) + 1;
}

function isMissingRelation(error: unknown): boolean {
  const message: string = error instanceof Error ? error.message : String(error);
  return message.includes('comp_biz_code_seq') || message.includes('42P01');
}
