/**
 * 定点复验 **D3**：纯空白 `closeSummary` 必须被拒（而不是落库 `'   '`）。
 *
 * ## 为什么要单独造样本
 *
 * `close` 动作的校验顺序是：① 无 pending 里程碑 → ② 交付物全部 accepted →
 * ③ **结项摘要非空白**。所以随便拿一个项目去打 close，会先被 ①/② 拦下，
 * 测到的是状态机/前置闸门，**测不到摘要这条**（我第一次就是这样误判的）。
 *
 * 本脚本在**一个事务里**造出满足 ① ② 的现场（新建项目 → 达成里程碑 →
 * 交付物 accepted），然后：
 *   · 用 `'   '`（纯空格）→ 期望 400 + 文案「结项须填写结项摘要」+ 库值未变；
 *   · 用 `'\t\n '`（制表/换行）→ 同样期望 400；
 *   · 用 `'  X  '`（有内容但带空白）→ 期望成功且**落库已 trim**（证明不是一刀切拒绝）。
 *
 * 全程只操作本次自建的行，结束时按精确主键清理。
 *
 * 用法：npx tsx scripts/verify-close-summary.mjs
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
    host: '127.0.0.1', port: 5433, user: 'erp', password: '******',
    database: 'shengseerp', connect_timeout: 5,
  });
  const made = { projectId: null, milestoneIds: [], deliverableIds: [] };

  try {
    /* ── 造现场：项目 + 合同（已生效）── */
    const cust = (await sql`SELECT id FROM md_customer ORDER BY name LIMIT 1`)[0];
    const ent = (await sql`SELECT id FROM md_tax_entity ORDER BY name LIMIT 1`)[0];
    const suf = Date.now();
    const ctr = await call('POST', '/api/contracts', {
      name: `${TAG} 结项用合同-${suf}`, customerId: String(cust.id), billingModel: 'project',
      amount: 1000, taxRate: 6, taxEntityId: String(ent.id), signDate: '2026-10-01',
    });
    const ctrId = ctr.json?.id;
    if (!ctrId) { rec('造合同', false, `HTTP ${ctr.status} ${ctr.text.slice(0, 90)}`); return; }
    await call('POST', `/api/contracts/${ctrId}/status`, { action: 'submit' });
    await call('POST', `/api/contracts/${ctrId}/status`, { action: 'approve' });

    const proj = await call('POST', '/api/projects', {
      name: `${TAG} 结项用项目-${suf}`, contractId: String(ctrId), budget: 1000,
    });
    const pid = proj.json?.id;
    if (!pid) { rec('造项目', false, `HTTP ${proj.status} ${proj.text.slice(0, 90)}`); return; }
    made.projectId = pid;
    rec('造出项目（用于结项闸门复验）', true, `code=${proj.json?.code ?? ''}`);

    /* ── 一个里程碑：达成 ── */
    const ms = await call('POST', `/api/projects/${pid}/milestones`, {
      name: `${TAG} 里程碑`, planDate: '2026-10-10', amount: 1000,
    });
    if (ms.json?.id) {
      made.milestoneIds.push(ms.json.id);
      await call('POST', `/api/projects/${pid}/milestones/${ms.json.id}/reach`, { actualDate: '2026-10-10' });
    }
    /* ── 一个交付物：提交后验收 ──
     * ⚠️ 字段名是 `deliverableType`（不是 `type`）；写错会被 forbidNonWhitelisted 打回，
     * 于是交付物建不出来 → `deliver` 报「请先登记交付物清单」。
     */
    const dlv = await call('POST', `/api/projects/${pid}/deliverables`, {
      name: `${TAG} 交付物`, deliverableType: 'doc',
    });
    if (!dlv.json?.id) console.log(`     建交付物失败 HTTP ${dlv.status} ${dlv.text.slice(0, 100)}`);
    if (dlv.json?.id) {
      made.deliverableIds.push(dlv.json.id);
      const sub = await call('POST', `/api/projects/deliverables/${dlv.json.id}/submit`, {});
      if (sub.status >= 400) console.log(`     交付物提交 HTTP ${sub.status} ${(sub.json?.error?.message ?? '').slice(0, 60)}`);
      /* ⚠️ 验收接口不接受 `conclusion` 字段（实测 400 conclusion: property should not exist） */
      const acc = await call('POST', `/api/projects/deliverables/${dlv.json.id}/accept`, {});
      if (acc.status >= 400) console.log(`     交付物验收 HTTP ${acc.status} ${(acc.json?.error?.message ?? '').slice(0, 60)}`);
    }

    /*
     * 推进到 accepting。状态机的权威流转是：
     *   initiating --approve--> executing --deliver--> delivering --accept--> accepting --close--> closed
     * ⚠️ 我第一次写成 `start`（不存在这个 action）→ 项目停在 initiating，
     * 于是 close 被状态机先拦下，**测到的是状态机而不是摘要校验**。
     */
    for (const action of ['approve', 'deliver', 'accept']) {
      const r = await call('POST', `/api/projects/${pid}/status`, { action });
      if (r.status >= 400) console.log(`     推进 ${action} → HTTP ${r.status} ${(r.json?.error?.message ?? '').slice(0, 60)}`);
    }
    const st = (await sql`SELECT status FROM erp_project WHERE id = ${pid}`)[0];
    const pend = (await sql`SELECT count(*)::int AS n FROM erp_project_milestone WHERE project_id = ${pid} AND status = 'pending'`)[0].n;
    const notAcc = (await sql`SELECT count(*)::int AS n FROM erp_deliverable WHERE project_id = ${pid} AND status <> 'accepted'`)[0].n;
    console.log(`     现场：status=${st?.status} pending里程碑=${pend} 未验收交付物=${notAcc}`);
    rec('现场满足 ①②（无 pending 里程碑、交付物全 accepted）', pend === 0 && notAcc === 0 && st?.status === 'accepting',
      `status=${st?.status} pending=${pend} notAccepted=${notAcc}`);

    /* ── ① 纯空格 → 必须 400 ── */
    const blank = await call('POST', `/api/projects/${pid}/status`, { action: 'close', closeSummary: '   ' });
    const afterBlank = (await sql`SELECT status, close_summary FROM erp_project WHERE id = ${pid}`)[0];
    rec(
      '⚠️ 纯空格摘要 → 400「结项须填写结项摘要」且库值未变',
      blank.status === 400 && afterBlank.close_summary === null && afterBlank.status !== 'closed',
      `HTTP ${blank.status} msg=${(blank.json?.error?.message ?? '').slice(0, 30)} status=${afterBlank.status} close_summary=${JSON.stringify(afterBlank.close_summary)}`,
    );

    /* ── ② 制表符/换行 → 同样 400 ── */
    const ws = await call('POST', `/api/projects/${pid}/status`, { action: 'close', closeSummary: '\t\n ' });
    rec('制表/换行摘要 → 400', ws.status === 400, `HTTP ${ws.status}`);

    /* ── ③ 空白可剥离的**有内容**摘要 → 成功且落库已 trim ── */
    const ok = await call('POST', `/api/projects/${pid}/status`, { action: 'close', closeSummary: '  真摘要  ' });
    const afterOk = (await sql`SELECT status, close_summary FROM erp_project WHERE id = ${pid}`)[0];
    rec(
      '正常摘要（带首尾空白）→ 成功且落库已 trim',
      ok.status < 300 && afterOk.status === 'closed' && afterOk.close_summary === '真摘要',
      `HTTP ${ok.status} status=${afterOk.status} close_summary=${JSON.stringify(afterOk.close_summary)}`,
    );

    /* ── ④ D4：已结项主档冻结（现在有 closed 项目了）── */
    const patch = await call('PATCH', `/api/projects/${pid}`, { remark: `${TAG} 结项后改动` });
    const afterPatch = (await sql`SELECT remark FROM erp_project WHERE id = ${pid}`)[0];
    rec(
      'D4 已结项项目主档 PATCH 被拒且库值未变',
      patch.status === 400 && afterPatch.remark === null,
      `HTTP ${patch.status} msg=${(patch.json?.error?.message ?? '').slice(0, 40)} remark=${JSON.stringify(afterPatch.remark)}`,
    );
  } finally {
    /* 只删本次自建（按精确主键） */
    try {
      if (made.projectId) {
        const ctrId = (await sql`SELECT contract_id FROM erp_project WHERE id = ${made.projectId}`)[0]?.contract_id;
        console.log('  待删: 项目 + 合同', String(ctrId ?? '').slice(0, 8));
        for (const t of ['erp_deliverable', 'erp_project_milestone', 'erp_project_minutes', 'erp_project_revenue', 'erp_project_cost']) {
          await sql.unsafe(`DELETE FROM ${t} WHERE project_id = $1`, [made.projectId]).catch(() => {});
        }
        await sql`DELETE FROM erp_project WHERE id = ${made.projectId}`;
        if (ctrId) {
          await sql`DELETE FROM erp_contract_item WHERE contract_id = ${ctrId}`.catch(() => {});
          await sql`DELETE FROM erp_contract WHERE id = ${ctrId}`;
        }
      }
      console.log('  清理完成');
    } catch (e) { console.log('  清理出错:', e.message); }
    const left = await sql`SELECT
      (SELECT count(*)::int FROM erp_project WHERE name LIKE ${`%${TAG}%`}) AS proj,
      (SELECT count(*)::int FROM erp_contract WHERE name LIKE ${`%${TAG}%`}) AS ctr`;
    console.log(`  残留: 项目=${left[0].proj} 合同=${left[0].ctr}`);
    await sql.end({ timeout: 2 }).catch(() => {});
  }

  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) { for (const b of bad) console.log(`  - ${b.n}  ${b.d ?? ''}`); process.exitCode = 1; }
}
void main().catch((e) => { console.error('复核失败:', e.message); process.exitCode = 1; });
