/**
 * 全路由走查：逐页导航 + 整页截图 + 诊断采集。
 *
 * 与"点一遍看看"的区别：每页记录
 *   · 控制台 error/warning、未捕获异常、HTTP ≥400、失败请求
 *   · 页面可见文本（用于判断空态/报错态/乱码）
 *   · 交互元素清单（按钮/输入框/表格/弹窗）
 * 并把整页截图落盘，供人工看 UI 美观问题（溢出、错位、空白、遮挡）。
 *
 * 用法：node scripts/browser-walkthrough/walk-routes.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const USER = process.env.WT_USER ?? 'chengsheng@chengshengdata.cn';
const PASS = process.env.WT_PASS ?? '******';
const OUT = 'scripts/browser-walkthrough/out';

/** client/src/app.tsx 里的路由（参数位用种子数据里的真实 id 替换） */
const SEED = {
  projectId: process.env.WT_PROJECT_ID ?? '',
  contractId: process.env.WT_CONTRACT_ID ?? '',
  opportunityId: process.env.WT_OPPORTUNITY_ID ?? '',
  quotationId: process.env.WT_QUOTATION_ID ?? '',
  invoiceId: process.env.WT_INVOICE_ID ?? '',
  voucherId: process.env.WT_VOUCHER_ID ?? '',
  leadId: process.env.WT_LEAD_ID ?? '',
  customerId: process.env.WT_CUSTOMER_ID ?? '',
};

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
  ['/fin-expense', '预算费控/报销'],
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
  // 明细/新建页（原先被路由守卫 fail-open 放行的那批，重点回归）
  ['/crm/leads/new', '新建线索'],
  ['/crm/opportunities/new', '新建商机'],
  ['/contracts/new', '新建合同'],
  ['/projects/new', '新建项目'],
  ['/finance/invoices/new', '新建发票'],
  ['/finance/tax-declaration?period=2026-10', '增值税申报(带期间)'],
  ...(SEED.projectId
    ? [
        [`/projects/${SEED.projectId}`, '项目详情'],
        [`/projects/${SEED.projectId}/edit`, '项目编辑'],
      ]
    : []),
  ...(SEED.contractId ? [[`/contracts/${SEED.contractId}`, '合同详情']] : []),
  ...(SEED.voucherId ? [[`/voucher/${SEED.voucherId}`, '凭证详情']] : []),
  ...(SEED.invoiceId ? [[`/finance/invoices/${SEED.invoiceId}`, '发票详情']] : []),
];

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (res.status !== 201) throw new Error(`登录失败: ${res.status} ${await res.text()}`);
  const jar = res.headers.getSetCookie?.() ?? [];
  const session = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session='));
  if (!session) throw new Error('未拿到 erp_session');
  return session.slice('erp_session='.length);
}

mkdirSync(OUT, { recursive: true });
const sessionValue = await login();

const browser = await Browser.launch({ port: 9334 });
const page = await browser.newPage();
await page.enable();
await page.setViewport(1600, 1000);
await page.setCookie({ name: 'erp_session', value: sessionValue, url: APP });

const report = [];
let i = 0;
for (const [route, label] of ROUTES) {
  i += 1;
  page.resetDiagnostics();
  const slug = route.replace(/[/?=&]/g, '_') || 'root';
  let navError = null;
  try {
    await page.goto(`${APP}${route}`, { settleMs: 1400 });
    // 图表/表格常需要额外一拍
    await sleep(900);
  } catch (error) {
    navError = error.message;
  }

  let snap = null;
  try {
    snap = await page.snapshot();
  } catch (error) {
    navError = `${navError ?? ''} snapshot失败: ${error.message}`;
  }

  const consoleErrors = page.consoleLogs
    .filter((c) => c.type === 'error')
    .map((c) => c.text.slice(0, 300));
  const consoleWarns = page.consoleLogs
    .filter((c) => c.type === 'warning')
    .map((c) => c.text.slice(0, 200));

  /*
   * 503 = "可选集成未配置"（飞书云空间/知识库凭证未填）。这不是缺陷，
   * 而是设计上的 fail-closed：未配置时后端明确拒绝并给出可读原因，
   * 前端也渲染了引导文案。单独归类，避免把它混进"真异常"里淹没信号。
   */
  const config503 = page.httpErrors.filter((h) => h.status === 503);
  const realHttpErrors = page.httpErrors.filter((h) => h.status !== 503);

  const entry = {
    idx: i,
    route,
    label,
    finalUrl: snap?.url ?? null,
    textLength: snap?.textLength ?? 0,
    textHead: (snap?.text ?? '').slice(0, 1200),
    buttonCount: snap?.buttons?.length ?? 0,
    buttons: (snap?.buttons ?? []).slice(0, 40),
    inputCount: snap?.inputs?.length ?? 0,
    tableCount: snap?.tables ?? 0,
    dialogCount: snap?.dialogs ?? 0,
    exceptions: page.exceptions.map((e) => ({
      text: e.text,
      description: (e.description ?? '').slice(0, 400),
    })),
    consoleErrors,
    consoleWarns,
    httpErrors: realHttpErrors,
    configNotConfigured503: config503,
    failedRequests: page.failedRequests,
    navError,
  };
  report.push(entry);

  try {
    await page.screenshot(`${OUT}/route-${String(i).padStart(2, '0')}-${slug}.png`);
  } catch (error) {
    entry.screenshotError = error.message;
  }

  const flag =
    entry.exceptions.length ||
    consoleErrors.length ||
    entry.httpErrors.length ||
    navError
      ? 'XX'
      : 'ok';
  console.log(
    `[${flag}] ${String(i).padStart(2, '0')} ${route} — ${label} | text=${entry.textLength} ` +
      `btn=${entry.buttonCount} input=${entry.inputCount} table=${entry.tableCount} dlg=${entry.dialogCount} ` +
      `exc=${entry.exceptions.length} cerr=${consoleErrors.length} http=${entry.httpErrors.length}` +
      (config503.length ? ` | 503(未配置)=${config503.length}` : '')
  );
  if (entry.httpErrors.length) {
    for (const h of entry.httpErrors.slice(0, 4)) console.log(`        HTTP ${h.status} ${h.method} ${h.url}`);
  }
  if (consoleErrors.length) {
    for (const c of consoleErrors.slice(0, 3)) console.log(`        console: ${c.replace(/\n/g, ' ')}`);
  }
  if (entry.exceptions.length) {
    for (const e of entry.exceptions.slice(0, 3)) console.log(`        threw: ${e.text} ${e.description?.slice(0, 160)}`);
  }
  if (navError) console.log(`        navError: ${navError}`);
}

writeFileSync(`${OUT}/route-report.json`, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n报告已写入 ${OUT}/route-report.json（共 ${report.length} 页）`);
const bad = report.filter(
  (r) => r.exceptions.length || r.consoleErrors.length || r.httpErrors.length || r.navError
);
const cfg = report.filter((r) => (r.configNotConfigured503 ?? []).length);
console.log(`有异常的页面：${bad.length} / ${report.length}`);
for (const b of bad) console.log(`  - ${b.route} (${b.label})`);
if (cfg.length) {
  console.log(`因「可选集成未配置」返回 503 的页面（非缺陷）：${cfg.map((c) => c.route).join(', ')}`);
}

await browser.close();
