/**
 * 定点复验：`/finance/tax-declaration` 在 §5.9 拆分后**行为必须完全一致**。
 *
 * 拆走了 4 块（VatSummaryCards / VatLineTable / VatHistorySection / VatConfirmDialog），
 * 所以要确认的不只是"页面能打开"，而是每一块都还在、都还能用：
 *   · 六张指标卡（含"估数/权威"口径提示）在；
 *   · 申报表行次表在，且**合计行只汇总 summable 行**（这是拆分时最容易丢掉的口径）；
 *   · 历史底稿区块在；
 *   · 「确认底稿」弹窗能开，差异说明**字数不足时报错、补足后错误消失**（抽取时改写过这段）。
 *
 * 用法：node scripts/browser-walkthrough/verify-tax-split.mjs
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

async function main() {
  const browser = await Browser.launch({ port: Number(process.env.WT_CDP_PORT ?? 9403) });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1700, 1200);
  await page.setCookie({ name: 'erp_session', value: await login(), url: APP });
  try {
    await page.goto(`${APP}/finance/tax-declaration`, { settleMs: 2800 });
    await sleep(1800);

    const info = await page.evaluate(`(() => {
      const text = document.body.innerText || '';
      const cards = [...document.querySelectorAll('*')].filter((el) =>
        el.children.length === 0 && /销项税额（发票台账口径）|进项税额|上一期间未抵扣完的进项|本期应纳税额|期末留抵|未开票收入（不含税）/.test(el.textContent || '')
      ).map((el) => (el.textContent || '').trim());
      /* 申报表行次表：找含"行次"表头的 antd 表 */
      const tables = [...document.querySelectorAll('.ant-table')];
      const lineTable = tables.find((t) => /申报表行次|行次/.test(t.textContent || ''));
      const summaryCells = lineTable
        ? [...(lineTable.querySelector('.ant-table-summary')?.querySelectorAll('td') ?? [])].map((td) => (td.textContent || '').trim())
        : [];
      return {
        hasCards: cards.length,
        cardLabels: cards.slice(0, 8),
        hintEstimated: /估数|权威/.test(text),
        hasLineTable: !!lineTable,
        summaryCells,
        hasHistory: /历史申报底稿/.test(text),
        hasRiskPanel: /税务风险扫描/.test(text),
        tableCount: tables.length,
      };
    })()`);

    rec('六张指标卡都在', info.hasCards >= 6, `找到 ${info.hasCards} 个标签文本`);
    rec('留抵来源口径提示（权威/估数）仍在', info.hintEstimated);
    rec('申报表行次表在', info.hasLineTable, `页内 antd 表 ${info.tableCount} 张`);
    rec('历史申报底稿区块在', info.hasHistory);
    rec('税务风险扫描面板在', info.hasRiskPanel);

    /*
     * 合计行口径：必须写明"仅本期发生项，不含留抵与应纳税额"，
     * 且第一个汇总单元格是那句口径说明（而不是一个被无条件求和的混合数）。
     */
    const first = info.summaryCells[0] ?? '';
    rec(
      '⚠️ 合计行口径说明在（拆分时最易丢的一条）',
      /仅第\s*1\/11\/12\/13\s*行|本期发生项/.test(first) && /不含留抵与应纳税额/.test(first),
      JSON.stringify(first.slice(0, 60)),
    );

    /*
     * ⚠️ 「确认底稿」在**纳税主体 = 全部主体**时是**故意禁用**的：
     * 附加税费须按主体逐户计提（城建税率按主体分档），未指定主体时后端必然拒绝，
     * 所以页面直接禁掉、避免使用者点完才吃 400。
     * 因此要验弹窗必须先**选一个具体主体** —— 第一次我没选，于是"弹窗打不开"
     * 被我误报成回归（其实按钮是 disabled 的，行为正确）。
     */
    const beforeState = await page.evaluate(`(() => {
      const h1 = document.querySelector('h1');
      const a = h1.parentElement.parentElement.children[1];
      const b = [...a.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '确认底稿');
      return b ? b.disabled : null;
    })()`);
    rec('未指定主体时「确认底稿」被禁用（防无谓 400）', beforeState === true, `disabled=${beforeState}`);

    /* 选一个具体纳税主体 */
    await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /全部主体/.test(x.textContent || ''));
      if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await sleep(900);
    const entityPicked = await page.evaluate(`(() => {
      const items = [...document.querySelectorAll('[role="option"]')];
      const target = items.find((o) => !/全部主体/.test(o.textContent || ''));
      if (!target) return null;
      const label = (target.textContent || '').trim();
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return label;
    })()`);
    await sleep(1600);
    rec('能选中具体纳税主体', !!entityPicked, `选中=${JSON.stringify(entityPicked)}`);

    const afterEnable = await page.evaluate(`(() => {
      const h1 = document.querySelector('h1');
      const a = h1.parentElement.parentElement.children[1];
      const b = [...a.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '确认底稿');
      return b ? b.disabled : null;
    })()`);
    rec('指定主体后「确认底稿」变为可用', afterEnable === false, `disabled=${afterEnable}`);

    /* ── 确认底稿弹窗：字数规则 ── */
    await page.evaluate(`(() => {
      const h1 = document.querySelector('h1');
      const row = h1.parentElement.parentElement;
      const a = row.children[1];
      const b = [...a.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '确认底稿');
      if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await sleep(1300);
    let dlg = await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"][data-state="open"]');
      return d ? { title: (d.querySelector('[role="heading"],h2')?.textContent || '').trim(), text: (d.textContent || '').slice(0, 120) } : null;
    })()`);
    rec('「确认底稿」弹窗能打开', !!dlg, dlg ? `标题=${dlg.title}` : '未打开');

    if (dlg) {
      /* 说明太短 → 点确认应出现错误提示 */
      await page.evaluate(`(() => {
        const d = document.querySelector('[role="dialog"][data-state="open"]');
        const btn = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '确认底稿');
        if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`);
      await sleep(1100);
      const shortErr = await page.evaluate(`(() => {
        const d = document.querySelector('[role="dialog"][data-state="open"]');
        const p = d ? [...d.querySelectorAll('p')].find((x) => /至少|说明/.test(x.textContent || '')) : null;
        return p ? (p.textContent || '').trim() : null;
      })()`);
      rec('说明过短 → 出现错误提示', !!shortErr, JSON.stringify(shortErr));

      /* 补足字数 → 提示应立即消失（抽取时重写过这段逻辑） */
      await page.evaluate(`(() => {
        const d = document.querySelector('[role="dialog"][data-state="open"]');
        const ta = d.querySelector('textarea');
        if (!ta) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '本期跨期开票，差异已核对无误');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(1000);
      const afterType = await page.evaluate(`(() => {
        const d = document.querySelector('[role="dialog"][data-state="open"]');
        const p = d ? [...d.querySelectorAll('p')].find((x) => /至少/.test(x.textContent || '')) : null;
        return p ? (p.textContent || '').trim() : null;
      })()`);
      rec('⚠️ 补足字数后错误提示立即消失', afterType === null, `残留提示=${JSON.stringify(afterType)}`);
    }

    rec('无未捕获异常', page.exceptions.length === 0, JSON.stringify(page.exceptions).slice(0, 140));
    rec('无 console.error', page.consoleLogs.filter((l) => l.type === 'error').length === 0);
    rec('无 HTTP ≥500', page.httpErrors.filter((e) => Number(e.status) >= 500).length === 0);
  } finally {
    await browser.close().catch(() => {});
  }
  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) process.exitCode = 1;
}
void main().catch((e) => { console.error(e.message); process.exitCode = 1; });
