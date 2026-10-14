#!/usr/bin/env node
/**
 * NFR-P2 真实 PostgreSQL 压测：在**隔离 schema** 中造 10 万凭证行，
 * 测量报表取数耗时并确认**索引真的被用上**。
 *
 * ## 为什么需要这个脚本（pglite 版不够）
 *
 * `bench-report-query.mjs` 用 pglite 测，好处是零依赖；但有两个局限：
 *   1. pglite 是单线程 WASM，绝对耗时高于真实 PostgreSQL（只给趋势）；
 *   2. **查询计划可能不同** —— 真实 PG 在小表上会选 Seq Scan，
 *      而"索引是否生效"恰恰是 NFR-P2 的关键（需求书写的是"需补索引"）。
 *
 * 所以这里在真实库上复测，并强制读取 `EXPLAIN (ANALYZE)` 的计划。
 *
 * ## 安全性：全程用独立 schema，结束即 DROP
 *
 * 在专用 schema（默认 `bench_nfrp2`）里建同名表，**不触碰 public 下任何数据**。
 * 脚本结束时 `DROP SCHEMA ... CASCADE`。即使中途失败，
 * 也不会影响既有表（这是选择独立 schema 而不是临时改 public 表的原因）。
 *
 * ## 用法
 *
 *   node ./scripts/bench-report-query-pg.mjs --lines=100000
 *   DB_URL=postgresql://... node ./scripts/bench-report-query-pg.mjs
 */

import { readFileSync } from 'node:fs';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : def;
};
const TARGET_LINES = arg('lines', 100_000);
const PERIODS = arg('periods', 24);
const SCHEMA = process.env.BENCH_SCHEMA ?? 'bench_nfrp2';

const url =
  process.env.DB_URL ??
  process.env.DATABASE_URL ??
  // 与仓库其余脚本一致：本地开发库
  (() => {
    try {
      const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
      const m = env.match(/^DATABASE_URL=(.+)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch {
      /* 忽略：回落到默认值 */
    }
    return 'postgresql://erp:******@127.0.0.1:5433/shengseerp';
  })();

const postgres = (await import('postgres')).default;
const sql = postgres(url, { max: 1, onnotice: () => {} });

console.log(`目标库：${url.replace(/:[^:@/]+@/, ':***@')}`);
console.log(`隔离 schema：${SCHEMA}（结束即 DROP，不影响 public）\n`);

let created = false;
try {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
  created = true;
  await sql.unsafe(`SET search_path TO ${SCHEMA}`);

  /* ---------- 表结构：与 public 一致的关键列 + 索引 ---------- */
  await sql.unsafe(`
    CREATE TABLE fin_voucher (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      period varchar(7),
      voucher_date date,
      status varchar(20) DEFAULT 'draft',
      tax_entity_id uuid
    );
    CREATE TABLE fin_voucher_line (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      voucher_id uuid,
      account_code varchar(20),
      debit numeric DEFAULT 0,
      credit numeric DEFAULT 0
    );
    -- 与 public 中已有索引同名同定义（需求书 NFR-P2 要求的那两个）
    CREATE INDEX idx_fin_voucher_period_status ON fin_voucher (period, status);
    CREATE INDEX idx_fin_voucher_line_account_voucher ON fin_voucher_line (account_code, voucher_id);
    CREATE INDEX idx_bench_line_voucher ON fin_voucher_line (voucher_id);
    CREATE TABLE fin_account (
      code varchar(20) PRIMARY KEY,
      name varchar(100)
    );
  `);

  /* ---------- 造数 ---------- */
  const ACCOUNTS = Array.from({ length: 100 }, (_, i) =>
    String(1001 + i).padStart(4, '0')
  );
  await sql.unsafe(`
    INSERT INTO fin_account (code, name)
    SELECT c, '科目' || c FROM unnest(ARRAY[${ACCOUNTS.map((a) => `'${a}'`).join(',')}]) AS c
  `);

  const vouchers = Math.ceil(TARGET_LINES / 2);
  console.log(`造数中：${vouchers} 张凭证 / ${vouchers * 2} 行 / ${PERIODS} 个期间…`);
  const t0 = Date.now();
  // 用 generate_series 一次性生成，比逐批 INSERT 快得多
  await sql.unsafe(`
    INSERT INTO fin_voucher (id, period, voucher_date, status)
    SELECT gen_random_uuid(),
           to_char(date '2026-01-01' + (i % ${PERIODS}) * interval '1 month', 'YYYY-MM'),
           (date '2026-01-05' + (i % ${PERIODS}) * interval '1 month')::date,
           'posted'
    FROM generate_series(0, ${vouchers - 1}) AS i;
  `);
  await sql.unsafe(`
    WITH v AS (SELECT id, row_number() OVER () - 1 AS i FROM fin_voucher)
    INSERT INTO fin_voucher_line (voucher_id, account_code, debit, credit)
    SELECT id, (ARRAY[${ACCOUNTS.map((a) => `'${a}'`).join(',')}])[(i % 100) + 1], 100, 0 FROM v
    UNION ALL
    SELECT id, (ARRAY[${ACCOUNTS.map((a) => `'${a}'`).join(',')}])[((i + 1) % 100) + 1], 0, 100 FROM v;
  `);
  console.log(`造数完成：${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ⚠️ 关键：真实 PG 的代价估算依赖统计信息。不 ANALYZE 就会一直选 Seq Scan，
  // 测出来的不是"索引没用"，而是"没有统计信息所以规划器不知道能用索引"。
  await sql.unsafe(`ANALYZE fin_voucher; ANALYZE fin_voucher_line;`);

  const stat = await sql.unsafe(
    `SELECT (SELECT count(*) FROM fin_voucher) AS v, (SELECT count(*) FROM fin_voucher_line) AS l`
  );
  console.log(`实际规模：${stat[0].v} 张凭证 / ${stat[0].l} 行\n`);

  /* ---------- 测量 ---------- */
  const ROLLED = `
    WITH opening AS (
      SELECT l.account_code, coalesce(sum(l.debit),0) AS d, coalesce(sum(l.credit),0) AS c
      FROM fin_voucher_line l JOIN fin_voucher v ON v.id = l.voucher_id
      WHERE v.status <> 'voided' AND v.period < $1
      GROUP BY l.account_code
    ), movement AS (
      SELECT l.account_code, coalesce(sum(l.debit),0) AS d, coalesce(sum(l.credit),0) AS c
      FROM fin_voucher_line l JOIN fin_voucher v ON v.id = l.voucher_id
      WHERE v.status <> 'voided' AND v.period = $1
      GROUP BY l.account_code
    )
    SELECT coalesce(o.account_code, m.account_code) AS account_code,
           coalesce(o.d,0) + coalesce(m.d,0) AS total_debit,
           coalesce(o.c,0) + coalesce(m.c,0) AS total_credit
    FROM opening o FULL OUTER JOIN movement m ON m.account_code = o.account_code`;

  const bench = async (label, text, params = [], runs = 20) => {
    // 先跑一次预热（填充 shared buffers / 编译计划），不计入统计
    await sql.unsafe(text, params);
    const times = [];
    for (let i = 0; i < runs; i += 1) {
      const s = performance.now();
      await sql.unsafe(text, params);
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    const at = (q) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * q))]);
    console.log(
      `  ${label.padEnd(32)} P50 ${String(at(0.5)).padStart(4)}ms  ` +
        `P95 ${String(at(0.95)).padStart(4)}ms  最快 ${String(Math.round(times[0])).padStart(4)}ms`
    );
    return at(0.95);
  };

  const lastPeriod = `2027-${String(PERIODS % 12 === 0 ? 12 : PERIODS % 12).padStart(2, '0')}`;
  console.log(`真实 PostgreSQL 测量结果（预热后 ${20} 次采样）：`);
  await bench('科目余额表（全年累计到年末）', ROLLED, [lastPeriod]);
  await bench('科目余额表（年中单月）', ROLLED, ['2027-06']);
  await bench(
    '本期发生额按科目聚合（利润表）',
    `SELECT l.account_code, coalesce(sum(l.debit),0) AS d, coalesce(sum(l.credit),0) AS c
     FROM fin_voucher_line l JOIN fin_voucher v ON v.id = l.voucher_id
     WHERE v.status <> 'voided' AND v.period = $1 GROUP BY l.account_code`,
    ['2027-06']
  );

  /* ---------- 计划核对：索引是否真的被用上 ---------- */
  console.log('\n=== 执行计划（本期发生额聚合）===');
  const plan = await sql.unsafe(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT l.account_code, coalesce(sum(l.debit),0) AS d
    FROM fin_voucher_line l JOIN fin_voucher v ON v.id = l.voucher_id
    WHERE v.status <> 'voided' AND v.period = '2027-06'
    GROUP BY l.account_code`);
  for (const row of plan) console.log('  ' + row['QUERY PLAN']);
  const planText = plan.map((r) => r['QUERY PLAN']).join('\n');
  console.log(
    /\bIndex (Only )?Scan|Bitmap Index Scan\b/.test(planText)
      ? '\n✅ 计划中出现 Index Scan / Bitmap Index Scan —— 索引生效'
      : '\n⚠️ 计划中未见索引扫描（可能因选择率不高而全表扫描更优；数据量再大时会转变）'
  );
} finally {
  if (created) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    console.log(`\n已清理隔离 schema ${SCHEMA}`);
  }
  await sql.end();
}
