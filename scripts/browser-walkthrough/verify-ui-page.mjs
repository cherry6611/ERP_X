/**
 * 逐页 UI 复验：截图 + 结构断言。
 *
 * 用法：
 *   node scripts/browser-walkthrough/verify-ui-page.mjs /finance/tax-declaration
 *   node scripts/browser-walkthrough/verify-ui-page.mjs --shot /finance/tax-declaration
 */
import { mkdirSync } from 'node:fs';
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const SHOT_DIR = 'scripts/browser-walkthrough/out/ui';
const args = process.argv.slice(2);
const route = args.find((a) => a.startsWith('/')) ?? '/';
const wantShot = args.includes('--shot');

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.BOOTSTRAP_ADMIN_USERNAME,
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    }),
  });
  const jar = res.headers.getSetCookie?.() ?? [];
  return jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session=')).slice(12);
}

async function main() {
  const browser = await Browser.launch({ port: Number(process.env.WT_CDP_PORT ?? 9375) });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1700, 1100);
  await page.setCookie({ name: 'erp_session', value: await login(), url: APP });
  try {
    await page.goto(`${APP}${route}`, { settleMs: 2600 });
    await sleep(1600);

    const info = await page.evaluate(`(() => {
      const shell = document.querySelector('h1')?.closest('div.flex.items-start');
      const h1 = document.querySelector('h1');
      const actions = shell ? shell.children[1] : null;
      /* 页头 actions 区里的按钮 */
      const headerBtns = actions ? [...actions.querySelectorAll('button')].map((b) => (b.textContent || '').trim()) : [];
      /* 页头与 actions 的矩形，判断是否同一行、是否基线错位 */
      const hr = h1 ? h1.getBoundingClientRect() : null;
      const ar = actions ? actions.getBoundingClientRect() : null;
      /* FilterBar 里的按钮（应为 0 —— 筛选区应纯净，刷新类除外） */
      const fb = document.querySelector('[class*="rounded"][class*="border"][class*="p-4"]');
      const fbBtns = fb ? [...fb.querySelectorAll('button')].map((b) => (b.textContent || '').trim()) : [];
      const labels = [...document.querySelectorAll('label')].map((l) => (l.textContent || '').trim());
      return {
        h1: h1 ? (h1.textContent || '').trim() : null,
        h1Top: hr ? Math.round(hr.top) : null,
        actionsTop: ar ? Math.round(ar.top) : null,
        headerBtns,
        filterBarButtons: fbBtns,
        labels,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      };
    })()`);

    console.log(`  路由 ${route}`);
    console.log('  标题:', info.h1);
    console.log('  页头 actions 里的按钮:', JSON.stringify(info.headerBtns));
    console.log('  标题 top / actions top:', info.h1Top, '/', info.actionsTop);
    console.log('  页面 label:', JSON.stringify(info.labels));
    console.log('  横向溢出:', info.overflowX, `(${info.scrollW} vs ${info.clientW})`);

    if (wantShot) {
      mkdirSync(SHOT_DIR, { recursive: true });
      const file = `${SHOT_DIR}${route.replace(/\//g, '_') || '_root'}.png`;
      await page.screenshot(file, { fullPage: false });
      console.log('  截图:', file);
    }
    console.log('  诊断: exc=' + page.exceptions.length + ' cerr=' + page.consoleLogs.filter((l) => l.type === 'error').length + ' http4xx+=' + page.httpErrors.length);
    if (page.exceptions.length) console.log('   ', JSON.stringify(page.exceptions).slice(0, 200));
    if (page.httpErrors.length) console.log('   ', JSON.stringify(page.httpErrors).slice(0, 200));
  } finally {
    await browser.close().catch(() => {});
  }
}
void main().catch((e) => { console.error(e.message); process.exitCode = 1; });
