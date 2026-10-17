/**
 * 定点验证：`/costs` 页头的三个动作按钮真的能驱动 `CostsTab` 内的弹窗，
 * 且切到别的 Tab 后按钮消失（ref 为 null 时不渲染）。
 *
 * 用法：node scripts/browser-walkthrough/verify-costs-actions.mjs
 */
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';

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

const results = [];
const rec = (n, pass, d) => {
  results.push({ n, pass, d });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
};

/** 页头 actions 区里的按钮 */
async function headerBtnLabels(page) {
  return page.evaluate(`(() => {
    const h1 = document.querySelector('h1');
    const row = h1 ? h1.parentElement?.parentElement : null;
    const actions = row && row.children.length > 1 ? row.children[1] : null;
    return actions ? [...actions.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean) : [];
  })()`);
}

async function clickHeader(page, label) {
  return page.evaluate(`(() => {
    const h1 = document.querySelector('h1');
    const row = h1 ? h1.parentElement?.parentElement : null;
    const actions = row && row.children.length > 1 ? row.children[1] : null;
    if (!actions) return 'no-actions';
    const b = [...actions.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
    if (!b) return 'btn-not-found';
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
}

async function dialogTitle(page) {
  return page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"], [role="alertdialog"]');
    if (!d) return null;
    return (d.querySelector('[role="heading"],h2')?.textContent || '').trim();
  })()`);
}

/**
 * 关掉**所有**已打开的弹窗。
 *
 * ⚠️ 不能只找"含 取消/关闭 文案的按钮"：`CreateCostDialog` 原本只有「保存」+
 * 无文案的 X 图标（`data-slot="dialog-close"`），按文案找会一个都匹配不到，
 * 于是弹窗不关、**遮罩继续挡住 Tab 点击**，后面整段都变成假失败
 * （实测：三个弹窗同时 open，因为前两个没关掉）。
 * 现在按 `data-slot="dialog-close"` 关，并按数量循环直到为 0。
 */
async function closeAllDialogs(page) {
  for (let round = 0; round < 5; round += 1) {
    const left = await page.evaluate(`document.querySelectorAll('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]').length`);
    if (left === 0) return true;
    await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]');
      if (!d) return;
      /* 优先用带文案的取消/关闭；否则用 Radix 的 dialog-close（X） */
      const byText = [...d.querySelectorAll('button')].find((x) => /^(取消|关闭)$/.test((x.textContent || '').trim()));
      const bySlot = d.querySelector('[data-slot="dialog-close"]');
      const target = byText ?? bySlot;
      if (target) target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await sleep(700);
  }
  return (await page.evaluate(`document.querySelectorAll('[role="dialog"][data-state="open"]').length`)) === 0;
}

async function main() {
  const browser = await Browser.launch({ port: Number(process.env.WT_CDP_PORT ?? 9385) });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1700, 1100);
  await page.setCookie({ name: 'erp_session', value: await login(), url: APP });
  try {
    await page.goto(`${APP}/costs`, { settleMs: 2600 });
    await sleep(1500);

    const labels = await headerBtnLabels(page);
    rec('页头出现三个动作按钮', labels.length === 3, JSON.stringify(labels));

    // ① 归集成本
    rec('点击「归集成本」', (await clickHeader(page, '归集成本')) === 'ok');
    await sleep(1200);
    const t1 = await dialogTitle(page);
    rec('→ 打开成本归集弹窗', !!t1, `标题=${t1}`);
    await closeAllDialogs(page);

    // ② 同步到多维表格（确认框）
    rec('点击「同步到多维表格」', (await clickHeader(page, '同步到多维表格')) === 'ok');
    await sleep(1200);
    const t2 = await dialogTitle(page);
    rec('→ 打开同步确认框', !!t2, `标题=${t2}`);
    await closeAllDialogs(page);

    // ③ 同步记录
    rec('点击「同步记录」', (await clickHeader(page, '同步记录')) === 'ok');
    await sleep(1200);
    const t3 = await dialogTitle(page);
    rec('→ 打开同步记录弹窗', !!t3, `标题=${t3}`);
    await closeAllDialogs(page);

    // ④ 切到别的 Tab：页头动作应消失（ref 为 null）
    await page.clickByText('工时登记', { selector: '[role="tab"]', settleMs: 1500 });
    await sleep(1000);
    const after = await headerBtnLabels(page);
    rec('切到「工时登记」后页头动作消失', after.length === 0, JSON.stringify(after));
    // ⑤ 切回后恢复
    await page.clickByText('成本归集', { selector: '[role="tab"]', settleMs: 1500 });
    await sleep(1000);
    const back = await headerBtnLabels(page);
    rec('切回「成本归集」后页头动作恢复', back.length === 3, JSON.stringify(back));

    rec('无未捕获异常', page.exceptions.length === 0, JSON.stringify(page.exceptions).slice(0, 150));
    rec('无 console.error', page.consoleLogs.filter((l) => l.type === 'error').length === 0);
    rec('无 HTTP ≥500', page.httpErrors.filter((e) => Number(e.status) >= 500).length === 0, JSON.stringify(page.httpErrors.slice(0, 2)));
  } finally {
    await browser.close().catch(() => {});
  }
  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) process.exitCode = 1;
}
void main().catch((e) => { console.error(e.message); process.exitCode = 1; });
