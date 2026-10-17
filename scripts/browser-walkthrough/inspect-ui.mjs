/**
 * UI 结构巡览：把指定页面上的**真实可点击元素**与输入框列出来。
 *
 * 用途：交互走查的失败里有相当一部分是"选择器猜错了"，而不是应用缺陷。
 * 先照出页面真实的按钮/Tab 文案与属性，才能写出**准确**的断言，
 * 避免把测试自己的问题当成产品问题报上去。
 *
 * 用法：node scripts/browser-walkthrough/inspect-ui.mjs /crm /contracts ...
 */
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const USER = process.env.WT_USER ?? 'chengsheng@chengshengdata.cn';
const PASS = process.env.WT_PASS ?? '******';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('用法: node inspect-ui.mjs <route> [route...]');
  process.exit(1);
}

const res = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const jar = res.headers.getSetCookie?.() ?? [];
const session = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session='));
const browser = await Browser.launch({ port: 9336 });
const page = await browser.newPage();
await page.enable();
await page.setViewport(1600, 1000);
await page.setCookie({ name: 'erp_session', value: session.slice(12), url: APP });

for (const route of targets) {
  await page.goto(`${APP}${route}`, { settleMs: 1500 });
  await sleep(1000);
  const info = await page.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const buttons = [...document.querySelectorAll('button, [role="tab"], a')]
      .filter(vis)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        text: (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
        variant: el.getAttribute('data-variant') || '',
        ariaSelected: el.getAttribute('aria-selected'),
        href: el.getAttribute('href') || '',
        disabled: !!el.disabled,
        cls: (el.className || '').toString().slice(0, 80),
      }))
      .filter(b => b.text);
    const inputs = [...document.querySelectorAll('input, textarea, select')]
      .filter(vis)
      .map(el => ({
        tag: el.tagName.toLowerCase(), type: el.type || '', id: el.id || '',
        placeholder: el.placeholder || '', name: el.name || '',
        value: (el.value || '').slice(0, 30), disabled: !!el.disabled,
      }));
    const selects = [...document.querySelectorAll('[role="combobox"]')].filter(vis).map(el => ({
      text: (el.innerText || '').trim().slice(0, 40),
      expanded: el.getAttribute('aria-expanded'),
    }));
    return { title: document.title, url: location.pathname + location.search, buttons, inputs, selects,
             textHead: (document.body.innerText || '').slice(0, 500) };
  })()`);

  console.log(`\n================ ${route} ================`);
  console.log('-- 可点击元素 --');
  for (const b of info.buttons) {
    console.log(
      `  [${b.tag}${b.role ? ` role=${b.role}` : ''}] "${b.text}"` +
        `${b.ariaSelected !== null ? ` selected=${b.ariaSelected}` : ''}` +
        `${b.disabled ? ' DISABLED' : ''}${b.href ? ` href=${b.href}` : ''}`
    );
  }
  console.log('-- 输入框 --');
  for (const i of info.inputs) {
    console.log(`  [${i.tag}${i.type ? ` type=${i.type}` : ''}] id=${i.id} ph="${i.placeholder}" value="${i.value}"${i.disabled ? ' DISABLED' : ''}`);
  }
  console.log('-- combobox --');
  for (const s of info.selects) console.log(`  "${s.text}" expanded=${s.expanded}`);
  console.log('-- 文本头部 --');
  console.log('  ' + info.textHead.replace(/\n/g, ' | ').slice(0, 400));
}

await browser.close();
