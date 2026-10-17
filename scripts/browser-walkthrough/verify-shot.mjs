/**
 * 定点复验：只打开指定路由并截图，用于修复后的快速回归。
 * 用法：node verify-shot.mjs <route> <name> [route name ...]
 */
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const USER = process.env.WT_USER ?? 'chengsheng@chengshengdata.cn';
const PASS = process.env.WT_PASS ?? '';

const pairs = [];
for (let i = 0; i + 1 < process.argv.length - 1; i += 2) {
  pairs.push([process.argv[i + 2], process.argv[i + 3]]);
}
if (pairs.length === 0) {
  console.error('用法: node verify-shot.mjs <route> <name> [...]');
  process.exit(1);
}

const res = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const jar = res.headers.getSetCookie?.() ?? [];
const session = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session='));
const browser = await Browser.launch({ port: 9337 });
const page = await browser.newPage();
await page.enable();
await page.setViewport(1600, 1000);
await page.setCookie({ name: 'erp_session', value: session.slice(12), url: APP });

for (const [route, name] of pairs) {
  page.resetDiagnostics();
  await page.goto(`${APP}${route}`, { settleMs: 1600 });
  await sleep(1200);
  const text = await page.evaluate('document.body.innerText');
  const out = `scripts/browser-walkthrough/out/verify-${name}.png`;
  await page.screenshot(out);
  console.log(`\n=== ${route} → ${out} ===`);
  console.log(text.slice(0, 1500));
  console.log(`exceptions=${page.exceptions.length} consoleErrors=${page.consoleLogs.filter((c) => c.type === 'error').length} httpErrors=${page.httpErrors.length}`);
}

await browser.close();
