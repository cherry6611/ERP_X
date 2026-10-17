/**
 * 浏览器验证：增值税底稿里「不可比」行渲染 `—` 而非数字。
 *
 * 背景：用户已确认把"不同维度"的行（第 1 行 净销售额 vs 销项税额、
 * 第 1-1 / 25 行无账簿对应）**标记为不可比**。界面与导出必须据此渲染 `—`，
 * 否则使用者会把两个不同量纲的数并列理解成"申报数与账簿数相差这么多"。
 *
 * 实现方式与 `ui-sweep.mjs` 一致：**API 登录 → setCookie → 直接访问页面**
 * （不走登录表单，避免表单选择器变动导致脚本脆弱）。
 *
 * 用法：node scripts/browser-walkthrough/verify-vat-comparable.mjs
 */
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';

const results = [];
const rec = (n, pass, d) => {
  results.push({ n, pass, d });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
};

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

/** 读底稿表格的每行单元格文本 */
const READ_ROWS = `(() => {
  const trs = [...document.querySelectorAll('table tbody tr')];
  return trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').trim()));
})()`;

async function main() {
  const browser = await Browser.launch({ port: Number(process.env.WT_CDP_PORT ?? 9380) });
  const page = await browser.newPage();
  await page.enable();
  await page.setCookie({ name: 'erp_session', value: await login(), url: APP });
  try {
    await page.setViewport(1700, 1100);
    page.resetDiagnostics();
    await page.goto(`${APP}/finance/tax-declaration`, { settleMs: 2600 });
    await sleep(2200);

    const rows = await page.evaluate(READ_ROWS);
    rec('底稿表格已渲染', Array.isArray(rows) && rows.length > 0, `行数=${Array.isArray(rows) ? rows.length : 0}`);
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('表格未渲染，无法验证');

    const find = (rowNo) => rows.find((r) => (r[0] ?? '') === rowNo);
    const r1 = find('1');
    const r11 = find('1-1');
    const r12 = find('12');
    const r25 = find('25');

    rec('找到第 1 行', !!r1, r1 ? JSON.stringify(r1).slice(0, 140) : '未找到');
    rec('找到第 1-1 行', !!r11, r11 ? JSON.stringify(r11).slice(0, 140) : '未找到');

    const dashes = (row) => (row ?? []).filter((c) => c === '—').length;
    rec(
      '⚠️ 第 1 行「总账口径金额 / 差异」渲染 —（不再把销项税额当账面销售额并列）',
      dashes(r1) >= 2,
      r1 ? `— 个数=${dashes(r1)} 单元格=${JSON.stringify(r1)}` : '',
    );
    rec(
      '⚠️ 第 1-1 行同样渲染 —',
      dashes(r11) >= 2,
      r11 ? `— 个数=${dashes(r11)}` : '',
    );
    if (r25) {
      rec('第 25 行同样渲染 —', dashes(r25) >= 2, `— 个数=${dashes(r25)}`);
    } else {
      rec('第 25 行未渲染（金额为 0 时可能不计入）—— 允许', true, '');
    }

    /* 可比行不能受影响 */
    if (r12) {
      rec('⚠️ 可比行（第 12 行）仍是数字、不是 —', dashes(r12) === 0, `单元格=${JSON.stringify(r12)}`);
    } else {
      rec('第 12 行存在（可比行样本）', false, '未找到第 12 行，无法验证可比行未被误伤');
    }

    const diag = page.diagnostics ? page.diagnostics() : {};
    const ex = (diag.exceptions ?? []).length;
    const ce = (diag.consoleErrors ?? []).length;
    rec('页面无未捕获异常 / console.error', ex === 0 && ce === 0, JSON.stringify({ exceptions: ex, consoleErrors: ce }));
  } finally {
    await browser.close?.();
  }

  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    for (const b of bad) console.log(`  - ${b.n}  ${b.d ?? ''}`);
    process.exitCode = 1;
  }
}
void main().catch((e) => { console.error('复核失败:', e.message); process.exitCode = 1; });
