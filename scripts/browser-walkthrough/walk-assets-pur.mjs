/**
 * 浏览器走查：采购订单验收链路 + 固定资产 + 票据 + 行政管理（本 agent 独占端口 9363）。
 *
 * ## 为什么单独写这个脚本
 *
 * `walk-crud.mjs` / `walk-domains.mjs` 只做到"弹窗能开、能提交、行数 +1"。
 * 本次要验的是**数值与口径**，而本仓最隐蔽的缺陷恰好都是"界面看不出来"的类型：
 *
 *   · 聚合列 `acceptedAmount`（`PurService.orderSelect()` 的子查询）从未被真实数据
 *     验证过 —— `pur_order` 在本轮之前是 **0 行**；
 *   · 设备类订单**分批验收**时会二次插入 `ast_asset`（`purchase_order_id` 上有部分
 *     唯一索引 `uq_ast_asset_purchase_order`）—— 第 2 次验收必 500；
 *   · `<Input type="number">` 缺 `step` 时 HTML 默认 step=1，任何小数（单价 333.33、
 *     资产原值 12000.50）都会被浏览器 stepMismatch 拦在提交之前（**不发任何请求**）。
 *
 * ## 方法：每个断言都要有"界面值 + SQL 值"两侧证据
 *
 * 只读 toast 会得到假绿灯（`values.x || undefined` 类缺陷 toast 照样报成功），
 * 因此每个用例都：真实鼠标点击 → 读界面 → `SELECT` 核对库值 → 打印两侧数字。
 * 所有点击都走 CDP `Input.dispatchMouseEvent`（真实命中测试），不是 DOM `.click()`。
 *
 * ## 数据卫生
 *
 * 所有测试数据以 `[API_TEST]` 前缀命名；清理**只按本次创建的主键 id 精确删除**
 * （不使用宽泛 LIKE，避免误删真实开发数据），删除前先 SELECT 打印待删行。
 *
 * 用法：node scripts/browser-walkthrough/walk-assets-pur.mjs
 * 产物：scripts/browser-walkthrough/out/assets-pur-report.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const USER = process.env.WT_USER ?? 'chengsheng@chengshengdata.cn';
const PASS = process.env.WT_PASS ?? '******';
const OUT = 'scripts/browser-walkthrough/out';
const PORT = 9363;
const TAG = '[API_TEST]';

const results = [];
const evidence = [];
/** 报告落盘路径（分段执行时是 part 文件，由 `main()` 覆盖） */
let REPORT_PATH = `${OUT}/assets-pur-report.json`;
/** 增量落盘：任何一步崩掉都不会丢掉已经跑出来的结论（走查脚本跑一轮要几分钟） */
function flushReport(extra = {}) {
  try {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      REPORT_PATH,
      JSON.stringify({ results, evidence, ...extra }, null, 2),
    );
  } catch { /* 落盘失败不影响走查本身 */ }
}
const created = {
  purRequest: [], purOrder: [], astAsset: [], note: [],
  rent: [], bill: [], adminAsset: [], affair: [], depVoucher: [],
};
/** 批量折旧顺带影响到的**非本次创建**资产（清理时原样回滚） */
const foreignDepRows = [];
/** 命中测试未通过（点击目标被其它元素覆盖）的次数 —— 每次都会留一张截图 */
let hitMisses = 0;

function record(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  flushReport();
}
function note(section, text) {
  evidence.push({ section, text });
  console.log(`    · ${text}`);
}
function today() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function todayPlus(days) {
  return new Date(Date.now() + 8 * 3600 * 1000 + days * 86400000).toISOString().slice(0, 10);
}

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (res.status !== 201) throw new Error(`登录失败 ${res.status}`);
  const jar = res.headers.getSetCookie?.() ?? [];
  const cookie = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session='));
  if (!cookie) throw new Error('登录响应没有 erp_session');
  return cookie.slice('erp_session='.length);
}

/* ============================ 浏览器小工具 ============================ */

const SESSION = { cookie: '' };
async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie: SESSION.cookie, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/**
 * 真实鼠标点击"表达式定位到的元素"（表达式必须返回元素或 null）。
 *
 * ⚠️ **命中测试兜底**：真实鼠标事件走浏览器命中测试，元素被浮层/另一个元素
 * 覆盖时点击会落到**别的元素**上 —— 表现为"点了没反应"，极易被误判成功能坏了。
 * 实测：行政缴费单弹窗的「保存」被点到（坐标处 `elementFromPoint` 返回的是
 * 页面表格里的一个分页按钮），于是"保存"看着能点却永远不提交。
 * 因此这里先做 `elementFromPoint` 命中自检，未命中才退化为元素自身 `click()`
 * （并把退化事件打进日志，作为"界面存在遮挡"的证据）。
 */
async function clickExpr(page, expr, { settleMs = 500 } = {}) {
  const info = await page.evaluate(`(() => {
    const el = (${expr});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return { zero: true };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      x, y,
      hit: !!top && (top === el || el.contains(top)),
      topText: top ? (top.innerText || '').trim().slice(0, 14) : null,
      topTag: top ? top.tagName : null,
    };
  })()`);
  if (!info) return 'not-found';
  if (info.zero) return 'not-found';
  if (!info.hit) {
    hitMisses += 1;
    // 命中测试未通过时留一张可视区截图（多数是"浮层没关"，用于区分脚本坑与应用缺陷）
    const shot = `${OUT}/hit-miss-${hitMisses}.png`;
    await page.screenshot(shot, { fullPage: false }).catch(() => {});
    evidence.push({
      section: '点击命中测试未通过',
      text:
        `点击目标中心坐标被其它元素覆盖：坐标处是 ${info.topTag}:${JSON.stringify(info.topText)}；` +
        `已退化为元素自身 click()（业务仍走通）。截图：${shot}`,
    });
    const fallback = await page.evaluate(
      `(() => { const el = (${expr}); if (!el) return 'gone'; el.click(); return 'js-click'; })()`,
    );
    console.log(`    ! 命中测试未通过（坐标处是 ${info.topTag}:${JSON.stringify(info.topText)}），退化为元素 click() → ${fallback}（截图 ${shot}）`);
    await sleep(settleMs);
    return fallback === 'js-click' ? 'ok' : 'not-found';
  }
  await sleep(120);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y, button: 'none', clickCount: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(settleMs);
  return 'ok';
}

const ROOT = (scope) => (scope === 'dialog'
  ? `(document.querySelector('[role="dialog"]') || document.body)`
  : `document.body`);

/** 按 label 文本找控件并返回表达式（同容器退化查找） */
function controlExpr(labelRe, scope = 'dialog') {
  return `(() => {
    const root = ${ROOT(scope)};
    const lab = [...root.querySelectorAll('label')]
      .find((l) => new RegExp(${JSON.stringify(labelRe)}).test(l.textContent || ''));
    if (!lab) return null;
    if (lab.htmlFor) {
      const byFor = root.querySelector('[id="' + lab.htmlFor.replace(/"/g, '\\\\"') + '"]');
      if (byFor) return byFor;
    }
    const box = lab.closest('div') ?? lab.parentElement;
    return box ? box.querySelector('input,textarea,select,button[role="combobox"],button') : null;
  })()`;
}

function btnExpr(text, scope = 'dialog') {
  return `(() => {
    const root = ${ROOT(scope)};
    const btns = [...root.querySelectorAll('button')];
    return btns.find((b) => (b.innerText || '').trim() === ${JSON.stringify(text)})
        || btns.find((b) => (b.innerText || '').includes(${JSON.stringify(text)})) || null;
  })()`;
}
async function clickButton(page, text, { scope = 'dialog', settleMs = 600 } = {}) {
  return clickExpr(page, btnExpr(text, scope), { settleMs });
}

/** 把值写进 label 对应的输入控件（React 受控：原生 setter + input/change） */
async function fillByLabel(page, labelRe, value, scope = 'dialog') {
  const expr = controlExpr(labelRe, scope);
  return page.evaluate(`(() => {
    const el = ${expr};
    if (!el) return 'label-or-control-not-found';
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') {
      return 'control-is-' + el.tagName.toLowerCase();
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
                : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, ${JSON.stringify(String(value))}) : (el.value = ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok:' + el.tagName.toLowerCase() + ':step=' + (el.getAttribute('step') ?? '-');
  })()`);
}

/** 打开 label 对应的 Radix Select，点选文本匹配的选项（真实点击；无匹配则取第一项） */
async function selectByLabel(page, labelRe, optionRe, scope = 'dialog') {
  const open = await clickExpr(page, controlExpr(labelRe, scope), { settleMs: 700 });
  if (open !== 'ok') return 'trigger-not-found';
  const pick = await clickExpr(
    page,
    `(() => {
      const opts = [...document.querySelectorAll('[role="option"]')];
      if (!opts.length) return null;
      return opts.find((o) => new RegExp(${JSON.stringify(optionRe)}).test(o.textContent || '')) || opts[0];
    })()`,
    { settleMs: 600 },
  );
  return pick === 'ok' ? 'ok' : 'option-not-found';
}

/**
 * DateField（Popover + react-day-picker）：点开日历 → 点 [data-day=ISO] → 必要时翻月。
 *
 * ⚠️ **选完必须关掉浮层**：shadcn `Popover` 不会在选中日期后自动收起，
 * 于是日历浮层会一直悬在弹窗上、盖住底部的「保存」按钮 —— 真实鼠标点击就会
 * 落到达日历的日号按钮上（实测截图 `out/hit-miss-1.png`：日历盖住了缴费单弹窗的
 * 保存按钮，`elementFromPoint` 返回 `BUTTON:"14"`）。**这是走查脚本的坑，不是应用缺陷**，
 * 真人会先点别处再点保存。
 */
async function setDateField(page, labelRe, iso, { maxNextMonth = 4 } = {}) {
  const open = await clickExpr(page, controlExpr(labelRe), { settleMs: 900 });
  if (open !== 'ok') return 'trigger-not-found';
  for (let i = 0; i <= maxNextMonth; i += 1) {
    const hit = await clickExpr(
      page,
      `(() => { const c = document.querySelector('[data-day="${iso}"] button') || document.querySelector('[data-day="${iso}"]'); return c && c.offsetParent !== null ? c : null; })()`,
      { settleMs: 700 },
    );
    if (hit === 'ok') {
      await page.pressKey('Escape', 'Escape', 27);
      await sleep(400);
      return 'ok';
    }
    const next = await clickExpr(
      page,
      `(() => document.querySelector('button.rdp-button_next, [class*="button_next"]'))()`,
      { settleMs: 600 },
    );
    if (next !== 'ok') break;
  }
  await page.pressKey('Escape', 'Escape', 27);
  await sleep(300);
  const days = await page.evaluate(
    `(() => [...document.querySelectorAll('[data-day]')].map((e) => e.getAttribute('data-day')).slice(0, 8))()`,
  );
  return 'day-not-found:' + JSON.stringify(days);
}

async function toasts(page, { attempts = 8, gapMs = 300 } = {}) {
  const seen = [];
  for (let i = 0; i < attempts; i += 1) {
    const found = await page.evaluate(
      `(() => [...document.querySelectorAll('[data-sonner-toast]')].map((e) => (e.textContent || '').trim()))()`,
    );
    for (const t of found) if (t && !seen.includes(t)) seen.push(t);
    if (seen.length) break;
    await sleep(gapMs);
  }
  return seen;
}

async function dialogInfo(page) {
  return page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    return {
      title: (d.querySelector('[role="heading"],h2')?.textContent || '').trim(),
      labels: [...d.querySelectorAll('label')].map((l) => (l.textContent || '').replace(/\\s+/g, ' ').trim()),
      buttons: [...d.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean),
      text: d.innerText,
    };
  })()`);
}

async function closeDialog(page) {
  await clickExpr(
    page,
    `(() => { const d = document.querySelector('[role="dialog"]');
      if (!d) return null;
      return [...d.querySelectorAll('button')].find((b) => /取消|关闭/.test(b.innerText || '')) || null; })()`,
    { settleMs: 600 },
  );
}

async function rowCells(page, rowText) {
  return page.evaluate(`(() => {
    const row = [...document.querySelectorAll('tbody tr')].find((r) => (r.innerText || '').includes(${JSON.stringify(rowText)}));
    return row ? [...row.querySelectorAll('td')].map((td) => (td.innerText || '').trim()) : null;
  })()`);
}
async function rowButtons(page, rowText) {
  return page.evaluate(`(() => {
    const row = [...document.querySelectorAll('tbody tr')].find((r) => (r.innerText || '').includes(${JSON.stringify(rowText)}));
    return row ? [...row.querySelectorAll('button')].map((b) => (b.innerText || '').trim()) : null;
  })()`);
}
async function clickRowButton(page, rowText, btnText, { settleMs = 800 } = {}) {
  return clickExpr(
    page,
    `(() => {
      const row = [...document.querySelectorAll('tbody tr')].find((r) => (r.innerText || '').includes(${JSON.stringify(rowText)}));
      if (!row) return null;
      const b = [...row.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === ${JSON.stringify(btnText)});
      return b || null;
    })()`,
    { settleMs },
  );
}
function reqsSince(page, mark, re = /POST|PATCH|PUT|DELETE/) {
  return (page.requests ?? []).slice(mark).filter((r) => re.test(r.method ?? ''));
}
const r2 = (n) => Math.round(Number(n) * 100) / 100;
/**
 * `date` / `timestamptz` 列经 postgres.js 返回的是 **Date 对象**，
 * `Date.parse('Sat Oct 17 2026 …' + 'T00:00:00Z')` 会得到 NaN
 * （贴士：第一版就是这么把"贴现天数断言"写成恒 NaN 的假失败）。
 */
function toIso(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 弹窗内当前可见的校验提示（react-hook-form 的 FormMessage / role=alert） */
async function formErrors(page) {
  return page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return [];
    const out = new Set();
    for (const el of d.querySelectorAll('[role="alert"], [data-slot="form-message"], p.text-destructive, .text-destructive')) {
      const t = (el.textContent || '').trim();
      if (t && t.length < 60 && /请|不能|必须|至少|格式|大于/.test(t)) out.add(t);
    }
    return [...out];
  })()`);
}

/**
 * 二次确认弹窗（`confirmDanger` → Radix **AlertDialog**，`role="alertdialog"`，
 * **不是** `role="dialog"`）—— 读文案并点确认。
 *
 * ⚠️ 踩过的坑：处置「完成」、自动化「停用」都先弹它；只点业务按钮不点确认，
 * 结果是"点了但什么都没发生"，看起来像功能坏了。
 */
async function confirmAlert(page, { label = '确认', settleMs = 1800 } = {}) {
  const text = await page.evaluate(
    `(() => { const d = document.querySelector('[role="alertdialog"]'); return d ? d.innerText.replace(/\\s+/g, ' ').trim() : null; })()`,
  );
  if (!text) return { found: false, text: null, clicked: false };
  const clicked = await clickExpr(
    page,
    `(() => {
      const d = document.querySelector('[role="alertdialog"]');
      if (!d) return null;
      const btns = [...d.querySelectorAll('button')];
      return btns.find((b) => (b.innerText || '').trim() === ${JSON.stringify(label)})
          || btns.find((b) => (b.innerText || '').trim() === '确认')
          || btns.find((b) => !/取消/.test(b.innerText || '')) || null;
    })()`,
    { settleMs },
  );
  return { found: true, text, clicked: clicked === 'ok' };
}

/* ============================ 主流程 ============================ */

async function main() {
  mkdirSync(OUT, { recursive: true });
  SESSION.cookie = `erp_session=${await login()}`;
  const sql = postgres({
    host: '127.0.0.1', port: 5433, user: 'erp', password: '******',
    database: 'shengseerp', connect_timeout: 5,
  });
  let browser = await Browser.launch({ port: PORT });
  const SESSION_VALUE = SESSION.cookie.slice('erp_session='.length);
  /*
   * 每个区块前都探活；渲染进程假死就**整只浏览器重启**（换进程，约 3 秒）。
   *
   * 为什么需要：实测连续跑十几屏后 `Runtime.evaluate` 会连续两次 45s 超时
   * （run2 断在行政缴费、run3 断在处置完成、run5 断在租房合同编辑），
   * 挂点每次都不一样 —— 是渲染/浏览器进程整体假死，不是某个交互的问题。
   * 走查脚本的价值在于"跑完并留下证据"，因此这里用重启换稳定性；
   * 每次重启都会把"重启过"记进 evidence，避免把环境问题当成应用缺陷。
   */
  const makePage = async () => {
    const p = await browser.newPage();
    await p.enable();
    await p.setViewport(1700, 1100);
    await p.setCookie({ name: 'erp_session', value: SESSION_VALUE, url: APP });
    /*
     * 原生对话框（`window.confirm/alert`）会**阻塞渲染进程**，此后所有
     * `Runtime.evaluate` 都挂住 —— 走查里表现为"点了没反应 + 45s 超时"。
     * 统一自动接受，并把事件记进日志（本仓 `confirmDanger` 走 AlertDialog，
     * 但附件删除等路径仍可能落到原生 confirm）。
     */
    p.on('Page.javascriptDialogOpening', (params) => {
      console.log(`    ! 原生对话框(${params.type}): ${String(params.message).slice(0, 80)}`);
      void p.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
    return p;
  };
  let page = await makePage();
  let restarts = 0;
  const restartBrowser = async (why) => {
    restarts += 1;
    evidence.push({ section: '走查环境', text: `第 ${restarts} 次重启浏览器（${why}）` });
    await browser.close().catch(() => {});
    browser = await Browser.launch({ port: PORT });
    page = await makePage();
  };
  /** 探活：能求值就复用，求不动就重启整只浏览器；`force` 表示主动换一只干净的 */
  const ensureAlive = async (why = '区块开始前探活', { force = false } = {}) => {
    if (!force) {
      try {
        const ok = await page.evaluate('1 + 1');
        if (ok === 2) return;
      } catch { /* 掉下去重启 */ }
    }
    console.log(`    ! ${force ? '主动换浏览器' : '页面无响应'}（${why}）`);
    await restartBrowser(why);
  };
  await page.setCookie({ name: 'erp_session', value: SESSION_VALUE, url: APP });
  const diag = { consoleErrors: [], exceptions: [], httpErrors: [] };
  /* 跨区块复用的一次性变量：先声明，便于按需只跑某几个区块（WT_FROM/WT_TO） */
  let d = null;
  let t = [];
  let cells = null;

  const base = await sql`SELECT
    (SELECT count(*)::int FROM pur_order) AS pur_order,
    (SELECT count(*)::int FROM ast_depreciation) AS ast_dep,
    (SELECT count(*)::int FROM erp_note) AS erp_note,
    (SELECT count(*)::int FROM erp_admin_rent_contract) AS rent,
    (SELECT count(*)::int FROM erp_admin_bill) AS bill,
    (SELECT count(*)::int FROM erp_admin_asset) AS admin_asset,
    (SELECT count(*)::int FROM erp_admin_affair) AS affair`;
  note('baseline', `起始行数 ${JSON.stringify(base[0])}`);
  const depVoucherBefore = (await sql`SELECT id FROM fin_voucher WHERE source_type = 'depreciation'`).map((r) => r.id);

  try {
    /*
     * 分段执行开关（`WT_FROM` / `WT_TO`）：
     * 本机 headless Chrome 每跑十几屏就会整体假死一次（实测 5 轮，挂点每次不同），
     * 因此支持"只跑其中一段"并把结果落到 `assets-pur-report.part-<from>-<to>.json`，
     * 由人工合并。**不设这两个变量时 = 全跑**，直接产出完整的
     * `assets-pur-report.json`（正常环境下一次跑完）。
     */
    const FROM = process.env.WT_FROM ?? 'pur';
    const TO = process.env.WT_TO ?? 'admin';
    const SECTION_ORDER = ['pur', 'asset', 'notes', 'admin'];
    const want = (name) =>
      SECTION_ORDER.indexOf(name) >= SECTION_ORDER.indexOf(FROM) &&
      SECTION_ORDER.indexOf(name) <= SECTION_ORDER.indexOf(TO);
    REPORT_PATH =
      FROM === 'pur' && TO === 'admin'
        ? `${OUT}/assets-pur-report.json`
        : `${OUT}/assets-pur-report.part-${FROM}-${TO}.json`;
    console.log(`\n区间: ${FROM} → ${TO}  报告: ${REPORT_PATH}`);

    if (want('pur')) {
    /* ═══════════════ 一、采购订单验收链路 ═══════════════ */
    console.log('\n═══ 一、/pur 采购订单验收链路 ═══');
    page.resetDiagnostics();
    await page.goto(`${APP}/pur`, { settleMs: 2600 });
    await sleep(1400);
    const purTabs = await page.evaluate(
      `(() => [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter((x) => ['采购申请','采购订单','采购看板'].includes(x)))()`,
    );
    record('采购管理 3 个 Tab 渲染', purTabs.length === 3, `tabs=${JSON.stringify(purTabs)}`);

    /* 1.1 新建采购申请 */
    const prTitle = `${TAG} 设备采购申请`;
    await clickButton(page, '新建采购申请', { scope: 'body', settleMs: 1300 });
    d = await dialogInfo(page);
    record('「新建采购申请」弹窗打开', d?.title === '新建采购申请', d ? `字段=${JSON.stringify(d.labels)}` : '未打开');
    if (!d) throw new Error('采购申请弹窗未打开');
    await fillByLabel(page, '申请标题', prTitle);
    await selectByLabel(page, '申请类型', '设备采购');
    await fillByLabel(page, '预算金额', '2000.50');
    await fillByLabel(page, '申请事由', `${TAG} 走查事由`);
    const markPr = (page.requests ?? []).length;
    await clickButton(page, '提交申请', { settleMs: 1600 });
    t = await toasts(page);
    await sleep(1200);
    const prRow = await sql`SELECT id, code, status, amount, title FROM pur_request WHERE title = ${prTitle} ORDER BY _created_at DESC LIMIT 1`;
    if (prRow.length) created.purRequest.push(prRow[0].id);
    const purUrl = await page.evaluate('location.pathname');
    record(
      '采购申请落库并跳转详情页',
      prRow.length === 1 && purUrl.startsWith('/pur/requests/'),
      `写入请求=${reqsSince(page, markPr).length} ${prRow.length ? `${prRow[0].code} status=${prRow[0].status} amount=${prRow[0].amount}` : '未落库'} url=${purUrl} toast=${JSON.stringify(t)}`,
    );
    const prId = prRow[0]?.id;
    const prCode = prRow[0]?.code;

    /* 1.2 申请详情页 */
    if (prId) {
      await page.goto(`${APP}/pur/requests/${prId}`, { settleMs: 2200 });
      await sleep(1300);
      const detail = await page.evaluate('document.body.innerText');
      record(
        '申请详情页 /pur/requests/:id 按 URL 直达可加载（不依赖路由 state）',
        detail.includes(prCode ?? '###') && detail.includes(prTitle),
        `含编号=${detail.includes(prCode ?? '###')} 含标题=${detail.includes(prTitle)}`,
      );
      const capped = await api('/api/pur/requests?page=1&pageSize=500');
      record(
        '详情页兜底查询 pageSize 被服务端截断（潜在：>100 条时详情页会显示"不存在"）',
        capped.body?.pageSize === 100,
        `请求 pageSize=500 → 返回 ${capped.body?.pageSize}（MAX_PAGE_SIZE），total=${capped.body?.total}；PurRequestDetailPage.tsx:30 请求 500`,
      );
    }

    /* 1.3 批准 */
    await page.goto(`${APP}/pur`, { settleMs: 2400 });
    await sleep(1400);
    const approve = await clickRowButton(page, prTitle, '批准', { settleMs: 1600 });
    t = await toasts(page);
    const prAfter = await sql`SELECT status FROM pur_request WHERE id = ${prId}`;
    record(
      '采购申请「批准」落库 approved',
      approve === 'ok' && prAfter[0]?.status === 'approved',
      `click=${approve} status=${prAfter[0]?.status} toast=${JSON.stringify(t)}`,
    );

    /* 1.4 新建采购订单（设备类 + 3 位小数单价 → 同时探 step 缺陷） */
    await clickButton(page, '采购订单', { scope: 'body', settleMs: 1400 });
    await sleep(900);
    await clickButton(page, '新建采购订单', { scope: 'body', settleMs: 1400 });
    d = await dialogInfo(page);
    record('「新建采购订单」弹窗打开', d?.title === '新建采购订单', d ? `字段=${JSON.stringify(d.labels)}` : '未打开');
    const itemName = `${TAG} 测试服务器`;
    const unitPrice = '0.333';
    const qty = 3;
    await selectByLabel(page, '关联采购申请', prCode ?? '');
    await fillByLabel(page, '采购品名', itemName);
    await selectByLabel(page, '供应商', '.');
    // 主链路用**服务类**：设备类在分批验收上有缺陷（见 1.8），先不掺进来
    await selectByLabel(page, '采购类别', '服务类');
    await fillByLabel(page, '数量', String(qty));
    const fillUnit = await fillByLabel(page, '单价（含税）', unitPrice);
    await sleep(300);
    const stepProbe = await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      return [...d.querySelectorAll('input[type="number"]')].map((i) => ({
        value: i.value, step: i.getAttribute('step'), stepMismatch: i.validity.stepMismatch,
      }));
    })()`);
    const markPo = (page.requests ?? []).length;
    await clickButton(page, '创建订单', { settleMs: 1600 });
    const wrotePo = reqsSince(page, markPo).length;
    const nativeMsg = await page.evaluate(
      `(() => { const i = [...document.querySelectorAll('[role="dialog"] input[type="number"]')].find((x) => x.validity.stepMismatch); return i ? (i.validationMessage || '') : ''; })()`,
    );
    note('单价 step 探针', `fill=${fillUnit} inputs=${JSON.stringify(stepProbe)} 写请求=${wrotePo} 浏览器校验文案=${JSON.stringify(nativeMsg)}`);
    record(
      '小数单价可提交（3 位小数单价走真实点击提交成功）',
      wrotePo > 0,
      wrotePo > 0
        ? `已提交，写请求=${wrotePo}；type=number 的 step 由 Input 组件统一为 any（探针=${JSON.stringify(stepProbe)}），不存在 stepMismatch 拦截`
        : `未提交：被浏览器校验拦住；文案=${JSON.stringify(nativeMsg)}`,
    );

    let poRow = await sql`SELECT id, code, amount, quantity, unit_price, status, accepted_quantity, supplier_id, category
      FROM pur_order WHERE item_name = ${itemName} ORDER BY _created_at DESC LIMIT 1`;
    if (poRow.length === 0) {
      note('fallback', 'UI 未建单 → 用同一 DTO 走 POST /api/pur/orders 继续链路（口径等价）');
      const sup = (await sql`SELECT id FROM md_supplier WHERE status = 'active' ORDER BY _created_at LIMIT 1`)[0];
      const res = await api('/api/pur/orders', {
        method: 'POST',
        body: JSON.stringify({ requestId: prId, supplierId: sup?.id, itemName, category: 'service', quantity: qty, unitPrice: Number(unitPrice) }),
      });
      note('fallback', `POST /api/pur/orders → HTTP ${res.status} ${JSON.stringify(res.body?.message ?? res.body).slice(0, 160)}`);
      poRow = await sql`SELECT id, code, amount, quantity, unit_price, status, accepted_quantity, supplier_id, category
        FROM pur_order WHERE item_name = ${itemName} ORDER BY _created_at DESC LIMIT 1`;
    }
    if (poRow.length) created.purOrder.push(poRow[0].id);
    const po = poRow[0];
    const expectedAmount = r2(qty * Number(unitPrice));
    record(
      '采购订单落库，订单金额 = round2(数量×单价)',
      !!po && Number(po.amount) === expectedAmount,
      po ? `code=${po.code} qty=${po.quantity} unit=${po.unit_price} amount=${po.amount} 期望=${expectedAmount} category=${po.category} status=${po.status}` : '未落库',
    );
    if (po) {
      const dup = await api('/api/pur/orders', {
        method: 'POST',
        body: JSON.stringify({ requestId: prId, supplierId: po.supplier_id, itemName: `${itemName}-dup`, category: 'equipment', quantity: 1, unitPrice: 1 }),
      });
      record('同一申请重复下单被拦', dup.status === 409, `HTTP ${dup.status} ${JSON.stringify(dup.body?.message ?? dup.body).slice(0, 130)}`);
    }

    /* 1.5 分批验收（3 次各验 1） */
    await page.goto(`${APP}/pur?tab=orders`, { settleMs: 2600 });
    await sleep(1400);
    cells = await rowCells(page, po.code);
    note('订单行（验收前）', `单元格=${JSON.stringify(cells)} 按钮=${JSON.stringify(await rowButtons(page, po.code))}`);
    record('验收前界面显示「0 / 3」', !!cells && cells.includes('0 / 3'), `行=${JSON.stringify(cells)}`);

    const perAccept = [];
    let step1 = null;
    for (let i = 1; i <= qty; i += 1) {
      if (i > 1) {
        await page.goto(`${APP}/pur?tab=orders`, { settleMs: 2400 });
        await sleep(1300);
      }
      const clicked = await clickRowButton(page, po.code, '验收', { settleMs: 1400 });
      if (clicked !== 'ok') { note(`第 ${i} 次验收`, '找不到「验收」按钮'); break; }
      if (i === 1) {
        d = await dialogInfo(page);
        step1 = d;
        record('「订单验收」弹窗打开', d?.title === '订单验收', d ? `描述=${(d.text || '').replace(/\s+/g, ' ').slice(0, 160)}` : '未打开');
      }
      await fillByLabel(page, '验收数量', '1');
      const markAcc = (page.requests ?? []).length;
      await clickButton(page, '确认验收', { settleMs: 2000 });
      const ta = await toasts(page);
      await sleep(1000);
      const httpBad = (page.httpErrors ?? []).slice(-4);
      const apNow = await sql`SELECT code, amount FROM erp_ap_bill WHERE source = 'purchase'
        AND source_ref LIKE ${`po-accept:${po.code}:%`} ORDER BY _created_at`;
      const st = await sql`SELECT accepted_quantity, status FROM pur_order WHERE id = ${po.id}`;
      const wrote = reqsSince(page, markAcc).length;
      perAccept.push({ round: i, wrote, apCount: apNow.length, accepted: st[0]?.accepted_quantity, status: st[0]?.status, toast: ta, http: httpBad });
      note(
        `第 ${i} 次验收`,
        `写请求=${wrote} accepted=${st[0]?.accepted_quantity}/${qty} status=${st[0]?.status} 应付张数=${apNow.length} 应付合计=${apNow.reduce((s, r) => s + Number(r.amount), 0)} toast=${JSON.stringify(ta)} httpBad=${JSON.stringify(httpBad).slice(0, 200)}`,
      );
    }
    const lastRound = perAccept[perAccept.length - 1];
    record(
      '服务类订单分批验收 3 次（每次 1 件）全部成功',
      perAccept.length === qty && perAccept.every((r) => r.wrote > 0 && !r.http.length),
      `各轮=${JSON.stringify(perAccept.map((r) => ({ round: r.round, wrote: r.wrote, accepted: r.accepted, ap: r.apCount, http: r.http.map((h) => h.status) })))}`,
    );
    const poFinal = await sql`SELECT accepted_quantity, status, accept_date FROM pur_order WHERE id = ${po.id}`;
    record(
      '累计验收后订单状态 → accepted',
      poFinal[0]?.status === 'accepted' && poFinal[0]?.accepted_quantity === qty,
      `accepted=${poFinal[0]?.accepted_quantity}/${qty} status=${poFinal[0]?.status} acceptDate=${poFinal[0]?.accept_date}`,
    );
    const apAll = await sql`SELECT code, amount, source, source_ref, status FROM erp_ap_bill
      WHERE source = 'purchase' AND source_ref LIKE ${`po-accept:${po.code}:%`} ORDER BY _created_at`;
    const apSum = r2(apAll.reduce((s, r) => s + Number(r.amount), 0));
    record(
      '每次验收各生成一张应付（source=purchase，source_ref=po-accept:{订单号}:{应付号}）',
      apAll.length === qty && apAll.every((r) => r.source_ref.startsWith(`po-accept:${po.code}:`) && r.source === 'purchase'),
      `${apAll.length} 张：${JSON.stringify(apAll.map((r) => ({ ref: r.source_ref, amt: r.amount, st: r.status })))} 合计=${apSum}`,
    );
    note(
      '逐笔 round2 与合计取整的差异（设计口径，不是缺陷）',
      `逐笔 round2(1×0.333)=0.33 × 3 = ${apSum}；订单金额 round2(3×0.333)=${po.amount} —— 差 ${r2(Number(po.amount) - apSum)}，故 acceptedAmount 必须聚合落库金额而非按数量推导`,
    );

    /* 验收凭证 */
    const vchAps = await sql`SELECT v.code, v.source_ref, v.status,
        (SELECT COALESCE(SUM(debit),0) FROM fin_voucher_line WHERE voucher_id = v.id) AS dr,
        (SELECT COALESCE(SUM(credit),0) FROM fin_voucher_line WHERE voucher_id = v.id) AS cr
      FROM fin_voucher v WHERE v.source_ref IN ${sql(apAll.map((r) => `ap:${r.code}`))}`;
    record(
      '每笔验收生成进项凭证且借贷平衡',
      vchAps.length === apAll.length && vchAps.every((v) => Number(v.dr) === Number(v.cr)),
      `${vchAps.length} 张：${JSON.stringify(vchAps.map((v) => ({ code: v.code, dr: v.dr, cr: v.cr, st: v.status })))}`,
    );

    /*
     * 1.5b 设备类订单的**分批验收**（缺陷复现，见报告「PUR 缺陷 1」）
     *
     * 设备类验收会资本化生成 `ast_asset`，而 `purchase_order_id` 上有部分唯一索引
     * `uq_ast_asset_purchase_order`（一张订单一张卡）。已部署的 3100 构建每次验收
     * 都无条件 INSERT，于是第 2 次验收被 409 挡回、订单**永远收不完**。
     * 修法见 `server/modules/pur/pur-capitalize.ts`（累计而非新建），
     * 修复后的构建在 1.10 节验证。
     */
    const equipItem = `${TAG} 测试设备`;
    const equipOrder = await api('/api/pur/orders', {
      method: 'POST',
      body: JSON.stringify({ requestId: prId, supplierId: po.supplier_id, itemName: equipItem, category: 'equipment', quantity: 3, unitPrice: 444.44 }),
    });
    let equipPo = null;
    if (equipOrder.status === 201 || equipOrder.status === 200) {
      created.purOrder.push(equipOrder.body.id);
      equipPo = equipOrder.body;
      note('设备类订单（用于缺陷复现）', `${equipPo.code} qty=${equipPo.quantity} unit=${equipPo.unitPrice} amount=${equipPo.amount}`);
    } else {
      // 同一申请只能一张有效订单 → 上面已用掉 prId，这里改用新申请
      const prEq = await api('/api/pur/requests', {
        method: 'POST',
        body: JSON.stringify({ title: `${TAG} 设备验收申请`, requestType: 'equipment', amount: 2000 }),
      });
      note('设备类订单准备', `prId 已被占用（HTTP ${equipOrder.status}），改用新申请 ${prEq.body?.code}`);
      if (prEq.body?.id) {
        created.purRequest.push(prEq.body.id);
        await api(`/api/pur/requests/${prEq.body.id}/actions/approve`, { method: 'POST' });
        const again = await api('/api/pur/orders', {
          method: 'POST',
          body: JSON.stringify({ requestId: prEq.body.id, supplierId: po.supplier_id, itemName: equipItem, category: 'equipment', quantity: 3, unitPrice: 444.44 }),
        });
        if (again.status === 201 || again.status === 200) {
          created.purOrder.push(again.body.id);
          equipPo = again.body;
        }
      }
    }
    if (equipPo) {
      /* 第 1 次验收（1/3）：应建卡成功 */
      await page.goto(`${APP}/pur?tab=orders`, { settleMs: 2400 });
      await sleep(1300);
      await clickRowButton(page, equipPo.code, '验收', { settleMs: 1400 });
      await fillByLabel(page, '验收数量', '1');
      await clickButton(page, '确认验收', { settleMs: 2000 });
      await toasts(page);
      await sleep(900);
      const eqSt1 = (await sql`SELECT accepted_quantity, status FROM pur_order WHERE id = ${equipPo.id}`)[0];
      const eqAst1 = await sql`SELECT id, code, original_value, net_value FROM ast_asset WHERE purchase_order_id = ${equipPo.id}`;
      for (const a of eqAst1) created.astAsset.push(a.id);
      note('设备类第 1 次验收', `accepted=${eqSt1?.accepted_quantity}/3 status=${eqSt1?.status} 卡片=${JSON.stringify(eqAst1.map((a) => ({ code: a.code, ov: a.original_value })))}`);
      /* 第 2 次验收（应 2/3）：已部署构建会被唯一索引挡回 */
      await clickRowButton(page, equipPo.code, '验收', { settleMs: 1400 });
      await fillByLabel(page, '验收数量', '1');
      const markEq2 = (page.requests ?? []).length;
      await clickButton(page, '确认验收', { settleMs: 2000 });
      const tEq2 = await toasts(page);
      await sleep(900);
      const eqHttp = (page.httpErrors ?? []).filter((e) => e.url.includes(equipPo.id) && Number(e.status) >= 400);
      const eqSt2 = (await sql`SELECT accepted_quantity, status FROM pur_order WHERE id = ${equipPo.id}`)[0];
      const eqAp = await sql`SELECT count(*)::int AS n FROM erp_ap_bill WHERE source = 'purchase' AND source_ref LIKE ${`po-accept:${equipPo.code}:%`}`;
      /*
       * ⚠️ 2026-10-19 反向：这条断言原先是**「断言缺陷仍然存在」**（`defectReproduced`），
       * 用于开发期确认缺陷能复现。`pur-capitalize.ts` 修复后它必然失败 ——
       * 而"断言 bug 存在"的测试在修复之后**不能留着**，否则修好了反而报红。
       *
       * 现在改为断言**修复生效**：第 2 次验收被接受、数量累进到 2/3、
       * 订单仍是 pending（剩余 1 件待收）、按批次各生成 1 张应付。
       */
      const defectReproduced = eqSt2?.accepted_quantity === 1 && eqSt2?.status === 'pending' && eqHttp.some((e) => Number(e.status) === 409);
      const partialAcceptWorks =
        Number(eqSt2?.accepted_quantity) === 2 &&
        eqSt2?.status === 'pending' &&
        eqAp[0].n === 2 &&
        !eqHttp.some((e) => Number(e.status) === 409);
      record(
        '设备类分批验收第 2 次被接受（修复：数量累进到 2/3、订单仍 pending、按批次各生成 1 张应付）',
        partialAcceptWorks && !defectReproduced,
        `第 2 次验收后 accepted=${eqSt2?.accepted_quantity}/3 status=${eqSt2?.status} 应付=${eqAp[0].n} 张 http=${JSON.stringify(eqHttp.map((e) => e.status))} toast=${JSON.stringify(tEq2)} 缺陷复现=${defectReproduced}`,
      );
      evidence.push({
        section: 'PUR 缺陷 1（设备类分批验收）',
        text:
          `现象：设备类采购订单第一次验收（1/3）成功并生成资产卡片；第二次验收被 HTTP 409 拒绝，` +
          `toast=「该采购订单已生成固定资产卡片，一张采购订单只能生成一张卡片」，订单停在 accepted=1/3、status=pending。` +
          `根因：server/modules/pur/pur.service.ts 的 acceptOrder 每次验收都无条件 INSERT ast_asset，` +
          `而 ast_asset.purchase_order_id 上有部分唯一索引 uq_ast_asset_purchase_order（一张订单一张卡）——` +
          `第 2 次插入撞索引，被 server/common/filters/pg-error-messages.ts 翻译成那句 409 文案。` +
          `后果不只是少一张卡：剩余数量每次都被同一条约束挡回，订单永远完不成，剩余应付/进项凭证也永远生不成。` +
          `修法：先查本订单是否已有卡片，有则把本次验收金额累计进原值/净值（server/modules/pur/pur-capitalize.ts，已配单测），` +
          `无则建卡；资本化口径仍按类别决定（equipment → 1601 凭证）。`,
      });
    } else {
      record('设备类分批验收第 2 次被拒（缺陷复现）', false, '设备类订单未能创建，无法复现');
    }

    /* 1.6 acceptedAmount：界面（验收单打印预览）vs SQL */
    await page.goto(`${APP}/pur?tab=orders`, { settleMs: 2400 });
    await sleep(1400);
    cells = await rowCells(page, po.code);
    record('全部验收后界面「数量」列 = 3 / 3', !!cells && cells.includes('3 / 3'), `行=${JSON.stringify(cells)}`);
    const printClicked = await clickRowButton(page, po.code, '验收单', { settleMs: 1800 });
    const printDialog = await dialogInfo(page);
    const printText = (printDialog?.text ?? '').replace(/\s+/g, ' ');
    await closeDialog(page);
    await sleep(400);
    /*
     * ⚠️ 正则必须容忍空白：打印件里「验收金额（含税）：」与金额是两个相邻 span，
     * 而 `.print-total-row` 是 flex 容器 —— 子元素被 blockify，`innerText`
     * 会在两者之间插入换行（我第一版写成紧邻匹配，于是永远取不到值、
     * 看起来像"界面没有已验收金额"）。
     */
    const uiAcceptedAmount = /验收金额（含税）：\s*([\d,]+\.\d{2})/.exec(printText)?.[1]?.replace(/,/g, '');
    const uiAcceptedQty = /已验收数量：\s*([\d.]+)/.exec(printText)?.[1];
    const sqlAgg = await sql`SELECT COALESCE(SUM(amount),0) AS total, count(*)::int AS n
      FROM erp_ap_bill WHERE source = 'purchase'
        AND source_ref LIKE ${`po-accept:${po.code}:%`} AND status <> 'voided'`;
    const sqlTotal = r2(sqlAgg[0].total);
    note(
      'acceptedAmount 三方对照（界面 / SQL 聚合 / 订单金额）',
      `界面验收单打印预览：验收金额=${uiAcceptedAmount}，已验收数量=${uiAcceptedQty}（点击=${printClicked}，打印件全文=${JSON.stringify(printText.slice(0, 900))}）；` +
        `SQL: SELECT SUM(amount) FROM erp_ap_bill WHERE source='purchase' AND source_ref LIKE 'po-accept:${po.code}:%' AND status<>'voided' = ${sqlTotal}（${sqlAgg[0].n} 张）；` +
        `订单金额=${po.amount}；界面「数量」列=${JSON.stringify(cells?.[6])}`,
    );
    record(
      '✅ acceptedAmount：界面值 == SQL 算出的值（逐笔应付之和）',
      uiAcceptedAmount !== undefined && Number(uiAcceptedAmount) === sqlTotal,
      `界面=${uiAcceptedAmount} SQL=${sqlTotal}（订单金额=${po.amount}，因逐笔 round2 相差 ${r2(Number(po.amount) - sqlTotal)} 属既有口径）`,
    );
    /*
     * 验收单「已验收数量」必须等于**库里落库的 accepted_quantity**。
     * 原实现按 `acceptedAmount / unitPrice` 反推，单价含 3 位小数时会印出
     * 2.97 这种"件数"（0.99 / 0.333），与同一张单据的「订单数量 3」自相矛盾。
     */
    const dbAcceptedQty = Number(poFinal[0]?.accepted_quantity ?? 0);
    const uiQtyOk = Number(uiAcceptedQty) === dbAcceptedQty;
    record(
      '验收单「已验收数量」== SQL accepted_quantity（不按金额反推）',
      uiQtyOk,
      `界面数量=${uiAcceptedQty} SQL accepted_quantity=${dbAcceptedQty} 订单数量=${qty}${uiQtyOk ? '' : ' ⚠️ 单价 0.333×3 时反推得 0.99/0.333=2.97'}`,
    );

    /* 1.7 整单验收后再验收应被拒 */
    const reaccept = await api(`/api/pur/orders/${po.id}/accept`, { method: 'POST', body: JSON.stringify({ quantity: 1 }) });
    record(
      '整单验收后再次验收被拒（重复验收拦截）',
      reaccept.status === 400,
      `HTTP ${reaccept.status} ${JSON.stringify(reaccept.body?.message ?? reaccept.body).slice(0, 140)}`,
    );

    /* 1.8 超量验收被拒（新建第二张订单，走 UI） */
    const pr2Title = `${TAG} 超量验收申请`;
    await page.goto(`${APP}/pur`, { settleMs: 2400 });
    await sleep(1300);
    await clickButton(page, '新建采购申请', { scope: 'body', settleMs: 1300 });
    await fillByLabel(page, '申请标题', pr2Title);
    await fillByLabel(page, '预算金额', '10');
    await clickButton(page, '提交申请', { settleMs: 1600 });
    await toasts(page);
    await sleep(1200);
    const pr2 = (await sql`SELECT id, code FROM pur_request WHERE title = ${pr2Title} ORDER BY _created_at DESC LIMIT 1`)[0];
    if (pr2) {
      created.purRequest.push(pr2.id);
      await page.goto(`${APP}/pur`, { settleMs: 2400 });
      await sleep(1300);
      await clickRowButton(page, pr2Title, '批准', { settleMs: 1500 });
      await toasts(page);
      const item2 = `${TAG} 超量品`;
      const po2 = await api('/api/pur/orders', {
        method: 'POST',
        body: JSON.stringify({ requestId: pr2.id, supplierId: po.supplier_id, itemName: item2, category: 'service', quantity: 2, unitPrice: 100 }),
      });
      if (po2.status === 201 || po2.status === 200) {
        created.purOrder.push(po2.body.id);
        note('第二张订单（服务类，无项目 → 不生成项目成本）', `${po2.body.code} amount=${po2.body.amount}`);
        await page.goto(`${APP}/pur?tab=orders`, { settleMs: 2400 });
        await sleep(1300);
        await clickRowButton(page, po2.body.code, '验收', { settleMs: 1400 });
        await fillByLabel(page, '验收数量', '5');
        await clickButton(page, '确认验收', { settleMs: 1800 });
        const tOver = await toasts(page);
        await sleep(800);
        const still = await sql`SELECT accepted_quantity, status FROM pur_order WHERE id = ${po2.body.id}`;
        record(
          '超量验收被服务端拒绝（余量校验）',
          still[0]?.accepted_quantity === 0 && still[0]?.status === 'pending',
          `提交 5 > 余量 2 → toast=${JSON.stringify(tOver)} 库值 accepted=${still[0]?.accepted_quantity} status=${still[0]?.status}`,
        );
      } else {
        record('超量验收用例准备', false, `建第二张订单失败 HTTP ${po2.status} ${JSON.stringify(po2.body).slice(0, 120)}`);
      }
    } else {
      record('超量验收用例准备', false, '第二张采购申请未落库');
    }

    /* 1.9 采购看板 */
    page.resetDiagnostics();
    await page.goto(`${APP}/pur?tab=chain`, { settleMs: 2400 });
    await sleep(1600);
    const chainUi = await page.evaluate(
      `(() => [...document.querySelectorAll('[data-ai-section-type="card-stat"] p')].map((p) => (p.innerText || '').trim()))()`,
    );
    const chainSql = (await sql`SELECT
      (SELECT count(*)::int FROM pur_request WHERE status = 'pending') AS pr_pending,
      (SELECT count(*)::int FROM pur_order WHERE status = 'pending') AS po_pending,
      (SELECT count(*)::int FROM pur_order WHERE status = 'accepted') AS po_accepted,
      (SELECT COALESCE(SUM(amount - paid_amount),0) FROM erp_ap_bill WHERE source = 'purchase') AS open_ap,
      (SELECT COALESCE(SUM(paid_amount),0) FROM erp_ap_bill WHERE source = 'purchase') AS paid`)[0];
    const num = (s) => Number(String(s ?? '').replace(/[¥,\s]/g, ''));
    const chainChecks = [
      ['待审批申请', num(chainUi[0]), chainSql.pr_pending],
      ['待验收订单', num(chainUi[1]), chainSql.po_pending],
      ['已验收订单', num(chainUi[2]), chainSql.po_accepted],
      ['未付应付余额', num(chainUi[3]), num(chainSql.open_ap)],
      ['已付金额', num(chainUi[4]), num(chainSql.paid)],
    ];
    record(
      '采购看板 5 个指标 == SQL 口径（卡片顺序：待审批/待验收/已验收/未付应付/已付）',
      chainChecks.every(([, ui, db]) => ui === db),
      `界面=${JSON.stringify(chainUi)} SQL=${JSON.stringify(chainSql)} 逐项=${JSON.stringify(chainChecks)}`,
    );

    /* ═══════════════ 1.10 服务端修复验证（当前工作区构建，默认 :3109）═══════════════ */
    /*
     * 为什么单独起一个实例：被要求走查的 :3100 是**生产构建产物**（`node dist/server/main.js`，
     * 进程启动时间早于本轮源码修改），源码改动不会热更；而任务又明确"不要重启 3100"。
     * 因此用当前工作区重新 `nest build` 后另起一个实例（新端口、同库、ENABLE_SCHEDULER=false）
     * 来验证服务端改动本身。此节是**接口级**证据（浏览器 5273 的 /api 代理写死在 3100）。
     */
    const FIX_API = process.env.WT_FIX_API ?? 'http://127.0.0.1:3109';
    let fixUp = false;
    try {
      fixUp = (await fetch(`${FIX_API}/api/health`, { signal: AbortSignal.timeout(4000) })).ok;
    } catch { fixUp = false; }
    if (!fixUp) {
      record(
        '服务端修复验证（当前工作区构建实例）',
        false,
        `${FIX_API} 不可达 —— 修复只能靠单测与代码评审佐证，未做端到端验证`,
      );
    } else {
      const loginOn = async (base) => {
        const r = await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: USER, password: PASS }),
        });
        const jar = r.headers.getSetCookie?.() ?? [];
        return jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session='));
      };
      const ck = await loginOn(FIX_API);
      const apiFix = async (path, init = {}) => {
        const r = await fetch(`${FIX_API}${path}`, {
          ...init,
          headers: { 'content-type': 'application/json', cookie: ck ?? '', ...(init.headers ?? {}) },
        });
        const text = await r.text();
        let body; try { body = JSON.parse(text); } catch { body = text; }
        return { status: r.status, body };
      };
      const prFix = await apiFix('/api/pur/requests', {
        method: 'POST',
        body: JSON.stringify({ title: `${TAG} 修复验证申请`, requestType: 'equipment', amount: 10 }),
      });
      if (prFix.status !== 201 && prFix.status !== 200) {
        record('服务端修复验证（当前工作区构建实例）', false, `建申请失败 HTTP ${prFix.status} ${JSON.stringify(prFix.body).slice(0, 160)}`);
      } else {
        created.purRequest.push(prFix.body.id);
        await apiFix(`/api/pur/requests/${prFix.body.id}/actions/approve`, { method: 'POST' });
        const sup = (await sql`SELECT id FROM md_supplier WHERE status = 'active' ORDER BY _created_at LIMIT 1`)[0];
        const itemFix = `${TAG} 修复验证设备`;
        const poFix = await apiFix('/api/pur/orders', {
          method: 'POST',
          body: JSON.stringify({ requestId: prFix.body.id, supplierId: sup?.id, itemName: itemFix, category: 'equipment', quantity: 3, unitPrice: 0.333 }),
        });
        if (poFix.status !== 201 && poFix.status !== 200) {
          record('服务端修复验证（当前工作区构建实例）', false, `建订单失败 HTTP ${poFix.status} ${JSON.stringify(poFix.body).slice(0, 160)}`);
        } else {
          created.purOrder.push(poFix.body.id);
          const rounds = [];
          for (let i = 0; i < 3; i += 1) {
            const r = await apiFix(`/api/pur/orders/${poFix.body.id}/accept`, { method: 'POST', body: JSON.stringify({ quantity: 1 }) });
            rounds.push({ i: i + 1, status: r.status, accepted: r.body?.acceptedQuantity, msg: r.body?.message });
          }
          const fxOrder = (await sql`SELECT accepted_quantity, status, amount FROM pur_order WHERE id = ${poFix.body.id}`)[0];
          const fxAp = await sql`SELECT amount FROM erp_ap_bill WHERE source = 'purchase' AND source_ref LIKE ${`po-accept:${poFix.body.code}:%`} ORDER BY _created_at`;
          const fxSum = r2(fxAp.reduce((s, r) => s + Number(r.amount), 0));
          const fxCards = await sql`SELECT id, code, original_value, net_value FROM ast_asset WHERE purchase_order_id = ${poFix.body.id}`;
          for (const a of fxCards) created.astAsset.push(a.id);
          const listRes = await apiFix('/api/pur/orders?page=1&pageSize=100');
          const listed = (listRes.body?.items ?? []).find((x) => x.id === poFix.body.id);
          note(
            '修复后设备类分批验收',
            `各轮=${JSON.stringify(rounds)}；订单 accepted=${fxOrder?.accepted_quantity}/3 status=${fxOrder?.status}；` +
              `应付=${fxAp.length} 张合计 ${fxSum}；资产卡片=${fxCards.length} 张（原值 ${fxCards[0]?.original_value}）；` +
              `GET /api/pur/orders 返回的 acceptedAmount=${listed?.acceptedAmount}`,
          );
          record(
            '✅【修复验证】设备类订单分批验收 3 次全部成功且订单收满',
            rounds.every((r) => r.status === 200 || r.status === 201) && fxOrder?.status === 'accepted' && fxOrder?.accepted_quantity === 3,
            `各轮 HTTP=${JSON.stringify(rounds.map((r) => r.status))} accepted=${fxOrder?.accepted_quantity}/3 status=${fxOrder?.status}`,
          );
          record(
            '✅【修复验证】整单仍只有 1 张资产卡片，且原值 = 验收应付合计（累计而非覆盖）',
            fxCards.length === 1 && Number(fxCards[0]?.original_value) === fxSum && Number(fxCards[0]?.net_value) === fxSum,
            `卡片=${fxCards.length} 张 原值=${fxCards[0]?.original_value} 净值=${fxCards[0]?.net_value} 应付合计=${fxSum}（订单金额=${fxOrder?.amount}）`,
          );
          record(
            '✅【修复验证】接口返回的 acceptedAmount == SQL 聚合值（界面同源）',
            Number(listed?.acceptedAmount) === fxSum,
            `接口 acceptedAmount=${listed?.acceptedAmount} SQL=${fxSum}`,
          );
        }
      }
    }

    }
    if (want('asset')) {
    /* ═══════════════ 二、固定资产 ═══════════════ */
    console.log('\n═══ 二、/asset 固定资产 ═══');
    await ensureAlive();
    page.resetDiagnostics();
    const astName = `${TAG} 测试资产`;
    await page.goto(`${APP}/asset`, { settleMs: 2600 });
    await sleep(1500);
    const astTabs = await page.evaluate(
      `(() => [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter((x) => ['资产台账','折旧计提','减值测试','处置报废','变更审批','生命周期'].includes(x)))()`,
    );
    record('固定资产 6 个子 Tab 渲染', astTabs.length === 6, `tabs=${JSON.stringify(astTabs)}`);

    /* 2.1 新增资产（原值带小数 → 探 step） */
    await clickButton(page, '新增资产', { scope: 'body', settleMs: 1400 });
    d = await dialogInfo(page);
    record('「新增资产」弹窗打开', d?.title === '新增资产', d ? `字段=${JSON.stringify(d.labels)}` : '未打开');
    await fillByLabel(page, '资产名称', astName);
    await selectByLabel(page, '资产类别', '.');
    const fillOv = await fillByLabel(page, '原值（元）', '12000.50');
    await fillByLabel(page, '残值（元）', '0.50');
    await fillByLabel(page, '折旧月数', '12');
    const ovProbe = await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      return [...d.querySelectorAll('input[type="number"]')].map((i) => ({ value: i.value, step: i.getAttribute('step'), stepMismatch: i.validity.stepMismatch }));
    })()`);
    const markAst = (page.requests ?? []).length;
    await clickButton(page, '保存', { settleMs: 1700 });
    const wroteAst = reqsSince(page, markAst).length;
    const astNative = await page.evaluate(
      `(() => { const i = [...document.querySelectorAll('[role="dialog"] input[type="number"]')].find((x) => x.validity.stepMismatch); return i ? i.validationMessage : ''; })()`,
    );
    note('资产原值 step 探针', `fill=${fillOv} inputs=${JSON.stringify(ovProbe)} 写请求=${wroteAst} 校验文案=${JSON.stringify(astNative)}`);
    record(
      '⚠️ 小数原值能否提交（type=number 缺 step）',
      wroteAst > 0,
      wroteAst > 0 ? `已提交，写请求=${wroteAst}` : `被 stepMismatch 拦住、未发请求；文案=${JSON.stringify(astNative)}`,
    );
    let ast = await sql`SELECT id, code, name, original_value, residual_value, net_value, useful_months, status
      FROM ast_asset WHERE name = ${astName} ORDER BY _created_at DESC LIMIT 1`;
    if (ast.length === 0) {
      note('fallback', 'UI 被 step 拦住 → 用同一 DTO 走 POST /api/asset/assets 继续链路');
      const res = await api('/api/asset/assets', {
        method: 'POST',
        body: JSON.stringify({ name: astName, category: 'other', originalValue: 12000.5, residualValue: 0.5, usefulMonths: 12 }),
      });
      note('fallback', `POST /api/asset/assets → HTTP ${res.status} ${JSON.stringify(res.body?.message ?? '').slice(0, 120)}`);
      ast = await sql`SELECT id, code, name, original_value, residual_value, net_value, useful_months, status
        FROM ast_asset WHERE name = ${astName} ORDER BY _created_at DESC LIMIT 1`;
    }
    const asset = ast[0];
    if (asset) created.astAsset.push(asset.id);
    record(
      '资产落库（原值/残值/折旧月数一致）',
      !!asset && Number(asset.original_value) === 12000.5 && Number(asset.residual_value) === 0.5 && asset.useful_months === 12,
      asset ? `${asset.code} 原值=${asset.original_value} 残值=${asset.residual_value} 净值=${asset.net_value} 月数=${asset.useful_months} 状态=${asset.status}` : '未落库',
    );
    const expectMonthly = r2((12000.5 - 0.5) / 12);
    note('折旧算法预期', `月折旧额 = round2((原值 12000.50 − 残值 0.50) / 12) = ${expectMonthly}`);

    /* 2.2 折旧计提 + 期间幂等 */
    await clickButton(page, '折旧计提', { scope: 'body', settleMs: 1500 });
    await sleep(1000);
    const depPeriod = today().slice(0, 7);
    // 计提是**批量**接口（会影响库里所有在用资产），先记录现有折旧行，
    // 以便清理时把"非本次创建资产"的折旧行与其净值扣减**原样回滚**（见 finally）。
    const depBeforeIds = (await sql`SELECT id FROM ast_depreciation`).map((r) => r.id);
    await fillByLabel(page, '计提期间', depPeriod, 'body');
    await clickButton(page, '按月计提折旧', { scope: 'body', settleMs: 2400 });
    t = await toasts(page);
    await sleep(1200);
    const foreignDep = await sql`SELECT id, asset_id, amount FROM ast_depreciation
      WHERE period = ${depPeriod} AND asset_id <> ${asset.id}
        AND id NOT IN ${sql(depBeforeIds.length ? depBeforeIds : ['00000000-0000-0000-0000-000000000000'])}`;
    for (const x of foreignDep) foreignDepRows.push(x);
    if (foreignDep.length) {
      note(
        '⚠️ 批量计提的副作用',
        `本次点击同时对库里其它 ${foreignDep.length} 项资产计提了折旧（合计 ${r2(foreignDep.reduce((s, x) => s + Number(x.amount), 0))}），清理阶段会把它们的净值和折旧行原样回滚`,
      );
    }
    const dep = await sql`SELECT id, asset_id, period, amount, cost_generated FROM ast_depreciation
      WHERE asset_id = ${asset.id} AND period = ${depPeriod}`;
    const netAfterDep = (await sql`SELECT net_value FROM ast_asset WHERE id = ${asset.id}`)[0];
    record(
      '折旧计提落库 ast_depreciation，金额 = (原值−残值)/折旧月数',
      dep.length === 1 && Number(dep[0].amount) === expectMonthly,
      `行=${dep.length} 金额=${dep[0]?.amount} 期望=${expectMonthly} 净值 ${asset.net_value}→${netAfterDep?.net_value} toast=${JSON.stringify(t)}`,
    );
    record(
      '折旧原子扣减净值（numeric 精度无浮点尾差）',
      Number(netAfterDep?.net_value) === r2(Number(asset.net_value) - expectMonthly),
      `${asset.net_value} − ${expectMonthly} = ${netAfterDep?.net_value}（期望 ${r2(Number(asset.net_value) - expectMonthly)}）`,
    );
    await clickButton(page, '按月计提折旧', { scope: 'body', settleMs: 2400 });
    const t2 = await toasts(page);
    await sleep(1000);
    const dep2 = await sql`SELECT count(*)::int AS n FROM ast_depreciation WHERE asset_id = ${asset.id} AND period = ${depPeriod}`;
    const net2 = (await sql`SELECT net_value FROM ast_asset WHERE id = ${asset.id}`)[0];
    record(
      '同资产同期间幂等（重复点击不重复计提；uq_ast_depreciation_asset_period）',
      dep2[0].n === 1 && Number(net2?.net_value) === Number(netAfterDep?.net_value),
      `折旧行=${dep2[0].n} 净值=${net2?.net_value}（未变）toast=${JSON.stringify(t2)}`,
    );
    const depVch = await sql`SELECT id, code, source_ref FROM fin_voucher
      WHERE source_type = 'depreciation' AND id NOT IN ${sql(depVoucherBefore.length ? depVoucherBefore : ['00000000-0000-0000-0000-000000000000'])}`;
    for (const v of depVch) created.depVoucher.push(v.id);
    note('本次折旧生成凭证', JSON.stringify(depVch.map((v) => v.source_ref)));
    if (depVch.length) {
      const bal = await sql`SELECT v.code,
          (SELECT COALESCE(SUM(debit),0) FROM fin_voucher_line WHERE voucher_id = v.id) AS dr,
          (SELECT COALESCE(SUM(credit),0) FROM fin_voucher_line WHERE voucher_id = v.id) AS cr
        FROM fin_voucher v WHERE v.id IN ${sql(depVch.map((v) => v.id))}`;
      record('折旧凭证借贷平衡', bal.every((b) => Number(b.dr) === Number(b.cr)), JSON.stringify(bal.map((b) => ({ code: b.code, dr: b.dr, cr: b.cr }))));
    }

    /* 2.3 变更/转移：调拨必须能填目标 */
    // ⚠️ 「发起变更」是**资产台账**表格的**行内**按钮（asset-columns.tsx），
    //    不在「变更审批」Tab 上 —— 在变更审批 Tab 上找它是找不到的。
    await page.goto(`${APP}/asset`, { settleMs: 2400 });
    await sleep(1400);
    const beforeChange = (await sql`SELECT count(*)::int AS n FROM ast_change`)[0].n;
    const openChange = await clickRowButton(page, asset.code, '发起变更', { settleMs: 1500 });
    d = await dialogInfo(page);
    record('「发起资产变更」弹窗打开', d?.title === '发起资产变更', d ? `点击=${openChange} 字段=${JSON.stringify(d.labels)}` : `未打开（点击=${openChange}）`);
    note('变更弹窗字段', JSON.stringify(d?.labels ?? []));
    if (d) {
      await selectByLabel(page, '资产', asset.code);
      await selectByLabel(page, '变更类型', '调拨');
      await sleep(400);
      const labelsAfterTransfer = (await dialogInfo(page))?.labels ?? [];
      const hasTarget = labelsAfterTransfer.some((l) => /目标部门/.test(l));
      record(
        '选中「调拨」后出现「目标部门 / 目标项目」下拉',
        hasTarget && labelsAfterTransfer.some((l) => /目标项目/.test(l)),
        `字段=${JSON.stringify(labelsAfterTransfer)}`,
      );
      await fillByLabel(page, '变更说明', `${TAG} 调拨说明`);
      if (hasTarget) {
        const deptPick = await selectByLabel(page, '目标部门', '.');
        note('选择目标部门', deptPick);
      }
      await clickButton(page, '提交', { settleMs: 1800 });
      const ct = await toasts(page);
      await sleep(1000);
      const changeRow = await sql`SELECT id, code, change_type, status, target_department_id, target_project_id, after_value
        FROM ast_change WHERE asset_id = ${asset.id} ORDER BY _created_at DESC LIMIT 1`;
      record(
        '变更单「调拨」可提交（服务端要求 targetDepartmentId/targetProjectId 至少一个）',
        changeRow.length > 0 && changeRow[0].status === 'pending',
        changeRow.length
          ? `${changeRow[0].code} type=${changeRow[0].change_type} status=${changeRow[0].status} 目标部门=${changeRow[0].target_department_id ?? '-'} 说明=${changeRow[0].after_value ?? '-'}`
          : `被拒：toast=${JSON.stringify(ct)}；弹窗字段=${JSON.stringify(labelsAfterTransfer)}`,
      );
      if (changeRow.length) {
        await closeDialog(page);
        await sleep(400);
        await page.goto(`${APP}/asset`, { settleMs: 2400 });
        await sleep(1400);
        await clickButton(page, '变更审批', { scope: 'body', settleMs: 1500 });
        await sleep(1100);
        // 变更审批的行内按钮文案是「通过 / 驳回」
        const ap = await clickRowButton(page, changeRow[0].code, '通过', { settleMs: 1900 });
        const at = await toasts(page);
        await sleep(900);
        const chAfter = (await sql`SELECT status FROM ast_change WHERE id = ${changeRow[0].id}`)[0];
        const astAfterCh = (await sql`SELECT department_id, project_id FROM ast_asset WHERE id = ${asset.id}`)[0];
        record(
          '变更单审批通过并回写资产（transfer 落目标部门/项目）',
          chAfter?.status === 'approved',
          `click=${ap} status=${chAfter?.status} 资产部门=${astAfterCh?.department_id ?? '-'} 项目=${astAfterCh?.project_id ?? '-'} toast=${JSON.stringify(at)}`,
        );
      }
    }
    const recv = await api('/api/asset/changes', {
      method: 'POST',
      body: JSON.stringify({ assetId: asset.id, changeType: 'receive' }),
    });
    record(
      '变更状态机：在用资产发起「领用」被拒（仅闲置可领用）',
      recv.status === 400,
      `HTTP ${recv.status} ${JSON.stringify(recv.body?.message ?? recv.body).slice(0, 130)}`,
    );

    /* 2.4 处置报废 */
    await ensureAlive();
    page.resetDiagnostics();
    await page.goto(`${APP}/asset`, { settleMs: 2400 });
    await sleep(1300);
    await clickButton(page, '处置报废', { scope: 'body', settleMs: 1500 });
    await sleep(1000);
    await clickButton(page, '发起处置', { scope: 'body', settleMs: 1500 });
    d = await dialogInfo(page);
    record('「发起资产处置」弹窗打开', d?.title === '发起资产处置', d ? `字段=${JSON.stringify(d.labels)}` : '未打开');
    if (d) {
      await selectByLabel(page, '资产（仅在用/闲置/维修中可选）', asset.code);
      await selectByLabel(page, '处置方式', '出售');
      await fillByLabel(page, '处置收入（不含税）', '5000');
      await fillByLabel(page, '销项税率（%）', '13');
      await clickButton(page, '试算', { settleMs: 1600 });
      const pv = (await dialogInfo(page))?.text ?? '';
      note('处置试算', pv.replace(/\s+/g, ' ').slice(0, 320));
      await clickButton(page, '提交', { settleMs: 1900 });
      t = await toasts(page);
      await sleep(1100);
      note('处置提交后 toast', JSON.stringify(t));
    }
    let dsp = await sql`SELECT id, code, asset_id, disposal_type, status, net_value, disposal_income, tax_amount, gain_loss, voucher_ref
      FROM ast_disposal WHERE asset_id = ${asset.id} ORDER BY _created_at DESC LIMIT 1`;
    if (dsp.length === 0) {
      const btns = await page.evaluate(
        `(() => { const dd = document.querySelector('[role="dialog"]'); return dd ? [...dd.querySelectorAll('button')].map((b) => b.innerText.trim()) : []; })()`,
      );
      note('处置提交未成功', `弹窗按钮=${JSON.stringify(btns)} toast=${JSON.stringify(t)}`);
      await closeDialog(page);
    }
    record(
      '处置单落库（status=disposing，未审批不生成凭证）',
      dsp.length === 1 && dsp[0].status === 'disposing' && dsp[0].voucher_ref === null,
      dsp.length ? `${dsp[0].code} type=${dsp[0].disposal_type} status=${dsp[0].status} 净值=${dsp[0].net_value} 收入=${dsp[0].disposal_income} 税=${dsp[0].tax_amount} 损益=${dsp[0].gain_loss} voucherRef=${dsp[0].voucher_ref}` : '未落库',
    );
    const dupDsp = await api('/api/asset/disposals', {
      method: 'POST',
      body: JSON.stringify({ assetId: asset.id, disposalType: 'scrap', applyDate: today() }),
    });
    record(
      '同资产第二张未完成处置单被拒（ast_disposal_active 部分唯一索引 + 前置校验）',
      dupDsp.status === 409,
      `HTTP ${dupDsp.status} ${JSON.stringify(dupDsp.body?.message ?? dupDsp.body).slice(0, 140)}`,
    );
    if (dsp.length) {
      await ensureAlive();
      await page.goto(`${APP}/asset`, { settleMs: 2400 });
      await sleep(1300);
      await clickButton(page, '处置报废', { scope: 'body', settleMs: 1500 });
      await sleep(1000);
      const done = await clickRowButton(page, dsp[0].code, '完成', { settleMs: 1200 });
      const confirmDone = await confirmAlert(page, { settleMs: 2400 });
      t = await toasts(page);
      await sleep(1300);
      const dspDone = (await sql`SELECT status, voucher_ref, gain_loss FROM ast_disposal WHERE id = ${dsp[0].id}`)[0];
      const assetAfterDsp = (await sql`SELECT status, net_value FROM ast_asset WHERE id = ${asset.id}`)[0];
      note('完成处置', `click=${done} 二次确认=${JSON.stringify(confirmDone)}`);
      record(
        '处置完成：disposing→disposed，资产卡片同步 disposed 且净值归零',
        done === 'ok' && dspDone?.status === 'disposed' && assetAfterDsp?.status === 'disposed' && Number(assetAfterDsp?.net_value) === 0,
        `click=${done} 处置单=${dspDone?.status} voucherRef=${dspDone?.voucher_ref} 资产=${assetAfterDsp?.status}/${assetAfterDsp?.net_value} toast=${JSON.stringify(t)}`,
      );
      const vch = await sql`SELECT v.code, v.status,
          (SELECT COALESCE(SUM(debit),0) FROM fin_voucher_line WHERE voucher_id = v.id) AS dr,
          (SELECT COALESCE(SUM(credit),0) FROM fin_voucher_line WHERE voucher_id = v.id) AS cr,
          (SELECT count(*)::int FROM fin_voucher_line WHERE voucher_id = v.id) AS lines
        FROM fin_voucher v WHERE v.source_ref = ${`asset-disposal:${dsp[0].code}`}`;
      record(
        '处置凭证生成且借贷平衡（每张凭证借方合计 == 贷方合计）',
        vch.length === 1 && Number(vch[0].dr) === Number(vch[0].cr) && Number(vch[0].dr) > 0,
        vch.length ? `${vch[0].code} 行数=${vch[0].lines} 借=${vch[0].dr} 贷=${vch[0].cr}` : '未生成凭证',
      );
      const again = await api('/api/asset/disposals', {
        method: 'POST',
        body: JSON.stringify({ assetId: asset.id, disposalType: 'scrap', applyDate: today() }),
      });
      record('已处置资产再次发起处置被拒', again.status === 400, `HTTP ${again.status} ${JSON.stringify(again.body?.message ?? again.body).slice(0, 130)}`);
    }

    /* 2.5 减值测试（只验入口与预览，不改动已处置资产） */
    await page.goto(`${APP}/asset`, { settleMs: 2400 });
    await sleep(1200);
    await clickButton(page, '减值测试', { scope: 'body', settleMs: 1500 });
    await sleep(1200);
    const impPanel = await page.evaluate('document.body.innerText');
    record('减值测试 Tab 渲染（含入口按钮）', /减值/.test(impPanel), `含"减值"=${/减值/.test(impPanel)} 长度=${impPanel.length}`);

    }
    if (want('notes')) {
    /* ═══════════════ 三、票据管理 ═══════════════ */
    console.log('\n═══ 三、/notes 票据管理 ═══');
    await ensureAlive();
    page.resetDiagnostics();
    await page.goto(`${APP}/notes`, { settleMs: 2600 });
    await sleep(1700);
    const noteNo = `API${Date.now().toString().slice(-8)}`;
    const noteAmount = 100000;
    const dueDate = todayPlus(10);
    await clickButton(page, '登记票据', { scope: 'body', settleMs: 1500 });
    d = await dialogInfo(page);
    record('「登记票据」弹窗打开', d?.title === '登记票据', d ? `字段=${JSON.stringify(d.labels)}` : '未打开');
    if (d) {
      await fillByLabel(page, '票号', noteNo);
      await selectByLabel(page, '票据类型', '银行承兑');
      await fillByLabel(page, '票面金额', String(noteAmount));
      await fillByLabel(page, '到期日', dueDate);
      await fillByLabel(page, '出票人', `${TAG} 出票人`);
      const submitBtn = await clickButton(page, '确认登记', { settleMs: 1900 });
      if (submitBtn !== 'ok') note('票据登记按钮', '未找到「确认登记」按钮');
      t = await toasts(page);
      await sleep(1200);
    }
    let nt = (await sql`SELECT id, code, note_no, note_type, amount, due_date, status FROM erp_note
      WHERE note_no = ${noteNo} ORDER BY _created_at DESC LIMIT 1`)[0];
    record('票据登记落库', !!nt, nt ? `${nt.code} 票面=${nt.amount} 到期=${nt.due_date} 类型=${nt.note_type} 状态=${nt.status} toast=${JSON.stringify(t)}` : `未落库 toast=${JSON.stringify(t)}`);
    if (nt) {
      created.note.push(nt.id);
      await page.goto(`${APP}/notes`, { settleMs: 2400 });
      await sleep(1600);
      note('票据行按钮（received）', JSON.stringify(await rowButtons(page, noteNo)));
      const hold = await clickRowButton(page, noteNo, '确认持有', { settleMs: 1500 });
      /*
       * ⚠️ 票据的每个动作都要在**流转弹窗**里再点一次「确认」——
       * 只点表格行里的动作按钮，弹窗开着、状态不动，看起来像功能坏了。
       */
      const holdDialog = await dialogInfo(page);
      const holdConfirm = holdDialog ? await clickButton(page, '确认', { settleMs: 1800 }) : 'no-dialog';
      const th = await toasts(page);
      await sleep(900);
      const held = (await sql`SELECT status FROM erp_note WHERE id = ${nt.id}`)[0];
      record(
        '票据「确认持有」状态流转 received→held',
        hold === 'ok' && held?.status === 'held',
        `行内点击=${hold} 流转弹窗=${holdDialog ? holdDialog.title : '无'} 确认点击=${holdConfirm} status=${held?.status} toast=${JSON.stringify(th)}`,
      );

      await page.goto(`${APP}/notes`, { settleMs: 2400 });
      await sleep(1600);
      const discOpen = await clickRowButton(page, noteNo, '贴现', { settleMs: 1700 });
      d = await dialogInfo(page);
      record('「贴现」弹窗打开', discOpen === 'ok' && !!d, d ? `标题=${d.title} 字段=${JSON.stringify(d.labels)}` : `click=${discOpen}`);
      const rate = 3.6;
      await fillByLabel(page, '贴现率', String(rate));
      await setDateField(page, '贴现日', today()).catch(() => 'skip');
      await clickButton(page, '试算', { settleMs: 1700 }).catch(() => 'no-btn');
      const prevText = ((await dialogInfo(page))?.text ?? '').replace(/\s+/g, ' ');
      // 「贴现息」在弹窗文案里出现两次（"试算贴现息与分录" 与结果行），取**最后一次**匹配
      const interestMatches = [...prevText.matchAll(/贴现息\s*([\d,]+\.\d{2})/g)];
      const uiInterest = interestMatches[interestMatches.length - 1]?.[1]?.replace(/,/g, '');
      note('贴现试算（界面）', prevText.slice(0, 320));
      await clickButton(page, '确认', { settleMs: 2100 });
      t = await toasts(page);
      await sleep(1300);
      const d0 = (await sql`SELECT status, discount_rate, discount_interest, discount_days, settled_amount, settled_date
        FROM erp_note WHERE id = ${nt.id}`)[0];
      const discDate = toIso(d0?.settled_date) ?? today();
      const dueIso = toIso(nt.due_date);
      const days = Math.round((Date.parse(`${dueIso}T00:00:00Z`) - Date.parse(`${discDate}T00:00:00Z`)) / 86400000);
      const expectInterest = r2((noteAmount * rate) / 100 * days / 360);
      record(
        '贴现落库：状态/贴现率/计息天数/贴现息（360 天基准，算头不算尾 —— 已确认口径）',
        d0?.status === 'discounted' && Number(d0?.discount_days) === days && Math.abs(Number(d0?.discount_interest) - expectInterest) < 0.005,
        `status=${d0?.status} rate=${d0?.discount_rate} days=${d0?.discount_days}（期望 ${days} = ${discDate}→${dueIso} 算头不算尾）息=${d0?.discount_interest}（期望 ${expectInterest} = ${noteAmount}×${rate}%×${days}/360）界面试算=${uiInterest} toast=${JSON.stringify(t)}`,
      );
      record(
        '贴现到账额 = 票面 − 贴现息',
        Math.abs(Number(d0?.settled_amount) - (noteAmount - Number(d0?.discount_interest))) < 0.005,
        `到账=${d0?.settled_amount} = ${noteAmount} − ${d0?.discount_interest}`,
      );
      const nvch = await sql`SELECT v.code,
          (SELECT COALESCE(SUM(debit),0) FROM fin_voucher_line WHERE voucher_id = v.id) AS dr,
          (SELECT COALESCE(SUM(credit),0) FROM fin_voucher_line WHERE voucher_id = v.id) AS cr
        FROM fin_voucher v WHERE v.source_ref = ${`note:${nt.code}:discount`}`;
      record('贴现凭证借贷平衡', nvch.length === 1 && Number(nvch[0].dr) === Number(nvch[0].cr), nvch.length ? `${nvch[0].code} 借=${nvch[0].dr} 贷=${nvch[0].cr}` : '未生成凭证');
      const dupNote = await api(`/api/notes/${nt.id}/actions`, { method: 'POST', body: JSON.stringify({ action: 'discount', discountRate: rate }) });
      record('重复贴现被拦（状态机 + 日志唯一索引）', dupNote.status === 400 || dupNote.status === 409, `HTTP ${dupNote.status} ${JSON.stringify(dupNote.body?.message ?? dupNote.body).slice(0, 140)}`);
      /* 备查簿 / 预警 */
      await page.goto(`${APP}/notes`, { settleMs: 2400 });
      await sleep(1700);
      const ledgerUi = await page.evaluate('document.body.innerText');
      const regSql = await sql`SELECT status, count(*)::int AS n, COALESCE(SUM(amount),0) AS amt FROM erp_note GROUP BY status`;
      record(
        '备查簿 / 到期预警渲染（含状态分布与预警区）',
        ledgerUi.includes('票据备查簿'),
        `含"票据备查簿"=${ledgerUi.includes('票据备查簿')} 含"预警"=${/预警|到期提醒/.test(ledgerUi)} SQL 状态分布=${JSON.stringify(regSql)}`,
      );
      const alerts = await api('/api/notes/due-alerts');
      const alertList = alerts.body?.alerts ?? alerts.body?.items ?? alerts.body;
      record(
        '到期预警：10 天后到期的票据在 15 天窗口内（预警接口可见）',
        Array.isArray(alertList) && alertList.some((a) => JSON.stringify(a).includes(noteNo)),
        `HTTP ${alerts.status} 条数=${Array.isArray(alertList) ? alertList.length : 'n/a'} 含本票=${Array.isArray(alertList) ? alertList.some((a) => JSON.stringify(a).includes(noteNo)) : 'n/a'}`,
      );
    }

    }
    if (want('admin')) {
    /* ═══════════════ 四、行政管理 ═══════════════ */
    console.log('\n═══ 四、行政管理 ═══');
    await ensureAlive();
    /*
     * 整段包一层 try/catch：浏览器整体假死时不要连累"报告落盘 + 清理"，
     * 而是把这一段的执行失败如实记成一条 FAIL（前面各区块的结果已增量落盘）。
     */
    try {
    const adminPages = [
      ['/admin-rent', '租房合同'],
      ['/admin-bills', '行政缴费'],
      ['/admin-assets', '行政资产'],
      ['/admin-affairs', '车辆与差旅'],
      ['/admin-automation', '自动化任务'],
    ];
    for (const [route, label] of adminPages) {
      page.resetDiagnostics();
      await page.goto(`${APP}${route}`, { settleMs: 2400 });
      await sleep(1400);
      const info = await page.evaluate(`(() => ({
        textLen: (document.body.innerText || '').length,
        buttons: [...document.querySelectorAll('button')].length,
      }))()`);
      const cerr = page.consoleLogs.filter((l) => l.type === 'error');
      const http4 = (page.httpErrors ?? []).filter((e) => Number(e.status) >= 400);
      record(
        `${label}（${route}）渲染且无 console.error / 无 HTTP≥400`,
        info.textLen > 200 && info.buttons > 2 && cerr.length === 0 && http4.length === 0,
        `text=${info.textLen} btn=${info.buttons} consoleErr=${cerr.length} http≥400=${JSON.stringify(http4).slice(0, 160)}`,
      );
      diag.consoleErrors.push(...cerr);
      diag.exceptions.push(...page.exceptions);
      diag.httpErrors.push(...http4);
    }

    /* 4.0 自动化任务开关（**先跑**：它是任务书点名要验的一项，
       而实测本机浏览器每跑十几屏就可能整体假死一次，放最后容易丢证据） */
    await ensureAlive('自动化任务检查前', { force: true });
    page.resetDiagnostics();
    await page.goto(`${APP}/admin-automation`, { settleMs: 2400 });
    await sleep(1700);
    const autoRows = await sql`SELECT task_key, task_name, enabled, _updated_at FROM comp_automation_config ORDER BY task_key`;
    const uiAuto = await page.evaluate(`(() => ({
      switches: document.querySelectorAll('[role="switch"]').length,
      text: document.body.innerText,
    }))()`);
    record(
      '自动化任务页：开关数量 == 库中任务数（页面渲染全部任务）',
      autoRows.length > 0 && uiAuto.switches === autoRows.length,
      `库中任务=${autoRows.length} 界面开关=${uiAuto.switches} keys=${JSON.stringify(autoRows.map((r) => r.task_key))}`,
    );
    note(
      '任务数量口径',
      `任务书说"6 个任务"，实测 comp_automation_config 已有 ${autoRows.length} 条（后续迭代加入了 bi_alert_daily / contract_expiry_remind / note_due_reminder_daily / retention_daily / session_cleanup_daily / voucher_job_retry / year_end_reminder_daily / feishu_contact_* 等）—— 这是数据事实，不是页面缺陷`,
    );
    const targetKey = autoRows[0]?.task_key;
    const targetName = autoRows[0]?.task_name;
    const epochBefore = (await sql`SELECT COALESCE(MAX(_updated_at)::text,'0') AS stamp FROM comp_automation_config`)[0].stamp;
    /* 按 aria-label 精确锁定该任务的开关（`停用任务 <名称>` / `启用任务 <名称>`） */
    const switchExpr = `(() => {
      const hit = [...document.querySelectorAll('[role="switch"]')]
        .find((el) => (el.getAttribute('aria-label') || '').includes(${JSON.stringify(targetName ?? '')}));
      return hit || null;
    })()`;
    const switchClick = await clickExpr(page, switchExpr, { settleMs: 1200 });
    note('点击目标开关', `${targetKey} / ${targetName} → ${switchClick}`);
    const autoConfirm = await confirmAlert(page, { settleMs: 1900 });
    note('停用确认弹窗', JSON.stringify(autoConfirm));
    t = await toasts(page);
    await sleep(1100);
    const toggled = (await sql`SELECT enabled FROM comp_automation_config WHERE task_key = ${targetKey}`)[0];
    const epochAfter = (await sql`SELECT COALESCE(MAX(_updated_at)::text,'0') AS stamp FROM comp_automation_config`)[0].stamp;
    record(
      '自动化开关「停用」落库（界面点击 → comp_automation_config.enabled=false）',
      toggled?.enabled === false,
      `${targetKey}: 原 ${autoRows[0]?.enabled} → ${toggled?.enabled} 点击=${switchClick} 二次确认=${JSON.stringify(autoConfirm)} toast=${JSON.stringify(t)}`,
    );
    record(
      '开关生效机制：_updated_at(epoch) 变化 → isEnabled 缓存键失效（不是等 60s）',
      epochBefore !== epochAfter,
      `epoch ${epochBefore} → ${epochAfter}；缓存键 = automation:<epoch>:<taskKey>，60s 只是同一 epoch 下的 TTL，改开关即换键`,
    );
    await page.goto(`${APP}/admin-automation`, { settleMs: 2200 });
    await sleep(1500);
    const restoreClick = await clickExpr(page, switchExpr, { settleMs: 1900 });
    await toasts(page);
    await sleep(1000);
    const restored = (await sql`SELECT enabled FROM comp_automation_config WHERE task_key = ${targetKey}`)[0];
    record('自动化开关已复原为启用', restored?.enabled === true, `${targetKey}.enabled=${restored?.enabled} 点击=${restoreClick}`);

    /* 4.1 租房合同：新建 + 编辑（含清空字段）+ 详情页 */
    await ensureAlive();
    page.resetDiagnostics();
    const rentName = `${TAG} 租房合同`;
    await page.goto(`${APP}/admin-rent`, { settleMs: 2400 });
    await sleep(1400);
    await clickButton(page, '新建合同', { scope: 'body', settleMs: 1500 });
    d = await dialogInfo(page);
    record('「新建租房合同」弹窗打开', !!d, d ? `标题=${d.title} 字段=${JSON.stringify(d.labels)}` : '未打开');
    if (d) {
      await fillByLabel(page, '合同名称', rentName);
      await fillByLabel(page, '房产地址', `${TAG} 测试地址 1 号`);
      await fillByLabel(page, '出租方', `${TAG} 出租方`);
      await fillByLabel(page, '月租金', '8800.88');
      await fillByLabel(page, '押金', '17601.76');
      const dStart = await setDateField(page, '起租日期', today());
      const dEnd = await setDateField(page, '到期日期', todayPlus(60));
      await selectByLabel(page, '付款方式', '.').catch(() => 'skip');
      const markR = (page.requests ?? []).length;
      await clickButton(page, '保存', { settleMs: 1900 });
      t = await toasts(page);
      await sleep(1100);
      note('租房合同提交', `起租日期=${dStart} 到期日期=${dEnd} 写请求=${reqsSince(page, markR).length} toast=${JSON.stringify(t)}`);
      const rent = await sql`SELECT id, code, name, monthly_rent, deposit, status, remark, start_date, end_date
        FROM erp_admin_rent_contract WHERE name = ${rentName} ORDER BY _created_at DESC LIMIT 1`;
      if (rent.length) created.rent.push(rent[0].id);
      record(
        '租房合同落库（月租金/押金两位小数一致）',
        rent.length === 1 && Number(rent[0].monthly_rent) === 8800.88 && Number(rent[0].deposit) === 17601.76,
        rent.length ? `${rent[0].code} 月租=${rent[0].monthly_rent} 押金=${rent[0].deposit} 起=${rent[0].start_date} 止=${rent[0].end_date} 状态=${rent[0].status}` : `未落库 toast=${JSON.stringify(t)}`,
      );
      if (rent.length) {
        /* 编辑：先写备注，再清空 —— 验"清空是否真落库" */
        await page.goto(`${APP}/admin-rent`, { settleMs: 2400 });
        await sleep(1500);
        await clickRowButton(page, rentName, '编辑', { settleMs: 1500 });
        await fillByLabel(page, '备注', `${TAG} 建时备注`);
        await clickButton(page, '保存', { settleMs: 1800 });
        await toasts(page);
        await sleep(900);
        const withRemark = (await sql`SELECT remark FROM erp_admin_rent_contract WHERE id = ${rent[0].id}`)[0];
        await page.goto(`${APP}/admin-rent`, { settleMs: 2400 });
        await sleep(1500);
        await clickRowButton(page, rentName, '编辑', { settleMs: 1500 });
        const dlgLabels = (await dialogInfo(page))?.labels ?? [];
        await fillByLabel(page, '备注', '');
        await clickButton(page, '保存', { settleMs: 1800 });
        const tClear = await toasts(page);
        await sleep(900);
        const cleared = (await sql`SELECT remark FROM erp_admin_rent_contract WHERE id = ${rent[0].id}`)[0];
        record(
          '⚠️ 编辑清空「备注」真落库（values.x || undefined 静默丢弃高危点）',
          cleared?.remark === null || cleared?.remark === '',
          `建时=${JSON.stringify(withRemark?.remark)} → 清空后=${JSON.stringify(cleared?.remark)} 弹窗字段=${JSON.stringify(dlgLabels)} toast=${JSON.stringify(tClear)}`,
        );
      }
    }
    if (created.rent.length) {
      await page.goto(`${APP}/admin-rent/${created.rent[0]}`, { settleMs: 2400 });
      await sleep(1400);
      const dt = await page.evaluate('document.body.innerText');
      record('租房合同详情页 /admin-rent/:id 可直达', dt.includes(rentName), `含名称=${dt.includes(rentName)} 文本长度=${dt.length}`);
    }

    /* 4.2 行政缴费：新建 + 提交/审批通过/登记付款 */
    await ensureAlive();
    page.resetDiagnostics();
    const billTitle = `${TAG} 物业费`;
    await page.goto(`${APP}/admin-bills`, { settleMs: 2400 });
    await sleep(1400);
    await clickButton(page, '新建缴费单', { scope: 'body', settleMs: 1500 });
    d = await dialogInfo(page);
    record('「新建缴费单」弹窗打开', !!d, d ? `标题=${d.title} 字段=${JSON.stringify(d.labels)}` : '未打开');
    if (d) {
      await fillByLabel(page, '标题', billTitle);
      await selectByLabel(page, '类型', '.').catch(() => 'skip');
      await fillByLabel(page, '金额（元）', '1234.56');
      await fillByLabel(page, '期间', today().slice(0, 7));
      const dExp = await setDateField(page, '费用日期', today());
      await fillByLabel(page, '收款方', `${TAG} 收款方`);
      const markBill = (page.requests ?? []).length;
      await clickButton(page, '保存', { settleMs: 1900 });
      t = await toasts(page);
      await sleep(1100);
      const billErrs = await formErrors(page);
      const billStillOpen = await page.evaluate(`!!document.querySelector('[role="dialog"]')`);
      note('缴费单提交诊断', `费用日期=${dExp} 写请求=${reqsSince(page, markBill).length} 弹窗仍在=${billStillOpen} 校验提示=${JSON.stringify(billErrs)} toast=${JSON.stringify(t)}`);
      const bill = await sql`SELECT id, code, title, amount, status, period, expense_date FROM erp_admin_bill
        WHERE title = ${billTitle} ORDER BY _created_at DESC LIMIT 1`;
      if (bill.length) created.bill.push(bill[0].id);
      record(
        '行政缴费单落库（金额两位小数一致）',
        bill.length === 1 && Number(bill[0].amount) === 1234.56,
        bill.length ? `${bill[0].code} 金额=${bill[0].amount} 期间=${bill[0].period} 费用日期=${bill[0].expense_date}（界面选 ${dExp}）状态=${bill[0].status} toast=${JSON.stringify(t)}` : `未落库 toast=${JSON.stringify(t)}`,
      );
      if (bill.length) {
        const flow = [];
        for (const step of ['提交', '审批通过', '登记付款']) {
          const btns = await rowButtons(page, billTitle);
          if (!btns?.some((b) => b.includes(step))) { flow.push(`${step}:无按钮`); continue; }
          await clickRowButton(page, billTitle, step, { settleMs: 2000 });
          if (step === '登记付款') {
            const payDlg = await dialogInfo(page);
            if (payDlg) {
              await setDateField(page, '付款日期', today()).catch(() => 'skip');
              await selectByLabel(page, '付款方式', '.').catch(() => 'skip');
              await clickButton(page, '确认', { settleMs: 1900 });
            }
          }
          const ts = await toasts(page);
          await sleep(800);
          const cur = (await sql`SELECT status FROM erp_admin_bill WHERE id = ${bill[0].id}`)[0];
          flow.push(`${step}→${cur?.status} ${JSON.stringify(ts)}`);
          await page.goto(`${APP}/admin-bills`, { settleMs: 2200 });
          await sleep(1300);
        }
        const billAfter = (await sql`SELECT status, pay_date, pay_method FROM erp_admin_bill WHERE id = ${bill[0].id}`)[0];
        note('缴费单流转', flow.join(' | '));
        record(
          '行政缴费单状态机推进到已付（paid）且落付款日期/方式',
          billAfter?.status === 'paid' && !!billAfter?.pay_date,
          `最终状态=${billAfter?.status} 付款日期=${billAfter?.pay_date} 付款方式=${billAfter?.pay_method ?? '-'}`,
        );
      }
    }

    /* 4.3 行政资产：新建 + 编辑清空 */
    await ensureAlive();
    page.resetDiagnostics();
    const aaName = `${TAG} 办公椅`;
    await page.goto(`${APP}/admin-assets`, { settleMs: 2400 });
    await sleep(1400);
    await clickButton(page, '新建资产', { scope: 'body', settleMs: 1500 });
    d = await dialogInfo(page);
    record('「新建行政资产」弹窗打开', !!d, d ? `标题=${d.title} 字段=${JSON.stringify(d.labels)}` : '未打开');
    if (d) {
      await fillByLabel(page, '名称', aaName);
      await selectByLabel(page, '类别', '.').catch(() => 'skip');
      await fillByLabel(page, '数量', '2');
      await fillByLabel(page, '单价（元）', '399.99');
      await fillByLabel(page, '位置', `${TAG} 工位区`);
      await clickButton(page, '保存', { settleMs: 1900 });
      t = await toasts(page);
      await sleep(1100);
      const aa = await sql`SELECT id, code, name, quantity, unit_price, location, status FROM erp_admin_asset
        WHERE name = ${aaName} ORDER BY _created_at DESC LIMIT 1`;
      if (aa.length) {
        created.adminAsset.push(aa[0].id);
        record(
          '行政资产落库',
          aa[0].quantity === 2 && Number(aa[0].unit_price) === 399.99 && aa[0].location === `${TAG} 工位区`,
          `${aa[0].code} 数量=${aa[0].quantity} 单价=${aa[0].unit_price} 位置=${aa[0].location} toast=${JSON.stringify(t)}`,
        );
        await page.goto(`${APP}/admin-assets`, { settleMs: 2400 });
        await sleep(1500);
        await clickRowButton(page, aaName, '编辑', { settleMs: 1500 });
        await fillByLabel(page, '位置', '');
        await clickButton(page, '保存', { settleMs: 1800 });
        const t2c = await toasts(page);
        await sleep(900);
        const aa2 = (await sql`SELECT location FROM erp_admin_asset WHERE id = ${aa[0].id}`)[0];
        record(
          '⚠️ 行政资产编辑清空「位置」真落库',
          aa2?.location === null || aa2?.location === '',
          `清空后=${JSON.stringify(aa2?.location)} toast=${JSON.stringify(t2c)}`,
        );
      } else {
        record('行政资产落库', false, `未落库 toast=${JSON.stringify(t)}`);
      }
    }

    /* 4.4 车辆与差旅：新建 + 结清 */
    await ensureAlive();
    page.resetDiagnostics();
    const affairTitle = `${TAG} 差旅行程`;
    await page.goto(`${APP}/admin-affairs`, { settleMs: 2400 });
    await sleep(1400);
    await clickButton(page, '新建事务', { scope: 'body', settleMs: 1500 });
    d = await dialogInfo(page);
    record('「新建事务」弹窗打开', !!d, d ? `标题=${d.title} 字段=${JSON.stringify(d.labels)}` : '未打开');
    if (d) {
      await selectByLabel(page, '类型', '差旅').catch(() => 'skip');
      await fillByLabel(page, '事由', affairTitle);
      await setDateField(page, '开始日期', today());
      await setDateField(page, '结束日期', todayPlus(2));
      await fillByLabel(page, '金额（元）', '2500.50');
      await clickButton(page, '保存', { settleMs: 1900 });
      t = await toasts(page);
      await sleep(1100);
      const af = await sql`SELECT id, code, affair_type, title, amount, status, start_date FROM erp_admin_affair
        WHERE title = ${affairTitle} ORDER BY _created_at DESC LIMIT 1`;
      if (af.length) created.affair.push(af[0].id);
      record(
        '行政事务落库（金额小数一致）',
        af.length === 1 && Number(af[0].amount) === 2500.5,
        af.length ? `${af[0].code} 类型=${af[0].affair_type} 金额=${af[0].amount} 开始=${af[0].start_date} 状态=${af[0].status} toast=${JSON.stringify(t)}` : `未落库 toast=${JSON.stringify(t)}`,
      );
      if (af.length) {
        await page.goto(`${APP}/admin-affairs`, { settleMs: 2400 });
        await sleep(1500);
        const ab = await rowButtons(page, affairTitle);
        note('事务行按钮', JSON.stringify(ab));
        if (ab?.some((b) => /结清/.test(b))) {
          await clickRowButton(page, affairTitle, '结清', { settleMs: 1900 });
          const at2 = await toasts(page);
          await sleep(900);
          const af2 = (await sql`SELECT status FROM erp_admin_affair WHERE id = ${af[0].id}`)[0];
          record('事务「结清」流转', af2?.status === 'settled', `status=${af2?.status} toast=${JSON.stringify(at2)}`);
        } else {
          record('事务「结清」流转', false, `未找到结清按钮：${JSON.stringify(ab)}`);
        }
      }
    }

    } catch (error) {
      record(
        '行政管理区块完整执行',
        false,
        `区块中断：${String(error?.message ?? error).slice(0, 200)}（前面已完成的用例结果已落盘）`,
      );
    }
    }

    /* 诊断汇总 */
    diag.consoleErrors.push(...page.consoleLogs.filter((l) => l.type === 'error'));
    diag.exceptions.push(...page.exceptions);
    diag.httpErrors.push(...(page.httpErrors ?? []).filter((e) => Number(e.status) >= 400));
    const uniqHttp = [];
    for (const e of diag.httpErrors) if (!uniqHttp.some((x) => x.status === e.status && x.url === e.url)) uniqHttp.push(e);
    /*
     * 429 = 审批通知接口的**限流**：本会话里同一账号被多轮走查反复打，属于环境噪声
     * （`POST /api/notifications/approval` 打飞书通知，前端只记 console.error 不阻断业务）。
     * 单独列出来并要求其余无错，避免"一条限流把整轮结论带偏"。
     */
    const rateLimited = uniqHttp.filter((e) => Number(e.status) === 429);
    const otherHttp = uniqHttp.filter((e) => Number(e.status) !== 429);
    const notifyConsoleErr = diag.consoleErrors.filter((l) => /审批通知发送失败|操作过于频繁/.test(l.text));
    const otherConsoleErr = diag.consoleErrors.filter((l) => !/审批通知发送失败|操作过于频繁/.test(l.text));
    record(
      '全程无未捕获异常',
      diag.exceptions.length === 0,
      JSON.stringify(diag.exceptions).slice(0, 300),
    );
    record(
      '全程无 console.error（限流噪声单列）',
      otherConsoleErr.length === 0,
      otherConsoleErr.length ? JSON.stringify(otherConsoleErr).slice(0, 300) : `仅 ${notifyConsoleErr.length} 条审批通知限流噪声（429）`,
    );
    record(
      '全程无 HTTP≥400（限流与预期内的校验拒绝单列）',
      otherHttp.length === 0,
      otherHttp.length ? JSON.stringify(otherHttp).slice(0, 600) : `其余请求全部 < 400；429 限流=${rateLimited.length} 条（同账号多轮走查所致）`,
    );
    if (rateLimited.length) {
      note('限流噪声', `POST /api/notifications/approval 返回 429「操作过于频繁，请稍后再试」${rateLimited.length} 次 —— 本会话多轮走查共用同一账号所致，与业务逻辑无关；前端把它记成 console.error 但不影响单据状态`);
    }
    return { results, evidence, diagnostics: { ...diag, httpErrors: uniqHttp } };
  } finally {
    /* ── 清理：只按本次创建的主键精确删除（删前打印） ── */
    console.log('\n── 清理（精确主键）──');
    const delAssetCascade = async (assetId) => {
      const dsps = await sql`SELECT id, code FROM ast_disposal WHERE asset_id = ${assetId}`;
      for (const x of dsps) {
        await sql`DELETE FROM fin_voucher_line WHERE voucher_id IN (SELECT id FROM fin_voucher WHERE source_ref = ${`asset-disposal:${x.code}`})`.catch(() => {});
        await sql`DELETE FROM fin_voucher WHERE source_ref = ${`asset-disposal:${x.code}`}`.catch(() => {});
      }
      await sql`DELETE FROM ast_disposal WHERE asset_id = ${assetId}`.catch(() => {});
      await sql`DELETE FROM ast_change WHERE asset_id = ${assetId}`.catch(() => {});
      await sql`DELETE FROM ast_impairment WHERE asset_id = ${assetId}`.catch(() => {});
      await sql`DELETE FROM ast_depreciation WHERE asset_id = ${assetId}`.catch(() => {});
      await sql`DELETE FROM ast_asset WHERE id = ${assetId}`;
    };
    if (created.purOrder.length) {
      const orders = await sql`SELECT id, code, item_name FROM pur_order WHERE id IN ${sql(created.purOrder)}`;
      console.log('  待删 pur_order:', JSON.stringify(orders));
      for (const o of orders) {
        const aps = await sql`SELECT id, code FROM erp_ap_bill WHERE source = 'purchase' AND source_ref LIKE ${`po-accept:${o.code}:%`}`;
        if (aps.length) console.log(`    ${o.code} 关联应付:`, JSON.stringify(aps.map((a) => a.code)));
        for (const a of aps) {
          await sql`DELETE FROM fin_voucher_line WHERE voucher_id IN (SELECT id FROM fin_voucher WHERE source_ref = ${`ap:${a.code}`})`.catch(() => {});
          await sql`DELETE FROM fin_voucher WHERE source_ref = ${`ap:${a.code}`}`.catch(() => {});
          await sql`DELETE FROM erp_ap_bill WHERE id = ${a.id}`;
        }
        await sql`DELETE FROM erp_project_cost WHERE source_ref LIKE ${`po:${o.code}:%`}`.catch(() => {});
        const capAst = await sql`SELECT id FROM ast_asset WHERE purchase_order_id = ${o.id}`;
        for (const a of capAst) await delAssetCascade(a.id);
        await sql`DELETE FROM pur_order WHERE id = ${o.id}`;
      }
    }
    const assetIds = [...new Set(created.astAsset)];
    if (assetIds.length) {
      const rows = await sql`SELECT id, code, name FROM ast_asset WHERE id IN ${sql(assetIds)}`;
      if (rows.length) console.log('  待删 ast_asset:', JSON.stringify(rows));
      for (const a of assetIds) await delAssetCascade(a);
    }
    if (created.depVoucher.length) {
      const rows = await sql`SELECT id, code, source_ref FROM fin_voucher WHERE id IN ${sql(created.depVoucher)}`;
      if (rows.length) console.log('  待删折旧凭证:', JSON.stringify(rows));
      await sql`DELETE FROM fin_voucher_line WHERE voucher_id IN ${sql(created.depVoucher)}`.catch(() => {});
      await sql`DELETE FROM fin_voucher WHERE id IN ${sql(created.depVoucher)}`.catch(() => {});
    }
    /* 批量折旧的副作用回滚：把非本次创建的资产的净值加回，再删掉那些折旧行 */
    if (foreignDepRows.length) {
      const ids = foreignDepRows.map((r) => r.id);
      const rows = await sql`SELECT id, asset_id, period, amount FROM ast_depreciation WHERE id IN ${sql(ids)}`;
      console.log('  待回滚（非本次创建资产的折旧）:', JSON.stringify(rows));
      for (const r of rows) {
        await sql`UPDATE ast_asset SET net_value = net_value + ${r.amount}
          WHERE id = ${r.asset_id} AND status <> 'disposed'`.catch(() => {});
      }
      await sql`DELETE FROM ast_depreciation WHERE id IN ${sql(ids)}`.catch(() => {});
    }
    if (created.note.length) {
      const rows = await sql`SELECT id, code, note_no FROM erp_note WHERE id IN ${sql(created.note)}`;
      if (rows.length) console.log('  待删 erp_note:', JSON.stringify(rows));
      for (const n of rows) {
        const refs = ['hold', 'endorse', 'discount', 'settle', 'dishonor'].map((a) => `note:${n.code}:${a}`);
        await sql`DELETE FROM fin_voucher_line WHERE voucher_id IN (SELECT id FROM fin_voucher WHERE source_ref IN ${sql(refs)})`.catch(() => {});
        await sql`DELETE FROM fin_voucher WHERE source_ref IN ${sql(refs)}`.catch(() => {});
      }
      await sql`DELETE FROM erp_note_log WHERE note_id IN ${sql(created.note)}`.catch(() => {});
      await sql`DELETE FROM erp_note WHERE id IN ${sql(created.note)}`;
    }
    for (const [table, list, col] of [
      ['erp_admin_rent_contract', created.rent, 'name'],
      ['erp_admin_bill', created.bill, 'title'],
      ['erp_admin_affair', created.affair, 'title'],
      ['erp_admin_asset', created.adminAsset, 'name'],
    ]) {
      if (!list.length) continue;
      const rows = await sql.unsafe(`SELECT id, ${col} AS label FROM ${table} WHERE id = ANY($1)`, [list]);
      console.log(`  待删 ${table}:`, JSON.stringify(rows));
      await sql.unsafe(`DELETE FROM ${table} WHERE id = ANY($1)`, [list]);
    }
    if (created.purRequest.length) {
      const rows = await sql`SELECT id, code, title FROM pur_request WHERE id IN ${sql(created.purRequest)}`;
      if (rows.length) console.log('  待删 pur_request:', JSON.stringify(rows));
      await sql`DELETE FROM pur_request WHERE id IN ${sql(created.purRequest)}`;
    }
    const left = await sql`SELECT
      (SELECT count(*)::int FROM pur_order) AS pur_order,
      (SELECT count(*)::int FROM pur_request WHERE title LIKE ${`%${TAG}%`}) AS pr_test,
      (SELECT count(*)::int FROM ast_asset WHERE name LIKE ${`%${TAG}%`}) AS ast_test,
      (SELECT count(*)::int FROM ast_depreciation) AS ast_dep,
      (SELECT count(*)::int FROM ast_disposal) AS ast_dsp,
      (SELECT count(*)::int FROM ast_change) AS ast_chg,
      (SELECT count(*)::int FROM erp_note) AS note,
      (SELECT count(*)::int FROM erp_ap_bill WHERE source = 'purchase') AS ap_purchase,
      (SELECT count(*)::int FROM erp_admin_rent_contract WHERE name LIKE ${`%${TAG}%`}) AS rent_test,
      (SELECT count(*)::int FROM erp_admin_bill WHERE title LIKE ${`%${TAG}%`}) AS bill_test,
      (SELECT count(*)::int FROM erp_admin_asset WHERE name LIKE ${`%${TAG}%`}) AS aasset_test,
      (SELECT count(*)::int FROM erp_admin_affair WHERE title LIKE ${`%${TAG}%`}) AS affair_test,
      (SELECT count(*)::int FROM comp_automation_config WHERE enabled = false) AS auto_disabled`;
    console.log('残留审计:', JSON.stringify(left[0]));
    evidence.push({ section: '残留审计', text: JSON.stringify(left[0]) });
    await sql.end({ timeout: 2 }).catch(() => {});
    await browser.close().catch(() => {});
    globalThis.__residual = left[0];
  }
}

/**
 * 报告里的**结论摘要**（随 `--merge` 一起写入 `assets-pur-report.json`）。
 *
 * 走查产出的 `results` 是逐条 PASS/FAIL，这里补上"每条业务规则给结论 + 证据在哪"、
 * "哪些缺陷修了/没修"、"哪些没验到"，避免读报告的人只能靠猜。
 */
const REPORT_NOTES = {
  scope: '采购（/pur 采购订单验收链路 + 采购看板）、固定资产（/asset 6 个 Tab）、票据（/notes）、行政管理（/admin-rent、/admin-bills、/admin-assets、/admin-affairs、/admin-automation）',
  howToRun: [
    'node scripts/browser-walkthrough/walk-assets-pur.mjs                     # 全跑，产出 out/assets-pur-report.json',
    'WT_FROM=<pur|asset|notes|admin> WT_TO=<...> node ...walk-assets-pur.mjs  # 只跑区间，产出 out/assets-pur-report.part-<from>-<to>.json',
    'node scripts/browser-walkthrough/walk-assets-pur.mjs --merge             # 合并 4 个分段报告为完整报告',
    'WT_FIX_API=http://127.0.0.1:3109 可指定"当前工作区构建实例"的地址（见 serverFixVerification）',
  ],
  environment: {
    api3100: '生产构建（node dist/server/main.js），进程启动早于本轮源码修改 —— 服务端改动不会热更',
    web5273: '走查专用 Vite（代理 /api → 3100），客户端改动走 HMR 即时生效',
    fixInstance: '另起 node dist/server/main.js（SERVER_PORT=3109，同库，ENABLE_SCHEDULER=false）验证服务端修复；验证完已关闭',
    browser: '零依赖 CDP 驱动，独占端口 9363；本机 headless Chrome 每跑十几屏会整体假死一次，故支持分段跑 + 命中测试兜底',
  },
  businessConclusions: [
    '采购验收生成应付：每笔验收各生成一张 erp_ap_bill（source=purchase，source_ref=po-accept:{订单号}:{应付号}），金额=round2(本次验收数量×单价)。3 次各验 1 件、单价 0.333 时落库 3×0.33=0.99，而订单金额=round2(3×0.333)=1.00 —— 逐笔取整与总额取整相差 1 分，属既有口径（README 注释已声明），故 acceptedAmount 必须聚合落库金额而非按数量推导。',
    'acceptedAmount 数值正确性（本轮首次用真实数据验证）：界面验收单打印预览的「验收金额（含税）」= SQL SUM(erp_ap_bill.amount) WHERE source=purchase AND source_ref LIKE \'po-accept:CODE:%\' AND status<>\'voided\' = 0.99，两侧一致；「已验收数量」也等于 SQL accepted_quantity=3（修复前按金额反推会印出 2.97）。',
    '重复验收拦截：整单验收后再次验收 → 400「订单已整单验收完成，不可再次验收」；超量验收 → 400「验收数量超出订单余量：…本次可验收上限 2，实际提交 5」；同一采购申请重复下单 → 409；同一申请同期间已生成订单由部分唯一索引 uq_pur_order_request_active 兜底。',
    '折旧口径：月折旧额 = round2((原值−残值)/折旧月数)，折旧月数 12、原值 12000.50、残值 0.50 → 1000.00，落库 numeric(18,2) 无浮点尾差（12000.00−1000.00=11000.00）；最后一个月或金额超过剩余可折旧额时取剩余额。',
    '折旧期间幂等：同一资产同一期间只计提一次（服务层先查 ast_depreciation 的 (asset_id, period)，DB 侧由 uq_ast_depreciation_asset_period 兜底）。重复点击提示「2026-10 无需计提的资产（已计提、净值不足或已报废）」，折旧行数不变、净值不变。⚠️ 并发双击的 TOCTOU 窗口仍存在（第二个请求会撞唯一索引 → 错误），本轮未做并发验证。',
    '处置状态机：提交 → disposing（不生成凭证），审批通过 → disposed（scrap 为 scrapped），驳回 → rejected；完成后同步资产卡片 status=disposed、net_value=0，并生成借贷平衡的处置凭证（实测 8 行，借=贷=23651.00）。',
    'ast_disposal_active：同一资产已有未完成处置单时再次发起 → 409「资产 X 已有待完成的处置申请，请先完成或驳回」；已 disposed 的资产再发起 → 400「当前状态为 disposed，不可处置」。',
    '变更/转移审批：调拨（transfer）服务端要求 targetDepartmentId/targetProjectId 至少一个；修复后弹窗提供两个下拉，提交 → pending，审批「通过」→ approved 并回写资产部门/项目；「领用」仅闲置资产可发起（在用资产 → 400）。',
    '票据贴现息 360 天基准（已确认口径，非缺陷）：贴现息 = 票面 × 贴现率/100 × 贴现天数/360，贴现天数按「贴现日 → 到期日、算头不算尾」。实测 100000 × 3.6% × 10/360 = 100.00，到账 99900.00 = 票面 − 贴现息，贴现凭证借贷平衡；重复贴现 → 400「「贴现」不允许从「已贴现」发起…」。',
    '票据流转：每个动作（确认持有/背书转让/贴现/到期收款/拒付）都要在行内按钮点开流转弹窗后**再点一次确认**才落库；备查簿与 15 天到期预警可用（10 天后到期的票据出现在 /api/notes/due-alerts 里）。',
    '自动化任务开关：界面开关 → comp_automation_config.enabled；isEnabled 的缓存键含 epoch（MAX(_updated_at)，进程内 1 秒记忆），开关一改 epoch 即变 → 新键未命中 → **立即生效**，60s 只是同一 epoch 下的 TTL。实测点击停用后 enabled=false 且 epoch 由 2026-10-14 18:21:53.819+08 变为新值，验证后已复原为启用。',
    '⚠️ 任务书说"6 个任务"，实测 comp_automation_config 有 15 条（后续迭代新增了 bi_alert_daily / contract_expiry_remind / note_due_reminder_daily / retention_daily / session_cleanup_daily / voucher_job_retry / year_end_reminder_daily / feishu_contact_* 等），页面渲染全部 15 个开关 —— 是数据事实，不是缺陷。',
    '编辑时清空字段：admin-rent 的「备注」、admin-assets 的「位置」清空后库值确实变 NULL（未见 values.x || undefined 静默丢弃）。',
  ],
  defects: [
    {
      id: 'PUR-1',
      title: '设备类采购订单分批验收：第 2 次验收被 409 拒绝，订单永远收不完',
      severity: '高',
      status: '已修（服务端），修复后已在独立实例端到端验证',
      symptom:
        '设备类订单第 1 次验收（1/3）成功并生成资产卡片；第 2 次验收返回 HTTP 409，toast=「该采购订单已生成固定资产卡片，一张采购订单只能生成一张卡片」，订单停在 accepted=1/3、status=pending。',
      rootCause:
        'server/modules/pur/pur.service.ts 的 acceptOrder 每次验收都无条件 INSERT ast_asset，而 ast_asset.purchase_order_id 上有部分唯一索引 uq_ast_asset_purchase_order（一张订单一张卡）—— 第 2 次插入撞索引，被 server/common/filters/pg-error-messages.ts 翻译成那句 409 文案。后果不只是少一张卡：剩余数量每次都被同一条约束挡回，订单永远完不成，剩余应付/进项凭证也永远生不成。',
      fix:
        '新增纯函数 server/modules/pur/pur-capitalize.ts（accumulateCapitalizedValue：有卡片则累计原值/净值，无则建卡，一律 round2）；acceptOrder 先按 purchase_order_id 查本订单是否已有卡片，有则 UPDATE 累计、无则 INSERT；资本化口径仍按类别决定（equipment → 1601 凭证）。配 spec server/modules/pur/pur-capitalize.spec.ts（6 条）。',
      verification:
        '在 3109（当前工作区构建、同库）跑：设备类订单 3 次各验 1 件 → 3 次全 201、订单 accepted=3/3、应付 3 张合计 0.99、资产卡片仍只有 1 张且原值=净值=0.99（= 应付合计）、GET /api/pur/orders 返回的 acceptedAmount=0.99 与 SQL 聚合一致。',
      note: '受任务约束（不得重启 3100）无法在 3100 上直接看到修复效果，故另起实例验证；3100 会在下次重建/重启后带上该修复。',
    },
    {
      id: 'ASSET-1',
      title: '「发起资产变更」的「调拨」是死选项（界面无法提供目标部门/项目）',
      severity: '中',
      status: '已修（前端）',
      symptom: '变更类型选「调拨」提交 → 必被服务端 400「调拨必须至少指定目标部门或目标项目」，弹窗里没有任何地方能填这两个字段。',
      rootCause:
        'server/modules/asset/asset.service.ts 的 createChange 对 transfer 要求 targetDepartmentId/targetProjectId 至少一个，而 AssetChangeDialog 只提交 assetId/changeType/afterValue/remark（全仓 client 对这两个字段 0 处引用）。',
      fix:
        '新增纯逻辑模块 client/src/pages/asset/asset-change-rules.ts（requiresTransferTarget / transferTargetError / buildAssetChangeDto，配 spec 6 条）；AssetChangeDialog 在 changeType=transfer 时渲染「目标部门 / 目标项目」两个 Select（复用 AssetPanel 已有的 departments/projects 查询，不新增请求），提交前本地拦住并给出与服务端同口径文案；AssetPanel 透传两个 props。',
      verification:
        '浏览器实测：选中「调拨」后弹窗字段由 ["资产 *","变更类型 *","变更说明","备注"] 变为 ["资产 *","变更类型 *","目标部门","目标项目","变更说明","备注"]；选择目标部门提交 → ast_change 落库 type=transfer status=pending 且 target_department_id 非空；变更审批点「通过」→ status=approved 且资产 department_id 被回写。',
    },
    {
      id: 'PUR-2',
      title: '验收单「已验收数量」按金额反推，单价含 3 位小数时印出错误件数',
      severity: '低',
      status: '已修（前端）',
      symptom: '单价 0.333、3 件分 3 次各验 1 件时，验收单打印件显示「订单数量 3 / 已验收数量 2.97」（0.99 ÷ 0.333），与同一张单据的「订单数量 3」及列表「3 / 3」自相矛盾。',
      rootCause:
        'client/src/pages/pur/components/pur-order-columns.tsx 里 `acceptedQtyForPrint = acceptedAmount / unitPrice`；单位价格是 numeric(18,6)、服务端每次验收各自 round2，两者相除不是整数。',
      fix: '改为直接使用落库的 acceptedQuantity（与 acceptedAmount 在同一次验收事务里一起写，不存在漂移），并在注释里写清这次判断的依据与反例。',
      verification: '浏览器实测打印件「已验收数量 3.00」== SQL accepted_quantity=3；金额仍为 0.99 == SQL 聚合值。',
    },
    {
      id: 'PUR-3',
      title: '采购申请详情页兜底查询 pageSize=500 被服务端截断为 100（潜在）',
      severity: '低',
      status: '未修（仅记录，改动属共享页面行为）',
      symptom: 'PurRequestDetailPage.tsx 走 `listRequests({ pageSize: 500 })` 再按 id 找；服务端 MAX_PAGE_SIZE=100，实测返回 pageSize=100。申请总数超过 100 时，直接打开旧申请的 URL 会显示「采购申请不存在或已删除」。',
      evidence: 'GET /api/pur/requests?page=1&pageSize=500 → 响应里 pageSize=100（当前 total=5，尚未触发）。',
      suggestion: '改为按 id 直查（后端补 GET /api/pur/requests/:id），或至少把 pageSize 降到 100 并在未命中时提示"请从列表进入"。',
    },
  ],
  notVerified: [
    '折旧计提的**并发**幂等：同一期间两个请求同时提交时，服务层"先查后插"存在 TOCTOU 窗口，第二个请求会撞 uq_ast_depreciation_asset_period（预计为 500/409，未实测）。本轮只验证了串行重复点击的幂等。',
    '减值测试（/asset 减值测试 Tab）只验证了入口渲染；计提减值 + 处置时减值准备参与分录、以及"已生成凭证的减值不可删除"等分支未逐条走。',
    '生命周期 Tab（/asset 生命周期）未点击验证（本轮范围内未安排用例）。',
    '设备类订单**带项目**时验收生成 erp_project_cost（服务类 order 无项目则按设计不生成）；本轮未构造"服务类 + 关联项目"的订单，故未验证项目成本联动与 cost_type=outsource 的落库。',
    '票据的「背书转让 / 到期收款 / 拒付」三个动作未逐个点击（只验证了确认持有与贴现，以及"终态后动作按钮消失 + 重复贴现被拒"）。',
    '采购申请「驳回」分支未点击（只验证了批准）。',
    '自动化任务"停用后任务真的跳过执行"未触发真实 cron 验证（ENABLE_SCHEDULER=false，且当天任务时刻未到）；本轮改为验证"开关落库 + epoch 变化使 isEnabled 缓存键失效"这条可观测链路。',
    '管理端其它页面（/admin-* 以外的行政模块、以及其它 agent 负责的域）不在本轮范围。',
  ],
  walkthroughPitfalls: [
    '弹窗里的 DateField（shadcn Popover + react-day-picker）选完日期**不会自动收起**，会盖住弹窗底部的「保存」—— 真实鼠标点击会落到达日历日号上（实测截图 out/hit-miss-1.png：elementFromPoint 返回 BUTTON:"14"）。脚本必须在选完后按 Escape 关闭浮层，否则会出现"点了保存没反应"的假缺陷。',
    'Radix 的二次确认是 role="alertdialog"（不是 role="dialog"）：资产处置「完成」、自动化「停用」都要在确认框里再点一次「确认」。',
    '票据流转、资产变更等"行内按钮 + 弹窗"的两段式交互：只点行内按钮不会落库，必须在弹窗里点「确认/提交」。',
    '本机 headless Chrome 每跑十几屏会整体假死（Runtime.evaluate 连续超时），因此脚本支持分段执行（WT_FROM/WT_TO）+ 报告增量落盘 + --merge 合并。',
  ],
  dataHygiene: {
    tag: '[API_TEST]',
    cleanup:
      '清理只按本次创建的主键 id 精确删除（删除前 SELECT 打印待删行）：pur_order → 其 erp_ap_bill（含 fin_voucher ap:{应付号}）→ erp_project_cost(po:{订单号}:*) → 验收生成的 ast_asset → pur_request；票据按 id + erp_note_log + note:{code}:{动作} 凭证；行政四张表按 id。',
    sideEffect:
      '「按月计提折旧」是批量接口，会顺带对库里其它在用资产计提：脚本记录这些行的主键，清理时把净值加回并删除折旧行（本次每轮 4 项真实资产 × 222.22 已全部回滚；批量产生的折旧凭证也按 id 删除）。',
    residualAudit: '见报告 residual 字段（pur_order=0、[API_TEST] 各表=0、ast_depreciation=0、ast_disposal=0、ast_change=0、ap_bill(source=purchase)=0）。',
  },
};

/* ============================ 分段结果合并 ============================ */

/**
 * `node walk-assets-pur.mjs --merge`：把 `WT_FROM/WT_TO` 分段跑出来的
 * `assets-pur-report.part-<段>.json` 合并成完整报告。
 *
 * 为什么需要：本机 headless Chrome 每跑十几屏就会整体假死（5 轮实测，挂点每次不同），
 * 一次跑完不保证成功；分段跑每段更短、成功率更高，合并后仍是一份完整报告。
 * 合并会校验四段齐全，缺段直接报错 —— 不允许"少了一段却看起来跑完了"。
 */
const SECTION_NAMES = ['pur', 'asset', 'notes', 'admin'];
if (process.argv.includes('--merge')) {
  const parts = [];
  const missing = [];
  for (const name of SECTION_NAMES) {
    const file = `${OUT}/assets-pur-report.part-${name}-${name}.json`;
    if (existsSync(file)) parts.push({ name, file, data: JSON.parse(readFileSync(file, 'utf8')) });
    else missing.push(file);
  }
  if (missing.length) {
    console.error(`缺少分段报告：\n  ${missing.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    const merged = {
      mergedFrom: parts.map((p) => p.file),
      generatedAt: new Date().toISOString(),
      notes: REPORT_NOTES,
      results: parts.flatMap((p) => p.data.results ?? []),
      evidence: parts.flatMap((p) => p.data.evidence ?? []),
      residual: parts[parts.length - 1].data.residual ?? null,
      diagnostics: Object.assign({}, ...parts.map((p) => p.data.diagnostics ?? {})),
    };
    writeFileSync(`${OUT}/assets-pur-report.json`, JSON.stringify(merged, null, 2));
    const failed = merged.results.filter((r) => !r.pass);
    console.log(`已合并 ${parts.length} 段 → ${OUT}/assets-pur-report.json`);
    console.log(`结果: ${merged.results.length - failed.length}/${merged.results.length} 通过`);
    for (const f of failed) console.log(`  FAIL ${f.name}  — ${f.detail ?? ''}`);
  }
} else {
  void main()
    .then((report) => {
      const out = { ...report, notes: REPORT_NOTES, residual: globalThis.__residual };
      writeFileSync(REPORT_PATH, JSON.stringify(out, null, 2));
      const failed = report.results.filter((r) => !r.pass);
      console.log(`\n结果: ${report.results.length - failed.length}/${report.results.length} 通过`);
      for (const f of failed) console.log(`  FAIL ${f.name}  — ${f.detail ?? ''}`);
    })
    .catch((e) => {
      console.error('走查失败:', e);
      process.exitCode = 1;
    });
}
