#!/usr/bin/env node
/**
 * NFR-P2 压测：报表取数的实际耗时（10 万凭证行）。
 *
 * ## 为什么先测再决定要不要做余额快照
 *
 * `fin_account_balance_snapshot`（月度科目余额快照表）是为 NFR-P2
 * "报表接口 P95 < 3s（10 万凭证行）"建的，但**一直没实现**。
 *
 * 在写物化层之前必须先回答一个问题：**现在的实时聚合到底够不够快？**
 * 物化要引入写入路径与失效逻辑，代价是"报表可能显示过期数据"——
 * 这是财务系统最不能接受的一类缺陷。**如果实时聚合本来就 < 3s，
 * 加快照就是用一类新缺陷换一个不存在的问题。**
 *
 * 本脚本在 pglite 上生成指定规模的数据并测量 A-01/A-03 的实际取数耗时。
 *
 * 用法：
 *   node ./scripts/bench-report-query.mjs              # 默认 10 万行
 *   node ./scripts/bench-report-query.mjs --lines=20000
 *
 * ⚠️ pglite 是单线程 WASM，绝对耗时会明显高于真实 PostgreSQL。
 * 因此结论按"**趋势**"读：随数据量增长是线性还是指数、索引是否生效。
 * 真实库压测需在有代表性的环境上另做（见输出末尾提示）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : def;
};
const TARGET_LINES = arg('lines', 100_000);
const PERIODS = arg('periods', 24);

const { PGlite } = await import('@electric-sql/pglite');
const db = await new PGlite(mkdtempSync(join(tmpdir(), 'bench-')));

/* ---------- 最小表结构（只需覆盖被测量的查询路径） ---------- */

await db.exec(`
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
  CREATE INDEX idx_bench_voucher_period_status ON fin_voucher (period, status);
  CREATE INDEX idx_bench_line_account_voucher ON fin_voucher_line (account_code, voucher_id);

  CREATE TABLE fin_account (
    code varchar(20) PRIMARY KEY,
    name varchar(100),
    account_type varchar(20),
    direction varchar(10),
    is_leaf integer DEFAULT 1,
    status varchar(20) DEFAULT 'active',
    parent_code varchar(20)
  );
`);

/* ---------- 造数 ---------- */
// 100 个科目、每个凭证 2 行 → 行数 / 2 张凭证
const ACCOUNTS = Array.from({ length: 100 }, (_, i) =>
  String(1001 + i).padStart(4, '0')
);
for (const code of ACCOUNTS) {
  await db.query(
    `INSERT INTO fin_account (code, name, account_type, direction) VALUES ($1,$2,'asset','debit')
     ON CONFLICT (code) DO NOTHING`,
    [code, `科目${code}`]
  );
}

const rowsPerVoucher = 2;
const vouchers = Math.ceil(TARGET_LINES / rowsPerVoucher);
console.log(
  `造数中：${vouchers} 张凭证 / ${vouchers * rowsPerVoucher} 行 / ${PERIODS} 个期间…`
);
const t0 = Date.now();
// 分批插入，避免单条 SQL 过大
const BATCH = 2000;
for (let start = 0; start < vouchers; start += BATCH) {
  const end = Math.min(start + BATCH, vouchers);
  const voucherValues = [];
  const lineValues = [];
  for (let i = start; i < end; i += 1) {
    const periodIdx = i % PERIODS;
    const period = `2026-${String((periodIdx % 12) + 1).padStart(2, '0')}`;
    const year = periodIdx < 12 ? 2026 : 2027;
    const p = `${year}-${String((periodIdx % 12) + 1).padStart(2, '0')}`;
    const vid = `11111111-0000-4000-8000-${String(i).padStart(12, '0')}`;
    voucherValues.push(
      `('${vid}','${p}','${p}-05','posted',NULL)`
    );
    lineValues.push(
      `('${vid}','${ACCOUNTS[i % ACCOUNTS.length]}',100,0)`
    );
    lineValues.push(
      `('${vid}','${ACCOUNTS[(i + 1) % ACCOUNTS.length]}',0,100)`
    );
    void period;
  }
  await db.exec(`
    INSERT INTO fin_voucher (id, period, voucher_date, status, tax_entity_id)
    VALUES ${voucherValues.join(',')};
    INSERT INTO fin_voucher_line (voucher_id, account_code, debit, credit)
    VALUES ${lineValues.join(',')};
  `);
}
console.log(`造数完成：${((Date.now() - t0) / 1000).toFixed(1)}s`);

const stat = await db.query(
  `SELECT (SELECT count(*) FROM fin_voucher) AS v, (SELECT count(*) FROM fin_voucher_line) AS l`
);
console.log(
  `实际规模：${stat.rows[0].v} 张凭证 / ${stat.rows[0].l} 行\n`
);

/* ---------- 测量 ---------- */

const bench = async (label, sql, params = [], runs = 3) => {
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const s = Date.now();
    await db.query(sql, params);
    times.push(Date.now() - s);
  }
  const best = Math.min(...times);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log(
    `  ${label.padEnd(38)} 最快 ${String(best).padStart(5)}ms  平均 ${String(avg).padStart(5)}ms`
  );
  return best;
};

// 与 ledgers.service.ts rolledBalances 同形态：
// 期初（period < P）+ 本期发生额（period = P），按科目聚合
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
  FROM opening o FULL OUTER JOIN movement m ON m.account_code = o.account_code
`;

console.log('测量结果（pglite，单线程 WASM，绝对耗时高于真实 PostgreSQL）：');
await bench('科目余额表（全年累计到年末）', ROLLED, ['2027-12']);
await bench('科目余额表（年中单月）', ROLLED, ['2027-06']);
await bench('科目余额表（首月，期初为空）', ROLLED, ['2026-01']);

// 单期间发生额（利润表形态）
await bench(
  '本期发生额按科目聚合（利润表）',
  `SELECT l.account_code, coalesce(sum(l.debit),0) AS d, coalesce(sum(l.credit),0) AS c
   FROM fin_voucher_line l JOIN fin_voucher v ON v.id = l.voucher_id
   WHERE v.status <> 'voided' AND v.period = $1 GROUP BY l.account_code`,
  ['2027-06']
);

// 全表扫描对照（验证索引是否生效）
await bench(
  '对照：全表无过滤聚合',
  `SELECT l.account_code, sum(l.debit), sum(l.credit) FROM fin_voucher_line l GROUP BY l.account_code`
);

console.log(`
判读要点：
  · 若"年中单月"明显快于"全年累计到年末"，说明 period 索引生效（期初范围小）；
  · 若各月耗时接近且都随数据量线性增长，说明期初聚合是主要成本 → 快照有价值；
  · NFR-P2 目标为 P95 < 3s（真实 PostgreSQL、10 万凭证行）。
    本脚本只给趋势；**是否落快照应以真实环境压测为准**，
    不宜仅凭 pglite 绝对耗时决定（WASM 慢一个数量级）。
`);

await db.close();
