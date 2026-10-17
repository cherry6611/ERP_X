/**
 * 独立端到端复核 **PUR-1 修复**：设备类采购订单**分批验收**不得被唯一索引挡回。
 *
 * ## 背景（这是本轮最有价值的一个真缺陷）
 *
 * `ast_asset.purchase_order_id` 上有部分唯一索引 `uq_ast_asset_purchase_order`
 * （语义：一张采购订单只能对应一张卡片）。原 `acceptOrder` **每次验收都无条件
 * `INSERT ast_asset`**，于是设备类订单：
 *   · 第 1 次验收（1/3 件）→ 建卡成功；
 *   · 第 2 次验收 → 撞唯一索引 → 409「该采购订单已生成固定资产卡片…」；
 *   · 订单卡在 `pending`，**剩余数量永远收不完**，剩余应付与进项凭证也永远生不成。
 *
 * 修法：新增纯函数 `accumulateCapitalizedValue`（有卡则累计原值/净值，无卡则建卡），
 * `acceptOrder` 在**同一 `FOR UPDATE` 事务内**先查后写。
 *
 * ## 本脚本要证明的三件事
 *   ① 3 次各验 1 件全部成功（不再 409）；
 *   ② 资产卡片**有且仅有一张**，原值 == 净值 == 应付合计（累计而非覆盖）；
 *   ③ 每笔验收各生成一张应付 + 一张借贷平衡的凭证；接口 `acceptedAmount` == SQL 聚合。
 *
 * 用法：npx tsx scripts/verify-pur-accept-batch.mjs
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const TAG = '[API_TEST]';
const STAMP = Date.now();

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
  const created = { requestId: null, orderId: null, supplierId: null };

  try {
    const supplier = (await sql`SELECT id, name FROM md_supplier LIMIT 1`)[0];
    if (!supplier) { record('准备供应商', false, '无供应商'); return; }
    created.supplierId = supplier.id;
    console.log('  用供应商:', supplier.name);

    /* ── ① 采购申请（equipment）→ 批准 ── */
    const req = await call('POST', '/api/pur/requests', {
      title: `${TAG} 分批验收申请-${STAMP}`,
      requestType: 'equipment',
      amount: 3,
    });
    record('建采购申请（equipment）', req.status < 300 && !!req.json?.id, `HTTP ${req.status} ${req.text.slice(0, 100)}`);
    if (!req.json?.id) return;
    created.requestId = req.json.id;
    const approve = await call('POST', `/api/pur/requests/${created.requestId}/actions/approve`, {});
    record('批准采购申请', approve.status < 300, `HTTP ${approve.status} ${approve.text.slice(0, 100)}`);

    /* ── ② 生成采购订单：数量 3、单价 1.00（整数便于断言）── */
    const order = await call('POST', '/api/pur/orders', {
      requestId: String(created.requestId),
      supplierId: String(supplier.id),
      itemName: `${TAG} 分批验收设备-${STAMP}`,
      category: 'equipment',
      quantity: 3,
      unitPrice: 1,
    });
    record('生成设备类采购订单', order.status < 300 && !!order.json?.id, `HTTP ${order.status} ${order.text.slice(0, 120)}`);
    if (!order.json?.id) return;
    created.orderId = order.json.id;
    const o0 = (await sql`SELECT code, quantity, unit_price::float8 AS price, amount::float8 AS amt,
                                 accepted_quantity::float8 AS acc_qty, status
                          FROM pur_order WHERE id = ${created.orderId}`)[0];
    console.log('  订单:', JSON.stringify(o0));

    /* ── ③ 分 3 次各验 1 件（修复前第 2 次必 409）── */
    const acceptStatuses = [];
    for (let i = 1; i <= 3; i += 1) {
      const acc = await call('POST', `/api/pur/orders/${created.orderId}/accept`, { quantity: 1 });
      acceptStatuses.push(acc.status);
      console.log(`    第 ${i} 次验收 → HTTP ${acc.status} ${acc.status >= 400 ? acc.text.slice(0, 110) : ''}`);
      if (acc.status >= 400) break;
    }
    record(
      '⚠️ 分批验收 3 次全部成功（不再 409）',
      acceptStatuses.length === 3 && acceptStatuses.every((s) => s < 300),
      `状态码序列=${JSON.stringify(acceptStatuses)}`,
    );

    const o1 = (await sql`SELECT accepted_quantity::float8 AS acc_qty, quantity::float8 AS qty, status
                          FROM pur_order WHERE id = ${created.orderId}`)[0];
    record('订单收满：accepted_quantity == quantity 且 status=accepted', Number(o1.acc_qty) === Number(o1.qty) && o1.status === 'accepted', JSON.stringify(o1));

    /* ── ④ 资产卡片：有且仅有一张，原值 == 净值 == 应付合计 ── */
    const cards = await sql`
      SELECT id, code, original_value::float8 AS ov, net_value::float8 AS nv
      FROM ast_asset WHERE purchase_order_id = ${created.orderId}`;
    record('该订单只生成**一张**资产卡片（唯一索引不被撞）', cards.length === 1, `卡片数=${cards.length} ${JSON.stringify(cards.map((c) => c.code))}`);

    const apSum = (await sql`
      SELECT count(*)::int AS n, coalesce(sum(amount), 0)::float8 AS total
      FROM erp_ap_bill
      WHERE source = 'purchase' AND source_ref LIKE ${`po-accept:${o0.code}:%`} AND status <> 'voided'`)[0];
    record('每笔验收各生成一张应付（3 张）', apSum.n === 3, `应付张数=${apSum.n} 合计=${apSum.total}`);
    if (cards.length === 1) {
      record(
        '卡片原值 == 净值 == 应付合计（**累计**而非覆盖）',
        Math.abs(cards[0].ov - apSum.total) <= 0.01 && Math.abs(cards[0].nv - apSum.total) <= 0.01,
        `原值=${cards[0].ov} 净值=${cards[0].nv} 应付合计=${apSum.total}（订单金额 ${o0.amt}）`,
      );
    }

    /* ── ⑤ 接口 acceptedAmount == SQL 聚合（我上轮改的那个子查询）── */
    const listRes = await call('GET', `/api/pur/orders?page=1&pageSize=100`);
    const list = listRes.json?.items ?? listRes.json?.data ?? listRes.json ?? [];
    const mine = Array.isArray(list) ? list.find((x) => x.id === created.orderId) : null;
    if (mine) {
      record(
        '接口 acceptedAmount == SQL 聚合（acceptedAmount 子查询正确）',
        Math.abs(Number(mine.acceptedAmount) - apSum.total) <= 0.01,
        `接口=${mine.acceptedAmount} SQL=${apSum.total} acceptedQuantity=${mine.acceptedQuantity}`,
      );
    } else {
      record('在订单列表里找到该订单', false, `列表条数=${Array.isArray(list) ? list.length : 'n/a'}`);
    }

    /* ── ⑥ 每笔验收的凭证借贷平衡 ── */
    const vouchers = await sql`
      SELECT v.code, v.status,
             coalesce(sum(l.debit), 0)::float8 AS dr,
             coalesce(sum(l.credit), 0)::float8 AS cr
      FROM fin_voucher v
      JOIN fin_voucher_line l ON l.voucher_id = v.id
      WHERE v.source_ref LIKE ${`%${o0.code}%`} OR v.summary LIKE ${`%${o0.code}%`}
      GROUP BY v.id, v.code, v.status`;
    record(
      '验收生成的凭证借贷平衡',
      vouchers.length > 0 && vouchers.every((v) => Math.abs(v.dr - v.cr) <= 0.005),
      vouchers.length ? `${vouchers.length} 张：${JSON.stringify(vouchers.map((v) => v.code))}` : '未找到凭证（source_ref/summary 未含订单号，需人工核对）',
    );

    /* ── ⑦ 整单验收后再验收应被拒 ── */
    const again = await call('POST', `/api/pur/orders/${created.orderId}/accept`, { quantity: 1 });
    record('整单验收后再验收被拒（400）', again.status === 400, `HTTP ${again.status} ${again.text.slice(0, 90)}`);
    /* ── ⑧ 超量验收应被拒 ── */
    const over = await call('POST', `/api/pur/orders/${created.orderId}/accept`, { quantity: 99 });
    record('超量验收被拒', over.status >= 400, `HTTP ${over.status} ${over.text.slice(0, 90)}`);
  } finally {
    /*
     * 清理：按**本次精确 id** 删，且先打印确认。
     * 顺序：凭证行 → 凭证 → 应付 → 资产卡片 → 订单 → 申请。
     */
    try {
      if (created.orderId) {
        const o = (await sql`SELECT code FROM pur_order WHERE id = ${created.orderId}`)[0];
        const aps = await sql`SELECT id, code FROM erp_ap_bill WHERE source_ref LIKE ${`po-accept:${o?.code ?? ''}:%`}`;
        const cards = await sql`SELECT id, code FROM ast_asset WHERE purchase_order_id = ${created.orderId}`;
        console.log('  待删: 应付=' + JSON.stringify(aps.map((a) => a.code)) + ' 资产卡=' + JSON.stringify(cards.map((c) => c.code)));
        for (const ap of aps) {
          const vs = await sql`SELECT id FROM fin_voucher WHERE source_ref LIKE ${`%${ap.code}%`}`;
          for (const v of vs) await sql`DELETE FROM fin_voucher_line WHERE voucher_id = ${v.id}`.catch(() => {});
          await sql`DELETE FROM fin_voucher WHERE source_ref LIKE ${`%${ap.code}%`}`.catch(() => {});
          await sql`DELETE FROM erp_ap_bill WHERE id = ${ap.id}`;
        }
        for (const c of cards) {
          await sql`DELETE FROM ast_depreciation WHERE asset_id = ${c.id}`.catch(() => {});
          await sql`DELETE FROM ast_asset WHERE id = ${c.id}`;
        }
        await sql`DELETE FROM pur_order WHERE id = ${created.orderId}`;
      }
      if (created.requestId) await sql`DELETE FROM pur_request WHERE id = ${created.requestId}`;
      console.log('  清理完成');
    } catch (e) { console.log('  清理出错:', e.message); }

    const left = await sql`SELECT
      (SELECT count(*)::int FROM pur_order) AS po,
      (SELECT count(*)::int FROM pur_request WHERE title LIKE ${`%${TAG}%`}) AS pr,
      (SELECT count(*)::int FROM ast_asset WHERE name LIKE ${`%${TAG}%`}) AS ast,
      (SELECT count(*)::int FROM erp_ap_bill WHERE source = 'purchase') AS ap_purchase`;
    console.log('  残留:', JSON.stringify(left[0]));
    await sql.end({ timeout: 2 }).catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) for (const f of failed) console.log(`  - ${f.name}  ${f.detail ?? ''}`);
}

void main().catch((e) => { console.error('复核失败:', e); process.exitCode = 1; });
