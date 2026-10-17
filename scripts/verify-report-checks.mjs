/**
 * 报表自查项的**自洽性**与**顶层合计 vs 行数据**的一致性复验。
 *
 * ## 验什么（两条，都是"界面上会自相矛盾"的类型）
 *
 * ① **`passed` 必须与 `difference` 同源**：
 *    报表接口每条 `checks[]` 都同时给出"差异"与"结论"，两者若矛盾，
 *    使用者会看到「差异 ¥0.00 · 不通过」（以为系统坏了），
 *    或更糟的「差异 ¥1234 · 通过」（**把真实的不平当成平**）。
 *
 * ② **顶层合计必须等于对应行的金额**：
 *    `balance_sheet` 响应里额外给了 `assetsTotal / liabilitiesTotal / equityTotal`，
 *    界面直接拿它们做顶栏展示。若它们与 `rows` 里的第 10/17/21 行不一致，
 *    同一页会出现"顶栏 ¥X、表格第 10 行 ¥Y"两个资产总计。
 *
 * 用法：npx tsx scripts/verify-report-checks.mjs
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const API = process.env.WT_API ?? 'http://127.0.0.1:3000';

function envOf(key) {
  const line = readFileSync('.env', 'utf8').split(/\r?\n/u).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

const results = [];
const rec = (n, pass, d) => {
  results.push({ n, pass, d });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
};

/** 金额判等：2 位小数口径 */
const same = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: envOf('BOOTSTRAP_ADMIN_USERNAME'),
      password: envOf('BOOTSTRAP_ADMIN_PASSWORD'),
    }),
  });
  if (login.status !== 201) throw new Error(`登录失败 ${login.status}`);
  const jar = login.headers.getSetCookie?.() ?? [];
  const session = jar.map((c) => c.split(';')[0]).find((c => c.startsWith('erp_session='))).slice(12);
  const get = async (path) => {
    const r = await fetch(`${API}${path}`, { headers: { cookie: `erp_session=${session}` } });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch { /* 非 JSON */ }
    return { status: r.status, j, t };
  };

  /* 期间取自库内实际有凭证的期间，避免拿空期间做"平凡通过" */
  const sql = postgres({
    host: '127.0.0.1', port: 5433, user: 'erp', password: process.env.DB_PASSWORD ?? '',
    database: 'shengseerp', connect_timeout: 5,
  });
  const periods = (await sql`SELECT DISTINCT period FROM fin_voucher ORDER BY period DESC LIMIT 3`)
    .map((r) => r.period);
  await sql.end({ timeout: 2 }).catch(() => {});
  if (periods.length === 0) {
    rec('取有凭证的期间', false, '库里没有凭证，无法验证（不要用空期间做平凡通过）');
    return;
  }
  console.log(`  取库内实际有凭证的期间：${periods.join(' / ')}\n`);

  let totalChecks = 0;
  let contradictions = 0;
  let totalMismatch = 0;

  for (const period of periods) {
    for (const code of ['balance_sheet', 'income_statement', 'cash_flow']) {
      const r = await get(`/api/finance/reports/${code}?period=${period}`);
      if (r.status !== 200) {
        rec(`${period} ${code} 可读取`, false, `HTTP ${r.status} ${r.t.slice(0, 60)}`);
        continue;
      }
      const checks = r.j.checks ?? [];
      const rows = r.j.rows ?? [];
      totalChecks += checks.length;

      /* ① passed 与 difference 同源 */
      for (const c of checks) {
        const differenceZero = Math.abs(Number(c.difference ?? 0)) < 1e-9;
        if (differenceZero !== Boolean(c.passed)) {
          contradictions += 1;
          console.log(`      ✗ ${c.code}: difference=${c.difference} passed=${c.passed}`);
        }
      }

      /* ② 顶层合计 vs 行数据 */
      const pick = (no) => Number(rows.find((x) => String(x.rowNo) === String(no))?.amount ?? 0);
      if (code === 'balance_sheet') {
        const pairs = [
          ['assetsTotal', r.j.assetsTotal, pick('10')],
          ['liabilitiesTotal', r.j.liabilitiesTotal, pick('17')],
          ['equityTotal', r.j.equityTotal, pick('21')],
        ];
        for (const [name, top, rowVal] of pairs) {
          if (!same(top, rowVal)) {
            totalMismatch += 1;
            console.log(`      ✗ ${period} ${name}: 顶层=${top} 行数据=${rowVal}`);
          }
        }
      }
    }
  }

  rec(
    `① 全部自查项的 passed 与 difference 自洽（${totalChecks} 项）`,
    contradictions === 0,
    `矛盾 ${contradictions} 项`,
  );
  rec(
    '② 资产负债表顶层合计等于对应行金额（资产/负债/权益）',
    totalMismatch === 0,
    `不一致 ${totalMismatch} 处`,
  );

  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    for (const b of bad) console.log(`  - ${b.n}  ${b.d ?? ''}`);
    process.exitCode = 1;
  }
}
void main().catch((e) => { console.error('复核失败:', e.message); process.exitCode = 1; });
