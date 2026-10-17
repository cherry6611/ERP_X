/**
 * 全页面视觉巡检：逐页截图 + 结构断言，产出一张可人工审阅的清单。
 *
 * 用法：
 *   node scripts/browser-walkthrough/ui-sweep.mjs            # 全部路由
 *   node scripts/browser-walkthrough/ui-sweep.mjs /finance   # 单页
 *
 * 产出：
 *   scripts/browser-walkthrough/out/ui/<slug>.png   逐页截图（可视区，非整页）
 *   scripts/browser-walkthrough/out/ui-sweep.json   结构断言结果
 *
 * 每页采集（都是"用眼睛看之前能自动判定的"项）：
 *   · 页头是否有标题、actions 区是否与标题同行（top 差 > 8px 视为错位）
 *   · FilterBar 内的按钮清单（区分"刷新/导出"这类工具动作 vs 表单提交）
 *   · 横向溢出（1280 与 1700 两档）
 *   · console.error / 未捕获异常 / HTTP ≥400
 *   · 可见文本里是否出现 **markdown 星号**（`**不做合规判定**` 这类：
 *     它们本该被渲染成粗体，出现在 DOM 文本里说明是纯文本漏渲染 —— 观感缺陷）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const OUT = 'scripts/browser-walkthrough/out';
const UI = `${OUT}/ui`;

/** 与 walk-routes.mjs 同源的路由表，去掉需要真实 id 的详情页（那些另有脚本覆盖） */
const ROUTES = [
  ['/', '经营看板'],
  ['/bi/metrics', '指标中心'],
  ['/customers', '客户管理'],
  ['/crm', '线索与商机'],
  ['/contracts', '合同管理'],
  ['/suppliers', '供应商管理'],
  ['/masterdata/tax-entities', '纳税主体'],
  ['/projects', '项目管理'],
  ['/costs', '成本核算'],
  ['/pur', '采购管理'],
  ['/returns', '退货管理'],
  ['/asset', '固定资产'],
  ['/revenue', '收入确认'],
  ['/finance', '应收应付'],
  ['/notes', '票据管理'],
  ['/fin-expense', '预算费控'],
  ['/voucher', '总账凭证'],
  ['/finance/reports', '财务报表'],
  ['/finance/ledgers', '会计账簿'],
  ['/finance/year-end', '期末年结'],
  ['/finance/tax-declaration', '增值税申报'],
  ['/hr', '人力资源'],
  ['/admin-rent', '租房合同'],
  ['/admin-bills', '行政缴费'],
  ['/admin-assets', '行政资产'],
  ['/admin-affairs', '车辆与差旅'],
  ['/admin-automation', '自动化任务'],
  ['/audit', '审计日志'],
  ['/data-asset', '数据资产'],
  ['/drive', '云空间'],
  ['/wiki', '知识库'],
  ['/settings', '设置'],
  ['/crm/leads/new', '新建线索'],
  ['/crm/opportunities/new', '新建商机'],
  ['/contracts/new', '新建合同'],
  ['/projects/new', '新建项目'],
  ['/finance/invoices/new', '新建发票'],
];

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.BOOTSTRAP_ADMIN_USERNAME,
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    }),
  });
  if (res.status !== 201) throw new Error(`登录失败 ${res.status}`);
  const jar = res.headers.getSetCookie?.() ?? [];
  return jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session=')).slice(12);
}

function probePage() {
  const h1 = document.querySelector('h1');
  const headerRow = h1 ? h1.parentElement?.parentElement : null;
  const actions = headerRow && headerRow.children.length > 1 ? headerRow.children[1] : null;
  const hr = h1 ? h1.getBoundingClientRect() : null;
  const ar = actions ? actions.getBoundingClientRect() : null;
  /* 找 FilterBar：一个含 >=2 个 label 的圆角边框容器 */
  const bars = [...document.querySelectorAll('div')].filter((d) => {
    const cls = String(d.className || '');
    return (
      cls.includes('border') &&
      cls.includes('rounded') &&
      d.querySelectorAll('label').length >= 2 &&
      d.clientHeight < 120
    );
  });
  const bar = bars[0] ?? null;
  const barBtns = bar
    ? [...bar.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean)
    : [];
  const bodyText = document.body.innerText || '';

  /*
   * markdown 强调标记必须在**渲染后的 DOM** 上查，不要在源码上正则：
   * 源码里的成对星号绝大多数落在注释里（本仓注释大量使用强调），
   * 按行/按字符串匹配会大量误报（我为此写坏过两版审计脚本）。
   * 走 DOM 文本节点则**渲染出来带星号 = 真缺陷**，零误报。
   *
   * 手工用 indexOf 配对而不是正则，避免在两层模板字符串里嵌套正则转义。
   */
  const badNodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = (node.nodeValue || '').trim();
    if (!t || t.length > 300) continue;
    const parts = t.split('**');
    const stars = [];
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const inner = parts[i];
      if (inner && inner.length <= 40 && inner.indexOf(String.fromCharCode(10)) < 0) {
        stars.push('**' + inner + '**');
      }
    }
    if (stars.length) badNodes.push({ stars: stars.slice(0, 3), sample: t.slice(0, 90) });
    if (badNodes.length >= 6) break;
  }

  return {
    h1: h1 ? (h1.textContent || '').trim() : null,
    h1Top: hr ? Math.round(hr.top) : null,
    actionsTop: ar ? Math.round(ar.top) : null,
    actionsBtns: actions
      ? [...actions.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean)
      : [],
    filterBarBtns: barBtns,
    badNodes,
    markdownStars: badNodes.flatMap((b) => b.stars),
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    textLen: bodyText.length,
  };
}
const PROBE_SRC = '(' + probePage.toString() + ')()';

async function main() {
  mkdirSync(UI, { recursive: true });
  const only = process.argv.find((a) => a.startsWith('/'));
  const list = only ? ROUTES.filter(([r]) => r === only) : ROUTES;
  if (only && list.length === 0) {
    // 允许巡检不在表里的路由
    list.push([only, only]);
  }

  const browser = await Browser.launch({ port: Number(process.env.WT_CDP_PORT ?? 9378) });
  const page = await browser.newPage();
  await page.enable();
  await page.setCookie({ name: 'erp_session', value: await login(), url: APP });
  const report = [];

  try {
    for (const [route, label] of list) {
      page.resetDiagnostics();
      const row = { route, label };
      try {
        await page.setViewport(1700, 1100);
        await page.goto(`${APP}${route}`, { settleMs: 2200 });
        await sleep(1000);
        Object.assign(row, await page.evaluate(PROBE_SRC), { ok: true });

        await page.setViewport(1280, 900);
        await sleep(700);
        const narrow = await page.evaluate(
          `(() => ({ overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2, w: document.documentElement.scrollWidth }))()`,
        );
        row.narrow1280 = narrow;

        await page.setViewport(1700, 1100);
        await sleep(400);
        const slug = (route.replace(/[/?=&]/g, '_') || '_root');
        await page.screenshot(`${UI}/${slug}.png`, { fullPage: false });
        row.shot = `${slug}.png`;

        row.diag = {
          exceptions: page.exceptions.length,
          consoleErrors: page.consoleLogs.filter((l) => l.type === 'error').length,
          httpErrors: page.httpErrors.length,
        };
      } catch (e) {
        row.ok = false;
        row.error = e.message;
      }
      report.push(row);
      const flags = [];
      if (row.ok === false) flags.push('NAV-FAIL');
      if (row.markdownStars?.length) flags.push(`markdown星号×${row.markdownStars.length}`);
      if (row.h1Top != null && row.actionsTop != null && Math.abs(row.h1Top - row.actionsTop) > 8) flags.push('页头错位');
      if (row.narrow1280?.overflowX) flags.push('1280溢出');
      if (row.diag?.exceptions) flags.push(`异常${row.diag.exceptions}`);
      if (row.diag?.consoleErrors) flags.push(`cerr${row.diag.consoleErrors}`);
      if (row.diag?.httpErrors) flags.push(`http${row.diag.httpErrors}`);
      console.log(
        `  ${flags.length ? '! ' : 'ok'} ${label.padEnd(12)} ${route.padEnd(30)}` +
          ` actions=${JSON.stringify(row.actionsBtns ?? []).slice(0, 40)}` +
          `${flags.length ? '  → ' + flags.join(' ') : ''}`,
      );
    }
  } finally {
    writeFileSync(`${OUT}/ui-sweep.json`, JSON.stringify(report, null, 2));
    await browser.close().catch(() => {});
  }

  const bad = report.filter(
    (r) => r.ok === false || r.markdownStars?.length || r.narrow1280?.overflowX || r.diag?.exceptions || r.diag?.consoleErrors || r.diag?.httpErrors,
  );
  console.log(`\n共 ${report.length} 页，可疑 ${bad.length} 页`);
  if (bad.length) {
    console.log('可疑清单：');
    for (const b of bad) {
      console.log(`  ${b.label} ${b.route}`);
      if (b.markdownStars?.length) console.log(`     未渲染的 markdown 星号: ${JSON.stringify(b.markdownStars)}`);
      if (b.narrow1280?.overflowX) console.log(`     1280px 横向溢出（scrollW=${b.narrow1280.w}）`);
      if (b.error) console.log(`     导航失败: ${b.error}`);
      if (b.diag) console.log(`     诊断: ${JSON.stringify(b.diag)}`);
    }
  }
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
