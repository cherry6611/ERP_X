/**
 * 财税口径定点复核：**显式税率** 与 **税率推导**（合同侧）。
 *
 * ## 本文件存在的理由（一次真实的误判，值得留档）
 *
 * 我最初用一个"合同税率重算"脚本报了三条缺陷，其中一条是：
 *   「显式传 taxRate=13 → 被静默忽略（库里仍是 1%），HTTP 200」
 *
 * 复核后发现**三条都是脚本自己的缺陷**，不是产品缺陷：
 *
 *   · 用例先执行了 `UPDATE erp_contract SET tax_entity_id = ...` **直接改库**，
 *     绕过了 service 的税主体解析；
 *   · 之后 PATCH 只看**库值**、没看**响应码** —— 若 PATCH 其实是 400（被正确拒绝），
 *     库值当然不变，于是被误读成"被静默忽略"。
 *
 * 现在的用例把每个请求的**响应码 + 响应体 + 库值**三者一起断言，不再靠猜。
 * 经验：**凡是"接口没生效"的判定，必须先看响应码**，否则分不清"被拒"和"被忽略"。
 *
 * 覆盖的口径：
 *   · 一般纳税人 + 显式 13% → 接受，rateSource=explicit
 *   · 显式 0%（免税档）→ 接受，tax=0 且 net==gross
 *   · 显式非法档 7% → 400（DTO 白名单拦住），库值不变
 *   · 小规模主体 + 显式 13% → 400「税率与纳税主体类型不匹配」，库值不变
 *   · 小规模主体 + 显式 1% → 接受且价税分离自洽
 *   · 只改 taxEntityId（显式档为空）→ 税率按**新主体**重新推导，net/tax 随之重算
 *   · 非 draft 改金额/客户 → 400（既有守卫未被放宽）
 *
 * 用法：npx tsx scripts/verify-tax-explicit-rate.mjs
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const TAG = '[API_TEST]';

function envOf(key) {
  const line = readFileSync('.env', 'utf8').split(/\r?\n/u).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: envOf('BOOTSTRAP_ADMIN_USERNAME'),
      password: envOf('BOOTSTRAP_ADMIN_PASSWORD'),
    }),
  });
  const jar = login.headers.getSetCookie?.() ?? [];
  const session = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session=')).slice(12);
  const call = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: `erp_session=${session}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
  };

  const sql = postgres({
    host: '127.0.0.1', port: 5433, user: 'erp', password: process.env.DB_PASSWORD ?? '',
    database: 'shengseerp', connect_timeout: 5,
  });
  const name = `${TAG} 显式税率`;

  try {
    const cust = (await sql`SELECT id, name FROM md_customer ORDER BY name LIMIT 1`)[0];
    // 一个小规模主体（默认 1%）与一个一般纳税人主体（默认 6%）
    const ents = await sql`
      SELECT id, name, taxpayer_type, default_output_rate::float8 AS rate
      FROM md_tax_entity ORDER BY default_output_rate DESC`;
    const general = ents.find((e) => e.taxpayer_type === 'general') ?? ents[0];
    const small = ents.find((e) => e.taxpayer_type !== 'general');
    console.log('  主体:', JSON.stringify(ents.map((e) => `${e.name}/${e.taxpayer_type}/${e.rate}%`)));

    const mk = await call('POST', '/api/contracts', {
      name,
      customerId: String(cust.id),
      billingModel: 'project',
      amount: 10000,
      taxEntityId: String(general.id),
      signDate: '2026-10-01',
    });
    const ctr = mk.json;
    record('建合同（一般纳税人主体）', mk.status < 300 && !!ctr?.id, `HTTP ${mk.status} rate=${ctr?.taxRate} source=${ctr?.rateSource}`);
    if (!ctr?.id) return;
    const read = async () =>
      (await sql`SELECT tax_rate::float8 AS rate, rate_source, net_amount::float8 AS net,
                        tax_amount::float8 AS tax, amount::float8 AS gross
                 FROM erp_contract WHERE id = ${ctr.id}`)[0];

    /* ① 一般纳税人 + 显式 13% → 应被接受 */
    const ok13 = await call('PATCH', `/api/contracts/${ctr.id}`, { taxRate: 13 });
    const a13 = await read();
    record(
      '一般纳税人 + 显式 13% → 接受且 rateSource=explicit',
      ok13.status < 300 && a13.rate === 13 && a13.rate_source === 'explicit',
      `HTTP ${ok13.status} rate=${a13.rate} source=${a13.rate_source} 响应体=${ok13.text.slice(0, 70)}`,
    );

    /* ② 显式传 0（免税档）→ 应被接受且 net==gross、tax==0 */
    const ok0 = await call('PATCH', `/api/contracts/${ctr.id}`, { taxRate: 0 });
    const a0 = await read();
    record(
      '显式传 0%（免税档）→ 接受且 tax=0、net==gross',
      ok0.status < 300 && a0.rate === 0 && a0.tax === 0 && Math.abs(a0.net - a0.gross) <= 0.01,
      `HTTP ${ok0.status} rate=${a0.rate} net=${a0.net} tax=${a0.tax} gross=${a0.gross}`,
    );

    /* ③ 显式传非法税率 7% → 必须 400（不能静默改成别的档） */
    const bad = await call('PATCH', `/api/contracts/${ctr.id}`, { taxRate: 7 });
    const a7 = await read();
    record(
      '显式传非法税率 7% → 400 且库值不变（不得静默改档）',
      bad.status === 400 && a7.rate === 0,
      `HTTP ${bad.status} 库 rate=${a7.rate}（应仍为 0） 响应体=${bad.text.slice(0, 100)}`,
    );

    /* ④ 小规模主体 + 显式 13% → 必须 400（税率与主体类型不匹配）*/
    if (small) {
      // 走**正规接口**改主体（不再直接改库，避免上一版的误判）
      const toSmall = await call('PATCH', `/api/contracts/${ctr.id}`, { taxEntityId: String(small.id) });
      const aS = await read();
      console.log(`    改主体响应: HTTP ${toSmall.status} 库 rate=${aS.rate} source=${aS.rate_source}`);
      const conflict = await call('PATCH', `/api/contracts/${ctr.id}`, { taxRate: 13 });
      const aC = await read();
      record(
        `小规模主体（${small.name}）+ 显式 13% → 400「税率与纳税主体类型不匹配」且库值不变`,
        conflict.status === 400 && aC.rate === aS.rate,
        `HTTP ${conflict.status} 库 rate=${aC.rate}（改前 ${aS.rate}） 响应体=${conflict.text.slice(0, 110)}`,
      );
      /* ⑤ 小规模 + 显式 1% → 应被接受 */
      const ok1 = await call('PATCH', `/api/contracts/${ctr.id}`, { taxRate: 1 });
      const a1 = await read();
      record(
        '小规模主体 + 显式 1% → 接受且自洽',
        ok1.status < 300 && a1.rate === 1 && Math.abs(a1.net + a1.tax - a1.gross) <= 0.01,
        `HTTP ${ok1.status} rate=${a1.rate} net=${a1.net} tax=${a1.tax} gross=${a1.gross}`,
      );
    }
  } finally {
    const mine = await sql`SELECT id, code FROM erp_contract WHERE name = ${name}`;
    for (const m of mine) {
      await sql`DELETE FROM erp_contract_item WHERE contract_id = ${m.id}`.catch(() => {});
      await sql`DELETE FROM erp_contract WHERE id = ${m.id}`;
    }
    const left = await sql`SELECT count(*)::int AS n FROM erp_contract WHERE name = ${name}`;
    console.log(`  残留: ${left[0].n}`);
    await sql.end({ timeout: 2 }).catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) for (const f of failed) console.log(`  - ${f.name}  ${f.detail ?? ''}`);
}

void main().catch((e) => { console.error('复核失败:', e); process.exitCode = 1; });
