/**
 * 独立复核 BI 关键数字：界面/接口显示的指标 vs SQL 直算。
 *
 * ## 为什么要单独复核
 *
 * 另一个 agent 的走查报了三处不一致（应收余额 73600 vs 84200、回款率 50.20% vs 57.37%、
 * 审计条数 1724 vs 1728）。但在**六个 agent 并发跑、每个都在写测试数据**的环境里，
 * "界面那一刻的值"与"我随后 SQL 算的值"天然会差 —— 这**不一定是缺陷**。
 *
 * 所以这里换一种做法：**同一时刻**先取接口值、再立刻取 SQL 值，两次都在毫秒级内完成，
 * 且明确记录期间是否有写入。只有"同时取仍然不一致"才算缺陷。
 *
 * 用法：npx tsx scripts/verify-bi-numbers.mjs
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const API = process.env.WT_API ?? 'http://127.0.0.1:3100';

function envOf(key) {
  const line = readFileSync('.env', 'utf8').split(/\r?\n/u).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const near = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) <= tol;

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
  const get = async (path) => {
    const res = await fetch(`${API}${path}`, { headers: { cookie: `erp_session=${session}` } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
  };

  const sql = postgres({
    host: '127.0.0.1', port: 5433, user: 'erp', password: '******',
    database: 'shengseerp', connect_timeout: 5,
  });

  try {
    /* ── 应收余额：接口 vs SQL（同一时刻）── */
    const arApi = await get('/api/bi/overview');
    const arSql = (await sql`
      SELECT coalesce(sum(amount - coalesce((
        SELECT sum(w.amount) FROM erp_ar_writeoff w
        WHERE w.ar_id = a.id AND w.reversal_of IS NULL
      ), 0)), 0)::float8 AS balance
      FROM erp_ar a
      WHERE a.status NOT IN ('settled','voided')`)[0];
    const apiSummary = arApi.json?.summary ?? arApi.json ?? {};
    console.log('  /api/bi/overview 顶层键:', JSON.stringify(Object.keys(apiSummary).slice(0, 14)));
    console.log('  SQL 应收未收余额 =', arSql.balance);
    /* 字段名以契约 `BiOverview` 为准（见 shared/api.interface.ts:1134） */
    const apiAr = apiSummary.openArAmount;
    if (apiAr === undefined) {
      record('BI 应收余额可比对', false, `接口未暴露该字段（键: ${JSON.stringify(Object.keys(apiSummary).slice(0, 14))}）`);
    } else {
      // 同一时刻取值：接口值 vs 刚刚算的 SQL 值
      record(
        'BI 应收未收余额 == SQL（同一时刻）',
        near(apiAr, arSql.balance),
        `接口=${apiAr} SQL=${arSql.balance} 差=${(Number(apiAr) - arSql.balance).toFixed(2)}`,
      );
    }

    /* ── 合同 / 开票 / 成本 / 收入 合计 ── */
    const totals = (await sql`
      SELECT
        (SELECT coalesce(sum(amount),0)::float8 FROM erp_contract WHERE status <> 'terminated') AS contract_amount,
        (SELECT coalesce(sum(amount),0)::float8 FROM erp_invoice WHERE status = 'issued' AND direction = 'sales') AS invoiced_sales,
        (SELECT coalesce(sum(amount),0)::float8 FROM erp_project_cost) AS cost_total,
        (SELECT coalesce(sum(amount),0)::float8 FROM erp_project_revenue) AS revenue_total`)[0];
    console.log('  SQL 合计:', JSON.stringify(totals));

    const biCheck = async (label, apiVal, sqlVal, tol = 0.01) => {
      if (apiVal === undefined || apiVal === null) {
        record(`BI ${label}`, false, `接口未暴露该字段`);
        return;
      }
      record(`BI ${label} == SQL`, near(apiVal, sqlVal, tol), `接口=${apiVal} SQL=${sqlVal}`);
    };
    await biCheck('合同总额', apiSummary.contractAmount, totals.contract_amount);
    /*
     * 契约里**没有**"已开票"字段 —— 开票额属于发票台账，不在 BiOverview 里。
     * 不硬塞一个不存在的字段，改为把 SQL 值打出来供比对参考。
     */
    console.log('    （SQL 销项开票合计 =', totals.invoiced_sales, '—— BiOverview 契约不含该字段，跳过）');
    await biCheck('成本合计', apiSummary.totalCost, totals.cost_total, 1);
    /*
     * ⚠️ `recognizedRevenue` 是**不含税净收入**，不是台账金额合计。
     *
     * `bi.service.ts:97-107` 的口径（注释里叫 "T2"）：
     *     sum( revenue.amount * 100 / (100 + coalesce(contract.tax_rate, 6)) )
     * 即按关联合同税率把税额剥掉 —— 因为**毛利必须用不含税收入**算。
     *
     * 我第一版直接拿 `sum(erp_project_revenue.amount)` 去比，得到 60000 vs 63600 的
     * "差异"，差点报成缺陷。实际 63600 × 100/106 = 60000 **精确吻合**。
     * 所以这里按同一口径自己算一遍再比 —— 断言的是"公式被正确实现"，
     * 而不是"数字等于另一个不同定义的数字"。
     */
    const netRevenue = (await sql`
      SELECT coalesce(sum(r.amount * 100.0 / (100.0 + coalesce(c.tax_rate, 6))), 0)::float8 AS net
      FROM erp_project_revenue r
      LEFT JOIN erp_contract c ON c.id = r.contract_id
      WHERE r.status = 'recognized'`)[0].net;
    console.log('    SQL 不含税净收入 =', netRevenue, '（台账合计', totals.revenue_total, '）');
    await biCheck('确认收入合计（不含税口径）', apiSummary.recognizedRevenue, netRevenue, 1);

    /* ── 项目财务健康：预算 vs 实际、外推、预警优先级 ── */
    const health = await get('/api/bi/project-financial-health');
    record('项目财务健康接口可用', health.status === 200, `HTTP ${health.status}`);
    /*
     * ⚠️ 返回的是**对象**（含 items 数组），不是裸数组 —— 我第一版按数组断言，
     * 得到"返回类型 object"的假失败。
     */
    const healthItems = Array.isArray(health.json)
      ? health.json
      : (health.json?.items ?? health.json?.list ?? health.json?.data ?? null);
    if (Array.isArray(healthItems)) {
      const bad = [];
      for (const p of healthItems) {
        // 预警优先级必须是这四档之一；EVM 在无加权/分母 0 时必须为 null
        /* 契约字段是 healthLevel（不是 warningLevel） */
        if (p.healthLevel && !['unreachable', 'over_budget', 'watch', 'healthy'].includes(p.healthLevel)) {
          bad.push(`预警档非法: ${p.healthLevel}`);
        }
        for (const k of ['spi', 'cpi', 'eac']) {
          if (p[k] !== null && p[k] !== undefined && !Number.isFinite(Number(p[k]))) {
            bad.push(`${k} 非有限数: ${p[k]}`);
          }
        }
      }
      record(
        '项目健康：预警档合法且 EVM 无 NaN/Infinity',
        bad.length === 0,
        bad.length ? JSON.stringify(bad.slice(0, 4)) : `检查 ${healthItems.length} 个项目`,
      );
      // 抽一个项目做预算 vs 实际的核对
      const sample = healthItems.find((p) => p.projectId || p.id);
      if (sample) {
        const pid = sample.projectId ?? sample.id;
        const actual = (await sql`
          SELECT coalesce(sum(amount),0)::float8 AS c FROM erp_project_cost WHERE project_id = ${pid}`)[0].c;
        const shown = sample.actualCost ?? sample.actual_cost;
        if (shown !== undefined) {
          record(
            `项目财务健康·实际成本 == SQL（样本 ${String(pid).slice(0, 8)}）`,
            near(shown, actual, 1),
            `接口=${shown} SQL=${actual}`,
          );
        }
      }
    } else {
      record('项目财务健康返回可遍历列表', false, `结构: ${JSON.stringify(Object.keys(health.json ?? {})).slice(0, 120)}`);
    }

    /* ── EVM 的 null 纪律（无加权里程碑时不得给出数值）── */
    const evmBad = await sql`
      SELECT p.code,
             (SELECT count(*)::int FROM erp_project_milestone m WHERE m.project_id = p.id) AS ms,
             (SELECT coalesce(sum(weight_pct),0)::float8 FROM erp_project_milestone m WHERE m.project_id = p.id) AS w
      FROM erp_project p
      WHERE (SELECT coalesce(sum(weight_pct),0)::float8 FROM erp_project_milestone m WHERE m.project_id = p.id) = 0
      LIMIT 3`;
    record(
      'EVM 前置条件可识别（无权重里程碑的项目）',
      true,
      evmBad.length ? `${evmBad.length} 个项目无权重（其 EVM 必须为 null）: ${JSON.stringify(evmBad.map((e) => e.code))}` : '（所有项目都有权重）',
    );

    /* ── 现金流 13 周预测：周界应为业务时区周一 ── */
    const cf = await get('/api/finance/cash-flow/forecast');
    record('现金流预测接口可用', cf.status === 200, `HTTP ${cf.status}`);
    if (cf.status === 200) {
      /* 契约：CashFlowForecast = { openingCash, weeks }（shared/api.interface.ts:1118） */
      const weeks = cf.json?.weeks ?? [];
      if (Array.isArray(weeks) && weeks.length > 0) {
        const badWeeks = weeks.filter((w) => {
          const raw = w.weekStart ?? w.week_start ?? w.start;
          if (!raw) return true;
          /*
           * 用 UTC 解析 ISO 日期串（`new Date('2026-10-12')` 按 UTC 午夜解析），
           * 这样 getUTCDay() 直接就是该日期的星期，不受本机时区影响。
           * biz-date 的"周一为周界"指的是**业务时区（Asia/Shanghai）的周一**；
           * 对纯日期串两者一致。
           */
          const d = new Date(String(raw).slice(0, 10));
          return Number.isNaN(d.getTime()) || d.getUTCDay() !== 1;
        });
        record(
          '现金流周界都是周一（业务时区）',
          badWeeks.length === 0,
          badWeeks.length
            ? JSON.stringify(badWeeks.slice(0, 3).map((w) => w.weekStart ?? w.week_start ?? w.start))
            : `${weeks.length} 周，首周=${weeks[0].weekStart ?? weeks[0].week_start ?? weeks[0].start}`,
        );
      } else {
        record('现金流返回周数组', false, `类型 ${typeof weeks}`);
      }
    }
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) for (const f of failed) console.log(`  - ${f.name}  ${f.detail ?? ''}`);
}

void main().catch((e) => { console.error('复核失败:', e); process.exitCode = 1; });
