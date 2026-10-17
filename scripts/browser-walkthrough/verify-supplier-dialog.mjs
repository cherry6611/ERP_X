/**
 * 定点复验：`/suppliers` 的表单弹窗在 §5.9 拆分后**行为必须完全一致**。
 *
 * 拆走了整个弹窗（`SupplierFormDialog`），父页面现在只通过 ref 句柄说"打开"。
 * 所以要确认的不只是"页面能打开"，而是：
 *   · 点「新建供应商」（页头）→ 弹窗打开、标题是"新建供应商"、名称字段为空；
 *   · 保存空表单 → 校验拦截（不发请求）；
 *   · 点行内「编辑」→ 弹窗打开、标题是"编辑供应商"、**名称已回填该行的值**
 *     （回填走的是 ref 句柄的 `open(supplier)` 分支）；
 *   · 「关联纳税主体」下拉里有哨兵项「不指定」（Radix 不允许空串 value）；
 *   · 关掉弹窗后重新打开，**上一次的值不残留**（新建路径必须 reset）。
 *
 * 用法：node scripts/browser-walkthrough/verify-supplier-dialog.mjs
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

/** 读当前打开的弹窗状态 */
const dlg = (page) =>
  page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"][data-state="open"]');
    if (!d) return null;
    const title = (d.querySelector('[role="heading"],h2')?.textContent || '').trim();
    const inputs = [...d.querySelectorAll('input')].map((i) => ({
      name: i.name || i.getAttribute('aria-label') || '',
      value: i.value,
      readonly: i.readOnly,
    }));
    const triggers = [...d.querySelectorAll('button[role="combobox"]')].map((b) => (b.textContent || '').trim());
    return { title, inputs, triggers };
  })()`);

async function clickHeader(page, label) {
  return page.evaluate(`(() => {
    const h1 = document.querySelector('h1');
    const a = h1.parentElement.parentElement.children[1];
    const b = [...a.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
    if (!b) return 'not-found';
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
}

async function closeDialog(page) {
  await page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"][data-state="open"]');
    if (!d) return;
    const x = d.querySelector('[data-slot="dialog-close"]');
    if (x) x.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await sleep(700);
}

async function main() {
  const browser = await Browser.launch({ port: Number(process.env.WT_CDP_PORT ?? 9412) });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1700, 1100);
  await page.setCookie({ name: 'erp_session', value: await login(), url: APP });
  try {
    await page.goto(`${APP}/suppliers`, { settleMs: 2800 });
    await sleep(1600);

    /* ① 新建 */
    rec('页头有「新建供应商」', (await clickHeader(page, '新建供应商')) === 'ok');
    await sleep(1200);
    let d = await dlg(page);
    rec('弹窗打开且标题为「新建供应商」', d?.title === '新建供应商', `标题=${d?.title}`);
    const nameEmpty = (d?.inputs ?? []).find((i) => i.name === 'name')?.value === '';
    rec('新建时名称字段为空（走 reset 分支）', nameEmpty, JSON.stringify((d?.inputs ?? []).slice(0, 3)));

    /* ② 空表单提交被拦 */
    const before = page.httpErrors.length;
    await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"][data-state="open"]');
      const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '保存');
      if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await sleep(1100);
    const stillOpen = (await dlg(page))?.title === '新建供应商';
    rec('空表单提交被校验拦下（弹窗不关、无写请求）', stillOpen && page.httpErrors.length === before,
      `仍打开=${stillOpen} 新增HTTP错误=${page.httpErrors.length - before}`);

    await closeDialog(page);
    rec('弹窗可关闭', (await dlg(page)) === null);

    /* ③ 编辑：名称必须回填 */
    const rowName = await page.evaluate(`(() => {
      /*
       * ⚠️ 不能取第一列 —— 供应商表的第一列是勾选框（我第一版取第一个 td 拿到的是
       * "编号" 这个表头文本，于是把"回填正确"误报成失败）。名称在第 3 列。
       * 这里改成"取编辑按钮所在行里第二个非空文本单元格"，更稳。
       * 注意：本段位于模板字符串内，注释里**不能出现反引号**（会提前终止字符串）。
       */
      const btn = [...document.querySelectorAll('.ant-table-tbody button')].find((b) => /编辑/.test(b.textContent || ''));
      const tr = btn ? btn.closest('tr') : null;
      if (!tr) return null;
      const cells = [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim()).filter(Boolean);
      return cells[1] ?? cells[0] ?? null;
    })()`);
    const editClicked = await page.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.ant-table-tbody button')].find((b) => /编辑/.test(b.textContent || ''));
      if (!btn) return 'not-found';
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(1300);
    d = await dlg(page);
    rec('行内「编辑」能打开弹窗', d?.title === '编辑供应商', `点击=${editClicked} 标题=${d?.title}`);
    const editName = (d?.inputs ?? []).find((i) => i.name === 'name')?.value;
    rec('⚠️ 编辑时名称已回填该行值（走 ref 句柄的 open(supplier) 分支）',
      !!editName && editName === rowName, `表格=${JSON.stringify(rowName)} 弹窗=${JSON.stringify(editName)}`);

    /* ④ 纳税主体下拉含哨兵项「不指定」 */
    const opened = await page.evaluate(`(() => {
      /*
       * ⚠️ 不能按 combobox 的**文案**找它：未选值时显示占位符「可选」，
       * 已选值时显示主体名 —— 于是同一个断言会因"第一行有没有关联主体"而飘
       * （我第一版按 /不指定|可选|请选择/ 匹配，在有一行选了主体时直接匹配不到，
       * 报成失败，其实功能是好的）。改为按「关联纳税主体」这个 FormLabel 定位它所属的
       * FormItem，再点该 item 内的 combobox。
       */
      const d = document.querySelector('[role="dialog"][data-state="open"]');
      if (!d) return 'no-dialog';
      const labels = [...d.querySelectorAll('label')];
      const target = labels.find((l) => (l.textContent || '').includes('关联纳税主体'));
      if (!target) return 'no-label';
      const item = target.closest('div');
      const trigger = item && item.querySelector('button[role="combobox"]');
      if (!trigger) return 'no-trigger';
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(900);
    const options = await page.evaluate(`[...document.querySelectorAll('[role="option"]')].map((o) => (o.textContent || '').trim())`);
    rec('⚠️ 下拉里有哨兵项「不指定」（Radix 不允许空串 value）',
      opened === 'ok' && options.includes('不指定'), `open=${opened} options=${JSON.stringify(options.slice(0, 8))}`);
    /* 关掉下拉再关弹窗 */
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(600);
    await closeDialog(page);

    /* ⑤ 再开新建：不得残留上一行（编辑）的值 */
    await clickHeader(page, '新建供应商');
    await sleep(1200);
    d = await dlg(page);
    const nameAfter = (d?.inputs ?? []).find((i) => i.name === 'name')?.value;
    rec('⚠️ 编辑后再点新建，名称不残留（新建路径必须 reset）',
      d?.title === '新建供应商' && nameAfter === '', `标题=${d?.title} 名称=${JSON.stringify(nameAfter)}`);

    rec('无未捕获异常', page.exceptions.length === 0, JSON.stringify(page.exceptions).slice(0, 140));
    rec('无 console.error', page.consoleLogs.filter((l) => l.type === 'error').length === 0);
    rec('无 HTTP ≥500', page.httpErrors.filter((e) => Number(e.status) >= 500).length === 0);
  } finally {
    await browser.close().catch(() => {});
  }
  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    console.log('失败项:');
    for (const b of bad) console.log(`  - ${b.n}  ${b.d ?? ''}`);
    process.exitCode = 1;
  }
}
void main().catch((e) => { console.error(e.message); process.exitCode = 1; });
