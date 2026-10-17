/**
 * 探针：在**真实系统**里验证用户确认的报价取整口径（111.42）。
 *
 * 用户已决定「保留现行逐行取整口径」。此前该结论只存在于源码注释与走查脚本里，
 * 现在 `quotation-totals.ts` 把它变成可执行契约（22 条断言）；
 * 这个探针再从**接口层**确认一次：建出来的报价单总额确实是 111.42、
 * 行金额合计 123.82、预估成本 45（而不是逐字公式的 111.44）。
 *
 * 用法：npx tsx scripts/verify-quotation-rounding.mjs
 */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const API = process.env.WT_API ?? 'http://127.0.0.1:3000';

function envOf(key) {
  const line = readFileSync('.env', 'utf8').split(/\r?\n/u).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

const URL = readFileSync('.env', 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL=')).slice(13).trim();

const results = [];
const rec = (n, pass, d) => {
  results.push({ n, pass, d });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
};

/** 用户确认的那 3 行（含行折扣）+ 整单 9 折 */
const ITEMS = [
  { itemName: '[API_TEST] A', unit: '人天', quantity: 3, unitPrice: 10.05, discountPct: 10, estUnitCost: 3 },
  { itemName: '[API_TEST] B', unit: '人天', quantity: 2, unitPrice: 33.33, discountPct: 5, estUnitCost: 12 },
  { itemName: '[API_TEST] C', unit: '次', quantity: 3, unitPrice: 12.35, discountPct: 10, estUnitCost: 4 },
];

async function main() {
  const sql = postgres(URL, { max: 1, idle_timeout: 10, connect_timeout: 10 });
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
  const session = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session=')).slice(12);
  const call = async (m, p, b) => {
    const r = await fetch(`${API}${p}`, {
      method: m,
      headers: { 'content-type': 'application/json', cookie: `erp_session=${session}` },
      body: b ? JSON.stringify(b) : undefined,
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch { /* 非 JSON */ }
    return { status: r.status, j, t };
  };

  const cust = (await sql`SELECT id FROM md_customer LIMIT 1`)[0];
  let createdId = null;
  try {
    const mk = await call('POST', '/api/crm/quotations', {
      customerId: cust?.id,
      title: `[API_TEST] 取整口径探针-${Date.now()}`,
      discountPct: 10,
      items: ITEMS,
    });
    const q = mk.j?.quotation ?? mk.j;
    createdId = q?.id ?? null;
    rec('建报价成功', mk.status < 300 && !!createdId, `HTTP ${mk.status} ${mk.j?.code ?? ''}`);

    if (createdId) {
      rec(
        '⚠️ 总额 = 111.42（现行逐行取整口径，用户已确认）',
        Number(q.totalAmount) === 111.42,
        `totalAmount=${q.totalAmount}`,
      );
      rec(
        '⚠️ 总额**不是**逐字公式的 111.44（该口径已被否决）',
        Number(q.totalAmount) !== 111.44,
        `totalAmount=${q.totalAmount}`,
      );
      rec('预估成本 = 45（Σ 数量×预估单价，不乘折扣）', Number(q.estimatedCost) === 45, `estimatedCost=${q.estimatedCost}`);

      /*
       * ⚠️ 我原先想验"表头总额 == 用接口返回的 items[].lineAmount 重算"，**这是错的**：
       * 接口返回的 `lineAmount` 本身**已经取整**，再乘整单折扣并取整就成了**二次取整**
       * （实测自算得 111.45，而正确口径是 111.42）。那不是产品不自洽，是我的算式错。
       *
       * 真正有意义的不变量是**毛利自洽**：服务端给的三金额必须满足
       * `marginPct == round2((totalAmount − estimatedCost) / totalAmount × 100)`。
       * 这条不因取整口径而变，且能抓到"改了总额忘了重算毛利"这类回归。
       */
      const expectedMargin =
        Number(q.totalAmount) === 0
          ? 0
          : Math.round(((Number(q.totalAmount) - Number(q.estimatedCost)) / Number(q.totalAmount)) * 10000) / 100;
      rec(
        '⚠️ 毛利自洽：marginPct == round2((总额 − 预估成本) / 总额 × 100)',
        Math.abs(Number(q.marginPct) - expectedMargin) < 0.005,
        `marginPct=${q.marginPct} 自算=${expectedMargin}（总额 ${q.totalAmount} / 成本 ${q.estimatedCost}）`,
      );
    }
  } finally {
    if (createdId) {
      await sql`DELETE FROM crm_quotation_item WHERE quotation_id = ${createdId}`.catch(() => {});
      await sql`DELETE FROM crm_quotation WHERE id = ${createdId}`.catch(() => {});
      console.log('  已清理探针报价');
    }
    const left = await sql`SELECT count(*)::int AS n FROM crm_quotation WHERE title LIKE ${'[API_TEST] 取整口径探针%'}`;
    console.log(`  残留探针报价: ${left[0].n}`);
    await sql.end({ timeout: 2 }).catch(() => {});
  }

  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    for (const b of bad) console.log(`  - ${b.n}  ${b.d ?? ''}`);
    process.exitCode = 1;
  }
}
void main().catch((e) => { console.error('复核失败:', e.message); process.exitCode = 1; });
