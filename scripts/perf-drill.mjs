/**
 * 性能验证：在**独立库**里造量，测真实查询耗时（不碰开发库）。
 *
 * ## 为什么需要它
 *
 * 本会话所有验证都跑在开发库上（几百行数据）。生产量级下：
 * 报表/账簿/底稿的 `ILIKE`、`join`、`group by` 是否会拖到不可用？
 * 分页是否走索引？—— 这些是**上线前唯一无法用功能测试回答**的问题。
 *
 * ## 做法
 *
 * ① `CREATE DATABASE shengseerp_perf` → 用既有 dump 恢复 schema（比跑迁移快，且与当前一致）
 * ② 用 `generate_series` 造量
 * ③ 起一个临时服务实例（`DATABASE_URL` 指向 perf 库），**走真实 HTTP 路径**测耗时
 * ④ `finally` 里杀实例 + `DROP DATABASE`
 *
 * ## 安全边界
 *
 * · **只在 `_perf` 库上写入**，源库只读（用于 dump）；
 * · 临时库名固定含 `_perf`，结束时一定 DROP；
 * · 临时服务实例用**独立端口**（默认 3200），不干扰常驻实例。
 *
 * 用法：npx tsx scripts/perf-drill.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const ROOT = process.cwd();
const PG_BIN = process.env.PG_BIN ?? 'C:\\Program Files\\PostgreSQL\\17\\bin';
const OUT_DIR = join(ROOT, '..', 'docs', 'perf-drill');
const PERF_PORT = Number(process.env.PERF_PORT ?? 3200);
const PERF_DB = 'shengseerp_perf';

const envLine = readFileSync(join(ROOT, '.env'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
const SRC_URL = envLine.slice(13).trim();
const m = SRC_URL.match(/^postgres(?:ql)?:\/\/([^:]+):([^@]*)@([^:]+):(\d+)\/([^?]+)/);
if (!m) throw new Error('无法解析 DATABASE_URL');
const cfg = { user: m[1], password: m[2], host: m[3], port: m[4], database: m[5] };
const pgEnv = { ...process.env, PGPASSWORD: cfg.password };
const PERF_URL = `postgres://${cfg.user}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}/${PERF_DB}`;

const exe = (b) => join(PG_BIN, `${b}.exe`);
function runPg(bin, args, label) {
  const cmd = [`"${exe(bin)}"`, ...args].join(' ');
  try {
    return execFileSync(cmd, { env: pgEnv, encoding: 'utf8', timeout: 1_800_000, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`${label} 失败：${`${e.stdout ?? ''}${e.stderr ?? ''}`.split('\n').filter(Boolean).slice(-3).join(' ')}`);
  }
}

/** 造量目标（覆盖"报表/账簿/底稿"最吃数据量的几张表） */
const TARGETS = { vouchers: 20_000, linesPerVoucher: 3, ars: 5_000, aps: 5_000, invoices: 8_000 };

/** 造量 SQL：全部用 generate_series，一条语句一张表 */
const SEED_SQL = `
-- 期间：2025-01 .. 2025-12（12 个期间）
CREATE TEMP TABLE p AS
SELECT to_char(date '2025-01-01' + (i || ' month')::interval, 'YYYY-MM') AS period
FROM generate_series(0, 11) AS i;

-- 凭证
INSERT INTO fin_voucher (code, voucher_date, period, summary, status, source_type)
SELECT
  'PERF' || lpad(g::text, 8, '0'),
  (date '2025-01-01' + ((g % 360) || ' day')::interval)::date,
  to_char(date '2025-01-01' + ((g % 360) || ' day')::interval, 'YYYY-MM'),
  '性能造量凭证 ' || g,
  CASE WHEN g % 5 = 0 THEN 'draft' ELSE 'posted' END,
  'perf'
FROM generate_series(1, ${TARGETS.vouchers}) AS g;

-- 分录：每张凭证 3 行（借/贷/借），科目取预置的 6xxx/1xxx
INSERT INTO fin_voucher_line (voucher_id, summary, account_code, debit, credit)
SELECT v.id, '性能造量分录 ' || v.code,
       (ARRAY['1001','1002','6001','6601','222101'])[1 + (row_number() OVER (PARTITION BY v.id ORDER BY v.id)) % 5],
       CASE WHEN row_number() OVER (PARTITION BY v.id ORDER BY v.id) = 2 THEN 0 ELSE 100 END,
       CASE WHEN row_number() OVER (PARTITION BY v.id ORDER BY v.id) = 2 THEN 100 ELSE 0 END
FROM fin_voucher v
CROSS JOIN generate_series(1, ${TARGETS.linesPerVoucher}) AS n
WHERE v.source_type = 'perf';

-- 应收
INSERT INTO erp_ar (code, customer_id, amount, settled_amount, due_date, status, source, owner_user_id)
SELECT 'PERFAR' || lpad(g::text, 8, '0'),
       (SELECT id FROM md_customer ORDER BY code LIMIT 1),
       1000 + (g % 500), 0,
       (date '2025-01-01' + ((g % 360) || ' day')::interval)::date,
       CASE WHEN g % 7 = 0 THEN 'settled' WHEN g % 5 = 0 THEN 'voided' ELSE 'open' END,
       'perf', NULL
FROM generate_series(1, ${TARGETS.ars}) AS g;

-- 应付
INSERT INTO erp_ap_bill (code, supplier_id, amount, paid_amount, due_date, status, source)
SELECT 'PERFAP' || lpad(g::text, 8, '0'),
       (SELECT id FROM md_supplier ORDER BY code LIMIT 1),
       1000 + (g % 500), 0,
       (date '2025-01-01' + ((g % 360) || ' day')::interval)::date,
       CASE WHEN g % 7 = 0 THEN 'paid' ELSE 'open' END,
       'perf'
FROM generate_series(1, ${TARGETS.aps}) AS g;

-- 发票（销项/进项各半）
INSERT INTO erp_invoice (code, invoice_no, direction, invoice_type, amount, tax_rate, tax_amount, net_amount, invoice_date, status, contract_id, supplier_id)
SELECT 'PERFINV' || lpad(g::text, 8, '0'),
       'PERF-NO-' || g,
       CASE WHEN g % 2 = 0 THEN 'sales' ELSE 'purchase' END,
       'vat_special',
       1000 + (g % 500), 6,
       round((1000 + (g % 500)) * 6 / 106.0, 2),
       round((1000 + (g % 500)) * 100 / 106.0, 2),
       (date '2025-01-01' + ((g % 360) || ' day')::interval)::date,
       'issued',
       CASE WHEN g % 2 = 0 THEN (SELECT id FROM erp_contract ORDER BY code LIMIT 1) ELSE NULL END,
       CASE WHEN g % 2 = 0 THEN NULL ELSE (SELECT id FROM md_supplier ORDER BY code LIMIT 1) END
FROM generate_series(1, ${TARGETS.invoices}) AS g;

ANALYZE fin_voucher;
ANALYZE fin_voucher_line;
ANALYZE erp_ar;
ANALYZE erp_ap_bill;
ANALYZE erp_invoice;
`;

const results = [];
const rec = (n, pass, d) => {
  results.push({ n, pass, d });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
};

async function waitHealth(url, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

async function main() {
  console.log('=== 性能验证（独立库造量 + 真实 HTTP 测耗时）===\n');
  console.log(`  源库: ${cfg.database}（只读，仅用于 dump schema）`);
  console.log(`  perf 库: ${PERF_DB}`);
  console.log(`  临时实例: :${PERF_PORT}\n`);

  rec('pg 工具存在', ['pg_dump', 'pg_restore'].every((b) => existsSync(exe(b))), PG_BIN);
  mkdirSync(OUT_DIR, { recursive: true });
  const dump = join(OUT_DIR, 'schema-source.dump');

  const admin = postgres(`postgres://${cfg.user}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}/postgres`, {
    max: 1, idle_timeout: 10, connect_timeout: 10,
  });
  let child = null;
  let created = false;
  try {
    /* 幂等：先删残留 */
    await admin.unsafe(`DROP DATABASE IF EXISTS "${PERF_DB}" WITH (FORCE)`).catch(() => {});
    await admin.unsafe(`CREATE DATABASE "${PERF_DB}"`);
    created = true;
    rec('① perf 库已创建', true, PERF_DB);

    runPg('pg_dump', ['-h', cfg.host, '-p', cfg.port, '-U', cfg.user, '-d', cfg.database, '-Fc', '-f', `"${dump}"`], 'pg_dump');
    runPg(
      'pg_restore',
      ['-h', cfg.host, '-p', cfg.port, '-U', cfg.user, '-d', PERF_DB, '--no-owner', '--no-privileges', '--exit-on-error', `"${dump}"`],
      'pg_restore',
    );
    rec('② schema 已恢复（与当前库一致）', true, dump.split(/[\\/]/).pop());

    /* ③ 造量 */
    const t0 = Date.now();
    const perfSql = postgres(PERF_URL, { max: 2, idle_timeout: 15, connect_timeout: 10 });
    try {
      await perfSql.unsafe(SEED_SQL);
      const c = await perfSql.unsafe(`
        SELECT (SELECT count(*) FROM fin_voucher WHERE source_type='perf')::int AS v,
               (SELECT count(*) FROM fin_voucher_line)::int AS l,
               (SELECT count(*) FROM erp_ar WHERE source='perf')::int AS a,
               (SELECT count(*) FROM erp_ap_bill WHERE source='perf')::int AS p,
               (SELECT count(*) FROM erp_invoice WHERE code LIKE 'PERFINV%')::int AS i`);
      rec(
        '③ 造量完成',
        c[0].v > 0 && c[0].l > 0,
        `凭证 ${c[0].v} / 分录 ${c[0].l} / 应收 ${c[0].a} / 应付 ${c[0].p} / 发票 ${c[0].i}  （${Date.now() - t0} ms）`,
      );
    } finally {
      await perfSql.end({ timeout: 5 }).catch(() => {});
    }

    /* ④ 起临时实例（DATABASE_URL 指向 perf 库；dotenv 不覆盖已存在的 env） */
    child = spawn(process.execPath, [join(ROOT, 'dist', 'server', 'main.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: PERF_URL,
        SERVER_PORT: String(PERF_PORT),
        NODE_ENV: 'production',
        ENABLE_SCHEDULER: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bootLog = '';
    child.stdout.on('data', (b) => { bootLog += b.toString(); });
    child.stderr.on('data', (b) => { bootLog += b.toString(); });
    const base = `http://127.0.0.1:${PERF_PORT}`;
    const healthy = await waitHealth(base);
    rec('④ 临时实例已就绪（指向 perf 库）', healthy, healthy ? base : bootLog.slice(-200));
    if (!healthy) throw new Error('临时实例未就绪');

    /* ⑤ 登录 + 测耗时 */
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: process.env.BOOTSTRAP_ADMIN_USERNAME,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      }),
    });
    if (loginRes.status !== 201) throw new Error(`perf 实例登录失败 ${loginRes.status}`);
    const jar = loginRes.headers.getSetCookie?.() ?? [];
    const session = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session=')).slice(12);
    rec('⑤ perf 实例可登录', true, `HTTP 201`);

    /** 测一个 GET 的耗时（跑 3 次取中位数，避免首次连接的冷启动噪声） */
    const timeGet = async (path) => {
      const times = [];
      let status = 0;
      for (let i = 0; i < 3; i += 1) {
        const s = Date.now();
        const r = await fetch(`${base}${path}`, {
          headers: { cookie: `erp_session=${session}` },
          signal: AbortSignal.timeout(120_000),
        });
        status = r.status;
        await r.text();
        times.push(Date.now() - s);
      }
      times.sort((a, b) => a - b);
      return { ms: times[1], status };
    };

    const CASES = [
      ['试算平衡表（12 月）', '/api/finance/ledgers/trial-balance?period=2025-12'],
      ['资产负债表', '/api/finance/reports/balance-sheet?period=2025-12'],
      ['利润表', '/api/finance/reports/income-statement?period=2025-12'],
      ['现金流量表', '/api/finance/reports/cash-flow?period=2025-12'],
      ['增值税底稿', '/api/finance/tax-declaration?period=2025-12'],
      /* 真实路由：finance-reports.controller 的基路径是 api/finance → /api/finance/ledgers/detail（我前两版分别写成 /ledgers/account/:code 与 /reports/ledgers/detail，都 404） */
      ['账簿明细（1122，含草稿）', '/api/finance/ledgers/detail?accountCode=1122&period=2025-12&includeDraft=true&page=1&pageSize=50'],
      ['应收列表（第 1 页）', '/api/finance/ars?page=1&pageSize=50'],
      ['发票列表（第 1 页）', '/api/finance/invoices?page=1&pageSize=50'],
      ['合同列表（模糊搜索）', '/api/contracts?page=1&pageSize=50&keyword=PERF'],
    ];

    console.log('\n  查询耗时（3 次取中位数）:');
    for (const [label, path] of CASES) {
      try {
        const { ms, status } = await timeGet(path);
        const ok = status === 200;
        console.log(`    ${ok ? '✓' : '✗'} ${String(ms).padStart(6)} ms  ${label}  (HTTP ${status})`);
        results.push({ n: `耗时: ${label}`, pass: ok, d: `${ms} ms HTTP ${status}` });
      } catch (e) {
        console.log(`    ✗  超时/失败  ${label}  ${String(e.message).split('\n')[0]}`);
        results.push({ n: `耗时: ${label}`, pass: false, d: String(e.message).split('\n')[0] });
      }
    }
  } finally {
    if (child) {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${PERF_DB}" WITH (FORCE)`).catch((e) => {
        console.log(`  ⚠️ DROP perf 库失败（需人工清理）：${e.message}`);
      });
      console.log(`\n  已 DROP ${PERF_DB}（源库未受任何影响）`);
    }
    await admin.end({ timeout: 5 }).catch(() => {});
  }

  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    for (const b of bad) console.log(`  - ${b.n}  ${b.d ?? ''}`);
    process.exitCode = 1;
  }
}
void main().catch((e) => { console.error('性能验证失败:', e.message); process.exitCode = 1; });
