/**
 * 备份 / 恢复演练（上线前必须做一次）。
 *
 * ## 为什么要有脚本，而不是文档写"记得演练"
 *
 * 备份最常见的失效方式不是"没备份"，而是**备份文件恢复不出来** ——
 * 权限、扩展、序列、所有权、编码，任何一样不对，真出事那天才发现。
 * 而"演练过"这件事本身也需要证据（文件名、校验和、行数比对）。
 *
 * 本脚本做五步，每步都有可核对的输出：
 *   ① `pg_dump` 出全库自定义格式备份（`-Fc`，压缩且可选择性恢复）
 *   ② 记录**文件大小与 sha256 校验和**
 *   ③ 建一个**临时库** `<源库>_drill_<时间戳>`
 *   ④ `pg_restore` 恢复到临时库（`--exit-on-error`：**任何一条失败立即中断**）
 *   ⑤ **逐表比对行数**（源库 vs 演练库）—— 全部一致才算通过，然后 DROP 临时库
 *
 * ## 安全边界
 *
 * · **只读源库**（`pg_dump` 不修改任何数据）；
 * · 临时库名带 `_drill_`，`finally` 里**一定 DROP**（`WITH (FORCE)` 防连接占用）；
 * · **绝不**对源库执行任何 DDL/DML。
 *
 * 用法：
 *   npx tsx scripts/drill-backup-restore.mjs
 *   PG_BIN="D:\\pgsql\\bin" npx tsx scripts/drill-backup-restore.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const ROOT = process.cwd();
const PG_BIN = process.env.PG_BIN ?? 'C:\\Program Files\\PostgreSQL\\17\\bin';
const OUT_DIR = join(ROOT, '..', 'docs', 'backup-drill');

const envLine = readFileSync(join(ROOT, '.env'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
if (!envLine) throw new Error('.env 里没有 DATABASE_URL');
const DATABASE_URL = envLine.slice(13).trim();

function parseUrl(u) {
  const m = u.match(/^postgres(?:ql)?:\/\/([^:]+):([^@]*)@([^:]+):(\d+)\/([^?]+)/);
  if (!m) throw new Error(`无法解析 DATABASE_URL: ${u}`);
  return { user: m[1], password: m[2], host: m[3], port: m[4], database: m[5] };
}
const cfg = parseUrl(DATABASE_URL);
const pgEnv = { ...process.env, PGPASSWORD: cfg.password };

const results = [];
const rec = (n, pass, d) => {
  results.push({ n, pass, d });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
};

const exe = (name) => join(PG_BIN, `${name}.exe`);

/** Windows 下 Program Files 含空格，必须走 shell 并自行加引号 */
function runPg(bin, args, label) {
  const cmd = [`"${exe(bin)}"`, ...args].join(' ');
  try {
    return execFileSync(cmd, {
      env: pgEnv,
      encoding: 'utf8',
      timeout: 1_800_000,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const tail = `${e.stdout ?? ''}${e.stderr ?? ''}`.split('\n').filter(Boolean).slice(-3).join(' ');
    throw new Error(`${label} 失败：${tail}`);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DRILL_DB = `${cfg.database}_drill_${Date.now()}`;
const DUMP_FILE = join(OUT_DIR, `dump-${stamp}.dump`);

/** 关键表（行数比对样本）：覆盖主数据/业务/账务/系统四层 */
const KEY_TABLES = [
  'md_customer',
  'md_supplier',
  'md_employee',
  'md_tax_entity',
  'erp_contract',
  'erp_project',
  'erp_ar',
  'erp_ap_bill',
  'erp_invoice',
  'erp_payment',
  'erp_receipt',
  'fin_voucher',
  'fin_voucher_line',
  'schema_migrations',
];

async function countsOf(url, tables) {
  const sql = postgres(url, { max: 2, idle_timeout: 10, connect_timeout: 10 });
  const out = {};
  try {
    for (const t of tables) {
      try {
        const r = await sql.unsafe(`SELECT count(*)::int AS n FROM "${t}"`);
        out[t] = Number(r[0].n);
      } catch {
        out[t] = null; // 表不存在
      }
    }
  } finally {
    await sql.end({ timeout: 3 }).catch(() => {});
  }
  return out;
}

async function main() {
  console.log('=== 备份 / 恢复演练 ===\n');
  console.log(`  源库: ${cfg.host}:${cfg.port}/${cfg.database}`);
  console.log(`  PG 工具: ${PG_BIN}\n`);

  rec(
    'pg_dump / psql / pg_restore 均存在',
    ['pg_dump', 'psql', 'pg_restore'].every((b) => existsSync(exe(b))),
    PG_BIN,
  );
  mkdirSync(OUT_DIR, { recursive: true });

  /* ① 备份 */
  const t0 = Date.now();
  runPg(
    'pg_dump',
    ['-h', cfg.host, '-p', cfg.port, '-U', cfg.user, '-d', cfg.database, '-Fc', '-f', `"${DUMP_FILE}"`],
    'pg_dump',
  );
  const dumpMs = Date.now() - t0;
  const size = statSync(DUMP_FILE).size;
  rec('① pg_dump 完成', size > 0, `${DUMP_FILE.split(/[\\/]/).pop()}  ${(size / 1024 / 1024).toFixed(2)} MB  ${dumpMs} ms`);

  /* ② 校验和 */
  const sha = createHash('sha256').update(readFileSync(DUMP_FILE)).digest('hex');
  rec('② 备份校验和已记录', sha.length === 64, `sha256=${sha}`);

  /* ③ 建临时库 → ④ 恢复 → ⑤ 行数比对 → finally DROP */
  const admin = postgres(
    `postgres://${cfg.user}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}/postgres`,
    { max: 1, idle_timeout: 10, connect_timeout: 10 },
  );
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${DRILL_DB}"`);
    created = true;
    rec('③ 临时演练库已创建', true, DRILL_DB);

    const t1 = Date.now();
    runPg(
      'pg_restore',
      [
        '-h', cfg.host, '-p', cfg.port, '-U', cfg.user, '-d', DRILL_DB,
        '--no-owner', '--no-privileges', '--exit-on-error', `"${DUMP_FILE}"`,
      ],
      'pg_restore',
    );
    rec('④ pg_restore 完成（--exit-on-error，任一条失败即中断）', true, `${Date.now() - t1} ms`);

    /* ⑤ 行数比对 */
    const srcCounts = await countsOf(DATABASE_URL, KEY_TABLES);
    const drillUrl = `postgres://${cfg.user}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}/${DRILL_DB}`;
    const drillCounts = await countsOf(drillUrl, KEY_TABLES);

    const diffs = [];
    for (const t of KEY_TABLES) {
      if (srcCounts[t] === null && drillCounts[t] === null) continue; // 两侧都不存在
      if (srcCounts[t] !== drillCounts[t]) diffs.push(`${t}: 源=${srcCounts[t]} 演练=${drillCounts[t]}`);
    }
    const total = Object.values(srcCounts).reduce((a, b) => a + (b ?? 0), 0);
    rec(
      `⑤ ${KEY_TABLES.length} 张关键表行数一致（合计 ${total} 行）`,
      diffs.length === 0,
      diffs.length ? diffs.join('；') : '全部一致',
    );
  } finally {
    if (created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DRILL_DB}" WITH (FORCE)`).catch((e) => {
        console.log(`  ⚠️ DROP 临时库失败（需人工清理）：${e.message}`);
      });
      console.log(`\n  已 DROP 临时库 ${DRILL_DB}（源库未受任何影响）`);
    }
    await admin.end({ timeout: 3 }).catch(() => {});
  }

  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  console.log(`  备份文件: ${DUMP_FILE}`);
  console.log(`  校验和  : sha256=${sha}`);
  if (bad.length) {
    for (const b of bad) console.log(`  - ${b.n}  ${b.d ?? ''}`);
    process.exitCode = 1;
  }
}
void main().catch((e) => { console.error('演练失败:', e.message); process.exitCode = 1; });
