/**
 * 定点复验：应付「核销 → 冲回」的**状态重算**在抽出 `./writeoff-status` 后行为一致。
 *
 * ## 为什么值得单独跑一遍真实链路
 *
 * 抽出的那 4 个纯函数有 13 条断言，但它们验的是"给定入参 → 给定状态"。
 * 真实链路还多三件事，纯函数测不到：
 *   ① 核销/冲回时 `paidAmount` 的**增量 SQL**（`coalesce(...) + x`、`greatest(0, ... - x)`）；
 *   ② 条件更新的**并发收口**（`WHERE paid + x <= amount`，不满足就不返回行）；
 *   ③ 「作废单不可核销」守卫真的在**路径上**生效（不是只在纯函数里成立）。
 *
 * 本脚本用一个 `[API_TEST]` 前缀的临时应付跑完整条链路，结束按精确主键清理。
 *
 * 用法：npx tsx scripts/verify-ap-writeoff.mjs
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const API = process.env.WT_API ?? 'http://127.0.0.1:3000';
const TAG = '[API_TEST]';

function envOf(key) {
  const line = readFileSync('.env', 'utf8').split(/\r?\n/u).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

const results = [];
const rec = (n, pass, d) => {
  results.push({ n, pass, d });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
};

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
  const made = { apId: null, paymentId: null };

  try {
    const sup = (await sql`SELECT id, name FROM md_supplier ORDER BY name LIMIT 1`)[0];
    if (!sup) { rec('准备供应商', false, '库里没有供应商'); return; }

    const AMOUNT = 1000;
    /* ① 建应付 */
    const ap = await call('POST', '/api/finance/aps', {
      supplierId: String(sup.id),
      amount: AMOUNT,
      dueDate: '2026-11-30',
      remark: `${TAG} 核销状态复验`,
    });
    made.apId = ap.json?.id ?? null;
    rec('建应付（1000）', !!made.apId && ap.status < 300, `HTTP ${ap.status} ${ap.text.slice(0, 80)}`);
    if (!made.apId) return;

    /* ② 建付款（全额）并审批 */
    const pay = await call('POST', '/api/finance/payments', {
      apId: made.apId, amount: AMOUNT, payDate: '2026-10-20', method: 'bank', remark: TAG,
    });
    made.paymentId = pay.json?.id ?? null;
    rec('建付款（1000）', !!made.paymentId, `HTTP ${pay.status} ${pay.text.slice(0, 80)}`);
    if (!made.paymentId) return;
    const appr = await call('POST', `/api/finance/payments/${made.paymentId}/approve`, { action: 'approve' });
    rec('审批付款', appr.status < 300, `HTTP ${appr.status}`);

    /* ③ 部分核销 400 → 应付应为 partial */
    const w1 = await call('POST', '/api/finance/ap-writeoffs', {
      apId: made.apId, paymentId: made.paymentId, amount: 400,
    });
    let row = (await sql`SELECT status, paid_amount::float8 AS paid FROM erp_ap_bill WHERE id = ${made.apId}`)[0];
    rec(
      '部分核销 400 → 应付状态 partial、paidAmount=400',
      w1.status < 300 && row.status === 'partial' && Math.abs(row.paid - 400) < 0.001,
      `HTTP ${w1.status} status=${row.status} paid=${row.paid}`,
    );

    /* ④ 再核销 600 → 应付应为 paid，付款单应为 paid */
    const w2 = await call('POST', '/api/finance/ap-writeoffs', {
      apId: made.apId, paymentId: made.paymentId, amount: 600,
    });
    row = (await sql`SELECT status, paid_amount::float8 AS paid FROM erp_ap_bill WHERE id = ${made.apId}`)[0];
    const payRow = (await sql`SELECT status, used_amount::float8 AS used FROM erp_payment WHERE id = ${made.paymentId}`)[0];
    rec(
      '补核销 600 → 应付 paid、付款单 paid（无容差判满）',
      w2.status < 300 && row.status === 'paid' && Math.abs(row.paid - 1000) < 0.001 && payRow.status === 'paid',
      `HTTP ${w2.status} ap=${row.status}/${row.paid} payment=${payRow.status}/${payRow.used}`,
    );

    /* ⑤ 超额核销必须被条件更新拦下（应付额度已用满） */
    const over = await call('POST', '/api/finance/ap-writeoffs', {
      apId: made.apId, paymentId: made.paymentId, amount: 1,
    });
    rec('超额核销被拒（400）', over.status === 400, `HTTP ${over.status} ${(over.json?.error?.message ?? '').slice(0, 40)}`);

    /* ⑥ 冲回第一笔 400 → 应付应回到 partial（600/1000） */
    const wo1 = (await sql`
      SELECT id FROM erp_ap_writeoff WHERE ap_id = ${made.apId} ORDER BY _created_at ASC LIMIT 1`)[0];
    if (wo1) {
      const rev = await call('POST', `/api/finance/ap-writeoffs/${wo1.id}/reverse`, { remark: TAG });
      row = (await sql`SELECT status, paid_amount::float8 AS paid FROM erp_ap_bill WHERE id = ${made.apId}`)[0];
      rec(
        '冲回 400 → 应付回到 partial、paidAmount=600',
        rev.status < 300 && row.status === 'partial' && Math.abs(row.paid - 600) < 0.001,
        `HTTP ${rev.status} status=${row.status} paid=${row.paid}`,
      );
    } else {
      rec('找到可冲回的核销记录', false, '未找到');
    }

    /* ⑦ 仍有已核销金额时作废**必须被拒**（守卫顺序：先看 paidAmount=600） */
    const voidBlocked = await call('POST', `/api/finance/aps/${made.apId}/void`, { reason: TAG });
    row = (await sql`SELECT status, paid_amount::float8 AS paid FROM erp_ap_bill WHERE id = ${made.apId}`)[0];
    rec(
      '仍有已核销金额时作废被拒（400，提示先冲销核销记录）',
      voidBlocked.status === 400 && row.status !== 'voided' && Math.abs(row.paid - 600) < 0.001,
      `HTTP ${voidBlocked.status} status=${row.status} paid=${row.paid}`,
    );

    /* ⑧ 把剩下的 600 也冲回 → 应付回到 pending、paidAmount=0（≤0.001 归零容差） */
    const wo2 = (await sql`
      SELECT id FROM erp_ap_writeoff
      WHERE ap_id = ${made.apId} AND reversal_of IS NULL
      ORDER BY _created_at DESC LIMIT 1`)[0];
    if (wo2) {
      const rev2 = await call('POST', `/api/finance/ap-writeoffs/${wo2.id}/reverse`, { remark: TAG });
      row = (await sql`SELECT status, paid_amount::float8 AS paid FROM erp_ap_bill WHERE id = ${made.apId}`)[0];
      rec(
        '全部冲回后应付回到 pending、paidAmount=0',
        rev2.status < 300 && row.status === 'pending' && Math.abs(row.paid) < 0.001,
        `HTTP ${rev2.status} status=${row.status} paid=${row.paid}`,
      );
    } else {
      rec('找到第二笔可冲回的核销', false, '未找到');
    }

    /* ⑨ 先作废付款单，再作废应付 → 这次应成功 */
    const payVoid = await call('POST', `/api/finance/payments/${made.paymentId}/void`, {});
    rec('作废付款单', payVoid.status < 300, `HTTP ${payVoid.status}`);
    const voided = await call('POST', `/api/finance/aps/${made.apId}/void`, { reason: TAG });
    row = (await sql`SELECT status FROM erp_ap_bill WHERE id = ${made.apId}`)[0];
    rec('作废应付 → voided', voided.status < 300 && row.status === 'voided', `HTTP ${voided.status} status=${row.status}`);

    /* ⑩ 对已作废单据再核销 → 守卫必须拦下，状态不得被「复活」 */
    const afterVoid = await call('POST', '/api/finance/ap-writeoffs', {
      apId: made.apId, paymentId: made.paymentId, amount: 100,
    });
    row = (await sql`SELECT status, paid_amount::float8 AS paid FROM erp_ap_bill WHERE id = ${made.apId}`)[0];
    rec(
      '作废后核销被拦下、状态仍 voided 且 paidAmount 未增（不得被"复活"）',
      afterVoid.status === 400 && row.status === 'voided' && Math.abs(row.paid) < 0.001,
      `HTTP ${afterVoid.status} status=${row.status} paid=${row.paid}`,
    );
  } finally {
    /* 按精确主键清理：核销 → 付款 → 应付 */
    try {
      if (made.apId) {
        const wos = await sql`SELECT id FROM erp_ap_writeoff WHERE ap_id = ${made.apId}`;
        const pays = await sql`SELECT id FROM erp_payment WHERE ap_id = ${made.apId}`;
        console.log(`  待删: 核销 ${wos.length} 条 / 付款 ${pays.length} 条 / 应付 1 条`);
        for (const w of wos) await sql`DELETE FROM erp_ap_writeoff_reversal WHERE writeoff_id = ${w.id}`.catch(() => {});
        await sql`DELETE FROM erp_ap_writeoff WHERE ap_id = ${made.apId}`.catch(() => {});
        await sql`DELETE FROM erp_payment WHERE ap_id = ${made.apId}`.catch(() => {});
        await sql`DELETE FROM erp_ap_bill WHERE id = ${made.apId}`;
      }
    } catch (e) { console.log('  清理出错:', e.message); }
    const left = await sql`SELECT
      (SELECT count(*)::int FROM erp_ap_bill WHERE remark LIKE ${`%${TAG}%`}) AS ap,
      (SELECT count(*)::int FROM erp_ap_writeoff w JOIN erp_ap_bill b ON b.id = w.ap_id WHERE b.remark LIKE ${`%${TAG}%`}) AS wo`;
    console.log(`  残留: 应付=${left[0].ap} 核销=${left[0].wo}`);
    await sql.end({ timeout: 2 }).catch(() => {});
  }

  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) { for (const b of bad) console.log(`  - ${b.n}  ${b.d ?? ''}`); process.exitCode = 1; }
}
void main().catch((e) => { console.error('复核失败:', e.message); process.exitCode = 1; });
