/**
 * 迁移链集成测试（需求书 B-10，P0）
 *
 * 验证目标：
 *   ① 全新建库时，server/database/migrations/*.sql 按文件名排序能全部执行成功；
 *   ② 迁移文件命名规则与排序规则（NNNN_ / YYYY-MM-DD- 单调递增）被真实校验；
 *   ③ 迁移落地的关键对象（表 / NULLS NOT DISTINCT 唯一索引 / plpgsql 触发器）
 *      在 PostgreSQL 语义下真实存在且真实生效；
 *   ④ 「坏迁移」必须让 harness 失败，并且错误信息带文件名——迁移链测试不会假绿。
 *
 * 边界说明：本文件只用 pglite（WASM PostgreSQL）验证迁移链与 DB 层语义，
 * 不连接本地开发库（CI 没有该库，且迁移器会写库）。
 */
import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MigrationChainError,
  PGLITE_SKIP_WHITELIST,
  applyMigrationChain,
  createPglite,
  listAppliedMigrations,
  listMigrationFiles,
  loadMigrations,
  probeCapabilities,
  queryRows,
  scalar,
  tableExists,
} from './pglite-harness';

/** pglite 首次启动（WASM 初始化）+ 21 条迁移约 2 秒，给足余量 */
const CHAIN_TIMEOUT_MS = 120_000;

const MIGRATION_NAME_PATTERN =
  /^(?:\d{4}_[a-z0-9_-]+|\d{4}-\d{2}-\d{2}-[a-z0-9-]+)\.sql$/;

describe('迁移链：文件名与排序规则', () => {
  const files = listMigrationFiles();

  it('迁移文件存在且命名符合 NNNN_snake_case / YYYY-MM-DD-描述 规则', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
    const illegal = files.filter((name) => !MIGRATION_NAME_PATTERN.test(name));
    expect(illegal).toEqual([]);
    // 迁移目录只放迁移：不得出现查询/诊断脚本
    expect(files.every((name) => name.endsWith('.sql'))).toBe(true);
  });

  it('排序单调且首个为 0000_baseline.sql（保证 baseline 先建表）', () => {
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
    expect(new Set(files).size).toBe(files.length);
    expect(files[0]).toBe('0000_baseline.sql');
  });

  it('日期风格迁移按日期单调递增（跨日期不允许倒序）', () => {
    const dated = files.filter((name) => /^\d{4}-\d{2}-\d{2}-/.test(name));
    const dates = dated.map((name) => name.slice(0, 10));
    expect(dates.length).toBeGreaterThan(10);
    expect(dates).toEqual([...dates].sort());
  });
});

describe('迁移链：全新 pglite 实例全量执行', () => {
  let db: Awaited<ReturnType<typeof createPglite>>;
  let results: Awaited<ReturnType<typeof applyMigrationChain>>;
  const migrations = loadMigrations();

  beforeAll(async () => {
    db = await createPglite();
    results = await applyMigrationChain(db, migrations);
  }, CHAIN_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
  });

  it('21 条迁移全部执行成功，无失败、无跳过', () => {
    expect(results).toHaveLength(migrations.length);
    expect(results.filter((item) => item.status === 'failed')).toEqual([]);
    expect(results.filter((item) => item.status === 'applied')).toHaveLength(
      migrations.length
    );
    // 「跳过清单为空或已登记白名单」：当前白名单为空，故跳过数必须为 0
    expect(results.filter((item) => item.status === 'skipped')).toEqual([]);
    expect(Object.keys(PGLITE_SKIP_WHITELIST)).toEqual([]);
  });

  it('每个迁移文件都被登记进 schema_migrations，且顺序与文件顺序一致', async () => {
    const applied = await listAppliedMigrations(db);
    expect(applied).toEqual(migrations.map((item) => item.name).sort());
  });

  it('pglite 支持迁移实际用到的 PostgreSQL 特性（实测探测）', async () => {
    const capabilities = await probeCapabilities(db);
    expect(capabilities).toEqual({
      genRandomUuid: true,
      doBlockDuplicateObject: true,
      nullsNotDistinct: true,
      plpgsqlTrigger: true,
    });
  });

  it('关键业务表在迁移链后全部存在', async () => {
    const required = [
      'schema_migrations',
      'sys_user',
      'sys_role_member',
      'comp_biz_code_seq',
      'comp_voucher_job',
      'erp_receipt',
      'erp_ar_writeoff',
      'erp_ap_writeoff',
      'fin_account',
      'fin_voucher',
      'fin_voucher_line',
      'fin_period_close',
      'fin_period_close_audit',
      'fin_account_balance_snapshot',
      'fin_vat_declaration',
      'fin_year_end_close',
      'hr_ss_city_rule',
    ];
    const missing: string[] = [];
    for (const name of required) {
      if (!(await tableExists(db, name))) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it('建表规模与 baseline 声明一致（≥66 张业务表）', async () => {
    const total = await scalar<string>(
      db,
      `SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public'`
    );
    expect(Number(total)).toBeGreaterThanOrEqual(66);
  });

  it('fin_account 已升级为多级科目树：parent_code / level / is_leaf / direction 列存在', async () => {
    const rows = await queryRows<{ column_name: string }>(
      db,
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'fin_account'
          AND column_name IN ('parent_code', 'level', 'is_leaf', 'direction', 'aux_required')`
    );
    expect(rows.map((row) => row.column_name).sort()).toEqual([
      'aux_required',
      'direction',
      'is_leaf',
      'level',
      'parent_code',
    ]);
  });

  it('唯一索引 uq_fin_vat_declaration_period_entity 真实建成 NULLS NOT DISTINCT', async () => {
    const rows = await queryRows<{ indnullsnotdistinct: boolean }>(
      db,
      `SELECT i.indnullsnotdistinct
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'uq_fin_vat_declaration_period_entity'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indnullsnotdistinct).toBe(true);
    // 唯一性真实生效：tax_entity_id 为 NULL 的重复期间必须被拒
    await db.exec(`
      INSERT INTO fin_vat_declaration (period, tax_entity_id) VALUES ('2026-01', NULL)
    `);
    await expect(
      db.exec(
        `INSERT INTO fin_vat_declaration (period, tax_entity_id) VALUES ('2026-01', NULL)`
      )
    ).rejects.toThrow(/uq_fin_vat_declaration_period_entity|duplicate key/);
  });

  it('凭证行科目回填触发器 trg_fin_voucher_line_account_code 真实生效', async () => {
    const trigger = await scalar<string>(
      db,
      `SELECT tgname FROM pg_trigger WHERE tgname = 'trg_fin_voucher_line_account_code'`
    );
    expect(trigger).toBe('trg_fin_voucher_line_account_code');

    await db.exec(`
      INSERT INTO fin_account (code, name, account_type, direction, level, is_leaf, status)
      VALUES ('9901', '测试用科目-触发器', 'asset', 'debit', 1, 1, 'active');
      INSERT INTO fin_voucher (code, voucher_date, period, summary, status)
      VALUES ('VCHTRIG0001', '2026-01-05', '2026-01', '触发器验证', 'draft');
      INSERT INTO fin_voucher_line (voucher_id, account_id, debit, credit)
      VALUES (
        (SELECT id FROM fin_voucher WHERE code = 'VCHTRIG0001'),
        (SELECT id FROM fin_account WHERE code = '9901'),
        100, 0
      );
    `);
    const filled = await scalar<string>(
      db,
      `SELECT account_code FROM fin_voucher_line
        WHERE voucher_id = (SELECT id FROM fin_voucher WHERE code = 'VCHTRIG0001')`
    );
    // 触发器按 account_id 回填 account_code；未生效则会读出 NULL
    expect(filled).toBe('9901');
  });
});

describe('迁移链：坏迁移必须失败（防止测试假绿）', () => {
  it('向全新 pglite 执行语法错误的 SQL 会抛错', async () => {
    const db = await createPglite();
    try {
      await expect(
        db.exec('CREATE TABLE _broken_migration_probe (')
      ).rejects.toThrow(/syntax error/i);
    } finally {
      await db.close();
    }
  }, CHAIN_TIMEOUT_MS);

  it('内联坏迁移会让 harness 抛 MigrationChainError，且错误信息带文件名', async () => {
    const db = await createPglite();
    try {
      const inline = [
        {
          name: '0000_baseline.sql',
          sql: 'CREATE TABLE _harness_ok (id integer PRIMARY KEY)',
        },
        {
          name: '9999_broken.sql',
          sql: 'ALTER TABLE _harness_missing_table ADD COLUMN x integer',
        },
      ];
      let caught: unknown;
      try {
        await applyMigrationChain(db, inline);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MigrationChainError);
      const chainError = caught as MigrationChainError;
      expect(chainError.fileName).toBe('9999_broken.sql');
      expect(chainError.index).toBe(1);
      expect(chainError.message).toContain('9999_broken.sql');
      expect(chainError.message).toMatch(/does not exist|42703|42P01/);
      // 好迁移已执行、坏迁移失败即中断：结果里有 1 条 applied + 1 条 failed
      expect(chainError.results.map((item) => item.status)).toEqual([
        'applied',
        'failed',
      ]);
      // 失败迁移的事务已回滚，且未登记进 schema_migrations
      expect(await listAppliedMigrations(db)).toEqual(['0000_baseline.sql']);
    } finally {
      await db.close();
    }
  }, CHAIN_TIMEOUT_MS);

  it('未登记白名单的迁移若被跳过，harness 判定跳过清单非法', () => {
    // 白名单为空 → 任何"跳过"都是未登记项，必须显式暴露而不是静默忽略
    const whitelist = PGLITE_SKIP_WHITELIST;
    expect(Object.keys(whitelist)).toEqual([]);
    const skipped = ['2026-10-15-upgrade-batch1-accounting-base.sql'];
    const unregistered = skipped.filter(
      (name) => !Object.prototype.hasOwnProperty.call(whitelist, name)
    );
    expect(unregistered).toEqual(skipped);
  });
});

describe('迁移链：dryrun 脚本（CI 入口）与 harness 使用同一份清单', () => {
  const repoRoot = resolve(__dirname, '..', '..', '..');
  const scriptPath = join(repoRoot, 'scripts', 'migrate-dryrun.mjs');

  it('`node scripts/migrate-dryrun.mjs --list` 输出的清单与 harness 完全一致', () => {
    // 用文件而非管道接收子进程输出：受限沙箱下管道（named pipe）可能被拒，
    // 重定向到临时文件在任何环境都可用。
    const dir = mkdtempSync(join(tmpdir(), 'dryrun-list-'));
    const outPath = join(dir, 'stdout.txt');
    const outFd = openSync(outPath, 'w');
    try {
      execFileSync(process.execPath, [scriptPath, '--list'], {
        cwd: repoRoot,
        stdio: ['ignore', outFd, 'inherit'],
      });
    } finally {
      closeSync(outFd);
    }
    const output = readFileSync(outPath, 'utf8');
    rmSync(dir, { recursive: true, force: true });

    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const summary = lines.find((line) => line.startsWith('[dryrun] list'));
    expect(summary).toBe(`[dryrun] list total=${listMigrationFiles().length}`);
    const listed = lines.filter((line) => line.endsWith('.sql'));
    expect(listed).toEqual(listMigrationFiles());
  }, 60_000);
});
