#!/usr/bin/env node
/**
 * 迁移链 dryrun（需求书 B-10 / B-11）
 *
 * 目的：在没有真实 PostgreSQL 的 CI 环境里，把 `server/database/migrations/*.sql`
 * 按文件名排序依次执行到一个**全新的 pglite 实例**（@electric-sql/pglite，纯 WASM
 * 内嵌 PostgreSQL），任何一条迁移失败即整体失败（退出码 1）。真实库迁移仍由
 * `scripts/db-migrate.mjs` 负责（不要在 CI 里跑它，它会写开发库）。
 *
 * 用法：
 *   node ./scripts/migrate-dryrun.mjs          # 全量执行迁移链，退出码 0/1
 *   node ./scripts/migrate-dryrun.mjs --list   # 只打印排序后的迁移清单（不启动 pglite）
 *   node ./scripts/migrate-dryrun.mjs --quiet  # 只打印失败与汇总
 *
 * 输出契约（jest 集成测试解析这两行，改动请同步 server/test/integration/）：
 *   [dryrun] OK <file> <ms>ms
 *   [dryrun] SUMMARY total=<n> applied=<n> skipped=<n> failed=<n> ms=<n> result=<PASS|FAIL>
 *
 * ---------------------------------------------------------------------------
 * pglite 兼容白名单
 * ---------------------------------------------------------------------------
 * 白名单用于登记"在 pglite 里确实无法执行、但在真实 PostgreSQL 上必须执行"的迁移。
 * 规则（不得静默忽略失败）：
 *   1) 白名单为空时应输出 `skipped=0`；一旦出现跳过，跳过项必须能在白名单里找到，
 *      否则直接判 FAIL —— 不存在"悄悄跳过让测试变绿"的路径。
 *   2) 每个白名单条目都必须写明理由与真实库执行方式，并同时打印 WARNING。
 *   3) 之所以默认留空：本仓迁移（当前 24 条，随业务批次增长）实测只用到了 CREATE TYPE /
 *      plpgsql 触发器 / gen_random_uuid() / NULLS NOT DISTINCT / DO $$ 幂等块，pglite 0.3.x
 *      全部支持（见下方 capability 探测输出），且没有任何迁移依赖 CREATE EXTENSION
 *      （pgcrypto / uuid-ossp 全仓 0 引用，gen_random_uuid() 自 PostgreSQL 13 起为内置函数）。
 *   4) 若将来某条迁移依赖 pglite 未内置的扩展，优先在 migrations 里显式
 *      `CREATE EXTENSION IF NOT EXISTS <ext>`；只有确认 pglite 无法支持时才登记白名单。
 * ---------------------------------------------------------------------------
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'server', 'database', 'migrations');

/**
 * pglite 兼容白名单：文件名 → 跳过理由（当前为空，见文件头说明）。
 * 注意：这里只允许写"pglite 侧"的理由，业务语义一律不得绕过。
 */
const PGLITE_SKIP_WHITELIST = Object.freeze({});

/**
 * 可选前置语句：为"未来可能出现"的扩展依赖做准备。
 * pglite 0.3.x 未内置 pgcrypto，故此处失败只打印 INFO，不算错误；
 * 真正的依赖会在迁移执行时以明确报错暴露（不静默）。
 */
const OPTIONAL_PRELUDE = ['CREATE EXTENSION IF NOT EXISTS pgcrypto'];

const args = new Set(process.argv.slice(2));
const LIST_ONLY = args.has('--list');
const QUIET = args.has('--quiet');

/** 与 db-migrate.mjs 一致：忽略 SKIP / .disabled 的半成品迁移 */
function listMigrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter(
      (name) =>
        name.endsWith('.sql') &&
        !name.includes('SKIP') &&
        !name.includes('.disabled') &&
        !name.endsWith('.sql.disabled'),
    )
    .sort();
}

function loadMigration(name, dir = MIGRATIONS_DIR) {
  return { name, sql: readFileSync(join(dir, name), 'utf8') };
}

function log(message) {
  if (!QUIET) console.log(message);
}

/** 打印 PostgreSQL 错误的结构化信息（pglite 抛出的 Error 上带 code/detail/hint/position） */
function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const extra = ['code', 'detail', 'hint', 'position']
    .map((key) => {
      const value = error[key];
      return value === undefined || value === null ? null : `${key}=${String(value)}`;
    })
    .filter(Boolean);
  return extra.length > 0 ? `${error.message} [${extra.join(' ')}]` : error.message;
}

/** 探测 pglite 对迁移链实际用到的 PostgreSQL 特性的支持情况 */
async function probeCapabilities(db) {
  const capabilities = {};

  // 1) gen_random_uuid()：0000_baseline.sql 的 66+ 张表主键默认值依赖它
  try {
    const rows = await db.query('SELECT gen_random_uuid()::text AS id');
    capabilities.gen_random_uuid = rows.rows[0]?.id ? 'ok' : 'empty';
  } catch (error) {
    capabilities.gen_random_uuid = `missing(${describeError(error)})`;
  }

  // 2) DO $$ ... EXCEPTION WHEN duplicate_object：迁移幂等块写法
  try {
    await db.exec(`
      DO $$
      BEGIN
        CREATE TYPE _dryrun_probe_type AS (a int);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
      DROP TYPE IF EXISTS _dryrun_probe_type;
    `);
    capabilities.plpgsql_do_block = 'ok';
  } catch (error) {
    capabilities.plpgsql_do_block = `missing(${describeError(error)})`;
  }

  // 3) NULLS NOT DISTINCT 唯一索引（PostgreSQL 15+）
  try {
    await db.exec(`
      CREATE TEMP TABLE _dryrun_probe_nnd (a varchar, b uuid);
      CREATE UNIQUE INDEX _dryrun_probe_nnd_uq ON _dryrun_probe_nnd (a, b) NULLS NOT DISTINCT;
      DROP TABLE _dryrun_probe_nnd;
    `);
    capabilities.nulls_not_distinct = 'ok';
  } catch (error) {
    capabilities.nulls_not_distinct = `missing(${describeError(error)})`;
  }

  // 4) CREATE TRIGGER + plpgsql 函数（accounting-base 的凭证行科目回填触发器）
  try {
    await db.exec(`
      CREATE TEMP TABLE _dryrun_probe_trg (a int);
      CREATE OR REPLACE FUNCTION pg_temp._dryrun_probe_fn() RETURNS trigger AS $fn$
      BEGIN
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER _dryrun_probe_trg_bi BEFORE INSERT ON _dryrun_probe_trg
        FOR EACH ROW EXECUTE FUNCTION pg_temp._dryrun_probe_fn();
    `);
    capabilities.plpgsql_trigger = 'ok';
  } catch (error) {
    capabilities.plpgsql_trigger = `missing(${describeError(error)})`;
  }

  return capabilities;
}

async function run() {
  const startedAt = Date.now();
  const files = listMigrationFiles();

  if (LIST_ONLY) {
    for (const name of files) console.log(name);
    console.log(`[dryrun] list total=${files.length}`);
    return 0;
  }

  console.log('[dryrun] 迁移链 dryrun 启动（pglite / WASM PostgreSQL，全新内存实例）');
  console.log(`[dryrun] 迁移目录：${MIGRATIONS_DIR}`);
  console.log(`[dryrun] total=${files.length}`);
  if (files.length === 0) {
    console.error('[dryrun] FAIL 迁移目录为空，无法验证迁移链');
    return 1;
  }

  let PGlite;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
  } catch (error) {
    console.error(
      `[dryrun] FAIL 无法加载 @electric-sql/pglite：${describeError(error)}（请先 npm install）`,
    );
    return 1;
  }

  const db = new PGlite();
  const report = [];
  let failed = 0;
  let skipped = 0;
  let applied = 0;

  try {
    await db.waitReady;

    for (const statement of OPTIONAL_PRELUDE) {
      try {
        await db.exec(statement);
        log(`[dryrun] INFO 前置语句成功：${statement}`);
      } catch (error) {
        // 可选前置，失败不致命：真实依赖会在迁移执行时显式报错
        log(`[dryrun] INFO 前置语句不可用（忽略）：${statement} → ${describeError(error)}`);
      }
    }

    const capabilities = await probeCapabilities(db);
    console.log(
      `[dryrun] capability ${Object.entries(capabilities)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')}`,
    );

    // 与 db-migrate.mjs 对齐：dryrun 也建同样的登记表，确保迁移里若引用它不会假报缺表
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const name of files) {
      if (Object.prototype.hasOwnProperty.call(PGLITE_SKIP_WHITELIST, name)) {
        skipped += 1;
        report.push({ name, status: 'skipped' });
        console.warn(
          `[dryrun] WARNING 跳过 ${name}：${PGLITE_SKIP_WHITELIST[name]}`,
        );
        console.log(`[dryrun] SKIP ${name}`);
        continue;
      }

      const { sql } = loadMigration(name);
      const fileStartedAt = Date.now();
      try {
        // 单条迁移事务化，与 db-migrate.mjs 一致：中途失败不留半应用 schema
        await db.transaction(async (tx) => {
          await tx.exec(sql);
          await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [name]);
        });
        applied += 1;
        const elapsed = Date.now() - fileStartedAt;
        report.push({ name, status: 'applied', ms: elapsed });
        console.log(`[dryrun] OK ${name} ${elapsed}ms`);
      } catch (error) {
        failed += 1;
        report.push({ name, status: 'failed', error: describeError(error) });
        console.error(`[dryrun] FAIL ${name}`);
        console.error(`[dryrun]   原因：${describeError(error)}`);
        break; // 迁移链中断，后续迁移不再执行（与真实库行为一致）
      }
    }

    // 断言"跳过清单为空或已登记白名单"：未登记白名单的迁移必须全部实际执行过
    const executed = new Set(report.filter((item) => item.status !== 'skipped').map((item) => item.name));
    const unregistered = report.find(
      (item) => item.status === 'skipped' && !Object.prototype.hasOwnProperty.call(PGLITE_SKIP_WHITELIST, item.name),
    );
    if (unregistered) {
      failed += 1;
      console.error(`[dryrun] FAIL 存在未登记白名单的跳过项：${unregistered.name}`);
    }
    if (failed === 0 && applied !== files.length - skipped) {
      failed += 1;
      console.error(
        `[dryrun] FAIL 执行条数不符：期望 ${files.length - skipped}，实际 ${applied}（executed=${executed.size}）`,
      );
    }

    // 迁移链完整性：登记表里的迁移数与实际执行数一致
    if (failed === 0) {
      const rows = await db.query('SELECT count(*)::int AS total FROM schema_migrations');
      const registered = Number(rows.rows[0]?.total ?? 0);
      if (registered !== applied) {
        failed += 1;
        console.error(
          `[dryrun] FAIL schema_migrations 登记数 ${registered} 与已执行数 ${applied} 不一致`,
        );
      }
    }
  } catch (error) {
    failed += 1;
    console.error(`[dryrun] FAIL 迁移链异常终止：${describeError(error)}`);
  } finally {
    await db.close().catch(() => undefined);
  }

  const totalMs = Date.now() - startedAt;
  const result = failed === 0 ? 'PASS' : 'FAIL';
  console.log(
    `[dryrun] SUMMARY total=${files.length} applied=${applied} skipped=${skipped} failed=${failed} ms=${totalMs} result=${result}`,
  );
  if (failed > 0) {
    console.error('[dryrun] 迁移链 dryrun 未通过：请修复失败的迁移后重跑');
    return 1;
  }
  console.log(`[dryrun] 迁移链 dryrun 通过：${applied} 条迁移在 pglite 上全部执行成功`);
  return 0;
}

process.exitCode = await run();
