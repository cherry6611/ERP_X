/**
 * 冒烟测试：确认 CDP 驱动本身可用（登录 → 打开看板 → 截图 → 收集诊断）。
 * 用法：node scripts/browser-walkthrough/smoke.mjs
 */
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const USER = process.env.WT_USER ?? 'chengsheng@chengshengdata.cn';
const PASS = process.env.WT_PASS ?? '******';

const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
console.log('login status', login.status);
const setCookie = login.headers.getSetCookie?.() ?? [];
const session = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session='));
if (!session) {
  console.log('原始 Set-Cookie:', setCookie);
  process.exit(1);
}
const sessionValue = session.slice('erp_session='.length);

const browser = await Browser.launch({ port: 9333 });
const page = await browser.newPage();
await page.enable();
await page.setViewport(1600, 1000);
await page.setCookie({ name: 'erp_session', value: sessionValue, url: APP });

await page.goto(`${APP}/`);
await sleep(1500);

const snap = await page.snapshot();
console.log('URL        :', snap.url);
console.log('title      :', snap.title);
console.log('textLength :', snap.textLength);
console.log('buttons    :', snap.buttons.slice(0, 20));
console.log('dialogs    :', snap.dialogs, 'tables:', snap.tables);
console.log('--- text head ---');
console.log(snap.text.slice(0, 800));
console.log('--- exceptions ---', page.exceptions.length);
for (const e of page.exceptions.slice(0, 5)) console.log('  ', e.text, e.description?.slice(0, 200));
console.log('--- console errors ---');
for (const c of page.consoleLogs.filter((c) => c.type === 'error').slice(0, 8)) {
  console.log('  ', c.text.slice(0, 300));
}
console.log('--- http errors ---');
for (const h of page.httpErrors.slice(0, 8)) console.log('  ', h.status, h.method, h.url);

await page.screenshot('scripts/browser-walkthrough/out/smoke-dashboard.png');
console.log('screenshot saved');

await browser.close();
