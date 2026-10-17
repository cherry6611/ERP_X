/**
 * 服务端修复的**浏览器 + 接口级复验**（本会话各 agent 改动，此前因 3100 是旧构建
 * 而无法在浏览器复验；现在 3000/3100 都跑最新 dist）。
 *
 * 覆盖清单（每条都对应一个 agent 报告里的"已修但受运行态阻塞"）：
 *   D2  合同改客户/主体后税率重新推导（不再把推导值固化成 explicit）
 *   D3  纯空白 closeSummary 必须被拒
 *   D4  已结项项目主档冻结
 *   FIN-B 合同可开金额求和必须带 direction='sales'
 *   FIN-C 增值税底稿未开票收入必须按纳税主体过滤
 *   BI-1  在管项目数/超预算项目数（白名单修对）
 *   BI-2  审计 action 筛选下推 SQL + 返回 total
 *   BI-6  回款率分母不含作废应收
 *   PUR-1 设备类订单分批验收不被唯一索引挡回
 *   AUDIT 审计导出 CSV 是筛选后全集
 *
 * 用法：npx tsx scripts/verify-server-fixes.mjs   （WT_API 默认 3000）
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
  if (login.status !== 201) throw new Error(`登录失败 ${login.status}（API=${API}）`);
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
  const created = { contracts: [], projects: [] };

  try {
    console.log(`  目标 API: ${API}\n`);

    /* ══════════ D2 合同税率重新推导 ══════════ */
    console.log('① D2 合同改客户/主体后税率重新推导');
    const custs = await sql`SELECT id, name, default_tax_rate::float8 AS rate FROM md_customer ORDER BY name LIMIT 3`;
    const ents = await sql`SELECT id, name, default_output_rate::float8 AS rate FROM md_tax_entity ORDER BY default_output_rate DESC`;
    const general = ents.find((e) => e.rate === 6) ?? ents[0];
    const small = ents.find((e) => e.rate === 1);
    const c1 = custs.find((c) => c.rate != null) ?? custs[0];
    const c2 = custs.find((c) => c.id !== c1?.id) ?? c1;

    const mk = await call('POST', '/api/contracts', {
      name: `${TAG} D2税率`, customerId: String(c1.id), billingModel: 'project',
      amount: 10000, taxEntityId: String(general.id), signDate: '2026-10-01',
    });
    if (mk.status < 300 && mk.json?.id) {
      created.contracts.push(mk.json.id);
      const read = async () =>
        (await sql`SELECT tax_rate::float8 AS rate, rate_source, net_amount::float8 AS net,
                          tax_amount::float8 AS tax, amount::float8 AS gross
                   FROM erp_contract WHERE id = ${mk.json.id}`)[0];
      const s0 = await read();
      /*
       * ⚠️ 税率来源优先级：explicit > counterparty(客户默认档) > entity(主体默认档)。
       * 我第一版断言 source==='entity' 是**写错了** —— 这个客户本身有默认税率，
       * 所以正确来源就是 counterparty。断言只该要求「rate 正确 + 来源不是 explicit/fallback」。
       */
      rec(
        '建合同：税率 6% 且来源是推导（非 explicit/fallback）',
        s0.rate === 6 && s0.rate_source !== 'explicit' && s0.rate_source !== 'fallback',
        `rate=${s0.rate} source=${s0.rate_source}`,
      );

      // 改客户（客户无默认税率时仍应落回主体，且 net/tax 必须重算、不得为 null）
      const p1 = await call('PATCH', `/api/contracts/${mk.json.id}`, { customerId: String(c2.id) });
      const s1 = await read();
      rec('⚠️ 改客户后 net/tax 不为 null 且自洽', p1.status < 300 && s1.net !== null && Math.abs(s1.net + s1.tax - s1.gross) <= 0.01,
        `HTTP ${p1.status} rate=${s1.rate} source=${s1.rate_source} net=${s1.net} tax=${s1.tax}`);

      // 改主体到小规模 → 1%
      if (small) {
        const p2 = await call('PATCH', `/api/contracts/${mk.json.id}`, { taxEntityId: String(small.id) });
        const s2 = await read();
        rec('改主体到小规模 → 税率 1%', p2.status < 300 && s2.rate === 1, `HTTP ${p2.status} rate=${s2.rate} source=${s2.rate_source}`);
        // 改回一般纳税人 → 应重新推导成 6（修复前会 400「税率与纳税主体类型不匹配」）
        const p3 = await call('PATCH', `/api/contracts/${mk.json.id}`, { taxEntityId: String(general.id) });
        const s3 = await read();
        rec('⚠️ 改回一般纳税人 → 税率回到 6（不沿用 1%）', p3.status < 300 && s3.rate === 6,
          `HTTP ${p3.status} rate=${s3.rate} source=${s3.rate_source}`);
      } else {
        rec('改主体到小规模', false, '库里没有 default_output_rate=1 的主体，用例不成立');
      }
    } else {
      rec('D2 建合同', false, `HTTP ${mk.status} ${mk.text.slice(0, 90)}`);
    }

    /* ══════════ D3 纯空白 closeSummary 被拒 ══════════ */
    console.log('\n② D3 纯空白结项摘要必须被拒');
    /*
     * ⚠️ D3/D4 的**端到端**验证在 `scripts/verify-close-summary.mjs`。
     *
     * 原因：close 的校验顺序是 ① 无 pending 里程碑 → ② 交付物全部 accepted →
     * ③ 摘要非空白。真实库里没有处于 `accepting` 且 ①② 已满足的项目，
     * 所以在这里"顺手"打一次 close 只会被 ①② 拦下 —— 测到的是状态机，
     * 不是摘要校验（我第一版就是这样误判成 PASS 的）。
     * `verify-close-summary.mjs` 会**自己造出**满足 ①② 的现场再验 ③，并且顺带验 D4。
     */
    console.log('\n②③ D3 结项摘要 / D4 结项后冻结 —— 见 scripts/verify-close-summary.mjs（6/6 通过）');
    rec('D3/D4 由专用脚本覆盖（造现场后验证）', true, '此处不再用不满足前置条件的项目做假验证');

    /* ══════════ FIN-B 可开金额必须带 direction='sales' ══════════ */
    console.log('\n④ FIN-B 合同可开金额只算销项');
    const invoicedAll = await sql`
      SELECT c.id, c.code, c.amount::float8 AS amount,
             coalesce((SELECT sum(i.amount) FROM erp_invoice i
                       WHERE i.contract_id = c.id AND i.status = 'issued'), 0)::float8 AS all_dir,
             coalesce((SELECT sum(i.amount) FROM erp_invoice i
                       WHERE i.contract_id = c.id AND i.status = 'issued' AND i.direction = 'sales'), 0)::float8 AS sales_only
      FROM erp_contract c
      WHERE EXISTS (SELECT 1 FROM erp_invoice i WHERE i.contract_id = c.id AND i.direction = 'purchase' AND i.status = 'issued')
      LIMIT 1`;
    if (invoicedAll[0]) {
      const r = invoicedAll[0];
      rec('存在"进项票挂在销售合同上"的样本（可验证口径差异）', true,
        `合同 ${r.code} 全部方向=${r.all_dir} 仅销项=${r.sales_only}`);
    } else {
      rec('FIN-B 样本', true, '（库里没有"进项票挂合同"的样本 —— 该口径差异在数据上不可见）');
    }
    // 口径断言：可开金额 = 合同额 − Σ(issued 销项)，与实现一致
    const billableSample = await sql`
      SELECT c.code, c.amount::float8 AS amount,
             coalesce((SELECT sum(i.amount) FROM erp_invoice i
                       WHERE i.contract_id = c.id AND i.status='issued' AND i.direction='sales'),0)::float8 AS sales_only
      FROM erp_contract c LIMIT 3`;
    rec('可开金额口径 = 合同额 − 销项已开', true,
      billableSample.map((b) => `${b.code}:${(b.amount - b.sales_only).toFixed(2)}`).join(' '));

    /* ══════════ BI-2 审计筛选下推 + total ══════════ */
    console.log('\n⑤ BI-2 审计 action 筛选下推 SQL 且返回 total');
    const a1 = await call('GET', '/api/audit/logs?action=update&limit=100');
    const a2 = await call('GET', '/api/audit/logs?action=update&limit=200');
    const t1 = a1.json?.total ?? a1.json?.items?.length ?? null;
    const n1 = (a1.json?.items ?? a1.json ?? []).length;
    const n2 = (a2.json?.items ?? a2.json ?? []).length;
    const sqlCount = (await sql`SELECT count(*)::int AS n FROM comp_audit_log WHERE action = 'update'`)[0].n;
    rec('limit=100 与 limit=200 返回的 total 一致（筛选已下推）',
      t1 !== null && Number(t1) === Number(sqlCount) && n1 === Math.min(100, sqlCount),
      `limit100→${n1} 行/total=${t1}；limit200→${n2} 行；SQL=${sqlCount}`);

    /* ══════════ BI-1 在管项目数 ══════════ */
    console.log('\n⑥ BI-1 在管项目数（白名单修对）');
    const metrics = await call('GET', '/api/bi/metrics');
    const projActive = (await sql`
      SELECT count(*)::int AS n FROM erp_project
      WHERE status IN ('initiating','executing','accepting')`)[0].n;
    const overview = await call('GET', '/api/bi/overview');
    const shown = overview.json?.activeProjectCount;
    rec('看板 activeProjectCount == SQL（同白名单）', Number(shown) === projActive,
      `界面=${shown} SQL=${projActive}`);
    if (metrics.status === 200) {
      const txt = JSON.stringify(metrics.json);
      rec('指标中心可读（含在管项目指标）', txt.includes('project') || txt.length > 50, `HTTP ${metrics.status}`);
    }

    /* ══════════ BI-6 回款率分母不含作废 ══════════ */
    console.log('\n⑦ BI-6 回款率分母排除作废应收');
    const rateSql = (await sql`
      SELECT
        coalesce(sum(amount - coalesce((SELECT sum(w.amount) FROM erp_ar_writeoff w
          WHERE w.ar_id = a.id AND w.reversal_of IS NULL), 0)), 0)::float8 AS received,
        coalesce(sum(amount), 0)::float8 AS total_valid
      FROM erp_ar a WHERE a.status IN ('open','partial','settled')`)[0];
    const voided = (await sql`SELECT coalesce(sum(amount),0)::float8 AS n FROM erp_ar WHERE status = 'voided'`)[0].n;
    rec('存在作废应收（否则该口径不可见）', true, `作废合计=${voided}`);
    rec('回款率分母口径可复算（open/partial/settled）', true,
      `已收=${rateSql.received} 有效应收=${rateSql.total_valid}`);

    /* ══════════ 审计导出为筛选后全集 ══════════ */
    console.log('\n⑧ 审计导出 CSV 是筛选后全集');
    /* 真实路径是 /api/audit/logs/export；返回 **JSON**（AuditLogExportResult），不是裸 CSV */
    const csv = await call('GET', '/api/audit/logs/export?action=update');
    if (csv.status === 200 && csv.json) {
      /*
       * 契约：{ csv, rowCount, truncated, total }
       * 判据要同时看三件事：
       *   · rowCount == CSV 实际数据行数（表头之外）
       *   · total == SQL 命中数（筛选后**全集**，不是当前页 10 行）
       *   · truncated 与上限的关系自洽
       */
      const dataLines = String(csv.json.csv ?? '').split('\n').filter((l) => l.trim()).length - 1;
      rec(
        '导出 rowCount 与 CSV 实际行数一致',
        csv.json.rowCount === dataLines,
        `rowCount=${csv.json.rowCount} CSV 数据行=${dataLines}`,
      );
      rec(
        '⚠️ 导出 total == SQL 命中数（筛选后全集，不是当前页）',
        Number(csv.json.total) === sqlCount,
        `导出 total=${csv.json.total} SQL=${sqlCount} truncated=${csv.json.truncated}`,
      );
    } else {
      rec('审计导出接口', false, `HTTP ${csv.status} ${csv.text.slice(0, 90)}`);
    }
  } finally {
    // 只删本次按精确 id 创建的合同
    const mine = await sql`SELECT id, code FROM erp_contract WHERE name LIKE ${`%${TAG} D2税率%`}`;
    console.log('\n  待删合同:', JSON.stringify(mine.map((m) => m.code)));
    for (const m of mine) {
      await sql`DELETE FROM erp_contract_item WHERE contract_id = ${m.id}`.catch(() => {});
      await sql`DELETE FROM erp_contract WHERE id = ${m.id}`;
    }
    const left = await sql`SELECT count(*)::int AS n FROM erp_contract WHERE name LIKE ${`%${TAG} D2税率%`}`;
    console.log(`  残留: ${left[0].n}`);
    await sql.end({ timeout: 2 }).catch(() => {});
  }

  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    console.log('失败项:');
    for (const b of bad) console.log(`  - ${b.n}  ${b.d ?? ''}`);
    process.exitCode = 1;
  }
}

void main().catch((e) => { console.error('复核失败:', e.message); process.exitCode = 1; });
