import pkg from 'file:///C:/Users/20127/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
import fs from 'node:fs';
const { chromium } = pkg;

const BASE = 'http://127.0.0.1:5173';
const SHOT_DIR = 'C:/Users/20127/Desktop/晟笙ERP/deliverables/_walk';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const PAGES = [
  ['经营看板', '/'],
  ['指标中心', '/bi/metrics'],
  ['客户管理', '/customers'],
  ['线索与商机', '/crm'],
  ['合同管理', '/contracts'],
  ['供应商管理', '/suppliers'],
  ['纳税主体', '/masterdata/tax-entities'],
  ['项目管理', '/projects'],
  ['成本核算', '/costs'],
  ['采购管理', '/pur'],
  ['退货管理', '/returns'],
  ['固定资产', '/asset'],
  ['收入确认', '/revenue'],
  ['应收应付', '/finance'],
  ['票据管理', '/notes'],
  ['预算费控', '/fin-expense'],
  ['总账凭证', '/voucher'],
  ['财务报表', '/finance/reports'],
  ['会计账簿', '/finance/ledgers'],
  ['期末年结', '/finance/year-end'],
  ['增值税申报', '/finance/tax-declaration'],
  ['人力资源', '/hr'],
  ['租房合同', '/admin-rent'],
  ['行政缴费', '/admin-bills'],
  ['行政资产', '/admin-assets'],
  ['车辆与差旅', '/admin-affairs'],
  ['自动化任务', '/admin-automation'],
  ['审计日志', '/audit'],
  ['数据资产', '/data-asset'],
  ['设置', '/settings'],
  ['云空间', '/drive'],
  ['知识库', '/wiki'],
];

function slug(s) { return s.replace(/[^\w一-龥]/g, '_'); }

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // 登录
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.fill('#login-username', 'chengsheng@chengshengdata.cn');
  await page.fill('#login-password', '******');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  console.log('LOGIN OK, url=', page.url());

  const report = [];
  for (const [label, path] of PAGES) {
    const errors = [];
    const onErr = (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); };
    page.on('console', onErr);
    const onPageErr = (e) => errors.push('PAGEERROR: ' + e.message.slice(0, 160));
    page.on('pageerror', onPageErr);
    let status = 'ok';
    let bodyText = '';
    let rowCount = 0;
    let title = '';
    try {
      await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(1800);
      title = await page.title();
      bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 240);
      rowCount = await page.locator('table tbody tr').count().catch(() => 0);
      await page.screenshot({ path: `${SHOT_DIR}/${slug(label)}.png`, fullPage: false });
    } catch (e) {
      status = 'ERROR: ' + e.message.slice(0, 120);
      await page.screenshot({ path: `${SHOT_DIR}/${slug(label)}.png` }).catch(() => {});
    }
    page.off('console', onErr);
    page.off('pageerror', onPageErr);
    report.push({ label, path, status, title, rowCount, errors, bodyText });
    console.log(`- ${label} (${path}) [${status}] rows=${rowCount} errors=${errors.length}`);
  }

  fs.writeFileSync(`${SHOT_DIR}/_report.json`, JSON.stringify(report, null, 2));
  console.log('REPORT WRITTEN:', `${SHOT_DIR}/_report.json`);
  await browser.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
