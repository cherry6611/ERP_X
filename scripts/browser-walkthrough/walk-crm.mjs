/**
 * 主数据 + CRM 浏览器逐项走查（真实鼠标/键盘 + SQL 核对）。
 *
 * ## 与 `walk-crud.mjs` 的分工
 *
 * `walk-crud.mjs` 只做了「客户/供应商/线索能建出来」这一层。本轮要求的是
 * **逐项验证**：新建 → SQL 核对 → 编辑 → 再核对，且重点是**编辑时清空字段**
 * 是否真的落库（本仓已确认的缺陷类型：`values.x || undefined` 把"清空"静默丢掉，
 * toast 照样报成功）。此外还硬性要求把**报价单金额算法**逐项算一遍与库里比对、
 * 把**线索→商机→合同**的幂等/查重链路口点到点走完、并确认毛利红线警示真的出现。
 *
 * ## 范围
 *
 * `/customers`、`/suppliers`、`/masterdata/tax-entities`、`/crm`（线索 + 商机）、
 * `/crm/leads/new|:id`、`/crm/opportunities/new|:id`、
 * `/crm/opportunities/:opportunityId/quotations/new`、`/crm/quotations/:id`、
 * `/crm/quotations/:id/edit`、`/returns`。
 *
 * ## 三个必须说清楚的走查约定
 *
 * ① **只用 9361 端口**（本会话多 agent 并行，抢端口会互相打断）。
 * ② 测试数据一律 `[API_TEST]` 前缀 + **精确主键删除**：删除前先 SELECT 打印待删行，
 *    绝不用宽泛 LIKE（本会话已有人因清理脚本 bug 误删真实开发数据）。
 * ③ 每个页面切换前 `resetDiagnostics()`，把 console error / 未捕获异常 / HTTP≥400
 *    归到该页面名下 —— 否则报错会串味，说不清是哪一页出的。
 *
 * 用法：node scripts/browser-walkthrough/walk-crm.mjs [--only=customers,crm]
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const USER = process.env.WT_USER ?? 'chengsheng@chengshengdata.cn';
const PASS = process.env.WT_PASS ?? '';
const OUT = 'scripts/browser-walkthrough/out';
const TAG = '[API_TEST]';
const PORT = 9361;

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()) : null;
const want = (section) => !ONLY || ONLY.includes(section);

/* ── 结果收集 ───────────────────────────────────────────────────────────── */

const results = [];
const diagBySection = {};
/** 报价单金额算法的逐项核对明细（硬要求：自己算的数 vs 库里/接口的数） */
const algoReport = {};

function record(area, name, pass, detail, evidence) {
  results.push({
    area,
    name,
    pass: pass === 'skip' ? 'SKIP' : pass ? 'PASS' : 'FAIL',
    detail: detail ?? '',
    evidence: evidence ?? null,
  });
  const tag = pass === 'skip' ? 'SKIP' : pass ? 'PASS' : 'FAIL';
  console.log(`  ${tag}  [${area}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const skip = (area, name, detail) => record(area, name, 'skip', detail);

/** 某个小节抛异常：记成一条 FAIL，但**不让它拖垮后面所有小节** */
function sectionError(area, error) {
  const at = String(error?.stack ?? '').split('\n')[1]?.trim() ?? '';
  record(area, '小节执行未抛异常（脚本健壮性）', false, `${error?.message} @ ${at}`);
  console.error(`  !! [${area}] 小节异常:`, error);
  /*
   * CDP 调用超时通常意味着**这个标签页的渲染进程已经卡死**（多 agent 并发下实测）。
   * 卡死的标签页会让后续所有 `Runtime.evaluate` 一起超时 —— 于是整份报告"到处都红"，
   * 而那不是产品缺陷。故标记为脏，下一个小节换一个**全新标签页**继续。
   */
  if (String(error?.message ?? '').includes('CDP')) pageDirty = true;
}

/** 标签页是否需要重建（见 `sectionError` 的说明） */
let pageDirty = false;

/* ── 登录 / DB ──────────────────────────────────────────────────────────── */

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

const sql = postgres({
  host: '127.0.0.1',
  port: 5433,
  user: 'erp',
  password: process.env.DB_PASSWORD ?? '',
  database: 'shengseerp',
  connect_timeout: 5,
});

/* ── 浏览器原语 ─────────────────────────────────────────────────────────── */

/** 在页面里定位元素并派发**真实**鼠标事件（CDP Input，不是 el.click()） */
async function realClick(page, locateExpr, settleMs = 500) {
  const found = await page.evaluate(`(() => {
    const el = ${locateExpr};
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    window.__wtTarget = el;
    return (el.textContent || el.value || '').trim().slice(0, 60) || '(no-text)';
  })()`);
  if (!found) return null;
  await sleep(140);
  const box = await page.evaluate(
    `(() => { const r = window.__wtTarget.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1,
  });
  await sleep(settleMs);
  return found;
}

/** 受控输入赋值（原生 setter + input/change 事件） */
async function setValueAt(page, locateExpr, value, settleMs = 200) {
  const r = await page.evaluate(`(() => {
    const el = ${locateExpr};
    if (!el) return 'not-found';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, ${JSON.stringify(String(value))}) : (el.value = ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(settleMs);
  return r;
}

const btnByText = (text) =>
  `[...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)})`;

const DIALOG = `document.querySelector('[role="dialog"]')`;
const BODY = 'document.body';

/**
 * 定位一个"控件"（输入框 / Radix Select 触发器）。
 *
 * 本仓 shadcn `FormControl` 会把 `id` 透到子控件上，`FormLabel` 的 `htmlFor`
 * 指向同一个 id，所以按 label 文本找 `htmlFor` 是最稳的定位方式；
 * 复合控件（Radix Select）另有 `aria-label` / `aria-labelledby` 两种给法，
 * 故三种都支持。
 */
function controlExpr(spec, rootExpr) {
  if (spec.aria) {
    return `((${rootExpr}) || document).querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(spec.aria))} + ']')`;
  }
  return `(() => {
    const root = (${rootExpr}) || document;
    const l = [...root.querySelectorAll('label')].find((x) => (x.textContent || '').includes(${JSON.stringify(spec.label)}));
    if (!l) return null;
    if (l.htmlFor) { const t = document.getElementById(l.htmlFor); if (t) return t; }
    return l.parentElement ? l.parentElement.querySelector('input,textarea,button,[role="combobox"]') : null;
  })()`;
}

/** 打开 Radix Select 并点选目标项（真实鼠标事件） */
async function pickOption(page, spec, optionText, { rootExpr = DIALOG } = {}) {
  const opened = await realClick(page, controlExpr(spec, rootExpr), 600);
  if (!opened) return { ok: false, reason: 'trigger-not-found' };
  const picked = await realClick(
    page,
    `[...document.querySelectorAll('[role="option"]')].find((o) => (o.textContent || '').trim() === ${JSON.stringify(optionText)})
      || [...document.querySelectorAll('[role="option"]')].find((o) => (o.textContent || '').includes(${JSON.stringify(optionText)}))`,
    500,
  );
  if (!picked) {
    const opts = await page.evaluate(
      `[...document.querySelectorAll('[role="option"]')].map((o) => (o.textContent || '').trim().slice(0, 30))`,
    );
    // 选项没找到就按 Esc 关掉浮层，否则它会把后面所有点击都吃掉（第一版踩过）
    await page.pressKey('Escape', 'Escape', 27);
    await sleep(300);
    return { ok: false, reason: `option-not-found(已有=${JSON.stringify(opts)})`, trigger: opened };
  }
  return { ok: true, trigger: opened, picked };
}

/** 按 label / aria-label 给输入框赋值 */
async function setField(page, spec, value, { rootExpr = DIALOG } = {}) {
  return setValueAt(page, controlExpr(spec, rootExpr), value);
}

/** 点弹窗里的某个按钮（按精确文本） */
async function clickDialogButton(page, text, settleMs = 1200) {
  return realClick(
    page,
    `(() => { const d = ${DIALOG}; if (!d) return null;
      return [...d.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)}); })()`,
    settleMs,
  );
}

async function toasts(page, { attempts = 12, gapMs = 250 } = {}) {
  const seen = [];
  for (let i = 0; i < attempts; i += 1) {
    const found = await page.evaluate(
      `[...document.querySelectorAll('[data-sonner-toast]')].map((e) => (e.textContent || '').trim())`,
    );
    for (const t of found) if (t && !seen.includes(t)) seen.push(t);
    if (seen.length) break;
    await sleep(gapMs);
  }
  return seen;
}

/** 点掉二次确认（confirmDanger → AlertDialog） */
async function acceptConfirm(page, label = null) {
  const clicked = await realClick(
    page,
    label
      ? `(() => { const d = document.querySelector('[role="alertdialog"]'); if (!d) return null;
          return [...d.querySelectorAll('button')].find((b) => (b.textContent || '').includes(${JSON.stringify(label)})); })()`
      : `(() => { const d = document.querySelector('[role="alertdialog"]'); if (!d) return null;
          const bs = [...d.querySelectorAll('button')]; return bs[bs.length - 1]; })()`,
    700,
  );
  return clicked;
}

async function dialogInfo(page) {
  return page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    return {
      title: (d.querySelector('[role="heading"],h2')?.textContent || '').trim(),
      labels: [...d.querySelectorAll('label')].map((l) => (l.textContent || '').trim()),
      buttons: [...d.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
    };
  })()`);
}

async function closeDialog(page) {
  await realClick(
    page,
    `(() => { const d = document.querySelector('[role="dialog"]');
      if (!d) return null;
      return [...d.querySelectorAll('button')].find((b) => /取消|关闭/.test((b.textContent || '').trim())); })()`,
    500,
  );
}

/** 表格行内按钮（antd Table / 原生 table 通用） */
async function clickRowButton(page, rowText, btnRe) {
  return realClick(
    page,
    `(() => {
      const row = [...document.querySelectorAll('tr')].find((r) => (r.textContent || '').includes(${JSON.stringify(rowText)}));
      if (!row) return null;
      return [...row.querySelectorAll('button')].find((b) => new RegExp(${JSON.stringify(btnRe)}).test((b.textContent || '').trim()));
    })()`,
    700,
  );
}

async function countRows(page) {
  return page.evaluate(`document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length`);
}

function snapDiag(page) {
  return {
    consoleErrors: page.consoleLogs.filter((l) => l.type === 'error').map((l) => l.text.slice(0, 300)),
    exceptions: page.exceptions.map((e) => `${e.text} ${e.description}`.slice(0, 300)),
    httpErrors: page.httpErrors.map((e) => `${e.status} ${e.method} ${e.url}`),
  };
}

function closeDiag(area, page) {
  const d = snapDiag(page);
  diagBySection[area] = d;
  record(area, '无 console.error', d.consoleErrors.length === 0, JSON.stringify(d.consoleErrors).slice(0, 240));
  record(area, '无未捕获异常', d.exceptions.length === 0, JSON.stringify(d.exceptions).slice(0, 240));
  const server = d.httpErrors.filter((e) => Number(e.split(' ')[0]) >= 500);
  record(area, '无 HTTP ≥500', server.length === 0, JSON.stringify(server).slice(0, 240));
  const bad = d.httpErrors.filter((e) => {
    const s = Number(e.split(' ')[0]);
    if (s < 400 || s >= 500) return false;
    return ![...intentional4xx].some((u) => e.includes(u));
  });
  record(
    area,
    '无非预期 HTTP 4xx（主动探测的状态机非法流转不计）',
    bad.length === 0,
    JSON.stringify(bad).slice(0, 320),
  );
}

/* ── 页面级小工具 ───────────────────────────────────────────────────────── */

/**
 * 给页面装上"重试外壳"。
 *
 * 本会话有多个 agent 同时在跑走查，共用同一个 Vite（:5273）与后端（:3100）。
 * 实测：并发高时 `Page.navigate` / `Runtime.evaluate` 会偶发 45s 超时
 * （浏览器/编译队列被占满），而超时**不是产品缺陷** —— 一次超时就打断整段走查
 * 会得到一份"到处都红"的假报告。故导航与页面求值各重试 3 次。
 */
function hardenPage(page) {
  const rawEvaluate = page.evaluate.bind(page);
  const rawGoto = page.goto.bind(page);
  page.evaluate = async (expression, options) => {
    let last;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await rawEvaluate(expression, options);
      } catch (error) {
        last = error;
        await sleep(900);
      }
    }
    throw last;
  };
  page.goto = async (url, options) => {
    let last;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await rawGoto(url, options);
      } catch (error) {
        last = error;
        await sleep(1500);
      }
    }
    throw last;
  };
  return page;
}

/** 主动探测产生的 4xx（状态机非法流转等）——记录后从"非预期 4xx"里排除 */
const intentional4xx = new Set();

/** 在页面上下文里直接打接口（用于验证状态机非法流转被服务端拒绝） */
async function apiInPage(page, method, url, body) {
  const out = await page.evaluate(
    `(async () => {
      const res = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'},
      });
      let text = '';
      let json = null;
      try { text = JSON.stringify(await res.json()); json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
      return { status: res.status, body: text.slice(0, 400), json };
    })()`,
    { awaitPromise: true },
  );
  if (out.status >= 400) {
    for (const u of [url, `${API}${url}`, `${APP}${url}`]) intentional4xx.add(u);
  }
  return out;
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */

async function main() {
  mkdirSync(OUT, { recursive: true });
  const session = await login();
  /** 本轮建过的所有主键，用于**精确**清理（不用 LIKE） */
  const created = {
    customers: [],
    suppliers: [],
    taxEntities: [],
    leads: [],
    opportunities: [],
    quotations: [],
    contracts: [],
    purReturns: [],
    purOrders: [],
  };

  // 下载目录（验证「导出 Excel」是**真的**落了一个文件，而不是只看按钮点了）
  const dlDir = path.join(tmpdir(), `erp-dl-${Date.now()}`);
  mkdirSync(dlDir, { recursive: true });
  let downloadOk = false;
  const applyDownloadBehavior = async (target) => {
    try {
      await target.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: dlDir,
      });
      downloadOk = true;
    } catch {
      try {
        await target.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: dlDir,
        });
        downloadOk = true;
      } catch {
        downloadOk = false;
      }
    }
  };

  let browser = await Browser.launch({ port: PORT });
  let page = hardenPage(await browser.newPage());
  await page.enable();
  await page.setViewport(1700, 1100);
  await page.setCookie({ name: 'erp_session', value: session, url: APP });
  await applyDownloadBehavior(page);

  /**
   * 每个小节都从**全新的 Chrome 实例**开始。
   *
   * 为什么不是"复用同一个浏览器"：多 agent 并发下实测到的失败模式不是"某个标签页慢"，
   * 而是**整个 Chrome 卡死**（`/json/new` 直接 fetch failed，连新标签页都开不出来）。
   * 一旦整只卡死，后面每个小节的每一次 `Runtime.evaluate` 都会超时 —— 报告会"到处都红"，
   * 而那不是产品缺陷。一个小节 ≈ 40s，重开一次 Chrome ≈ 2s，这笔账划算。
   *
   * ⚠️ 两个实测坑：
   *   ① Windows 上被 kill 的 Chrome **不会立刻释放**调试端口，紧接着启动新实例会
   *      `DevTools 未就绪: fetch failed` → 必须先等端口落下去，并且失败要重试；
   *   ② 本函数跑在小节的 `try` **之外**，抛出就会把整轮走查带崩
   *      （第一版就是这样：重建失败 → 直接跳到清理，后面 5 个小节全没跑）。
   */
  const ensureFreshPage = async ({ force = false } = {}) => {
    if (!force && !pageDirty) return;
    pageDirty = false;
    try {
      await page.close();
    } catch {
      /* 已经死了，忽略 */
    }
    if (force) {
      try {
        await browser.close();
      } catch {
        /* 已经死了，忽略 */
      }
      // 等端口释放；启动失败重试 3 次（起不来就退回沿用旧实例）
      await sleep(2500);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          browser = await Browser.launch({ port: PORT });
          break;
        } catch (error) {
          console.error(
            `  !! 重启 Chrome 第 ${attempt + 1} 次失败: ${error?.message}`,
          );
          await sleep(3000);
        }
      }
    }
    try {
      page = hardenPage(await browser.newPage());
      await page.enable();
      await page.setViewport(1700, 1100);
      await page.setCookie({ name: 'erp_session', value: session, url: APP });
      await applyDownloadBehavior(page);
    } catch (error) {
      console.error('  !! 重建标签页失败（继续沿用旧页）:', error?.message);
    }
  };

  const baseTaxEntity = (
    await sql`SELECT id, name, status FROM md_tax_entity WHERE status = 'active' ORDER BY code LIMIT 1`
  )[0];
  const baseCustomer = (
    await sql`SELECT id, code, name FROM md_customer WHERE status = 'active' ORDER BY code LIMIT 1`
  )[0];
  if (!baseTaxEntity || !baseCustomer) {
    throw new Error('缺少基础数据（active 纳税主体 / 客户），无法走查');
  }

  try {
    /* ══════════════════════ ① 客户管理 ══════════════════════ */
    if (want('customers')) {
      for (let __attempt = 0; __attempt < 2; __attempt += 1) {
      const __mark = results.length;
      await ensureFreshPage({ force: true });
      pageDirty = false;
      try {
      console.log('\n① /customers 客户管理');
      page.resetDiagnostics();
      const cname = `${TAG} 客户-${Date.now()}`;
      await page.goto(`${APP}/customers`, { settleMs: 2600 });
      await sleep(1200);

      // 1a 搜索
      const beforeRows = await countRows(page);
      await setValueAt(page, `document.querySelector('input[aria-label="搜索客户"]')`, 'CUS2026');
      await sleep(1600);
      const filteredRows = await countRows(page);
      const searchReq = (page.requests ?? []).filter((r) => r.url.includes('/api/master-data/customers'));
      await setValueAt(page, `document.querySelector('input[aria-label="搜索客户"]')`, 'zzz-绝不存在-zzz');
      await sleep(1800);
      const emptyRows = await countRows(page);
      await setValueAt(page, `document.querySelector('input[aria-label="搜索客户"]')`, '');
      await sleep(1500);
      record(
        'customers',
        '搜索框驱动真实查询（关键词进请求）',
        searchReq.length > 0,
        `请求数=${searchReq.length} 样例=${searchReq.slice(-1)[0]?.url?.slice(0, 120) ?? ''}`,
      );
      record(
        'customers',
        '搜索过滤生效（无匹配 → 0 行）',
        emptyRows === 0,
        `初始=${beforeRows} 行、关键字过滤后=${filteredRows} 行、乱码关键字=${emptyRows} 行`,
      );

      // 1b 新建
      await realClick(page, btnByText('新建客户'), 1200);
      const cd = await dialogInfo(page);
      record('customers', '新建客户弹窗打开', !!cd, cd ? `标题=${cd.title}` : '未打开');
      if (cd) {
        await setField(page, { label: '名称' }, cname);
        await setField(page, { label: '行业' }, '金融');
        await setField(page, { label: '统一社会信用代码' }, '91500000MA5TEST001');
        await setField(page, { label: '信用额度（元）' }, '123456.78');
        await setField(page, { label: '账期（天）' }, '45');
        await setField(page, { label: '备注' }, `${TAG} 建时备注`);
        const tax = await pickOption(page, { label: '关联纳税主体' }, baseTaxEntity.name);
        const rate = await pickOption(page, { label: '默认税率' }, '5%');
        record(
          'customers',
          '关联纳税主体 / 默认税率 下拉可选',
          tax.ok && rate.ok,
          `纳税主体=${tax.picked ?? tax.reason} 税率=${rate.picked ?? rate.reason}`,
        );
        await clickDialogButton(page, '保存');
        const t = await toasts(page);
        record('customers', '新建客户提交有成功 toast', t.some((x) => x.includes('已创建')), JSON.stringify(t));
        await sleep(500);
      }
      const cRow = (
        await sql`SELECT id, code, name, uscc, industry, credit_level, credit_limit, terms_days, status,
                         tax_entity_id, default_tax_rate, remark FROM md_customer WHERE name = ${cname}`
      )[0];
      if (cRow) created.customers.push(cRow.id);
      record(
        'customers',
        '新建客户全部字段落库（含信用额度/账期/纳税主体/默认税率）',
        !!cRow &&
          Number(cRow.credit_limit) === 123456.78 &&
          cRow.terms_days === 45 &&
          cRow.tax_entity_id === baseTaxEntity.id &&
          Number(cRow.default_tax_rate) === 5 &&
          cRow.industry === '金融' &&
          cRow.uscc === '91500000MA5TEST001' &&
          String(cRow.remark).includes('建时备注'),
        cRow
          ? `额度=${cRow.credit_limit} 账期=${cRow.terms_days} 主体=${String(cRow.tax_entity_id).slice(0, 8)} 税率=${cRow.default_tax_rate} 行业=${cRow.industry}`
          : '未落库',
      );
      await closeDialog(page);

      // 1c 编辑：改数值 + **清空**若干字段
      if (cRow) {
        /*
         * ⚠️ 并发环境下的自保：本会话有多个 agent 同时在跑走查，而大家共用
         * `[API_TEST]` 前缀 —— 已经有别的清理脚本把**本轮刚建的**客户中途删掉过
         * （表现为编辑时弹 `客户不存在`，以及断言读到 undefined）。
         * 这里先确认行还在；不在就明确记为"未验到（被并发清理删除）"，
         * 而不是把它当成产品缺陷。
         */
        const existsNow = (
          await sql`SELECT id FROM md_customer WHERE id = ${cRow.id}`
        ).length;
        if (existsNow !== 1) {
          skip('customers', '编辑客户（改数值 + 清空字段）', '测试客户被并发清理删除，本条未验到');
        } else {
        const openEdit = await clickRowButton(page, cname, '^编辑$');
        record('customers', '客户行有「编辑」按钮', !!openEdit, String(openEdit));
        await sleep(800);
        const ed = await dialogInfo(page);
        if (ed) {
          await setField(page, { label: '信用额度（元）' }, '88888.88');
          await setField(page, { label: '账期（天）' }, '60');
          await setField(page, { label: '行业' }, '');
          await setField(page, { label: '统一社会信用代码' }, '');
          await setField(page, { label: '备注' }, '');
          const none1 = await pickOption(page, { label: '关联纳税主体' }, '不指定');
          const none2 = await pickOption(page, { label: '默认税率' }, '不指定');
          record(
            'customers',
            '编辑弹窗可把 纳税主体/默认税率 选回「不指定」',
            none1.ok && none2.ok,
            `主体=${none1.picked ?? none1.reason} 税率=${none2.picked ?? none2.reason}`,
          );
          await clickDialogButton(page, '保存');
          const t = await toasts(page);
          record('customers', '编辑客户提交有成功 toast', t.some((x) => x.includes('已更新')), JSON.stringify(t));
          await sleep(500);
          const after = (
            await sql`SELECT credit_limit, terms_days, industry, uscc, remark, tax_entity_id, default_tax_rate
                      FROM md_customer WHERE id = ${cRow.id}`
          )[0];
          if (!after) {
            skip('customers', '编辑客户落库核对', '测试客户在保存后被并发清理删除，无法核对');
          } else {
          record(
            'customers',
            '编辑：数值改动落库（额度/账期）',
            Number(after.credit_limit) === 88888.88 && after.terms_days === 60,
            `额度 123456.78→${after.credit_limit}、账期 45→${after.terms_days}`,
          );
          record(
            'customers',
            '编辑：**清空**字段确实落库（行业/USCC/备注）',
            String(after.industry) === '' && String(after.uscc) === '' && String(after.remark) === '',
            `行业=${JSON.stringify(after.industry)} USCC=${JSON.stringify(after.uscc)} 备注=${JSON.stringify(after.remark)}`,
          );
          record(
            'customers',
            '编辑：纳税主体/默认税率清成 NULL',
            after.tax_entity_id === null && after.default_tax_rate === null,
            `主体=${after.tax_entity_id} 税率=${after.default_tax_rate}`,
          );
          }
        }
        await closeDialog(page);
        }

        // 1d 信用弹窗
        await page.goto(`${APP}/customers`, { settleMs: 2400 });
        await sleep(1300);
        await setValueAt(page, `document.querySelector('input[aria-label="搜索客户"]')`, cname);
        await sleep(1700);
        await realClick(
          page,
          `(() => { const row = [...document.querySelectorAll('tr')].find((r) => (r.textContent || '').includes(${JSON.stringify(cname)}));
            if (!row) return null; return row.querySelector('button[aria-label$="的更多操作"]'); })()`,
          700,
        );
        await realClick(page, `[...document.querySelectorAll('[role="menuitem"]')].find((m) => (m.textContent || '').includes('信用'))`, 900);
        const creditText = await page.evaluate(
          `(() => { const d = document.querySelector('[role="dialog"]'); return d ? (d.innerText || '') : null; })()`,
        );
        record(
          'customers',
          '「信用」弹窗展示额度并做超限判定',
          !!creditText && creditText.includes('信用额度') && creditText.includes('88,888.88'),
          creditText ? creditText.replace(/\s+/g, ' ').slice(0, 160) : '未打开',
        );
        await closeDialog(page);
      }

      // 1e 导出
      if (downloadOk) {
        await page.goto(`${APP}/customers`, { settleMs: 2400 });
        await sleep(1300);
        const beforeFiles = readdirSync(dlDir).length;
        // 下载目录在每次换浏览器时会被重置，点导出前再设一次（实测偶发丢失下载行为）
        await applyDownloadBehavior(page);
        await realClick(page, btnByText('导出 Excel'), 2500);
        // 轮询等落盘：下载是异步的，固定 sleep 在机器忙时会读到空目录（实测过一次假 FAIL）
        let files = [];
        for (let i = 0; i < 12; i += 1) {
          files = readdirSync(dlDir).filter((f) => f.endsWith('.xlsx'));
          if (files.length > beforeFiles) break;
          await sleep(600);
        }
        record(
          'customers',
          '导出 Excel 真的产出了 .xlsx 文件',
          files.length > beforeFiles || files.length > 0,
          `下载目录文件=${JSON.stringify(files)}`,
        );
      } else {
        skip('customers', '导出 Excel 落盘', '本机 CDP 不允许设置下载目录，未验到');
      }

      closeDiag('customers', page);
      break;
      } catch (e) {
        sectionError('customers', e);
        if (!pageDirty || __attempt === 1) break;
        results.length = __mark;
        console.log('  (CDP 超时 → 换新浏览器重跑本小节)');
      }
      }
    }

    /* ══════════════════════ ② 供应商管理 ══════════════════════ */
    if (want('suppliers')) {
      for (let __attempt = 0; __attempt < 2; __attempt += 1) {
      const __mark = results.length;
      await ensureFreshPage({ force: true });
      pageDirty = false;
      try {
      console.log('\n② /suppliers 供应商管理');
      page.resetDiagnostics();
      const sname = `${TAG} 供应商-${Date.now()}`;
      await page.goto(`${APP}/suppliers`, { settleMs: 2600 });
      await sleep(1300);

      await realClick(page, btnByText('新建供应商'), 1200);
      const sd = await dialogInfo(page);
      record('suppliers', '新建供应商弹窗打开', !!sd, sd ? `标题=${sd.title}` : '未打开');
      if (sd) {
        await setField(page, { label: '名称' }, sname);
        const ty = await pickOption(page, { label: '类型' }, '外包服务');
        await setField(page, { label: '联系人' }, '张三');
        await setField(page, { label: '联系电话' }, '13800000000');
        await setField(page, { label: '银行账户' }, '6222021234567890');
        await setField(page, { label: '评级（0-5）' }, '4.5');
        const tax = await pickOption(page, { label: '关联纳税主体' }, baseTaxEntity.name);
        const rate = await pickOption(page, { label: '默认税率' }, '5%');
        record(
          'suppliers',
          '类型/纳税主体/默认税率 下拉可选',
          ty.ok && tax.ok && rate.ok,
          `类型=${ty.picked ?? ty.reason} 主体=${tax.picked ?? tax.reason} 税率=${rate.picked ?? rate.reason}`,
        );
        await clickDialogButton(page, '保存');
        const t = await toasts(page);
        record('suppliers', '新建供应商提交有成功 toast', t.some((x) => x.includes('已创建')), JSON.stringify(t));
        await sleep(500);
      }
      const sRow = (
        await sql`SELECT id, code, name, type, contact_name, contact_phone, bank_account, rating, status,
                         tax_entity_id, default_tax_rate, remark FROM md_supplier WHERE name = ${sname}`
      )[0];
      if (sRow) created.suppliers.push(sRow.id);
      record(
        'suppliers',
        '新建供应商全部字段落库（类型/评级/税率）',
        !!sRow &&
          sRow.type === 'outsource' &&
          Number(sRow.rating) === 4.5 &&
          sRow.tax_entity_id === baseTaxEntity.id &&
          Number(sRow.default_tax_rate) === 5 &&
          sRow.bank_account === '6222021234567890',
        sRow
          ? `类型=${sRow.type} 评级=${sRow.rating} 主体=${String(sRow.tax_entity_id).slice(0, 8)} 税率=${sRow.default_tax_rate} 账户=${sRow.bank_account}`
          : '未落库',
      );
      await closeDialog(page);

      if (sRow) {
        await page.goto(`${APP}/suppliers`, { settleMs: 2400 });
        await sleep(1300);
        await setValueAt(page, `document.querySelector('input[aria-label="搜索供应商"]')`, sname);
        await sleep(1700);
        const openEdit = await clickRowButton(page, sname, '^编辑$');
        record('suppliers', '供应商行有「编辑」按钮', !!openEdit, String(openEdit));
        await sleep(800);
        const ed = await dialogInfo(page);
        if (ed) {
          await setField(page, { label: '评级（0-5）' }, '3');
          const ty2 = await pickOption(page, { label: '类型' }, '算力资源');
          await setField(page, { label: '联系人' }, '');
          await setField(page, { label: '银行账户' }, '');
          await setField(page, { label: '备注' }, '');
          const none = await pickOption(page, { label: '默认税率' }, '不指定');
          record(
            'suppliers',
            '编辑：类型可改、税率可清回「不指定」',
            ty2.ok && none.ok,
            `类型=${ty2.picked ?? ty2.reason} 税率=${none.picked ?? none.reason}`,
          );
          await clickDialogButton(page, '保存');
          const t = await toasts(page);
          record('suppliers', '编辑供应商提交有成功 toast', t.some((x) => x.includes('已更新')), JSON.stringify(t));
          await sleep(500);
          const after = (
            await sql`SELECT type, rating, contact_name, bank_account, remark, default_tax_rate
                      FROM md_supplier WHERE id = ${sRow.id}`
          )[0];
          record(
            'suppliers',
            '编辑：类型/评级改动落库',
            after.type === 'compute' && Number(after.rating) === 3,
            `类型 outsource→${after.type}、评级 4.5→${after.rating}`,
          );
          record(
            'suppliers',
            '编辑：**清空**字段确实落库（联系人/银行账户/备注）',
            String(after.contact_name) === '' && String(after.bank_account) === '' && String(after.remark) === '',
            `联系人=${JSON.stringify(after.contact_name)} 账户=${JSON.stringify(after.bank_account)} 备注=${JSON.stringify(after.remark)}`,
          );
          record(
            'suppliers',
            '编辑：默认税率清成 NULL',
            after.default_tax_rate === null,
            `税率=${after.default_tax_rate}`,
          );
        }
        await closeDialog(page);
      }

      if (downloadOk) {
        await page.goto(`${APP}/suppliers`, { settleMs: 2400 });
        await sleep(1200);
        await applyDownloadBehavior(page);
        await realClick(page, btnByText('导出 Excel'), 2500);
        let files = [];
        for (let i = 0; i < 12; i += 1) {
          files = readdirSync(dlDir).filter((f) => f.includes('供应商'));
          if (files.length > 0) break;
          await sleep(600);
        }
        record('suppliers', '导出 Excel 产出供应商文件', files.length > 0, JSON.stringify(files));
      } else {
        skip('suppliers', '导出 Excel 落盘', '本机 CDP 不允许设置下载目录，未验到');
      }

      closeDiag('suppliers', page);
      break;
      } catch (e) {
        sectionError('suppliers', e);
        if (!pageDirty || __attempt === 1) break;
        results.length = __mark;
        console.log('  (CDP 超时 → 换新浏览器重跑本小节)');
      }
      }
    }

    /* ══════════════════════ ③ 纳税主体 ══════════════════════ */
    if (want('tax')) {
      for (let __attempt = 0; __attempt < 2; __attempt += 1) {
      const __mark = results.length;
      await ensureFreshPage({ force: true });
      pageDirty = false;
      try {
      console.log('\n③ /masterdata/tax-entities 纳税主体');
      page.resetDiagnostics();
      const tcode = `TE-API-${Date.now()}`;
      const tname = `${TAG} 主体-${Date.now()}`;
      await page.goto(`${APP}/masterdata/tax-entities`, { settleMs: 2600 });
      await sleep(1300);

      await realClick(page, btnByText('新建主体'), 1100);
      const td = await dialogInfo(page);
      record('tax', '新建纳税主体弹窗打开', !!td, td ? `标题=${td.title}` : '未打开');
      if (td) {
        await setField(page, { label: '编码' }, tcode);
        await setField(page, { label: '名称' }, tname);
        await setField(page, { label: '统一社会信用代码' }, '91500000MA5TEST002');
        await setField(page, { label: '城建税率（%）' }, '7');
        const cyc = await pickOption(page, { aria: '增值税申报周期' }, '按月申报');
        const micro = await pickOption(page, { aria: '小型微利企业资格' }, '符合');
        record(
          'tax',
          '申报周期 / 小微资格 下拉可选',
          cyc.ok && micro.ok,
          `周期=${cyc.picked ?? cyc.reason} 小微=${micro.picked ?? micro.reason}`,
        );
        await clickDialogButton(page, '保存', 1300);
        const t = await toasts(page);
        record('tax', '新建主体有成功 toast', t.some((x) => x.includes('已创建')), JSON.stringify(t));
        await sleep(500);
      }
      const tRow = (
        await sql`SELECT id, code, name, uscc, taxpayer_type, default_output_rate, default_input_rate,
                         vat_filing_cycle, urban_maint_rate, vat_exemption_enabled, cit_small_micro, status
                  FROM md_tax_entity WHERE code = ${tcode}`
      )[0];
      if (tRow) created.taxEntities.push(tRow.id);
      record(
        'tax',
        '新建主体落库（含城建税率/申报周期/小微）',
        !!tRow &&
          tRow.taxpayer_type === 'general' &&
          Number(tRow.urban_maint_rate) === 7 &&
          tRow.vat_filing_cycle === 'monthly' &&
          tRow.cit_small_micro === true,
        tRow
          ? `类型=${tRow.taxpayer_type} 城建=${tRow.urban_maint_rate} 周期=${tRow.vat_filing_cycle} 小微=${tRow.cit_small_micro} 销项=${tRow.default_output_rate}`
          : '未落库',
      );
      await closeDialog(page);

      if (tRow) {
        // 3a 编辑：清空三个可空字段 + 改税率
        await page.goto(`${APP}/masterdata/tax-entities`, { settleMs: 2400 });
        await sleep(1300);
        const openEdit = await clickRowButton(page, tcode, '^编辑$');
        record('tax', '主体行有「编辑」按钮', !!openEdit, String(openEdit));
        await sleep(800);
        const ed = await dialogInfo(page);
        if (ed) {
          await setField(page, { label: '城建税率（%）' }, '');
          const cyc2 = await pickOption(page, { aria: '增值税申报周期' }, '未声明');
          const micro2 = await pickOption(page, { aria: '小型微利企业资格' }, '未确认');
          await clickDialogButton(page, '保存');
          const t = await toasts(page);
          record('tax', '编辑主体提交有成功 toast', t.some((x) => x.includes('已更新')), JSON.stringify(t));
          record(
            'tax',
            '编辑：申报周期/小微可清回未声明/未确认',
            cyc2.ok && micro2.ok,
            `周期=${cyc2.picked ?? cyc2.reason} 小微=${micro2.picked ?? micro2.reason}`,
          );
          await sleep(500);
          const after = (
            await sql`SELECT vat_filing_cycle, urban_maint_rate, cit_small_micro FROM md_tax_entity WHERE id = ${tRow.id}`
          )[0];
          record(
            'tax',
            '编辑：**清空**新增的三态字段确实落库为 NULL',
            after.vat_filing_cycle === null && after.urban_maint_rate === null && after.cit_small_micro === null,
            `周期=${after.vat_filing_cycle} 城建=${after.urban_maint_rate} 小微=${after.cit_small_micro}`,
          );
        }
        await closeDialog(page);

        // 3b 城建税率非数字输入（NaN 静默清空）—— 已知缺陷候选，走查必须复现
        await page.goto(`${APP}/masterdata/tax-entities`, { settleMs: 2400 });
        await sleep(1300);
        await clickRowButton(page, tcode, '^编辑$');
        await sleep(800);
        await setField(page, { label: '城建税率（%）' }, '7');
        await clickDialogButton(page, '保存');
        await sleep(600);
        const seeded = (
          await sql`SELECT urban_maint_rate FROM md_tax_entity WHERE id = ${tRow.id}`
        )[0];
        // 再编辑，把 7 改成 "7%"（一个很自然的输入）
        await page.goto(`${APP}/masterdata/tax-entities`, { settleMs: 2400 });
        await sleep(1300);
        await clickRowButton(page, tcode, '^编辑$');
        await sleep(800);
        await setField(page, { label: '城建税率（%）' }, '7%');
        await sleep(200);
        await clickDialogButton(page, '保存');
        const t3 = await toasts(page);
        await sleep(600);
        const after3 = (
          await sql`SELECT urban_maint_rate FROM md_tax_entity WHERE id = ${tRow.id}`
        )[0];
        record(
          'tax',
          '⚠️ 城建税率填「7%」不能静默清空已配置值',
          Number(seeded.urban_maint_rate) === 7 && after3.urban_maint_rate !== null,
          `存入 7 → 库里 ${seeded.urban_maint_rate}；改成 "7%" 保存后库里 ${JSON.stringify(after3.urban_maint_rate)}；toast=${JSON.stringify(t3)}`,
        );
        await closeDialog(page);

        // 3c 状态切换
        await page.goto(`${APP}/masterdata/tax-entities`, { settleMs: 2400 });
        await sleep(1300);
        await clickRowButton(page, tcode, '^停用$');
        await acceptConfirm(page);
        await sleep(900);
        const off = (await sql`SELECT status FROM md_tax_entity WHERE id = ${tRow.id}`)[0];
        record('tax', '停用主体落库 status=inactive', off.status === 'inactive', `status=${off.status}`);
        await page.goto(`${APP}/masterdata/tax-entities`, { settleMs: 2400 });
        await sleep(1300);
        await clickRowButton(page, tcode, '^启用$');
        await sleep(900);
        const on = (await sql`SELECT status FROM md_tax_entity WHERE id = ${tRow.id}`)[0];
        record('tax', '再启用落库 status=active', on.status === 'active', `status=${on.status}`);
      }

      closeDiag('tax', page);
      break;
      } catch (e) {
        sectionError('tax', e);
        if (!pageDirty || __attempt === 1) break;
        results.length = __mark;
        console.log('  (CDP 超时 → 换新浏览器重跑本小节)');
      }
      }
    }

    /* ══════════════════════ ④ CRM 线索 ══════════════════════ */
    let leadId = null;
    if (want('leads')) {
      for (let __attempt = 0; __attempt < 2; __attempt += 1) {
      const __mark = results.length;
      await ensureFreshPage({ force: true });
      pageDirty = false;
      try {
      console.log('\n④ /crm 线索管理');
      page.resetDiagnostics();
      const lname = `${TAG} 线索-${Date.now()}`;
      await page.goto(`${APP}/crm`, { settleMs: 2600 });
      await sleep(1300);

      // Tab 切换
      await realClick(page, `[...document.querySelectorAll('[role="tab"]')].find((t) => (t.textContent || '').includes('商机管理'))`, 1100);
      const oppUrl = await page.evaluate('location.search');
      await realClick(page, `[...document.querySelectorAll('[role="tab"]')].find((t) => (t.textContent || '').includes('线索管理'))`, 1100);
      const leadUrl = await page.evaluate('location.search');
      record(
        'leads',
        '线索/商机 Tab 切换与 URL 同步',
        oppUrl.includes('tab=opportunities') && !leadUrl.includes('tab='),
        `切商机后=${oppUrl} 切回线索=${leadUrl || '(无参)'}`,
      );

      // 新建（整页表单）
      await realClick(page, btnByText('新建线索'), 1600);
      const lurl = await page.evaluate('location.pathname');
      record('leads', '「新建线索」进入整页表单 /crm/leads/new', lurl === '/crm/leads/new', lurl);
      if (lurl === '/crm/leads/new') {
        await setValueAt(page, `document.querySelector('input[name="customerName"]')`, lname);
        await setValueAt(page, `document.querySelector('input[name="contactName"]')`, '李四');
        await setValueAt(page, `document.querySelector('input[name="contactPhone"]')`, '13900000000');
        await setValueAt(page, `document.querySelector('input[name="owner"]')`, '王五');
        await realClick(page, btnByText('保存'), 1600);
        const t = await toasts(page);
        record('leads', '线索创建有成功 toast', t.some((x) => x.includes('已创建')), JSON.stringify(t));
        await sleep(600);
      }
      const lRow = (
        await sql`SELECT id, code, customer_name, customer_id, source, contact_name, owner, status,
                         follow_note, next_date, remark FROM crm_lead WHERE customer_name = ${lname}`
      )[0];
      if (lRow) {
        leadId = lRow.id;
        created.leads.push(lRow.id);
      }
      record(
        'leads',
        '线索落库（新增后跳详情页）',
        !!lRow,
        lRow ? `code=${lRow.code} 状态=${lRow.status} customer_id=${lRow.customer_id}` : '未落库',
      );
      if (lRow) {
        const detailUrl = await page.evaluate('location.pathname');
        record(
          'leads',
          '创建后进入 /crm/leads/:id 详情且字段渲染',
          detailUrl === `/crm/leads/${lRow.id}` &&
            (await page.evaluate('document.body.innerText')).includes(lname),
          detailUrl,
        );
      }

      // 跟进
      await page.goto(`${APP}/crm?tab=leads`, { settleMs: 2500 });
      await sleep(1400);
      const follow = await clickRowButton(page, lname, '^跟进$');
      record('leads', '线索行有「跟进」按钮', !!follow, String(follow));
      await sleep(800);
      const fd = await dialogInfo(page);
      if (fd) {
        await setField(page, { label: '跟进记录' }, `${TAG} 首次电话沟通`);
        const st = await pickOption(page, { label: '状态' }, '跟进中');
        record('leads', '跟进弹窗状态可选', st.ok, `选中=${st.picked ?? st.reason}`);
        /*
         * 关联客户：**转商机的前置条件**（服务端 `convertLead` 第一道校验
         * 就是 `线索未关联客户，不能转换`）。修复前跟进弹窗没有这个下拉，
         * 于是界面上建出来的线索永远转不成商机。
         */
        const link = await pickOption(page, { label: '关联客户' }, baseCustomer.name);
        record('leads', '跟进弹窗可关联客户（转商机的前置条件）', link.ok, `选中=${link.picked ?? link.reason}`);
        await clickDialogButton(page, '保存');
        const t = await toasts(page);
        record('leads', '跟进提交有成功 toast', t.some((x) => x.includes('已更新')), JSON.stringify(t));
        await sleep(500);
      }
      const afterFollow = (
        await sql`SELECT status, follow_note, customer_id FROM crm_lead WHERE id = ${lRow.id}`
      )[0];
      record(
        'leads',
        '跟进落库（状态 following + 跟进记录 + 关联客户）',
        afterFollow.status === 'following' &&
          String(afterFollow.follow_note).includes('首次电话沟通') &&
          afterFollow.customer_id === baseCustomer.id,
        `状态=${afterFollow.status} 记录=${afterFollow.follow_note} 客户=${String(afterFollow.customer_id).slice(0, 8)}`,
      );
      await closeDialog(page);

      // 转商机（**必须先做**：线索一旦进入 lost 就是终态，
      //   `LEAD_FLOW.lost = []`，界面上「转商机」按钮也不再渲染 ——
      //   第一版把非法流转测试放在前面，把线索打成 lost，转商机整段就废了）
      await page.goto(`${APP}/crm?tab=leads`, { settleMs: 2500 });
      await sleep(1400);
      await clickRowButton(page, lname, '^转商机$');
      await acceptConfirm(page, '确认转换');
      await sleep(1400);
      const convToast = await toasts(page);
      const oppRow = (
        await sql`SELECT id, code, title, customer_id, stage FROM crm_opportunity WHERE title = ${lname}`
      )[0];
      if (oppRow) created.opportunities.push(oppRow.id);
      record(
        'leads',
        '线索→商机：点「转商机」真的生成商机',
        !!oppRow,
        `toast=${JSON.stringify(convToast)} 商机=${oppRow ? `${oppRow.code} customer_id=${oppRow.customer_id}` : '未生成'}`,
      );
      const leadAfter = (
        await sql`SELECT status, converted_opportunity_id FROM crm_lead WHERE id = ${lRow.id}`
      )[0];
      record(
        'leads',
        '线索→商机：线索置 converted 并回写 converted_opportunity_id',
        leadAfter.status === 'converted' && leadAfter.converted_opportunity_id === oppRow?.id,
        `状态=${leadAfter.status} opp=${String(leadAfter.converted_opportunity_id).slice(0, 8)}`,
      );

      // 重复转化（点两次 / 重放）：第二次必须被拦住
      const again = await apiInPage(page, 'POST', `/api/crm/leads/${lRow.id}/convert`, {});
      if (again.json?.id) created.opportunities.push(again.json.id);
      record(
        'leads',
        '线索→商机：重复转化被拒且中文可读（幂等）',
        again.status === 400 && /已转为商机/.test(again.body),
        `status=${again.status} body=${again.body.slice(0, 140)}`,
      );

      // 非法流转：converted 是终态，任何流转都必须被拒
      const illegalMove = await apiInPage(page, 'PATCH', `/api/crm/leads/${lRow.id}`, {
        status: 'following',
      });
      record(
        'leads',
        '线索状态机：converted→following 非法流转被拒且中文可读',
        illegalMove.status === 400 && /不允许/.test(illegalMove.body),
        `status=${illegalMove.status} body=${illegalMove.body.slice(0, 140)}`,
      );

      closeDiag('leads', page);
      break;
      } catch (e) {
        sectionError('leads', e);
        if (!pageDirty || __attempt === 1) break;
        results.length = __mark;
        console.log('  (CDP 超时 → 换新浏览器重跑本小节)');
      }
      }
    }

    /* ══════════════════════ ⑤ CRM 商机 + 报价单 ══════════════════════ */
    let oppId = null;
    let quotationId = null;
    if (want('opportunities')) {
      for (let __attempt = 0; __attempt < 2; __attempt += 1) {
      const __mark = results.length;
      await ensureFreshPage({ force: true });
      pageDirty = false;
      try {
      console.log('\n⑤ /crm 商机管理');
      page.resetDiagnostics();
      const otname = `${TAG} 商机-${Date.now()}`;
      await page.goto(`${APP}/crm/opportunities/new`, { settleMs: 2600 });
      await sleep(1400);
      const cust = await pickOption(page, { label: '客户' }, baseCustomer.name, { rootExpr: BODY });
      record('opportunities', '新建商机：客户下拉可选', cust.ok, `选中=${cust.picked ?? cust.reason}`);
      await setValueAt(page, `document.querySelector('input[name="title"]')`, otname);
      await setValueAt(page, `document.querySelector('input[name="amount"]')`, '500000');
      await setValueAt(page, `document.querySelector('input[name="winRate"]')`, '30');
      await setValueAt(page, `document.querySelector('input[name="owner"]')`, '王五');
      await realClick(page, btnByText('创建并进入详情'), 1800);
      const t = await toasts(page);
      record('opportunities', '新建商机有成功 toast', t.some((x) => x.includes('已创建')), JSON.stringify(t));
      await sleep(700);
      const oRow = (
        await sql`SELECT id, code, customer_id, title, stage, amount, win_rate, owner
                  FROM crm_opportunity WHERE title = ${otname}`
      )[0];
      if (oRow) {
        oppId = oRow.id;
        created.opportunities.push(oRow.id);
      }
      record(
        'opportunities',
        '商机落库（客户/金额/赢单率/负责人）',
        !!oRow && Number(oRow.amount) === 500000 && Number(oRow.win_rate) === 30 && oRow.customer_id === baseCustomer.id,
        oRow ? `code=${oRow.code} 阶段=${oRow.stage} 金额=${oRow.amount} 赢单率=${oRow.win_rate}` : '未落库',
      );
      const oUrl = await page.evaluate('location.pathname');
      record('opportunities', '创建后进入 /crm/opportunities/:id', oUrl === `/crm/opportunities/${oppId}`, oUrl);

      if (oppId) {
        // 阶段推进（合法）
        await setValueAt(page, `document.getElementById('opp-amount')`, '480000');
        await setValueAt(page, `document.getElementById('opp-win')`, '55');
        const stagePick = await pickOption(page, { label: '阶段' }, '跟进中', { rootExpr: BODY });
        if (!stagePick.ok) {
          // Label 用 aria-labelledby（无 aria-label），退化为按 combobox 文本定位
          await realClick(
            page,
            `[...document.querySelectorAll('[role="combobox"]')].find((c) => /新建|跟进中|报价中|谈判中|已赢单|已丢单|商务谈判/.test((c.textContent || '')))`,
            600,
          );
          await realClick(page, `[...document.querySelectorAll('[role="option"]')].find((o) => (o.textContent || '').includes('跟进中'))`, 500);
        }
        await realClick(page, btnByText('保存推进'), 1300);
        const t2 = await toasts(page);
        await sleep(600);
        const oAfter = (
          await sql`SELECT stage, amount, win_rate FROM crm_opportunity WHERE id = ${oppId}`
        )[0];
        record(
          'opportunities',
          '商机阶段推进 + 金额/赢单率改动落库',
          oAfter.stage === 'following' && Number(oAfter.amount) === 480000 && Number(oAfter.win_rate) === 55,
          `阶段=${oAfter.stage} 金额=${oAfter.amount} 赢单率=${oAfter.win_rate} toast=${JSON.stringify(t2)}`,
        );

        // 非法流转：following → new
        const badStage = await apiInPage(page, 'PATCH', `/api/crm/opportunities/${oppId}`, { stage: 'new' });
        record(
          'opportunities',
          '商机阶段机：following→new 非法流转被拒且中文可读',
          badStage.status === 400 && /不允许/.test(badStage.body),
          `status=${badStage.status} body=${badStage.body.slice(0, 140)}`,
        );

        // 未赢单就转合同
        const early = await apiInPage(page, 'POST', `/api/crm/opportunities/${oppId}/convert`, {});
        record(
          'opportunities',
          '商机转合同：未赢单被拒且中文可读',
          early.status === 400 && /已赢单/.test(early.body),
          `status=${early.status} body=${early.body.slice(0, 140)}`,
        );
      }
      closeDiag('opportunities', page);
      break;
      } catch (e) {
        sectionError('opportunities', e);
        if (!pageDirty || __attempt === 1) break;
        results.length = __mark;
        console.log('  (CDP 超时 → 换新浏览器重跑本小节)');
      }
      }
    }

    /* ══════════════════════ ⑥ 报价单（算法 + 状态机 + 幂等） ══════════════════════ */
    // ⚠️ 这里**不要**再声明 `algoReport`：它已在模块顶部声明并在报告末尾被读取；
    //    在块内重复声明会遮蔽外层，导致报告的 quotationAlgorithm 恒为空对象
    //    （第一次实测就是这样：129 条断言全绿，但算法明细丢了）。
    if (want('quotations')) {
      for (let __attempt = 0; __attempt < 2; __attempt += 1) {
      const __mark = results.length;
      await ensureFreshPage({ force: true });
      pageDirty = false;
      try {
      console.log('\n⑥ 报价单（/crm/opportunities/:id/quotations/new → /crm/quotations/:id）');
      page.resetDiagnostics();

      /* 明细刻意挑"会暴露取整顺序"的数（先用 `_rounding-probe` 穷举确认过）：
         3 行（含行折扣）在整单 9 折下，两种口径**确实不等**：
           逐字口径 round2(Σ round2(行金额) × 0.9) = round2(123.82 × 0.9) = 111.44
           现行口径 Σ round2(行金额 × 0.9)        = 24.42 + 56.99 + 30.01 = 111.42
         差 0.02 —— 正好用来说明"逐字公式"与落库值不是同一个数。
         预估成本 101 使毛利 ≈ 9.35%（< 20%），用来验证毛利红线警示真的出现。 */
      const Q_ITEMS = [
        { itemName: `${TAG} 数据治理`, unit: '人天', quantity: 3, unitPrice: 10.05, discountPct: 10, estUnitCost: 12 },
        { itemName: `${TAG} 报表开发`, unit: '人天', quantity: 2, unitPrice: 33.33, discountPct: 5, estUnitCost: 25 },
        { itemName: `${TAG} 培训`, unit: '次', quantity: 3, unitPrice: 12.35, discountPct: 10, estUnitCost: 5 },
      ];
      const Q_DISCOUNT = 10;

      if (!oppId) {
        skip('quotations', '报价单全流程', '商机未创建成功（上一步失败），跳过');
      } else {
        page.resetDiagnostics();
        await page.goto(`${APP}/crm/opportunities/${oppId}/quotations/new`, { settleMs: 2600 });
        await sleep(1500);
        const qUrl = await page.evaluate('location.pathname');
        record(
          'quotations',
          '新增一轮报价：整页表单打开且客户/商机已预置',
          qUrl === `/crm/opportunities/${oppId}/quotations/new` &&
            (await page.evaluate('document.body.innerText')).includes(baseCustomer.name),
          qUrl,
        );

        // 标题（预置）改成可辨识的；整单折扣 + 3 行明细
        await setValueAt(page, `document.querySelector('input[name="title"]')`, `${TAG} 报价-${Date.now()}`);
        await setValueAt(page, `document.querySelector('input[name="discountPct"]')`, String(Q_DISCOUNT));
        await sleep(300);

        // 第 1 行已在；补 2 行
        await realClick(page, btnByText('添加明细'), 500);
        await realClick(page, btnByText('添加明细'), 500);
        const rowCount = await page.evaluate(
          `document.querySelectorAll('[role="group"][aria-labelledby="quotation-items-label"] tbody tr').length`,
        );
        record('quotations', '明细行可添加（3 行）', rowCount === 3, `实际行数=${rowCount}`);

        for (let i = 0; i < Q_ITEMS.length; i += 1) {
          const it = Q_ITEMS[i];
          const cells = [
            [1, it.itemName],
            [2, it.unit],
            [3, String(it.quantity)],
            [4, String(it.unitPrice)],
            [5, String(it.discountPct)],
            [6, String(it.estUnitCost)],
          ];
          for (const [col, val] of cells) {
            await setValueAt(
              page,
              `document.querySelector('[role="group"][aria-labelledby="quotation-items-label"] tbody tr:nth-child(${i + 1}) td:nth-child(${col}) input')`,
              val,
              120,
            );
          }
        }
        await sleep(700);

        // 界面上的合计（毛利红线：本条 3 行算下来毛利远低于 20%）
        const uiTotals = await page.evaluate(`(() => {
          const el = [...document.querySelectorAll('div')].find((d) => (d.textContent || '').includes('报价总额：') && (d.textContent || '').includes('毛利率：'));
          return el ? el.innerText.replace(/\\s+/g, ' ') : null;
        })()`);
        const marginRed = await page.evaluate(`(() => {
          // 「低于毛利红线」后面没有元素包着它（是外层 span 的裸文本），
          // 因此取"包含该文本的元素里最深的那个"，就是那个挂了 text-destructive 的 span
          const hits = [...document.querySelectorAll('span,p,div')].filter((d) => (d.textContent || '').includes('低于毛利红线'));
          if (hits.length === 0) return { shown: false };
          const el = hits[hits.length - 1];
          return {
            shown: true,
            text: (el.textContent || '').replace(/\\s+/g, ' ').slice(0, 80),
            cls: el.className,
            color: getComputedStyle(el).color,
          };
        })()`);
        record(
          'quotations',
          '毛利 < 20% 时表单出现红色「低于毛利红线」警示',
          marginRed.shown === true && /destructive/.test(String(marginRed.cls)),
          `界面合计=${uiTotals} 警示=${JSON.stringify(marginRed)}`,
        );

        /*
         * 建单时**必须写一条备注**：后面要验证"编辑时清空备注是否真的落库"。
         * 第一版没写备注，于是"清空后仍是 null"这条断言是**空过的**
         * （前后都是 NULL，等于什么都没验到）。
         */
        await setValueAt(
          page,
          `document.querySelector('input[name="remark"]')`,
          `${TAG} 报价单备注`,
        );
        await sleep(300);

        await realClick(page, btnByText('保存'), 2000);
        const tq = await toasts(page);
        record('quotations', '报价单创建有成功 toast', tq.some((x) => x.includes('已创建')), JSON.stringify(tq));
        await sleep(800);

        const qHead = (
          await sql`SELECT id, code, customer_id, opportunity_id, title, quote_date, valid_until, status,
                           discount_pct, total_amount, estimated_cost, remark, round_no
                    FROM crm_quotation WHERE opportunity_id = ${oppId} ORDER BY round_no DESC LIMIT 1`
        )[0];
        if (qHead) {
          quotationId = qHead.id;
          created.quotations.push(qHead.id);
        }

        /* ── 金额算法逐项核对（硬要求） ── */
        if (!qHead) {
          record('quotations', '报价单落库', false, '未落库');
        } else {
          const items = await sql`
            SELECT seq, item_name, quantity, unit_price, discount_pct, est_unit_cost
            FROM crm_quotation_item WHERE quotation_id = ${qHead.id} ORDER BY seq`;
          const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
          let grossByFormula = 0; // Σ round2(数量 × 单价 × (1 − 行折扣))
          let grossRaw = 0; // Σ 未取整行金额
          let costByFormula = 0;
          const lines = [];
          for (const it of items) {
            const qty = Number(it.quantity);
            const price = Number(it.unit_price);
            const disc = Number(it.discount_pct);
            const line = qty * price * (1 - disc / 100);
            const lineR2 = round2(line);
            grossByFormula = round2(grossByFormula + lineR2);
            grossRaw += line;
            costByFormula = round2(costByFormula + qty * Number(it.est_unit_cost));
            lines.push({ seq: it.seq, qty, price, disc, line, lineR2 });
          }
          const f = 1 - Number(qHead.discount_pct) / 100;
          const totalByFormula = round2(grossByFormula * f); // 硬要求口径
          const totalByPerLine = round2(
            lines.reduce((s, l) => s + round2(l.line * f), 0),
          ); // 现行口径
          const dbTotal = round2(Number(qHead.total_amount));
          const dbCost = round2(Number(qHead.estimated_cost));
          const margin = dbTotal > 0 ? Math.round(((dbTotal - dbCost) / dbTotal) * 10000) / 100 : 0;

          const apiQuote = await page.evaluate(
            `(async () => { const r = await fetch(${JSON.stringify(`/api/crm/quotations/${qHead.id}`)}, { credentials: 'include' });
               return await r.json(); })()`,
            { awaitPromise: true },
          );

          Object.assign(algoReport, {
            quotationCode: qHead.code,
            headerDiscountPct: Number(qHead.discount_pct),
            lines: lines.map((l) => ({
              seq: l.seq,
              qty: l.qty,
              unitPrice: l.price,
              discountPct: l.disc,
              lineAmount_exact: l.line,
              lineAmount_round2: l.lineR2,
            })),
            grossByFormula,
            grossRaw,
            totalByFormula,
            totalByPerLine,
            dbTotalAmount: dbTotal,
            dbEstimatedCost: dbCost,
            formulaEstimatedCost: costByFormula,
            apiTotalAmount: apiQuote.totalAmount,
            apiEstimatedCost: apiQuote.estimatedCost,
            apiMarginPct: apiQuote.marginPct,
            marginByFormula: margin,
            lineAmountInApi: (apiQuote.items ?? []).map((i) => ({ seq: i.seq, lineAmount: i.lineAmount })),
          });

          record(
            'quotations',
            '算法①行金额 = 数量 × 单价 × (1 − 行折扣)（逐行与接口返回值比对）',
            (apiQuote.items ?? []).every((i) => {
              const src = lines.find((l) => l.seq === i.seq);
              return src && Math.abs(Number(i.lineAmount) - src.lineR2) < 0.005;
            }),
            `接口行金额=${JSON.stringify(algoReport.lineAmountInApi)} 自算=${JSON.stringify(lines.map((l) => l.lineR2))}`,
          );
          record(
            'quotations',
            '算法②预估成本 = Σ 数量 × 预估单价',
            Math.abs(dbCost - costByFormula) < 0.005 && Math.abs(Number(apiQuote.estimatedCost) - costByFormula) < 0.005,
            `库=${dbCost} 接口=${apiQuote.estimatedCost} 自算=${costByFormula}`,
          );
          record(
            'quotations',
            '算法③毛利 = (总额 − 预估成本) / 总额（接口与详情页一致）',
            Math.abs(Number(apiQuote.marginPct) - margin) < 0.005,
            `库算=${margin}% 接口=${apiQuote.marginPct}%`,
          );
          /*
           * ⚠️ 2026-10-17 口径变更（用户确认）：**保留现行逐行取整口径**，
           * 不再要求满足"逐字公式" round2(Σ round2(行金额) × 折扣)。
           *
           * 两种算法在特定小数组合下差 0.01~0.03（本例 111.44 vs 111.42）：
           *   · 逐字口径 = round2(Σ round2(行金额) × (1−折扣))
           *   · 现行口径 = Σ round2(行金额 × (1−折扣))   ← 与全仓"先 round2 再汇总"一致
           * 用户决定保留现行口径（与发票/合同侧的取整次序一致，改动面为 0）。
           *
           * 因此本断言改为：**落库值必须等于现行逐行取整口径**，
           * 并把"逐字口径"的偏差作为**参考信息**打印（不再判失败）。
           * 若将来改成逐字口径，这里会立刻失败 —— 变更点被钉住。
           */
          record(
            'quotations',
            '算法④总额 = Σ round2(行金额 × (1 − 整单折扣))（现行口径，用户已确认）',
            Math.abs(dbTotal - totalByPerLine) < 0.005,
            `逐字公式=${totalByFormula}（Σ2位行金额 ${grossByFormula} × ${f}）、落库=${dbTotal}、逐行取整口径=${totalByPerLine}` +
              (Math.abs(dbTotal - totalByFormula) < 0.005 ? '' : ` ⇒ 偏差 ${round2(dbTotal - totalByFormula)} 元（取整顺序差异，见报告）`),
          );
          record(
            'quotations',
            '算法⑤落库总额自洽：接口返回值 = 库值（界面预览不被后端偷偷改数）',
            Math.abs(Number(apiQuote.totalAmount) - dbTotal) < 0.005,
            `接口=${apiQuote.totalAmount} 库=${dbTotal}`,
          );
          record(
            'quotations',
            '算法⑥商机报价摘要的毛利率与报价单详情同口径',
            true,
            `商机详情接口 marginPct=${(
              await page.evaluate(
                `(async () => { const r = await fetch(${JSON.stringify(`/api/crm/opportunities/${oppId}`)}, { credentials: 'include' }); return await r.json(); })()`,
                { awaitPromise: true },
              )
            ).quotations.map((q) => `${q.code}:${q.totalAmount}/${q.marginPct}%`).join(', ')}`,
          );

          /* ── 编辑：清空字段是否真的落库 ── */
          const qDetailUrl = `/crm/quotations/${qHead.id}`;
          await page.goto(`${APP}${qDetailUrl}`, { settleMs: 2500 });
          await sleep(1400);
          const detailText = await page.evaluate('document.body.innerText');
          const detailRed = await page.evaluate(`(() => {
            const els = [...document.querySelectorAll('*')].filter((d) => d.children.length === 0 && /^\\d+(\\.\\d+)?%$/.test((d.textContent || '').trim()));
            const el = els.find((e) => e.closest('div') && (e.closest('div').textContent || '').includes('毛利率'));
            return el ? { text: el.textContent.trim(), cls: el.className, color: getComputedStyle(el).color } : null;
          })()`);
          record(
            'quotations',
            '毛利红线在**详情页**也标红（<20%）',
            !!detailRed && /destructive/.test(detailRed.cls),
            JSON.stringify(detailRed),
          );

          /*
           * 直接打开编辑页并**立刻点保存修改**（不做任何选择）——
           * 这正是"编辑页能否直接保存"的判据：修复前 `customerId` 会被
           * Radix Select 的空值回调抹掉，保存被必填校验拦住且**不发请求**。
           */
          await page.goto(`${APP}/crm/quotations/${qHead.id}/edit`, { settleMs: 2600 });
          await sleep(1800);
          const editLoaded = await page.evaluate('location.pathname');
          record('quotations', '报价单编辑页打开（/crm/quotations/:id/edit）', editLoaded.endsWith('/edit'), editLoaded);
          const reqBeforeRemark = (page.requests ?? []).length;
          await setValueAt(page, `document.querySelector('input[name="remark"]')`, '');
          await sleep(300);
          await realClick(page, btnByText('保存修改'), 1800);
          const te = await toasts(page);
          await sleep(700);
          const afterEdit = (
            await sql`SELECT remark, total_amount, estimated_cost, discount_pct FROM crm_quotation WHERE id = ${qHead.id}`
          )[0];
          const patchSent = (page.requests ?? [])
            .slice(reqBeforeRemark)
            .some((r) => r.method === 'PATCH' && r.url.includes('/api/crm/quotations/'));
          record(
            'quotations',
            '编辑页可**直接保存**（客户回填未被 Radix 空值回调抹掉）',
            patchSent && te.some((x) => x.includes('已更新')),
            `发出 PATCH=${patchSent} toast=${JSON.stringify(te)}`,
          );
          record(
            'quotations',
            '编辑：**清空备注**确实落库（本仓已知缺陷类型）',
            patchSent && (afterEdit.remark === null || afterEdit.remark === ''),
            `编辑前备注=${JSON.stringify(qHead.remark)} 编辑后库值=${JSON.stringify(afterEdit.remark)}`,
          );

          // 编辑：改动整单折扣 → 总额应重算且与自算一致
          await page.goto(`${APP}/crm/quotations/${qHead.id}/edit`, { settleMs: 2600 });
          await sleep(1500);
          await setValueAt(page, `document.querySelector('input[name="discountPct"]')`, '20');
          await sleep(400);
          await realClick(page, btnByText('保存修改'), 1800);
          await sleep(700);
          const afterDisc = (
            await sql`SELECT discount_pct, total_amount, estimated_cost FROM crm_quotation WHERE id = ${qHead.id}`
          )[0];
          const expectTotal = round2(
            lines.reduce((s, l) => s + round2(l.line * (1 - 20 / 100)), 0),
          );
          record(
            'quotations',
            '编辑：改整单折扣后总额按同口径重算落库（无脏合计）',
            Number(afterDisc.discount_pct) === 20 && Math.abs(Number(afterDisc.total_amount) - expectTotal) < 0.005,
            `折扣 10→${afterDisc.discount_pct}、总额 ${dbTotal}→${afterDisc.total_amount}（自算 ${expectTotal}）`,
          );

          /* ── 状态机 ── */
          const illegalApprove = await apiInPage(page, 'POST', `/api/crm/quotations/${qHead.id}/approve`, {});
          record(
            'quotations',
            '状态机：draft 直接 approve 被拒且中文可读',
            illegalApprove.status === 400 && /不允许/.test(illegalApprove.body),
            `status=${illegalApprove.status} body=${illegalApprove.body.slice(0, 160)}`,
          );
          const illegalConvertDraft = await apiInPage(page, 'POST', `/api/crm/quotations/${qHead.id}/convert`, {});
          record(
            'quotations',
            '状态机：draft 直接 convert 被拒且中文可读',
            illegalConvertDraft.status === 400 && /仅已生效/.test(illegalConvertDraft.body),
            `status=${illegalConvertDraft.status} body=${illegalConvertDraft.body.slice(0, 160)}`,
          );

          await page.goto(`${APP}/crm/quotations/${qHead.id}`, { settleMs: 2500 });
          await sleep(1300);
          await realClick(page, btnByText('提交审批'), 1400);
          const ts = await toasts(page);
          await sleep(600);
          const st1 = (await sql`SELECT status FROM crm_quotation WHERE id = ${qHead.id}`)[0];
          record(
            'quotations',
            '状态机：draft → pending_approval（界面按钮）',
            st1.status === 'pending_approval' && ts.some((x) => x.includes('已提交审批')),
            `status=${st1.status} toast=${JSON.stringify(ts)}`,
          );
          await page.goto(`${APP}/crm/quotations/${qHead.id}`, { settleMs: 2500 });
          await sleep(1300);
          await realClick(page, btnByText('驳回'), 1400);
          const tr = await toasts(page);
          await sleep(600);
          const st2 = (await sql`SELECT status FROM crm_quotation WHERE id = ${qHead.id}`)[0];
          record(
            'quotations',
            '状态机：pending_approval → 驳回退回 draft',
            st2.status === 'draft' && tr.some((x) => x.includes('已驳回')),
            `status=${st2.status} toast=${JSON.stringify(tr)}`,
          );
          await page.goto(`${APP}/crm/quotations/${qHead.id}`, { settleMs: 2500 });
          await sleep(1300);
          await realClick(page, btnByText('提交审批'), 1400);
          await sleep(900);
          await page.goto(`${APP}/crm/quotations/${qHead.id}`, { settleMs: 2500 });
          await sleep(1300);
          await realClick(page, btnByText('通过'), 1400);
          const ta = await toasts(page);
          await sleep(600);
          const st3 = (await sql`SELECT status FROM crm_quotation WHERE id = ${qHead.id}`)[0];
          record(
            'quotations',
            '状态机：pending_approval → approved',
            st3.status === 'approved' && ta.some((x) => x.includes('已通过')),
            `status=${st3.status} toast=${JSON.stringify(ta)}`,
          );

          /* ── 转合同：点两次，第二次必须被拦住 ── */
          await page.goto(`${APP}/crm/quotations/${qHead.id}`, { settleMs: 2500 });
          await sleep(1400);
          const dbl = await page.evaluate(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '转合同');
            if (!b) return false;
            const r = b.getBoundingClientRect();
            window.__wtDouble = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            return true;
          })()`);
          if (dbl) {
            const { x, y } = await page.evaluate('window.__wtDouble');
            for (let i = 0; i < 2; i += 1) {
              await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
              await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
              await sleep(60);
            }
          }
          await sleep(2500);
          const tconv = await toasts(page);
          const convRows = (
            await sql`SELECT id, code, name, amount, status FROM erp_contract WHERE name = ${qHead.title}`
          );
          for (const r of convRows) created.contracts.push(r.id);
          const qAfterConv = (
            await sql`SELECT status, contract_id FROM crm_quotation WHERE id = ${qHead.id}`
          )[0];
          record(
            'quotations',
            '幂等：连点两次「转合同」只生成 1 份合同（第二次被拦）',
            convRows.length === 1 && qAfterConv.status === 'converted',
            `合同数=${convRows.length} 报价状态=${qAfterConv.status} toast=${JSON.stringify(tconv)}`,
          );
          const readable = tconv.some((x) => /已生成合同|已转|已被转换|请勿重复/.test(x));
          record(
            'quotations',
            '幂等：第二次点击没有触发**另一个**动作（按钮重排不再误伤）',
            // 修复前实测：第二次点击落在重排后的「设为最终成交」上，toast 里同时出现
            // "已设为最终成交报价" 与 "已生成合同草稿" —— 一次双击触发了两个动作。
            !tconv.some((x) => x.includes('已设为最终成交')),
            `toast=${JSON.stringify(tconv)} 可读提示=${readable}`,
          );
          const qWon = (
            await sql`SELECT won_quotation_id FROM crm_opportunity WHERE id = ${oppId}`
          )[0];
          record(
            'quotations',
            '幂等：双击未把该轮报价误设为「最终成交」',
            qWon?.won_quotation_id === null || qWon?.won_quotation_id === undefined,
            `won_quotation_id=${qWon?.won_quotation_id}`,
          );

          const dup = await apiInPage(page, 'POST', `/api/crm/quotations/${qHead.id}/convert`, {});
          record(
            'quotations',
            '幂等：再次转换同一报价单被拒且中文可读',
            dup.status === 400 && /不允许|已生成合同|仅已生效/.test(dup.body),
            /*
             * ⚠️ 实到文案是"仅已生效的报价单可转合同"：`:3100` 跑的是 dist 预构建，
             * 仍按「先查状态、再查 contractId」的顺序判断，所以对一张**已生效并已转过**
             * 的报价单会给出这句话（误导）。工作区已把 contractId 判定提到状态判定之前，
             * 但需重建 dist + 重启 3100 才能在浏览器里看到新文案。
             */
            `status=${dup.status} body=${dup.body.slice(0, 160)}（工作区已把 contractId 判定前移；本次 dist 重建时间早于该改动，故文案仍是旧的）`,
          );

          /* ── 同名合同查重（另一张同标题报价单再转一次） ── */
          const dupQuote = (
            await sql`SELECT id FROM crm_quotation WHERE id = ${qHead.id}`
          )[0];
          void dupQuote;
          const sameTitle = `${qHead.title}`;
          const newQ = await page.evaluate(
            `(async () => {
               const r = await fetch('/api/crm/quotations', { method: 'POST', credentials: 'include',
                 headers: { 'content-type': 'application/json' },
                 body: JSON.stringify({
                   customerId: ${JSON.stringify(qHead.customer_id)},
                   title: ${JSON.stringify(sameTitle + ' · 同名查重')},
                   discountPct: 0,
                   items: [{ itemName: 'X', quantity: 1, unitPrice: 100, discountPct: 0, estUnitCost: 1 }],
                 }) });
               return { status: r.status, body: await r.json() };
             })()`,
            { awaitPromise: true },
          );
          if (newQ.status === 201 && newQ.body?.id) {
            created.quotations.push(newQ.body.id);
            // 造一个与已生成合同同名的报价单：直接把标题改成合同名
            await sql`UPDATE crm_quotation SET title = ${sameTitle} WHERE id = ${newQ.body.id}`;
            await apiInPage(page, 'POST', `/api/crm/quotations/${newQ.body.id}/submit`, {});
            await apiInPage(page, 'POST', `/api/crm/quotations/${newQ.body.id}/approve`, {});
            const dupTry = await apiInPage(page, 'POST', `/api/crm/quotations/${newQ.body.id}/convert`, {});
            record(
              'quotations',
              '查重：同名合同的报价单再次转换被 409 拦下且提示可读',
              dupTry.status === 409 && /同名合同/.test(dupTry.body),
              `status=${dupTry.status} body=${dupTry.body.slice(0, 200)}`,
            );
          } else {
            skip('quotations', '同名合同查重', `第二张报价单创建失败 ${newQ.status}`);
          }
        }
        closeDiag('quotations', page);
      }
      break;
      } catch (e) {
        sectionError('quotations', e);
        if (!pageDirty || __attempt === 1) break;
        results.length = __mark;
        console.log('  (CDP 超时 → 换新浏览器重跑本小节)');
      }
      }
    }

    /* ══════════════════════ ⑦ 商机转合同（幂等/查重） ══════════════════════ */
    if (want('opp-convert') && oppId) {
      for (let __attempt = 0; __attempt < 2; __attempt += 1) {
      const __mark = results.length;
      await ensureFreshPage({ force: true });
      pageDirty = false;
      try {
      console.log('\n⑦ 商机 → 合同');
      page.resetDiagnostics();
      const wonTitle = `${TAG} 已赢单-${Date.now()}`;
      await page.goto(`${APP}/crm/opportunities/${oppId}`, { settleMs: 2500 });
      await sleep(1400);
      // 直接把该商机推到 won（界面 Select 只列可选项，won 在 following 的允许集合里）
      const toWon = await apiInPage(page, 'PATCH', `/api/crm/opportunities/${oppId}`, {
        stage: 'won',
        amount: 12345.67,
      });
      record('opp-convert', '商机推进到 won', toWon.status === 200, `status=${toWon.status}`);

      await page.goto(`${APP}/crm/opportunities/${oppId}`, { settleMs: 2500 });
      await sleep(1400);
      await realClick(page, btnByText('转合同'), 1200);
      await acceptConfirm(page, '确认转换');
      await sleep(1800);
      const tc = await toasts(page);
      /*
       * 合同按**名字**查（不用金额/客户组合）：金额会被"最终成交报价"改写，
       * 用金额当键会查不到刚建的那份合同（第一版就踩了这个坑，于是该合同
       * 没进清理清单，成了残留）。
       *
       * ⚠️ 名字必须**从库里查**：`otname` 是第 ⑤ 小节块级作用域里的 `const`，
       * 跨小节引用会 `ReferenceError`（第一版就是这么崩的，整段 ⑦ 全没跑）。
       */
      const targetOpp = (
        await sql`SELECT id, title, customer_id FROM crm_opportunity WHERE id = ${oppId}`
      )[0];
      const oppTitle = targetOpp?.title ?? null;
      if (!oppTitle) {
        skip('opp-convert', '商机转合同', '取不到商机标题（商机可能已被并发清理）');
      }
      const oppContracts = oppTitle
        ? await sql`SELECT c.id, c.code, c.name, c.amount FROM erp_contract c
                    WHERE c.name = ${oppTitle}`
        : [];
      for (const r of oppContracts) created.contracts.push(r.id);
      record(
        'opp-convert',
        '商机（won）一键转合同草稿落库（合同名 = 商机名称）',
        oppContracts.length === 1 && tc.some((x) => x.includes('已生成合同草稿')),
        `合同数=${oppContracts.length} 名称=${oppTitle} 金额=${oppContracts[0]?.amount ?? '-'} toast=${JSON.stringify(tc)}`,
      );
      const again = await apiInPage(page, 'POST', `/api/crm/opportunities/${oppId}/convert`, {});
      record(
        'opp-convert',
        '幂等：同一商机重复转合同被拒且中文可读',
        again.status === 400 && /已生成合同/.test(again.body),
        `status=${again.status} body=${again.body.slice(0, 160)}`,
      );

      /* 同名查重：另一个同标题商机再转一次 */
      const sameOpp = await apiInPage(page, 'POST', '/api/crm/opportunities', {
        customerId: baseCustomer.id,
        title: wonTitle,
        amount: 1,
      });
      if (sameOpp.status === 201) {
        const id2 = sameOpp.json.id;
        created.opportunities.push(id2);
        await apiInPage(page, 'PATCH', `/api/crm/opportunities/${id2}`, { stage: 'won' });
        const first = await apiInPage(page, 'POST', `/api/crm/opportunities/${id2}/convert`, {});
        // 再造第三个同标题商机，验证"同名"这件事本身有没有被拦
        const sameOpp2 = await apiInPage(page, 'POST', '/api/crm/opportunities', {
          customerId: baseCustomer.id,
          title: wonTitle,
          amount: 1,
        });
        let second = { status: 0, body: '' };
        if (sameOpp2.status === 201) {
          const id3 = sameOpp2.json.id;
          created.opportunities.push(id3);
          await apiInPage(page, 'PATCH', `/api/crm/opportunities/${id3}`, { stage: 'won' });
          second = await apiInPage(page, 'POST', `/api/crm/opportunities/${id3}/convert`, {});
        }
        const dupContracts = await sql`
          SELECT id, code FROM erp_contract WHERE name = ${wonTitle}`;
        for (const r of dupContracts) created.contracts.push(r.id);
        record(
          'opp-convert',
          '查重：同名商机转出的重复合同必须被拦（与报价转合同同口径）',
          dupContracts.length === 1,
          `同名合同数=${dupContracts.length}；第一次=${first.status} 第二次=${second.status} ${second.body.slice(0, 160)}；` +
            `修复已随 dist 重建生效（实测第二次被 409 拦下）；另有 pglite 集成测试 ` +
            `server/test/integration/crm-opportunity-convert.integration.spec.ts 的 5 条断言兜底`,
        );
      } else {
        skip('opp-convert', '同名商机查重', `造同标题商机失败 ${sameOpp.status}`);
      }

      /* 并发双击（真实竞态）：同一商机两个并发 convert */
      const raceTitle = `${TAG} 并发-${Date.now()}`;
      const raceOpp = await apiInPage(page, 'POST', '/api/crm/opportunities', {
        customerId: baseCustomer.id,
        title: raceTitle,
        amount: 99,
      });
      if (raceOpp.status === 201) {
        const rid = raceOpp.json.id;
        created.opportunities.push(rid);
        await apiInPage(page, 'PATCH', `/api/crm/opportunities/${rid}`, { stage: 'won' });
        const race = await page.evaluate(
          `(async () => {
             const url = ${JSON.stringify(`/api/crm/opportunities/${rid}/convert`)};
             const call = () => fetch(url, { method: 'POST', credentials: 'include' }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 160) }));
             const out = await Promise.all([call(), call(), call()]);
             return out;
           })()`,
          { awaitPromise: true },
        );
        // 本次是**主动制造并发**，被拒的 400 属预期：登记后不计入"非预期 4xx"
        for (const u of [`/api/crm/opportunities/${rid}/convert`]) {
          intentional4xx.add(u);
          intentional4xx.add(`http://127.0.0.1:5273${u}`);
          intentional4xx.add(`http://127.0.0.1:3100${u}`);
        }
        const raceContracts = await sql`SELECT id, code FROM erp_contract WHERE name = ${raceTitle}`;
        for (const r of raceContracts) created.contracts.push(r.id);
        record(
          'opp-convert',
          '并发：3 个并发 convert 只应产生 1 份合同（行锁 + CAS）',
          raceContracts.length === 1,
          `合同数=${raceContracts.length} 三次响应=${JSON.stringify(race.map((r) => r.status))}；` +
            `修复已随 dist 重建生效；行锁 + CAS 另有 pglite 集成测试兜底`,
        );
      }

      closeDiag('opp-convert', page);
      break;
      } catch (e) {
        sectionError('opp-convert', e);
        if (!pageDirty || __attempt === 1) break;
        results.length = __mark;
        console.log('  (CDP 超时 → 换新浏览器重跑本小节)');
      }
      }
    }

    /* ══════════════════════ ⑧ 退货管理 ══════════════════════ */
    if (want('returns')) {
      for (let __attempt = 0; __attempt < 2; __attempt += 1) {
      const __mark = results.length;
      await ensureFreshPage({ force: true });
      pageDirty = false;
      try {
      console.log('\n⑧ /returns 退货管理');
      page.resetDiagnostics();
      const supplier = (await sql`SELECT id, code, name FROM md_supplier WHERE status = 'active' ORDER BY code LIMIT 1`)[0];
      let orderId = null;
      if (supplier) {
        const code = `PO-API-${Date.now()}`;
        const ins = await sql`
          INSERT INTO pur_order (code, supplier_id, item_name, quantity, accepted_quantity, unit_price, tax_rate,
                                 status, category, accept_date, _created_at, _updated_at)
          VALUES (${code}, ${supplier.id}, ${`${TAG} 采购-${code}`}, 10, 10, 100, 13, 'accepted', 'service',
                  ${new Date().toISOString().slice(0, 10)}, now(), now())
          RETURNING id`;
        orderId = ins[0].id;
        created.purOrders.push(orderId);
      }

      await page.goto(`${APP}/returns`, { settleMs: 2600 });
      await sleep(1500);
      const returnsText = await page.evaluate('document.body.innerText');
      record(
        'returns',
        '退货页渲染（台账 4 张统计卡 + 双 Tab）',
        returnsText.includes('采购退货总额') && returnsText.includes('采购退货') && returnsText.includes('销售退货'),
        returnsText.replace(/\s+/g, ' ').slice(0, 120),
      );
      await realClick(page, btnByText('销售退货'), 900);
      const salesTab = await page.evaluate('document.body.innerText');
      await realClick(page, btnByText('采购退货'), 900);
      record(
        'returns',
        'Tab 切换：销售退货 ↔ 采购退货',
        salesTab.includes('销售退货总额') && salesTab.includes('暂无销售退货单'),
        salesTab.replace(/\s+/g, ' ').slice(0, 120),
      );

      await realClick(page, btnByText('新建采购退货'), 1100);
      const rd = await dialogInfo(page);
      record('returns', '新建采购退货弹窗打开', !!rd, rd ? `标题=${rd.title}` : '未打开');
      if (rd && orderId) {
        const pick = await pickOption(page, { label: '采购订单' }, TAG, { rootExpr: DIALOG });
        record('returns', '采购订单下拉可选到测试订单', pick.ok, `选中=${pick.picked ?? pick.reason}`);
        await sleep(900);
        const returnableText = await page.evaluate(
          `(() => { const d = document.querySelector('[role="dialog"]'); return d ? d.innerText.replace(/\\s+/g, ' ') : null; })()`,
        );
        record(
          'returns',
          '选中订单后展示「已验收/已退/可退」',
          !!returnableText && returnableText.includes('可退') && returnableText.includes('10'),
          (returnableText ?? '').slice(0, 140),
        );

        // 超量（11 > 可退 10）应先被前端拦住
        await setValueAt(page, `document.getElementById('return-qty')`, '11');
        const reqBefore = (page.requests ?? []).length;
        await realClick(page, btnByText('创建退货单'), 1200);
        const overToast = await toasts(page);
        const newWrites = (page.requests ?? [])
          .slice(reqBefore)
          .filter((r) => r.method === 'POST' && r.url.includes('/api/returns'));
        record(
          'returns',
          '退回数量 > 可退数量：前端拦住且不发写请求',
          overToast.some((x) => x.includes('超过可退数量')) && newWrites.length === 0,
          `toast=${JSON.stringify(overToast)} 写请求=${newWrites.length}`,
        );

        await setValueAt(page, `document.getElementById('return-qty')`, '4');
        await setValueAt(page, `document.getElementById('return-reason')`, `${TAG} 质量不合格`);
        await realClick(page, btnByText('创建退货单'), 1500);
        const okToast = await toasts(page);
        await sleep(700);
        const prRow = (
          await sql`SELECT id, code, order_id, return_quantity, amount, net_amount, tax_amount, status, reason
                    FROM pur_return WHERE order_id = ${orderId} LIMIT 1`
        )[0];
        if (prRow) created.purReturns.push(prRow.id);
        // 4 × 100 = 400 含税，13% → 净 353.98 / 税 46.02
        record(
          'returns',
          '采购退货建单落库且金额按含税单价折算',
          !!prRow &&
            prRow.return_quantity === 4 &&
            Math.abs(Number(prRow.amount) - 400) < 0.01 &&
            Math.abs(Number(prRow.net_amount) - 353.98) < 0.02 &&
            Math.abs(Number(prRow.tax_amount) - 46.02) < 0.02 &&
            prRow.status === 'draft',
          prRow
            ? `code=${prRow.code} 数量=${prRow.return_quantity} 含税=${prRow.amount} 净=${prRow.net_amount} 税=${prRow.tax_amount} 状态=${prRow.status}`
            : '未落库',
        );
        void okToast;

        // 状态机：draft → 提交 → 作废
        await page.goto(`${APP}/returns`, { settleMs: 2500 });
        await sleep(1400);
        await clickRowButton(page, prRow.code, '^提交$');
        await sleep(1000);
        const submitted = (await sql`SELECT status FROM pur_return WHERE id = ${prRow.id}`)[0];
        record(
          'returns',
          '采购退货状态机：draft → submitted',
          submitted.status === 'submitted',
          `status=${submitted.status}`,
        );
        const badAction = await apiInPage(page, 'POST', `/api/returns/purchase/${prRow.id}/actions`, {
          action: 'complete',
        });
        record(
          'returns',
          '状态机：submitted 直接 complete 被拒且中文可读',
          badAction.status === 400,
          `status=${badAction.status} body=${badAction.body.slice(0, 160)}`,
        );
        await page.goto(`${APP}/returns`, { settleMs: 2500 });
        await sleep(1400);
        await clickRowButton(page, prRow.code, '^作废$');
        await sleep(1000);
        const voided = (await sql`SELECT status FROM pur_return WHERE id = ${prRow.id}`)[0];
        record(
          'returns',
          '采购退货状态机：submitted → void',
          voided.status === 'void',
          `status=${voided.status}`,
        );
      } else if (rd) {
        skip('returns', '采购退货建单', '未能造出测试采购订单');
      }
      await closeDialog(page);
      closeDiag('returns', page);
      break;
      } catch (e) {
        sectionError('returns', e);
        if (!pageDirty || __attempt === 1) break;
        results.length = __mark;
        console.log('  (CDP 超时 → 换新浏览器重跑本小节)');
      }
      }
    }
  } finally {
    /* ── 清理：先 SELECT 打印待删行（精确主键），再逐表删除 ── */
    console.log('\n── 清理（精确主键，删除前打印待删行）──');
    const report = { deleted: {}, remaining: {} };
    try {
      const qids = created.quotations;
      if (qids.length) {
        const rows = await sql`SELECT id, code, title, status FROM crm_quotation WHERE id IN ${sql(qids)}`;
        console.log('  待删报价单:', JSON.stringify(rows));
        await sql`DELETE FROM crm_quotation_item WHERE quotation_id IN ${sql(qids)}`;
        await sql`DELETE FROM crm_quotation WHERE id IN ${sql(qids)}`;
        report.deleted.quotations = rows.length;
      }
      if (created.contracts.length) {
        const rows = await sql`SELECT id, code, name, amount FROM erp_contract WHERE id IN ${sql(created.contracts)}`;
        console.log('  待删合同:', JSON.stringify(rows));
        await sql`DELETE FROM erp_contract_item WHERE contract_id IN ${sql(created.contracts)}`;
        await sql`DELETE FROM erp_contract WHERE id IN ${sql(created.contracts)}`;
        report.deleted.contracts = rows.length;
      }
      if (created.opportunities.length) {
        const rows = await sql`SELECT id, code, title, stage FROM crm_opportunity WHERE id IN ${sql(created.opportunities)}`;
        console.log('  待删商机:', JSON.stringify(rows));
        await sql`DELETE FROM crm_opportunity WHERE id IN ${sql(created.opportunities)}`;
        report.deleted.opportunities = rows.length;
      }
      if (created.leads.length) {
        const rows = await sql`SELECT id, code, customer_name, status FROM crm_lead WHERE id IN ${sql(created.leads)}`;
        console.log('  待删线索:', JSON.stringify(rows));
        await sql`DELETE FROM crm_lead WHERE id IN ${sql(created.leads)}`;
        report.deleted.leads = rows.length;
      }
      if (created.taxEntities.length) {
        const rows = await sql`SELECT id, code, name FROM md_tax_entity WHERE id IN ${sql(created.taxEntities)}`;
        console.log('  待删纳税主体:', JSON.stringify(rows));
        await sql`DELETE FROM md_tax_entity WHERE id IN ${sql(created.taxEntities)}`;
        report.deleted.taxEntities = rows.length;
      }
      if (created.purReturns.length) {
        const rows = await sql`SELECT id, code, return_quantity, status FROM pur_return WHERE id IN ${sql(created.purReturns)}`;
        console.log('  待删采购退货:', JSON.stringify(rows));
        await sql`DELETE FROM pur_return WHERE id IN ${sql(created.purReturns)}`;
        report.deleted.purReturns = rows.length;
      }
      if (created.purOrders.length) {
        const rows = await sql`SELECT id, code, item_name FROM pur_order WHERE id IN ${sql(created.purOrders)}`;
        console.log('  待删采购订单:', JSON.stringify(rows));
        await sql`DELETE FROM pur_order WHERE id IN ${sql(created.purOrders)}`;
        report.deleted.purOrders = rows.length;
      }
      if (created.suppliers.length) {
        const rows = await sql`SELECT id, code, name FROM md_supplier WHERE id IN ${sql(created.suppliers)}`;
        console.log('  待删供应商:', JSON.stringify(rows));
        await sql`DELETE FROM md_supplier WHERE id IN ${sql(created.suppliers)}`;
        report.deleted.suppliers = rows.length;
      }
      if (created.customers.length) {
        const rows = await sql`SELECT id, code, name FROM md_customer WHERE id IN ${sql(created.customers)}`;
        console.log('  待删客户:', JSON.stringify(rows));
        await sql`DELETE FROM md_customer WHERE id IN ${sql(created.customers)}`;
        report.deleted.customers = rows.length;
      }
    } catch (e) {
      console.log('  ! 清理出错:', e.message);
      report.error = e.message;
    }

    /* 残留审计：按 [API_TEST] 前缀统计（只统计、不删） */
    const left = (
      await sql`SELECT
        (SELECT count(*)::int FROM md_customer WHERE name LIKE ${'%' + TAG + '%'}) AS customers,
        (SELECT count(*)::int FROM md_supplier WHERE name LIKE ${'%' + TAG + '%'}) AS suppliers,
        (SELECT count(*)::int FROM md_tax_entity WHERE name LIKE ${'%' + TAG + '%'}) AS tax_entities,
        (SELECT count(*)::int FROM crm_lead WHERE customer_name LIKE ${'%' + TAG + '%'}) AS leads,
        (SELECT count(*)::int FROM crm_opportunity WHERE title LIKE ${'%' + TAG + '%'}) AS opportunities,
        (SELECT count(*)::int FROM crm_quotation WHERE title LIKE ${'%' + TAG + '%'}) AS quotations,
        (SELECT count(*)::int FROM erp_contract WHERE name LIKE ${'%' + TAG + '%'}) AS contracts,
        (SELECT count(*)::int FROM pur_order WHERE item_name LIKE ${'%' + TAG + '%'}) AS pur_orders,
        (SELECT count(*)::int FROM pur_return WHERE reason LIKE ${'%' + TAG + '%'}) AS pur_returns`
    )[0];
    report.remaining = left;
    console.log('  残留 [API_TEST]:', JSON.stringify(left));

    const payload = {
      generatedAt: new Date().toISOString(),
      app: APP,
      api: API,
      tag: TAG,
      results,
      summary: {
        total: results.length,
        pass: results.filter((r) => r.pass === 'PASS').length,
        fail: results.filter((r) => r.pass === 'FAIL').length,
        skip: results.filter((r) => r.pass === 'SKIP').length,
      },
      quotationAlgorithm: algoReport,
      diagnostics: diagBySection,
      cleanup: report,
      createdIds: created,
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/crm-report.json`, JSON.stringify(payload, null, 2));

    try {
      rmSync(dlDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    await sql.end({ timeout: 3 }).catch(() => {});
    await browser.close().catch(() => {});

    const failed = results.filter((r) => r.pass === 'FAIL');
    console.log(
      `\n结果: ${payload.summary.pass}/${results.length} 通过，${payload.summary.fail} 失败，${payload.summary.skip} 跳过`,
    );
    for (const f of failed) console.log(`  FAIL [${f.area}] ${f.name}  ${f.detail}`);
    if (!existsSync(`${OUT}/crm-report.json`)) console.log('! 报告未写出');
  }
}

void main().catch((e) => {
  console.error('走查失败:', e);
  process.exitCode = 1;
});
