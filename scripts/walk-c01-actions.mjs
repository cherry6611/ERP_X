import pkg from 'file:///C:/Users/20127/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const { chromium } = pkg;
const BASE = 'http://127.0.0.1:5173';
const SHOT = 'C:/Users/20127/Desktop/晟笙ERP/deliverables/_walk';
function log(...a) { console.log('[C01-ACTION]', ...a); }

async function toasts(page) {
  const sel = '[data-sonner-toast], [role="status"], [role="alert"], .toast';
  const t = await page.locator(sel).allInnerTexts().catch(() => []);
  return t.filter(Boolean);
}

async function rowStatus(page) {
  const row = page.locator('table tbody tr', { hasText: 'INV2026100002' }).first();
  return (await row.innerText().catch(() => 'ROW_GONE')).replace(/\s+/g, ' | ');
}

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const api = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/invoices/') || u.includes('verify') || u.includes('certif')) {
      api.push(r.status() + ' ' + r.request().method() + ' ' + u.replace('http://127.0.0.1:5173/api/finance/', ''));
    }
  });

  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.fill('#login-username', 'chengsheng@chengshengdata.cn');
  await page.fill('#login-password', '');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
  await page.goto(BASE + '/finance', { waitUntil: 'networkidle' });
  await page.getByText('发票登记', { exact: true }).first().click();
  await page.waitForTimeout(1500);

  log('初始行:', await rowStatus(page));

  // ---- 测试1：查验（Provider=none，观察行为） ----
  log('=== 测试1：点击 [查验]（none Provider） ===');
  const verifyBtn = page.locator('table tbody tr', { hasText: 'INV2026100002' }).first().getByRole('button', { name: '查验' });
  if (await verifyBtn.count() === 0) { log('查验按钮不可见！'); }
  else {
    await verifyBtn.click();
    await page.waitForTimeout(1500);
    log('查验后 toast:', JSON.stringify(await toasts(page)));
    log('查验后行:', await rowStatus(page));
    await page.screenshot({ path: `${SHOT}/c01_查验后.png` });
  }

  // ---- 测试2：认证 - 非法期间 ----
  log('=== 测试2：点击 [认证] 输入非法期间 2026-13 ===');
  page.once('dialog', (d) => { log('  dialog prompt:', d.message()); d.accept('2026-13'); });
  const certifyBtn = page.locator('table tbody tr', { hasText: 'INV2026100002' }).first().getByRole('button', { name: '认证' });
  if (await certifyBtn.count() === 0) { log('认证按钮不可见！'); }
  else {
    await certifyBtn.click();
    await page.waitForTimeout(1200);
    log('非法期间 toast:', JSON.stringify(await toasts(page)));
    log('非法期间后行:', await rowStatus(page));
    await page.screenshot({ path: `${SHOT}/c01_认证非法期间.png` });
  }

  // ---- 测试3：认证 - 合法期间 2026-10 ----
  log('=== 测试3：点击 [认证] 输入合法期间 2026-10 ===');
  page.once('dialog', (d) => { log('  dialog prompt:', d.message()); d.accept('2026-10'); });
  await certifyBtn.click();
  await page.waitForTimeout(1500);
  log('合法期间 toast:', JSON.stringify(await toasts(page)));
  log('合法期间后行:', await rowStatus(page));
  await page.screenshot({ path: `${SHOT}/c01_认证成功.png` });

  console.log('=== C01 API 调用 ===');
  api.forEach((c) => console.log(' ', c));
  await browser.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
