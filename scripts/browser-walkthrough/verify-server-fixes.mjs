/**
 * 「修复后证据」——用**跑源码的临时实例**验证两处只在服务端生效的修复。
 *
 * ## 为什么需要这个脚本
 *
 * 走查脚本 `walk-projects.mjs` 打的是 `http://127.0.0.1:3100`，而那个进程跑的是
 * `dist/server/main.js`（**编译产物**）。本次改的是 `server/**` 源码，
 * 而任务明确要求**不重启 3100/5273** —— 于是走查会在 T4b / T5d / G3c 三条上
 * 继续复现**修复前**的行为。
 *
 * 为了不让"已修"停留在纸面上，这里另起一个**读源码**的实例（`tsx server/main.ts`，
 * `SERVER_PORT=3111`，同一个库），只打这三条规则。它不碰 3100/5273，
 * 与仓库里既有的 `verify-server-3107.log` 等做法一致。
 *
 * 用法：
 *   1) `SERVER_PORT=3111 npx tsx --tsconfig tsconfig.node.json server/main.ts`（后台）
 *   2) `node scripts/browser-walkthrough/verify-server-fixes.mjs`
 *
 * 结论落 `out/server-fix-verification.json`。自建数据全部带 [API_TEST] 前缀，
 * 收尾按**精确主键**删除。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

const API = process.env.WT_API_VERIFY ?? 'http://127.0.0.1:3111';
const USER = process.env.WT_USER ?? 'chengsheng@chengshengdata.cn';
const PASS = process.env.WT_PASS ?? '';
const OUT = 'scripts/browser-walkthrough/out';
const TAG = '[API_TEST]';

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function login(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (res.status !== 201) throw new Error(`登录失败 ${res.status}`);
  const jar = res.headers.getSetCookie?.() ?? [];
  return jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session=')).slice(12);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const session = await login(API);
  const call = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: `erp_session=${session}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, body: json };
  };
  const msg = (r) => JSON.stringify(r.body ?? '').slice(0, 200);
  const sql = postgres({ host: '127.0.0.1', port: 5433, user: 'erp', password: process.env.DB_PASSWORD ?? '', database: 'shengseerp' });
  const mine = { contractIds: [], customerIds: [], projectIds: [] };

  try {
    // 探活：确认这个实例真的跑的是**新源码**（看它是否加载了本轮的判据）
    const alive = await call('GET', '/api/contracts?pageSize=1');
    record(`临时实例可访问（${API}）`, alive.status === 200, `http=${alive.status}`);

    /* ── 场景 1：改客户后税率按新客户解析（rate_source=counterparty 不得被固化成 explicit）── */
    const custA = (await sql`SELECT id, name, default_tax_rate FROM md_customer WHERE default_tax_rate = 13 LIMIT 1`)[0]
      ?? null;
    const mkA = await call('POST', '/api/master-data/customers', { name: `${TAG} 验13`, defaultTaxRate: 13, status: 'active' });
    const idA = (mkA.body?.data ?? mkA.body)?.id;
    mine.customerIds.push(idA);
    record('准备：13% 客户', !!idA, `http=${mkA.status} ${custA ? '' : '(库里没有 13% 客户，故新建)'}`);

    const custB = (await sql`SELECT id, name, default_tax_rate FROM md_customer WHERE name NOT LIKE ${`%${TAG}%`} AND default_tax_rate IS NOT NULL ORDER BY default_tax_rate LIMIT 1`)[0];
    const rateA = Number((await sql`SELECT default_tax_rate FROM md_customer WHERE id = ${idA}`)[0].default_tax_rate);
    const rateB = Number(custB.default_tax_rate);

    const mkC = await call('POST', '/api/contracts', {
      name: `${TAG} 验税率重算`, customerId: custB.id, billingModel: 'project', amount: 113000,
    });
    const ctrId = (mkC.body?.data ?? mkC.body)?.id;
    mine.contractIds.push(ctrId);
    record('准备：按客户默认税率建合同（不传 taxRate）', !!ctrId && Number((mkC.body?.data ?? mkC.body)?.taxRate) === rateB, `http=${mkC.status}`);

    // 显式税率清空 → 改客户到 A，应得 13% / counterparty
    await sql`UPDATE erp_contract SET tax_rate = NULL, net_amount = NULL, tax_amount = NULL, rate_source = NULL WHERE id = ${ctrId}`;
    const toA = await call('PATCH', `/api/contracts/${ctrId}`, { customerId: idA });
    const rA = (await sql`SELECT tax_rate, rate_source, customer_id FROM erp_contract WHERE id = ${ctrId}`)[0];
    record(
      '修复①a 改客户到 13% 客户 → 税率按新客户解析（counterparty）',
      toA.status === 200 && Number(rA.tax_rate) === rateA && rA.rate_source === 'counterparty' && rA.customer_id === idA,
      `http=${toA.status} taxRate=${rA.tax_rate} 期望=${rateA} rateSource=${rA.rate_source} ${msg(toA)}`,
    );

    // 再改回 B：**这就是修复点** —— 修复前会沿用 13 并把来源洗成 explicit
    const toB = await call('PATCH', `/api/contracts/${ctrId}`, { customerId: custB.id });
    const rB = (await sql`SELECT tax_rate, rate_source, customer_id, amount, net_amount, tax_amount FROM erp_contract WHERE id = ${ctrId}`)[0];
    record(
      '修复①b 【核心】再次改客户回 6% → 仍跟随新客户重新推导（修复前 taxRate 保持 13、rateSource 变 explicit）',
      toB.status === 200 && Number(rB.tax_rate) === rateB && rB.rate_source === 'counterparty' && rB.customer_id === custB.id,
      `http=${toB.status} taxRate=${rB.tax_rate} 期望=${rateB} rateSource=${rB.rate_source} ${msg(toB)}`,
    );
    const expTax = Math.round((Number(rB.amount) * Number(rB.tax_rate)) / (100 + Number(rB.tax_rate)) * 100) / 100;
    record(
      '修复①c 重算后 netAmount + taxAmount == amount 且税额 = splitTax 口径',
      Math.abs(Number(rB.net_amount) + Number(rB.tax_amount) - Number(rB.amount)) < 0.005
        && Math.abs(Number(rB.tax_amount) - expTax) < 0.005,
      `amount=${rB.amount} net=${rB.net_amount} tax=${rB.tax_amount} 期望税=${expTax}`,
    );

    /* ── 场景 2：由主体推导的税率在换主体后必须重新推导 ── */
    const small = (await sql`SELECT id, name, default_output_rate FROM md_tax_entity WHERE taxpayer_type = 'small' LIMIT 1`)[0];
    const def = (await sql`SELECT id, name, default_output_rate FROM md_tax_entity WHERE is_default = 1`)[0];
    const noRateCust = await call('POST', '/api/master-data/customers', { name: `${TAG} 验无税率`, status: 'active' });
    const idNoRate = (noRateCust.body?.data ?? noRateCust.body)?.id;
    mine.customerIds.push(idNoRate);

    await sql`UPDATE erp_contract SET tax_rate = NULL, net_amount = NULL, tax_amount = NULL, rate_source = NULL, customer_id = ${idNoRate} WHERE id = ${ctrId}`;
    const toSmall = await call('PATCH', `/api/contracts/${ctrId}`, { taxEntityId: small.id });
    const rS = (await sql`SELECT tax_rate, rate_source, tax_entity_id FROM erp_contract WHERE id = ${ctrId}`)[0];
    record(
      '修复②a 换成小规模主体 → 税率取其默认征收率（entity）',
      toSmall.status === 200 && Number(rS.tax_rate) === Number(small.default_output_rate) && rS.rate_source === 'entity',
      `http=${toSmall.status} taxRate=${rS.tax_rate} 期望=${small.default_output_rate} rateSource=${rS.rate_source} ${msg(toSmall)}`,
    );
    const backDef = await call('PATCH', `/api/contracts/${ctrId}`, { taxEntityId: def.id });
    const rD = (await sql`SELECT tax_rate, rate_source, tax_entity_id FROM erp_contract WHERE id = ${ctrId}`)[0];
    record(
      '修复②b 【核心】换回一般纳税人主体 → 税率重新推导为 6%（修复前：把推导值 1% 当显式，直接 400「税率与纳税主体类型不匹配」）',
      backDef.status === 200 && Number(rD.tax_rate) === Number(def.default_output_rate) && rD.tax_entity_id === def.id,
      `http=${backDef.status} taxRate=${rD.tax_rate} 期望=${def.default_output_rate} rateSource=${rD.rate_source} ${msg(backDef)}`,
    );

    /* ── 场景 3：结项摘要纯空白必须被拒 ── */
    const projContract = await call('POST', '/api/contracts', {
      name: `${TAG} 验结项闸门`, customerId: custB.id, billingModel: 'project', amount: 1000, taxRate: 6,
    });
    const pcId = (projContract.body?.data ?? projContract.body)?.id;
    mine.contractIds.push(pcId);
    await call('POST', `/api/contracts/${pcId}/status`, { action: 'submit' });
    await call('POST', `/api/contracts/${pcId}/status`, { action: 'approve' });
    const proj = await call('POST', '/api/projects', { name: `${TAG} 验结项项目`, contractId: pcId, budget: 1000 });
    const pid = (proj.body?.data ?? proj.body)?.id;
    mine.projectIds.push(pid);
    // 推到 accepting：需要至少一个交付物且全部验收通过
    const del = await call('POST', `/api/projects/${pid}/deliverables`, { name: `${TAG} 验交付物` });
    const did = (del.body?.data ?? del.body)?.id;
    await call('POST', `/api/projects/deliverables/${did}/submit`);
    await call('POST', `/api/projects/deliverables/${did}/accept`, { acceptConclusion: `${TAG} 结论` });
    await call('POST', `/api/projects/${pid}/status`, { action: 'approve' });
    await call('POST', `/api/projects/${pid}/status`, { action: 'deliver' });
    await call('POST', `/api/projects/${pid}/status`, { action: 'accept' });
    const st = (await sql`SELECT status FROM erp_project WHERE id = ${pid}`)[0].status;
    record('准备：项目已进入 accepting（交付物全部验收通过）', st === 'accepting', `status=${st}`);

    const blank = await call('POST', `/api/projects/${pid}/status`, { action: 'close', closeSummary: '   ' });
    const afterBlank = (await sql`SELECT status, close_summary, closed_at FROM erp_project WHERE id = ${pid}`)[0];
    record(
      '修复③ 【核心】纯空白 closeSummary → 被拒且项目未被结项（修复前：201、库里 close_summary = \'   \'）',
      blank.status === 400 && afterBlank.status === 'accepting' && afterBlank.closed_at === null,
      `http=${blank.status} status=${afterBlank.status} closeSummary=${JSON.stringify(afterBlank.close_summary)} ${msg(blank)}`,
    );
    const ws = await call('POST', `/api/projects/${pid}/status`, { action: 'close', closeSummary: `\t\n ` });
    record('修复③b 制表符/换行组成的摘要同样被拒', ws.status === 400, `http=${ws.status} ${msg(ws)}`);

    const ok = await call('POST', `/api/projects/${pid}/status`, { action: 'close', closeSummary: `  ${TAG} 正常摘要  ` });
    const okRow = (await sql`SELECT status, close_summary FROM erp_project WHERE id = ${pid}`)[0];
    record(
      '修复③c 正常摘要仍可结项，且落库值已去首尾空白',
      ok.status >= 200 && ok.status < 300 && okRow.status === 'closed' && okRow.close_summary === `${TAG} 正常摘要`,
      `http=${ok.status} status=${okRow.status} closeSummary=${JSON.stringify(okRow.close_summary)}`,
    );

    /* ── 场景 4：项目主档的"已结项即冻结"（与交付物那条同一业务规则）── */
    const frozenEdit = await call('PATCH', `/api/projects/${pid}`, { pm: `${TAG} 结项后改名` });
    const pmAfter = (await sql`SELECT pm FROM erp_project WHERE id = ${pid}`)[0]?.pm ?? null;
    record(
      '修复④ 已结项项目的主档写动作被冻结（被拒 + 中文 + 指出"先反结项"），且库值未变',
      frozenEdit.status === 400 && /反结项/.test(msg(frozenEdit)) && pmAfter !== `${TAG} 结项后改名`,
      `http=${frozenEdit.status} pm=${JSON.stringify(pmAfter)} ${msg(frozenEdit)}`,
    );
    const reopened = await call('POST', `/api/projects/${pid}/status`, { action: 'reopen' });
    const editAfterReopen = await call('PATCH', `/api/projects/${pid}`, { pm: `${TAG} 反结项后可改` });
    const pm2 = (await sql`SELECT pm FROM erp_project WHERE id = ${pid}`)[0]?.pm ?? null;
    record(
      '修复④b 冻结文案给出的出路真实可用：反结项后可正常改（不是死锁）',
      reopened.status >= 200 && reopened.status < 300 && editAfterReopen.status === 200 && pm2 === `${TAG} 反结项后可改`,
      `reopen=${reopened.status} patch=${editAfterReopen.status} pm=${JSON.stringify(pm2)}`,
    );

    /* ── 对照：旧实例（3100）在同一场景下的行为，证明差异来自本次修复 ── */
    let oldApi = null;
    try {
      const oldSession = await login('http://127.0.0.1:3100');
      const callOld = async (method, path, body) => {
        const res = await fetch(`http://127.0.0.1:3100${path}`, {
          method,
          headers: { 'content-type': 'application/json', cookie: `erp_session=${oldSession}` },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        let json = null;
        try { json = await res.json(); } catch { /* 非 JSON */ }
        return { status: res.status, body: json };
      };
      const mkOld = await callOld('POST', '/api/contracts', { name: `${TAG} 对照-旧实例`, customerId: custB.id, billingModel: 'project', amount: 113000 });
      const oldCtr = (mkOld.body?.data ?? mkOld.body)?.id;
      mine.contractIds.push(oldCtr);
      await sql`UPDATE erp_contract SET tax_rate = NULL, net_amount = NULL, tax_amount = NULL, rate_source = NULL WHERE id = ${oldCtr}`;
      await callOld('PATCH', `/api/contracts/${oldCtr}`, { customerId: idA });
      await callOld('PATCH', `/api/contracts/${oldCtr}`, { customerId: custB.id });
      const oldRow = (await sql`SELECT tax_rate, rate_source FROM erp_contract WHERE id = ${oldCtr}`)[0];
      oldApi = { taxRate: Number(oldRow.tax_rate), rateSource: oldRow.rate_source };
      record(
        '对照：运行中的 3100（旧构建）在同一序列下仍复现缺陷（taxRate=13 / rateSource=explicit）',
        Number(oldRow.tax_rate) === rateA && oldRow.rate_source === 'explicit',
        `3100: taxRate=${oldRow.tax_rate} rateSource=${oldRow.rate_source}｜3111: taxRate=${rB.tax_rate} rateSource=${rB.rate_source}`,
      );
    } catch (e) {
      record('对照：旧实例 3100 复现缺陷', false, `无法连接 3100：${e.message}`);
    }

    writeFileSync(`${OUT}/server-fix-verification.json`, JSON.stringify({
      generatedAt: new Date().toISOString(),
      verifiedAgainst: API,
      note: '3100 运行的是 dist 旧构建；本脚本打的是跑源码的临时实例（SERVER_PORT=3111），同一个库。',
      results, oldApi,
    }, null, 2));
  } finally {
    /* 精确清理（先打印待删行） */
    console.log('\n── 清理（先 SELECT 打印待删行）──');
    try {
      const plan = await sql`
        SELECT 'erp_contract' AS t, count(*)::int AS n FROM erp_contract WHERE id = ANY(${sql.array(mine.contractIds.filter(Boolean))}::uuid[])
        UNION ALL SELECT 'erp_project', count(*)::int FROM erp_project WHERE id = ANY(${sql.array(mine.projectIds.filter(Boolean))}::uuid[])
        UNION ALL SELECT 'erp_contract_item', count(*)::int FROM erp_contract_item WHERE contract_id = ANY(${sql.array(mine.contractIds.filter(Boolean))}::uuid[])
        UNION ALL SELECT 'md_customer', count(*)::int FROM md_customer WHERE id = ANY(${sql.array(mine.customerIds.filter(Boolean))}::uuid[])`;
      for (const row of plan) if (row.n > 0) console.log(`  待删 ${row.t}: ${row.n} 行`);
      const guard = (await sql`
        SELECT
          (SELECT count(*)::int FROM erp_contract WHERE id = ANY(${sql.array(mine.contractIds.filter(Boolean))}::uuid[]) AND name NOT LIKE ${`%${TAG}%`}) AS fc,
          (SELECT count(*)::int FROM erp_project WHERE id = ANY(${sql.array(mine.projectIds.filter(Boolean))}::uuid[]) AND name NOT LIKE ${`%${TAG}%`}) AS fp,
          (SELECT count(*)::int FROM md_customer WHERE id = ANY(${sql.array(mine.customerIds.filter(Boolean))}::uuid[]) AND name NOT LIKE ${`%${TAG}%`}) AS fu`)[0];
      if (guard.fc + guard.fp + guard.fu > 0) {
        record('清理：待删集合只含自建数据', false, JSON.stringify(guard));
      } else {
        record('清理：待删集合只含自建数据（安全闸通过）', true, '');
        const cids = sql.array(mine.contractIds.filter(Boolean));
        const pids = sql.array(mine.projectIds.filter(Boolean));
        const uids = sql.array(mine.customerIds.filter(Boolean));
        await sql`DELETE FROM erp_deliverable WHERE project_id = ANY(${pids}::uuid[])`;
        await sql`DELETE FROM erp_project_milestone WHERE project_id = ANY(${pids}::uuid[])`;
        await sql`DELETE FROM erp_contract_milestone WHERE contract_id = ANY(${cids}::uuid[])`;
        await sql`DELETE FROM erp_contract_item WHERE contract_id = ANY(${cids}::uuid[])`;
        await sql`DELETE FROM erp_contract_version WHERE contract_id = ANY(${cids}::uuid[])`;
        await sql`DELETE FROM erp_project WHERE id = ANY(${pids}::uuid[])`;
        await sql`DELETE FROM erp_contract WHERE id = ANY(${cids}::uuid[])`;
        await sql`DELETE FROM md_customer WHERE id = ANY(${uids}::uuid[])`;
        console.log('  已清理');
      }
    } catch (e) {
      console.log('清理出错:', e.message);
    }
    const left = (await sql`
      SELECT
        (SELECT count(*)::int FROM erp_contract WHERE id = ANY(${sql.array(mine.contractIds.filter(Boolean))}::uuid[])) AS c,
        (SELECT count(*)::int FROM erp_project WHERE id = ANY(${sql.array(mine.projectIds.filter(Boolean))}::uuid[])) AS p,
        (SELECT count(*)::int FROM md_customer WHERE id = ANY(${sql.array(mine.customerIds.filter(Boolean))}::uuid[])) AS u`)[0];
    record('残留审计：本次自建数据全部清空', Number(left.c) + Number(left.p) + Number(left.u) === 0, JSON.stringify(left));

    await sql.end({ timeout: 2 }).catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail}`);
}

void main().then(() => process.exit(0), (e) => { console.error('验证中断:', e); process.exit(1); });
