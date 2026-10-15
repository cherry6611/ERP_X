import pkg from 'file:///C:/Users/20127/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const { chromium } = pkg;
const BASE = 'http://127.0.0.1:5173';
const SHOT = 'C:/Users/20127/Desktop/晟笙ERP/deliverables/_walk';

function log(...a) { console.log('[C01]', ...a); }

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const apiCalls = [];
  page.on('response', (r) => { if (r.url().includes('/api/')) apiCalls.push(r.status() + ' ' + r.request().method() + ' ' + r.url().replace(BASE, '')); });
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)); });

  // 登录
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.fill('#login-username', 'chengsheng@chengshengdata.cn');
  await page.fill('#login-password', '******');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
  await page.goto(BASE + '/finance', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 点击 发票登记 Tab
  const tab = page.getByText('发票登记', { exact: true }).first();
  await tab.click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOT}/c01_发票登记tab.png` });
  log('发票登记 tab opened');

  // 转储表格行与按钮
  const rows = await page.locator('table tbody tr').evaluateAll((els) =>
    els.slice(0, 12).map((tr) => tr.innerText.replace(/\s+/g, ' | ').slice(0, 220))
  );
  console.log('=== invoice rows ===');
  rows.forEach((r, i) => console.log(`row${i}:`, r));

  const buttons = await page.locator('button').evaluateAll((els) =>
    els.map((b) => b.innerText.trim()).filter((t) => t && t.length < 20)
  );
  console.log('=== buttons ===', JSON.stringify([...new Set(buttons)]));

  console.log('=== api calls ===');
  apiCalls.slice(0, 30).forEach((c) => console.log(' ', c));
  await browser.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
