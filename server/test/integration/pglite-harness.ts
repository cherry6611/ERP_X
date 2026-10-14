/**
 * pglite 集成测试 harness（需求书 B-10）
 *
 * 为什么用 pglite：CI 环境没有真实 PostgreSQL。@electric-sql/pglite 是编译为 WASM 的
 * 完整 PostgreSQL（本项目锁定 0.3.16），在内存里跑，语义与真实库一致，因此可以用它
 * 验证「迁移链能否在全新库上跑通」与「核心账务链路的 SQL 恒等式」。
 *
 * 本文件提供三件事：
 *   ① 迁移链加载：按文件名排序读取 server/database/migrations/*.sql（与
 *      scripts/db-migrate.mjs、scripts/migrate-dryrun.mjs 同一套过滤与排序规则）；
 *   ② 迁移链执行：单条迁移事务化执行，失败抛 MigrationChainError 且**错误信息带文件名**；
 *   ③ 账务查询/断言辅助：科目余额、试算平衡、恒等式断言。
 *
 * 与真实库的边界（诚实声明）：
 *   - pglite 未内置 pgcrypto / uuid-ossp 等扩展。本仓迁移实测不依赖任何扩展
 *     （gen_random_uuid() 自 PostgreSQL 13 起为内置函数），故无需兼容白名单；
 *     若将来某条迁移依赖扩展，请在 PGLITE_SKIP_WHITELIST 显式登记并写明理由，
 *     本 harness 会对未登记白名单的跳过项直接判失败（不静默忽略）。
 *   - pglite 无 RLS 会话变量上下文（app.user_id 为空），`_created_by` 等系统字段默认值为 NULL，
 *     与真实库「以某个用户身份写入」的差异仅影响审计列，不影响账务数值。
 *
 * 与 jest 运行环境的适配：pglite 打包产物在 Node 分支使用真实动态 import，
 * 而 jest 的 CJS VM 不允许（详见 scripts/jest-pglite-transform.cjs 与 jest.config.cjs 的
 * transform 配置），因此 jest.config.cjs 对 pglite 产物挂了专用 transform；
 * plain node（scripts/migrate-dryrun.mjs）无需该处理。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@server/database/schema';

/** 迁移目录：server/test/integration → server/database/migrations */
export const MIGRATIONS_DIR = resolve(
  __dirname,
  '..',
  '..',
  'database',
  'migrations'
);

/**
 * pglite 兼容白名单：文件名 → 跳过理由。当前为空（实测全部迁移均可执行）。
 * 只有确实无法在 pglite 中执行的迁移才允许登记，并必须同时说明真实库执行方式。
 */
export const PGLITE_SKIP_WHITELIST: Readonly<Record<string, string>> =
  Object.freeze({});

export interface MigrationFile {
  name: string;
  sql: string;
}

export interface MigrationResult {
  name: string;
  status: 'applied' | 'skipped' | 'failed';
  ms: number;
  error?: string;
}

/** 迁移执行失败：错误信息必须带文件名，便于定位坏迁移 */
export class MigrationChainError extends Error {
  constructor(
    readonly fileName: string,
    readonly index: number,
    readonly total: number,
    readonly results: MigrationResult[],
    cause: unknown
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`迁移 ${fileName}（第 ${index + 1}/${total} 条）执行失败：${detail}`);
    this.name = 'MigrationChainError';
  }
}

/** 与 db-migrate.mjs 一致：忽略含 SKIP / .disabled 的半成品迁移，按文件名升序 */
export function listMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter(
      (name) =>
        name.endsWith('.sql') &&
        !name.includes('SKIP') &&
        !name.includes('.disabled') &&
        !name.endsWith('.sql.disabled')
    )
    .sort();
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return listMigrationFiles(dir).map((name) => ({
    name,
    sql: readFileSync(join(dir, name), 'utf8'),
  }));
}

/** 创建全新的内存 pglite 实例（每次调用都是一个空库） */
export async function createPglite(): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  return db;
}

/** 探测 pglite 对迁移链实际用到的 PostgreSQL 特性的支持情况（供测试断言） */
export async function probeCapabilities(
  db: PGlite
): Promise<Record<string, boolean>> {
  const capabilities: Record<string, boolean> = {};

  try {
    await db.query('SELECT gen_random_uuid()::text AS id');
    capabilities.genRandomUuid = true;
  } catch {
    capabilities.genRandomUuid = false;
  }

  try {
    await db.exec(`
      DO $$
      BEGIN
        CREATE TYPE _harness_probe_type AS (a int);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
      DROP TYPE IF EXISTS _harness_probe_type;
    `);
    capabilities.doBlockDuplicateObject = true;
  } catch {
    capabilities.doBlockDuplicateObject = false;
  }

  try {
    await db.exec(`
      CREATE TEMP TABLE _harness_probe_nnd (a varchar, b uuid);
      CREATE UNIQUE INDEX _harness_probe_nnd_uq
        ON _harness_probe_nnd (a, b) NULLS NOT DISTINCT;
      DROP TABLE _harness_probe_nnd;
    `);
    capabilities.nullsNotDistinct = true;
  } catch {
    capabilities.nullsNotDistinct = false;
  }

  try {
    await db.exec(`
      CREATE TEMP TABLE _harness_probe_trg (a int);
      CREATE OR REPLACE FUNCTION pg_temp._harness_probe_fn() RETURNS trigger AS $fn$
      BEGIN
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER _harness_probe_trg_bi BEFORE INSERT ON _harness_probe_trg
        FOR EACH ROW EXECUTE FUNCTION pg_temp._harness_probe_fn();
    `);
    capabilities.plpgsqlTrigger = true;
  } catch {
    capabilities.plpgsqlTrigger = false;
  }

  return capabilities;
}

/** 建 schema_migrations 登记表（与 db-migrate.mjs 行为对齐） */
export async function createMigrationRegistry(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * 依次执行迁移链；任何一条失败即抛 MigrationChainError（信息含文件名）。
 * 单条迁移事务化：失败不留半应用 schema，与真实库执行器一致。
 */
export async function applyMigrationChain(
  db: PGlite,
  migrations: MigrationFile[],
  options: {
    whitelist?: Readonly<Record<string, string>>;
    createRegistry?: boolean;
  } = {}
): Promise<MigrationResult[]> {
  const whitelist = options.whitelist ?? PGLITE_SKIP_WHITELIST;
  if (options.createRegistry !== false) {
    await createMigrationRegistry(db);
  }

  const results: MigrationResult[] = [];
  for (const [index, migration] of migrations.entries()) {
    if (Object.prototype.hasOwnProperty.call(whitelist, migration.name)) {
      results.push({ name: migration.name, status: 'skipped', ms: 0 });
      continue;
    }
    const startedAt = Date.now();
    try {
      await db.transaction(async (tx) => {
        await tx.exec(migration.sql);
        await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [
          migration.name,
        ]);
      });
    } catch (error) {
      const ms = Date.now() - startedAt;
      results.push({
        name: migration.name,
        status: 'failed',
        ms,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new MigrationChainError(
        migration.name,
        index,
        migrations.length,
        results,
        error
      );
    }
    results.push({ name: migration.name, status: 'applied', ms: Date.now() - startedAt });
  }
  return results;
}

/** 已登记的迁移 id（升序） */
export async function listAppliedMigrations(db: PGlite): Promise<string[]> {
  const rows = await queryRows<{ id: string }>(
    db,
    'SELECT id FROM schema_migrations ORDER BY id'
  );
  return rows.map((row) => row.id);
}

/** drizzle 实例（构造真实 service 时用，如 VoucherService） */
export function createDrizzle(db: PGlite) {
  return drizzle(db, { schema });
}

export interface Harness {
  db: PGlite;
  orm: ReturnType<typeof createDrizzle>;
  migrations: MigrationFile[];
  results: MigrationResult[];
  close(): Promise<void>;
}

/** 一步到位：全新 pglite + 全量迁移链 + drizzle 实例 */
export async function createHarness(): Promise<Harness> {
  const db = await createPglite();
  const migrations = loadMigrations();
  try {
    const results = await applyMigrationChain(db, migrations);
    return {
      db,
      orm: createDrizzle(db),
      migrations,
      results,
      close: () => db.close(),
    };
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
}

/* ========================== 查询与断言辅助 ========================== */

/** numeric / int8 在 pglite 里可能是 string，统一转 number */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function queryRows<T>(
  db: PGlite,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await db.query<T>(sql, params);
  return result.rows;
}

export async function scalar<T>(
  db: PGlite,
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await queryRows<Record<string, T>>(db, sql, params);
  const first = rows[0];
  if (!first) return null;
  const values = Object.values(first);
  return (values[0] ?? null) as T | null;
}

/** 表/视图是否存在（to_regclass） */
export async function tableExists(db: PGlite, name: string): Promise<boolean> {
  const found = await scalar<string>(db, 'SELECT to_regclass($1)::text', [name]);
  return found !== null && found !== undefined;
}

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string | null;
  debit: number;
  credit: number;
  /** 借 − 贷 */
  netDebit: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  /** 借贷合计是否相等（试算平衡第一恒等式） */
  balanced: boolean;
}

/**
 * 科目余额表（试算平衡表）：按已过账/草稿凭证（排除作废）汇总各科目借贷发生额。
 * 可选 period 限定期间。
 */
export async function trialBalance(
  db: PGlite,
  period?: string
): Promise<TrialBalance> {
  const params: unknown[] = [];
  const periodFilter = period ? 'AND v.period = $1' : '';
  if (period) params.push(period);
  const rows = await queryRows<{
    account_code: string | null;
    account_name: string | null;
    debit: string | null;
    credit: string | null;
  }>(
    db,
    `SELECT l.account_code,
            a.name AS account_name,
            COALESCE(SUM(l.debit), 0) AS debit,
            COALESCE(SUM(l.credit), 0) AS credit
       FROM fin_voucher_line l
       JOIN fin_voucher v ON v.id = l.voucher_id
       LEFT JOIN fin_account a ON a.code = l.account_code
      WHERE v.status <> 'voided' ${periodFilter}
      GROUP BY l.account_code, a.name
      ORDER BY l.account_code`,
    params
  );
  const items: TrialBalanceRow[] = rows.map((row) => {
    const debit = toNumber(row.debit);
    const credit = toNumber(row.credit);
    return {
      accountCode: row.account_code ?? '',
      accountName: row.account_name,
      debit,
      credit,
      netDebit: Math.round((debit - credit) * 100) / 100,
    };
  });
  const totalDebit = round2(items.reduce((sum, row) => sum + row.debit, 0));
  const totalCredit = round2(items.reduce((sum, row) => sum + row.credit, 0));
  return {
    rows: items,
    totalDebit,
    totalCredit,
    balanced: totalDebit === totalCredit,
  };
}

/** 单科目发生额（排除作废凭证） */
export async function accountMovement(
  db: PGlite,
  accountCode: string,
  period?: string
): Promise<{ debit: number; credit: number; netDebit: number }> {
  const params: unknown[] = [accountCode];
  const periodFilter = period ? 'AND v.period = $2' : '';
  if (period) params.push(period);
  const rows = await queryRows<{ debit: string | null; credit: string | null }>(
    db,
    `SELECT COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
       FROM fin_voucher_line l
       JOIN fin_voucher v ON v.id = l.voucher_id
      WHERE v.status <> 'voided' AND l.account_code = $1 ${periodFilter}`,
    params
  );
  const debit = toNumber(rows[0]?.debit);
  const credit = toNumber(rows[0]?.credit);
  return { debit, credit, netDebit: round2(debit - credit) };
}

/** 全库借贷恒等式：所有非作废凭证行借方合计 = 贷方合计 */
export async function ledgerIdentity(db: PGlite): Promise<{
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
  lineCount: number;
}> {
  const rows = await queryRows<{
    total_debit: string | null;
    total_credit: string | null;
    line_count: string | null;
  }>(
    db,
    `SELECT COALESCE(SUM(l.debit), 0) AS total_debit,
            COALESCE(SUM(l.credit), 0) AS total_credit,
            COUNT(*) AS line_count
       FROM fin_voucher_line l
       JOIN fin_voucher v ON v.id = l.voucher_id
      WHERE v.status <> 'voided'`
  );
  const totalDebit = round2(toNumber(rows[0]?.total_debit));
  const totalCredit = round2(toNumber(rows[0]?.total_credit));
  return {
    totalDebit,
    totalCredit,
    balanced: totalDebit === totalCredit,
    lineCount: toNumber(rows[0]?.line_count),
  };
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
