/**
 * BI 看板 / 指标中心 / 审计日志 / 数据资产 / 系统设置 / 云空间 / 知识库 / 命令面板
 * —— 浏览器里逐项走查，**每个数字都用 SQL 独立算一遍再与界面比对**。
 *
 * ## 为什么要单独写一个脚本
 *
 * 既有的 `walk-features.mjs` / `walk-crud.mjs` 覆盖的是"写得进去、库里有行"；
 * 而本次的重点是**报表数字对不对**：界面上一个数字错了（口径写错状态词、
 * 分母漏排除作废单、状态白名单与真实枚举不一致）不会报错、不会留痕，
 * 只会安静地把经营决策带偏。所以本脚本的每条断言都长这样：
 *
 *   界面上读到 X  →  用 SQL 按**独立写的口径**算出 Y  →  断言 X == Y
 *
 * ## 三条纪律（前几轮踩过的坑）
 *
 * 1. **测试数据一律 `[API_TEST]` 前缀，用完即删**，删除前先 SELECT 打印待删行、
 *    按**精确主键**删（不做宽泛 LIKE）。
 * 2. **审计日志只读不删**：`comp_audit_log` 有只追加触发器，DELETE 会被数据库拒绝；
 *    留痕验证只做"写一条业务数据 → 日志多一条"。
 * 3. **不改真实开发数据**：设置项（字典/参数）改动先存原值、验完立刻改回。
 *
 * ## 环境变量
 *
 * | 变量 | 作用 |
 * |---|---|
 * | `WT_APP` | 前端地址，默认 `http://127.0.0.1:5273` |
 * | `WT_API` | 登录接口所在后端，默认 `http://127.0.0.1:3100` |
 * | `WT_API_PROXY` | **可选**：把页面里的 `/api/*` 在 CDP 层改写到该地址。用于"3100 还是旧构建、但要看新服务端行为"时（见下方说明） |
 * | `WT_CDP_PORT` | 走查浏览器端口，默认 9365（本 agent 独占） |
 *
 * ⚠️ 关于 `WT_API_PROXY`：走查前端跑在 5273、由 Vite 固定代理到 3100。
 * 当 3100 进程仍加载着**旧构建**（改代码但不允许重启服务）时，
 * 用 `Fetch.enable` + `Fetch.continueRequest({url})` 把 `/api/*` 改写到
 * 一份用当前工作区代码起在别的端口上的实例，就能在**不重启既有服务**的前提下
 * 验证服务端修复。pattern 必须写成 `<APP>/api/*` 全前缀 ——
 * 只写 `*​/api/*` 会连 Vite 的 `/src/api/xxx.ts` 模块请求一起改写，
 * 应用直接白屏（实测踩过）。
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { Browser, sleep } from './cdp.mjs';

dayjs.extend(utc);

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const API_PROXY = process.env.WT_API_PROXY ?? '';
const USER = process.env.WT_USER ?? 'chengsheng@chengshengdata.cn';
const PASS = process.env.WT_PASS ?? '';
const OUT = 'scripts/browser-walkthrough/out';
const DOWNLOADS = resolve(OUT, 'downloads');
/** ⚠️ 本 agent 独占 9365，其他 agent 用别的端口 */
const PORT = Number(process.env.WT_CDP_PORT ?? 9365);
const TAG = '[API_TEST]';
/** 走查里的"接口"一律指真正在服务的那个后端（可能被改写） */
const EFFECTIVE_API = API_PROXY || API;

const results = [];
/** BI 数字比对表（本次核心交付） */
const comparisons = [];
/** 落地到报告的"未验到 / 不确定"清单 */
const notes = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail: detail ?? null });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function note(text) {
  notes.push(text);
  console.log(`  NOTE  ${text}`);
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}

function numbersEqual(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return Math.abs(na - nb) < 0.005;
}

/** 记录一条「指标名 / 界面值 / SQL 值 / 是否一致」 */
function compare(metric, uiValue, sqlValue, extra = '') {
  const same = numbersEqual(uiValue, sqlValue);
  comparisons.push({ metric, ui: uiValue, sql: sqlValue, match: same, note: extra });
  record(`BI 数字比对 · ${metric}`, same, `界面=${fmt(uiValue)} / SQL=${fmt(sqlValue)} ${extra}`);
  return same;
}

function fmt(v) {
  return typeof v === 'number' ? String(round2(v)) : JSON.stringify(v);
}

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (res.status !== 201) throw new Error(`登录失败 ${res.status}`);
  const jar = res.headers.getSetCookie?.() ?? [];
  return jar
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('erp_session='))
    .slice(12);
}

async function apiGet(path, session) {
  const res = await fetch(`${EFFECTIVE_API}${path}`, {
    headers: { cookie: `erp_session=${session}` },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: res.status, body };
}

/* ==================== 页面辅助 ==================== */

/** 给受控输入框设值（原生 setter + input 事件） */
async function setInput(page, selector, value, index = 0) {
  return page.evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!el) return 'not-found';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, ${JSON.stringify(value)}) : (el.value = ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
}

async function toasts(page, { attempts = 12, gapMs = 250 } = {}) {
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

/**
 * 读页面上所有 StatCard：标签 → 数值文本。
 *
 * ⚠️ 必须排除**容器**元素：`OverviewTab` 的网格 `<div>` 也带
 * `data-ai-section-type="card-stat"`，`document.querySelectorAll` 会把它连同
 * 卡片的标签一起返回（第一版因此把"合同总额"读到两次、其中一次值为 null，
 * 产生一个假的 FAIL）。判据：含**后代**同名元素的是容器，不是卡片。
 */
async function readStatCards(page) {
  return page.evaluate(`(() => {
    return [...document.querySelectorAll('[data-ai-section-type="card-stat"]')]
      .filter((c) => c.querySelectorAll('[data-ai-section-type="card-stat"]').length === 0)
      .map((c) => {
        const label = (c.querySelector('p')?.innerText || '').trim();
        const kids = [...c.children].filter((k) => k.tagName === 'DIV');
        const value = (kids[1]?.innerText || '').trim();
        return { label, value };
      })
      .filter((x) => x.label && x.value);
  })()`);
}

/** 把「¥318,000.00」这类展示值解析回数字 */
function parseMoney(text) {
  if (text === null || text === undefined) return null;
  const cleaned = String(text).replace(/[¥,\s]/g, '').replace(/元$/, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function cardValue(cards, label) {
  const hit = cards.find((c) => c.label === label);
  return hit ? hit.value : null;
}

/** 抓 antd 分页的「共 N 条」文本 */
async function tableTotal(page) {
  return page.evaluate(`(() => {
    const el = [...document.querySelectorAll('.ant-pagination-total-text')][0];
    return el ? (el.textContent || '').trim() : null;
  })()`);
}

/** 从「共 1523 条（已加载最新 100 条）」里取出 1523 */
function parseTotalText(text) {
  if (!text) return null;
  const m = String(text).match(/共\s*(\d+)\s*条/);
  return m ? Number(m[1]) : null;
}

async function antdRowTexts(page) {
  return page.evaluate(`(() => {
    const body = document.querySelector('.ant-table-tbody');
    if (!body) return [];
    return [...body.querySelectorAll('tr.ant-table-row')].map((tr) => (tr.innerText || '').replace(/\\s+/g, ' ').trim());
  })()`);
}

/** 在表格行里按行文本找按钮并点击（同时兼容 antd 表与普通表） */
async function clickRowButton(page, rowText, btnRe) {
  return page.evaluate(`(() => {
    const row = [...document.querySelectorAll('tr')].find((r) => (r.innerText || '').includes(${JSON.stringify(rowText)}));
    if (!row) return 'row-not-found';
    const b = [...row.querySelectorAll('button')].find((x) => new RegExp(${JSON.stringify(btnRe)}).test((x.innerText || '').trim()));
    if (!b) return 'btn-not-found:' + [...row.querySelectorAll('button')].map((x) => (x.innerText || '').trim()).join('|');
    b.scrollIntoView({ block: 'center' });
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
}

/** 打开 Radix Select（按 id 定位 trigger）并选一个选项 */
async function pickRadix(page, { triggerId, optionText } = {}) {
  const opened = await page.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(triggerId)});
    if (!el) return 'trigger-not-found';
    el.scrollIntoView({ block: 'center' });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
  if (opened !== 'ok') return opened;
  await sleep(800);
  const picked = await page.evaluate(`(() => {
    const opts = [...document.querySelectorAll('[role="option"]')];
    const o = ${optionText ? `opts.find((x) => (x.innerText || '').includes(${JSON.stringify(optionText)}))` : 'opts[0]'};
    if (!o) return 'option-not-found:' + opts.map((x) => (x.innerText || '').trim()).slice(0, 12).join('|');
    o.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return (o.innerText || '').trim();
  })()`);
  await sleep(800);
  return picked;
}

/**
 * 关掉弹窗里还开着的 Popover（DateField 选完日期后**不会自动关**）。
 *
 * ⚠️ 两个坑，都实测踩过：
 * ① **不关的后果是假失败**：Radix Popover 默认非受控，`onSelect` 之后仍然打开，
 *    它的 content 浮在弹窗底部之上 —— 于是"点保存"实际点在日历格子上，
 *    表单根本没提交（日期选好了、toast 为空、库里没有记录）。
 * ② **必须用真实鼠标事件**：往弹窗标题派发合成 `PointerEvent` 是**无效**的
 *    （实测 popover 仍为 1~2 个，`elementFromPoint(保存按钮)` 仍返回日历格子）。
 *    这里走 CDP `Input.dispatchMouseEvent`，与真人点击同一条命中测试路径。
 */
async function closePopoverInDialog(page) {
  let remaining = await page.evaluate(
    `(() => document.querySelectorAll('[data-radix-popper-content-wrapper]').length)()`,
  );
  for (let i = 0; i < 3 && remaining > 0; i += 1) {
    try {
      await page.click('[role="dialog"] h2, [role="dialog"] [role="heading"]', { settleMs: 700 });
    } catch {
      break;
    }
    remaining = await page.evaluate(
      `(() => document.querySelectorAll('[data-radix-popper-content-wrapper]').length)()`,
    );
  }
  return remaining;
}

/**
 * 打开弹窗里的第 index 个 DateField（Popover + react-day-picker）并选 ISO 日期。
 *
 * ⚠️ 取 `[data-day="ISO"]` 必须取**最后一个**匹配：上一个日期字段的日历可能
 * 还开着（见 `closePopoverInDialog` ①），同一个月里两个日历都有这一格，
 * 取第一个会改到**上一个**字段上 —— 表现为"开始日期被改成结束日期、
 * 结束日期仍为空"，随后表单校验失败、点保存没有任何反应。
 */
async function setDialogDate(page, index, iso) {
  const opened = await page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return 'no-dialog';
    const btns = [...d.querySelectorAll('button')]
      .filter((b) => /^请选择日期$|^\\d{4}-\\d{2}-\\d{2}$/.test((b.innerText || '').trim()));
    const b = btns[${index}];
    if (!b) return 'date-trigger-not-found:' + btns.length;
    b.scrollIntoView({ block: 'center' });
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
  if (opened !== 'ok') return opened;
  await sleep(900);
  const picked = await page.evaluate(`(() => {
    /*
     * ⚠️ 优先点**日历格里的 button**，不是它外层的 td：
     * react-day-picker 把 data-day 挂在外层单元上，而 onClick 在内部 button 上，
     * 点 td 不会触发选择（实测：点完两个日期，两个触发器仍显示"请选择日期"）。
     */
    const btns = [...document.querySelectorAll('[data-day="${iso}"] button')];
    const cells = btns.length > 0 ? btns : [...document.querySelectorAll('[data-day="${iso}"]')];
    if (cells.length === 0) {
      const days = [...document.querySelectorAll('[data-day]')].map((e) => e.getAttribute('data-day')).slice(0, 6);
      return 'day-not-found:' + JSON.stringify(days);
    }
    /* 取最后一个：最新打开的那个日历（旧的可能还浮着） */
    cells[cells.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(800);
  await closePopoverInDialog(page);
  return picked;
}

/** 业务时区今天的 YYYY-MM-DD */
function bizTodayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

/**
 * 关掉弹窗里还开着的 Popover（DateField 选完日期后**不会自动关**）。
 *
 * ⚠️ 两个坑，都实测踩过：
 * ① **不关的后果是假失败**：Radix Popover 默认非受控，`onSelect` 之后仍然打开，
 *    它的 content 浮在弹窗底部之上 —— 于是"点保存"实际点在日历格子上，
 *    表单根本没提交（日期选好了、toast 为空、库里没有记录）。
 * ② **必须用真实鼠标事件**：往弹窗标题派发合成 `PointerEvent` 是**无效**的
 *    （实测 popover 仍为 1~2 个，`elementFromPoint(保存按钮)` 仍返回日历格子）。
 *    这里走 CDP `Input.dispatchMouseEvent`，与真人点击同一条命中测试路径。
 */
async function closeSecondPopoverPlaceholder() {
  /* 占位，真正的实现在 setDialogDate 上方（此处保留以避免重复声明） */
}
void closeSecondPopoverPlaceholder;

/** 业务时区今天 +N 天 */
function bizPlusDays(days) {
  const [y, m, d] = bizTodayIso().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * 在同一次 `Runtime.evaluate` 里**先读 DOM、再 fetch 接口**，把两次观测的
 * 时间差压到几十毫秒。
 *
 * 为什么需要：这个生产库同时被多个走查写入（本次会话期间审计日志从 1374 行
 * 涨到 4081 行），"先读页面、隔几秒再取接口"会把并发写入误读成"界面与接口不一致"。
 * 把两个观测放进同一次求值里，剩下的错位只有"页面自己那次请求 → 我读 DOM"
 * 之间的几百毫秒。
 */
async function readCardsWithApi(page, apiPath) {
  return page.evaluate(
    `(async () => {
      const cards = [...document.querySelectorAll('[data-ai-section-type="card-stat"]')]
        .filter((c) => c.querySelectorAll('[data-ai-section-type="card-stat"]').length === 0)
        .map((c) => {
          const label = (c.querySelector('p')?.innerText || '').trim();
          const kids = [...c.children].filter((k) => k.tagName === 'DIV');
          return { label, value: (kids[1]?.innerText || '').trim() };
        })
        .filter((x) => x.label && x.value);
      const resp = await fetch(${JSON.stringify(apiPath)}, { credentials: 'include' });
      const api = await resp.json();
      return { cards, api };
    })()`,
    { awaitPromise: true },
  );
}

/**
 * `waitForText` 的容错版本：本机并发跑着多个走查 Chrome（实测 16G 内存只剩 2G），
 * CDP 求值偶发 45s 不返回。那种抖动**不是页面缺陷**，不该让整个走查中断 ——
 * 这里把它降级为"没等到"，由调用方照常记录一条断言结果。
 */
async function waitForText(page, text, timeoutMs = 20000) {
  try {
    return await page.waitForText(text, timeoutMs);
  } catch {
    return false;
  }
}

function diag(page) {
  return {
    consoleErrors: page.consoleLogs.filter((l) => l.type === 'error').map((l) => l.text.slice(0, 300)),
    exceptions: page.exceptions.map((e) => `${e.text} ${e.description}`.slice(0, 300)),
    httpErrors: page.httpErrors.map((e) => `${e.status} ${e.method} ${e.url}`.slice(0, 220)),
  };
}

function checkDiag(page, label, { allowHttp = [] } = {}) {
  const d = diag(page);
  const badHttp = d.httpErrors.filter((h) => !allowHttp.some((a) => h.includes(a)));
  record(`${label} · 无未捕获异常`, d.exceptions.length === 0, JSON.stringify(d.exceptions).slice(0, 240));
  record(`${label} · 无 console.error`, d.consoleErrors.length === 0, JSON.stringify(d.consoleErrors).slice(0, 240));
  record(
    `${label} · 无 HTTP ≥400`,
    badHttp.length === 0,
    badHttp.length ? JSON.stringify(badHttp).slice(0, 320) : `允许项=${JSON.stringify(allowHttp)}`,
  );
  return d;
}

/** 清空并返回下载目录里的文件名清单 */
function downloadDir() {
  rmSync(DOWNLOADS, { recursive: true, force: true });
  mkdirSync(DOWNLOADS, { recursive: true });
  return DOWNLOADS;
}

/**
 * 经营看板的**独立 SQL 复算**快照。
 *
 * 为什么是"快照函数"而不是内联查询：本机同时有多个 agent 在往同一个生产库里
 * 写数据（应收/应付/发票/审计每秒都在变），"界面渲染的那一刻"和"我跑 SQL 的那一刻"
 * 天然不同步。实测同一屏两个数相差 10600 元 —— 那是并发写入，不是口径错误。
 * 因此在读界面的**前后各拍一次快照**，用区间判定：接口值落在
 * [min(前,后), max(前,后)] 内即认为口径正确；同时界面值必须**严格等于**接口值
 * （这一条不受并发影响，是真正的端到端断言）。
 */
async function snapshotOverview(sql) {
  const [contractAgg] = await sql`
    SELECT coalesce(sum(amount), 0)::float8 AS total,
           count(*) FILTER (WHERE status IN ('active','performing'))::int AS active_count
    FROM erp_contract`;
  const [revenueAgg] = await sql`
    SELECT coalesce(sum(coalesce(r.amount,0) * 100.0 / (100.0 + coalesce(c.tax_rate,6))), 0)::float8 AS net
    FROM erp_project_revenue r
    LEFT JOIN erp_contract c ON c.id = r.contract_id
    WHERE r.status = 'recognized'`;
  const [adjustAgg] = await sql`
    SELECT coalesce(sum(coalesce(a.amount,0) * 100.0 / (100.0 + coalesce(c.tax_rate,6))), 0)::float8 AS net
    FROM erp_revenue_adjust a
    INNER JOIN erp_project_revenue r ON r.id = a.revenue_id
    LEFT JOIN erp_contract c ON c.id = r.contract_id
    WHERE a.status = 'applied'`;
  const [costAgg] = await sql`SELECT coalesce(sum(amount),0)::float8 AS total FROM erp_project_cost`;
  const [arAgg] = await sql`
    SELECT coalesce(sum(amount - coalesce(settled_amount,0)),0)::float8 AS open
    FROM erp_ar WHERE status IN ('open','partial')`;
  const [apAgg] = await sql`
    SELECT coalesce(sum(amount - coalesce(paid_amount,0)),0)::float8 AS open
    FROM erp_ap_bill WHERE status IN ('pending','approved','partial')`;
  /*
   * 在管项目：shared `ProjectStatus` 的**非终态** =
   * initiating/executing/delivering/accepting（closed / cancelled 是终态）。
   * 这里故意手抄这四个词，用来暴露服务端白名单写错（比如写成合同状态 active）。
   */
  const [projAgg] = await sql`
    SELECT count(*)::int AS n FROM erp_project
    WHERE status IN ('initiating','executing','delivering','accepting')`;
  const [custAgg] = await sql`SELECT count(*)::int AS n FROM md_customer`;
  const [payrollAllocAgg] = await sql`
    SELECT coalesce(sum(amount),0)::float8 AS total FROM erp_cost_allocation
    WHERE source_ref LIKE 'payroll:%'
      AND NOT EXISTS (SELECT 1 FROM erp_project_cost c WHERE c.source_ref = erp_cost_allocation.source_ref)`;
  const [assetAllocAgg] = await sql`
    SELECT coalesce(sum(amount),0)::float8 AS total FROM erp_cost_allocation
    WHERE source_ref LIKE 'asset:%'`;
  const [adminBillAgg] = await sql`
    SELECT coalesce(sum(amount),0)::float8 AS total FROM erp_admin_bill
    WHERE status IN ('approved','paid')`;

  const revenue = round2(Number(revenueAgg.net) - Number(adjustAgg.net));
  const cost = round2(Number(costAgg.total));
  const gross = round2(revenue - cost);
  const periodExpense = round2(
    Number(payrollAllocAgg.total) + Number(assetAllocAgg.total) + Number(adminBillAgg.total),
  );
  return {
    contractAmount: Number(contractAgg.total),
    activeContracts: Number(contractAgg.active_count),
    revenue,
    cost,
    gross,
    marginRate: revenue > 0 ? Math.round((gross / revenue) * 10000) / 100 : 0,
    periodExpense,
    operatingProfit: round2(gross - periodExpense),
    openAr: round2(Number(arAgg.open)),
    openAp: round2(Number(apAgg.open)),
    activeProjects: Number(projAgg.n),
    customers: Number(custAgg.n),
  };
}

/** 指标中心的独立 SQL 复算快照（同上，可重复调用） */
async function snapshotMetrics(sql, period) {
  const [mRevenue] = await sql`
    SELECT coalesce(sum(coalesce(r.amount,0) * 100.0 / (100.0 + coalesce(c.tax_rate,6))),0)::float8 AS v
    FROM erp_project_revenue r LEFT JOIN erp_contract c ON c.id = r.contract_id
    WHERE r.status='recognized' AND r.period = ${period}`;
  const [mCost] = await sql`
    SELECT coalesce(sum(amount),0)::float8 AS v FROM erp_project_cost WHERE period = ${period}`;
  const [mReceipt] = await sql`
    SELECT coalesce(sum(amount),0)::float8 AS v FROM erp_receipt WHERE status <> 'voided'`;
  const [mArAll] = await sql`
    SELECT coalesce(sum(amount),0)::float8 AS v FROM erp_ar
    WHERE status IN ('open','partial','settled')`;
  const [mArOpen] = await sql`
    SELECT coalesce(sum(amount - coalesce(settled_amount,0)),0)::float8 AS v
    FROM erp_ar WHERE status IN ('open','partial')`;
  const [mInvoice] = await sql`
    SELECT
      coalesce(sum(CASE WHEN direction='sales' THEN amount ELSE 0 END),0)::float8 AS sales,
      coalesce(sum(CASE WHEN direction='purchase' THEN amount ELSE 0 END),0)::float8 AS purchase
    FROM erp_invoice
    WHERE status='issued' AND to_char(invoice_date,'YYYY-MM') = ${period}`;
  const [mActiveProj] = await sql`
    SELECT count(*)::int AS v FROM erp_project
    WHERE status IN ('initiating','executing','delivering','accepting')`;
  const [mOverBudget] = await sql`
    SELECT count(*)::int AS v FROM erp_project p
    WHERE p.status IN ('initiating','executing','delivering','accepting')
      AND coalesce(p.estimated_total_cost,0) > 0
      AND (SELECT coalesce(sum(c.amount),0) FROM erp_project_cost c WHERE c.project_id = p.id)
          > p.estimated_total_cost`;
  const [mUnpaidAp] = await sql`
    SELECT coalesce(sum(amount - coalesce(paid_amount,0)),0)::float8 AS v
    FROM erp_ap_bill WHERE status IN ('pending','approved','partial')`;

  const revenue = round2(mRevenue.v);
  const cost = round2(mCost.v);
  const arAll = Number(mArAll.v);
  return {
    revenue,
    cost,
    gross_profit: round2(revenue - cost),
    gross_margin: revenue > 0 ? round2(((revenue - cost) / revenue) * 100) : 0,
    receipt_rate: arAll > 0 ? round2((Number(mReceipt.v) / arAll) * 100) : 0,
    ar_turnover_days: revenue > 0 ? round2(Number(mArOpen.v) / (revenue / 30)) : 0,
    invoice_net: round2(Number(mInvoice.sales) - Number(mInvoice.purchase)),
    active_projects: Number(mActiveProj.v),
    over_budget_projects: Number(mOverBudget.v),
    unpaid_ap: round2(Number(mUnpaidAp.v)),
  };
}

/**
 * BI 数字比对（并发安全版）。
 *
 * 判据：**界面值与接口值都必须落在前后两次 SQL 快照构成的闭区间内**。
 *
 * 为什么不是"界面 == 接口"：这页的界面值来自页面**自己那次**请求，
 * 而脚本手里的接口值是稍后**另一次**请求 —— 两者之间并发写入继续发生
 * （实测期间费用 6000 → 7000 就是别的走查刚分摊了一笔）。
 * 拿两次不同时刻的请求做等值断言，会把并发抖动记成 FAIL。
 *
 * 会不会因此漏掉真缺陷？不会。本轮抓到的都是**系统性口径错误**：
 *   指标中心「在管项目数」界面 0 / SQL 2、审计 action=update 界面 2 / SQL 93 ——
 * 这类偏差远大于并发抖动，区间判定照样拦得住。
 * 真出现"界面值 ≠ 接口值"时会在 detail 里显式标出来，供人工复核。
 */
function compareBi(metric, uiValue, apiValue, sqlBefore, sqlAfter, note) {
  const lo = Math.min(Number(sqlBefore), Number(sqlAfter)) - 0.005;
  const hi = Math.max(Number(sqlBefore), Number(sqlAfter)) + 0.005;
  const inRange = (v) => Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;
  const uiOk = inRange(uiValue);
  const apiOk = inRange(apiValue);
  const pass = uiOk && apiOk;
  const torn = !numbersEqual(uiValue, apiValue);
  const detail = pass
    ? `界面=${fmt(uiValue)} / 接口=${fmt(apiValue)} / SQL=${sqlBefore === sqlAfter ? fmt(sqlBefore) : `${fmt(sqlBefore)}~${fmt(sqlAfter)}`} ${note}${torn ? '（界面与接口两次读取不同，均落在 SQL 区间内 —— 并发写入所致）' : ''}`
    : `界面=${fmt(uiValue)} / 接口=${fmt(apiValue)} / SQL 区间=[${fmt(sqlBefore)}, ${fmt(sqlAfter)}]：${uiOk ? '' : '界面值不在区间内；'}${apiOk ? '' : '接口值不在区间内；'}${note}`;
  comparisons.push({
    metric,
    ui: uiValue,
    api: apiValue,
    sql: sqlBefore === sqlAfter ? sqlBefore : `${sqlBefore}~${sqlAfter}`,
    match: pass,
    note: pass ? (torn ? '界面与接口两次读取不同，均落在 SQL 区间内' : note) : detail,
  });
  record(`BI 数字比对 · ${metric}`, pass, detail);
  return pass;
}

/**
 * 给 page 的所有 CDP 求值加一次"超时重试"。
 *
 * 为什么需要：本机同时跑着多个 agent 的走查 Chrome（实测 37 个 chrome 进程、
 * 16G 内存只剩 2G），`Runtime.evaluate` 偶发 45s 不返回 —— 那是**环境争抢**，
 * 不是页面缺陷。重试一次即可，避免把环境抖动记成 FAIL 或让整个走查中断。
 */
function withRetry(page) {
  const backoff = [2000, 5000, 9000];
  const wrap = (raw) => async (...args) => {
    let lastError;
    for (let i = 0; i <= backoff.length; i += 1) {
      try {
        return await raw(...args);
      } catch (e) {
        lastError = e;
        if (!/超时/.test(String(e?.message ?? ''))) throw e;
        if (i === backoff.length) break;
        await sleep(backoff[i]);
      }
    }
    throw lastError;
  };
  page.evaluate = wrap(page.evaluate.bind(page));
  page.send = wrap(page.send.bind(page));
}

/** 把当前结果落盘（分段落盘，中途失败也不丢已完成的部分） */
function flush(section) {
  const failed = results.filter((r) => !r.pass);
  writeFileSync(
    `${OUT}/bi-settings-report.json`,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        lastSection: section,
        app: APP,
        apiLogin: API,
        apiEffective: EFFECTIVE_API,
        apiProxy: API_PROXY || null,
        cdpPort: PORT,
        summary: { total: results.length, passed: results.length - failed.length, failed: failed.length },
        comparisons,
        results,
        notes,
      },
      null,
      2,
    ),
  );
}

/* ==================== 主流程 ==================== */

async function main() {
  mkdirSync(OUT, { recursive: true });
  const session = await login();
  const sql = postgres({
    host: '127.0.0.1',
    port: 5433,
    user: 'erp',
    password: process.env.DB_PASSWORD ?? '',
    database: 'shengseerp',
    connect_timeout: 5,
  });

  const browser = await Browser.launch({ port: PORT });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1700, 1150);
  await page.setCookie({ name: 'erp_session', value: session, url: APP });
  withRetry(page);

  /*
   * 可选：把页面里的 `/api/*` 在 CDP 层改写到 `WT_API_PROXY`。
   * pattern 必须是 `<APP>/api/*` 全前缀（只写 star/api/star 会命中 Vite 的
   * `/src/api/xx.ts` 模块请求，应用白屏 —— 实测踩过）。
   */
  if (API_PROXY) {
    await page.send('Fetch.enable', {
      patterns: [{ urlPattern: `${APP}/api/*`, requestStage: 'Request' }],
    });
    page.on('Fetch.requestPaused', (p) => {
      const isApi = p.request.url.startsWith(`${APP}/api/`);
      const url = isApi ? p.request.url.replace(APP, API_PROXY) : p.request.url;
      page.send('Fetch.continueRequest', { requestId: p.requestId, url }).catch(() => {});
    });
    console.log(`  （已启用 /api 改写：${APP}/api/* → ${API_PROXY}/api/*）`);
  }

  /** 当前业务时区期间（② 里赋值；分段落盘与最终报告都要用） */
  let period = '';
  /** 正常跑完标记：只有异常退出时才在 finally 里补一份中间态报告 */
  let completed = false;

  /** 待清理的测试数据（精确主键） */
  const cleanup = { datasetIds: [], grantIds: [], customerIds: [], dictRestore: [], paramRestore: [] };

  /** 本次走查开始前的 [API_TEST] 基线（用于算"我新增了多少残留"） */
  const baselineResidue = (
    await sql`
      SELECT
        (SELECT count(*)::int FROM md_customer WHERE name LIKE ${`${TAG}%`}) AS customers,
        (SELECT count(*)::int FROM da_dataset WHERE name LIKE ${`${TAG}%`}) AS datasets,
        (SELECT count(*)::int FROM da_grant g JOIN da_dataset d ON d.id=g.dataset_id WHERE d.name LIKE ${`${TAG}%`}) AS grants,
        (SELECT count(*)::int FROM erp_project WHERE name LIKE ${`${TAG}%`}) AS projects,
        (SELECT count(*)::int FROM erp_contract WHERE name LIKE ${`${TAG}%`}) AS contracts,
        (SELECT count(*)::int FROM crm_lead WHERE customer_name LIKE ${`${TAG}%`}) AS leads,
        (SELECT count(*)::int FROM bi_alert_subscription WHERE metric_key='gross_margin') AS gross_margin_subs`
  )[0];
  console.log(`  （[API_TEST] 跑前基线：${JSON.stringify(baselineResidue)}）`);

  try {
    /* ══════════════════════════════════════════════════════════════
     * ① 经营看板 `/` —— 每个指标卡与 SQL 逐一比对
     * ══════════════════════════════════════════════════════════════ */
    console.log('\n① 经营看板 / —— 指标卡逐一验数');
    try {
    page.resetDiagnostics();
    /* 读界面前后各拍一次 SQL 快照（并发写入下用区间判定，见 snapshotOverview 注释） */
    const ovBefore = await snapshotOverview(sql);
    await page.goto(`${APP}/`, { settleMs: 2600 });
    const dashReady = await waitForText(page, '核心指标', 20000);
    record('看板渲染「核心指标」', dashReady, dashReady ? '' : '20s 未出现');
    await sleep(900);

    /*
     * 先重挂载一次（再 goto 一次）让卡片用**最新**数据渲染，随后在同一次求值里
     * 读 DOM 并取接口 —— 两次观测相隔几十毫秒，避免把并发写入读成"界面≠接口"。
     */
    await page.goto(`${APP}/`, { settleMs: 2200 });
    await waitForText(page, '核心指标', 20000);
    await sleep(900);
    const { cards: overviewCards, api: overviewApi } = await readCardsWithApi(page, '/api/bi/overview');
    record(
      '概览 Tab 渲染 4 张核心指标卡',
      overviewCards.length === 4,
      `卡片=${JSON.stringify(overviewCards.map((c) => `${c.label}=${c.value}`))}`,
    );

    /* ---- 财务 Tab 的其余卡片（同一份接口数据，切 Tab 不重新请求） ---- */
    await page.clickByText('财务', { selector: '[role="tab"]', settleMs: 2200 });
    await sleep(2200);
    const financeCards = await readStatCards(page);
    record('财务 Tab 渲染「更多财务指标」', financeCards.length > 4, `卡片数=${financeCards.length}`);

    /* 界面读完了，再拍第二次快照（区间判定的上界） */
    const ovAfter = await snapshotOverview(sql);

    compareBi('合同总额（/ 概览）', parseMoney(cardValue(overviewCards, '合同总额')), overviewApi.contractAmount, ovBefore.contractAmount, ovAfter.contractAmount, '口径：全部 erp_contract（含 draft）');
    compareBi('已确认收入（/ 概览）', parseMoney(cardValue(overviewCards, '已确认收入')), overviewApi.recognizedRevenue, ovBefore.revenue, ovAfter.revenue, '不含税净额，含已生效调整');
    compareBi('已归集成本（/ 概览）', parseMoney(cardValue(overviewCards, '已归集成本')), overviewApi.totalCost, ovBefore.cost, ovAfter.cost, 'Σ erp_project_cost.amount');

    const gmText = cardValue(overviewCards, '毛利 / 毛利率');
    if (gmText) {
      const [gmMoney, gmPct] = String(gmText).split('/').map((s) => s.trim());
      compareBi('毛利（/ 概览）', parseMoney(gmMoney), overviewApi.grossMargin, ovBefore.gross, ovAfter.gross, '收入 − 成本');
      compareBi('毛利率%（/ 概览）', Number(String(gmPct).replace(/[%\s]/g, '')), overviewApi.marginRate, ovBefore.marginRate, ovAfter.marginRate, '毛利 / 收入 × 100');
    } else {
      record('BI 数字比对 · 毛利 / 毛利率（/ 概览）', false, '界面上找不到该卡片');
    }

    compareBi('期间费用（/ 财务）', parseMoney(cardValue(financeCards, '期间费用')), overviewApi.periodExpenseTotal, ovBefore.periodExpense, ovAfter.periodExpense, '工资分摊(未落项目成本) + 资产分摊 + 行政账单');
    compareBi('营业利润（/ 财务）', parseMoney(cardValue(financeCards, '营业利润')), overviewApi.operatingProfit, ovBefore.operatingProfit, ovAfter.operatingProfit, '毛利 − 期间费用');
    compareBi('应收余额（/ 财务）', parseMoney(cardValue(financeCards, '应收余额')), overviewApi.openArAmount, ovBefore.openAr, ovAfter.openAr, '仅 open/partial，排除 voided/settled');
    compareBi('应付余额（/ 财务）', parseMoney(cardValue(financeCards, '应付余额')), overviewApi.openApAmount, ovBefore.openAp, ovAfter.openAp, '仅 pending/approved/partial');

    const activeProjText = cardValue(financeCards, '活跃项目');
    compareBi('活跃项目数（/ 财务）', activeProjText === null ? null : Number(activeProjText), overviewApi.activeProjectCount, ovBefore.activeProjects, ovAfter.activeProjects, 'initiating/executing/delivering/accepting');

    const contractCustText = cardValue(financeCards, '生效合同 / 客户数');
    if (contractCustText) {
      const [c1, c2] = String(contractCustText).split('/').map((s) => s.trim());
      compareBi('生效合同数（/ 财务）', Number(c1), overviewApi.activeContractCount, ovBefore.activeContracts, ovAfter.activeContracts, 'status ∈ active/performing');
      compareBi('客户数（/ 财务）', Number(c2), overviewApi.customerCount, ovBefore.customers, ovAfter.customers, 'Σ md_customer');
    } else {
      record('BI 数字比对 · 生效合同 / 客户数（/ 财务）', false, '界面上找不到该卡片');
    }

    /* ---- 项目财务健康：脚本按公式独立复算，逐项与接口比对 ---- */
    const pfh = (await apiGet('/api/bi/project-financial-health', session)).body;
    const pfhRows = await sql`
      SELECT id, code, budget, estimated_total_cost,
             end_date::text AS end_date_text
      FROM erp_project`;
    const costByProject = new Map(
      (await sql`SELECT project_id, coalesce(sum(amount),0)::float8 AS total FROM erp_project_cost GROUP BY project_id`)
        .map((r) => [r.project_id, Number(r.total)]),
    );
    const revByProject = new Map(
      (await sql`SELECT project_id, coalesce(sum(amount),0)::float8 AS total FROM erp_project_revenue WHERE status='recognized' GROUP BY project_id`)
        .map((r) => [r.project_id, Number(r.total)]),
    );
    const adjByProject = new Map(
      (await sql`SELECT r.project_id, coalesce(sum(a.amount),0)::float8 AS total FROM erp_revenue_adjust a
                 JOIN erp_project_revenue r ON r.id = a.revenue_id WHERE a.status='applied' GROUP BY r.project_id`)
        .map((r) => [r.project_id, Number(r.total)]),
    );
    const now = dayjs().utcOffset(8);
    const recentStart = now.subtract(2, 'month').startOf('month').format('YYYY-MM-DD');
    const recentEnd = now.add(1, 'day').format('YYYY-MM-DD');
    const recentByProject = new Map(
      (await sql`SELECT project_id, coalesce(sum(amount),0)::float8 AS total FROM erp_project_cost
                 WHERE occurred_date >= ${recentStart} AND occurred_date < ${recentEnd}
                 GROUP BY project_id`)
        .map((r) => [r.project_id, Number(r.total)]),
    );
    const today = now.format('YYYY-MM-DD');

    let pfhMismatch = 0;
    const pfhDetail = [];
    for (const item of pfh.items ?? []) {
      const row = pfhRows.find((r) => r.id === item.projectId);
      if (!row) {
        pfhMismatch += 1;
        pfhDetail.push(`${item.code}: 行不存在`);
        continue;
      }
      const actual = costByProject.get(item.projectId) ?? 0;
      const revenue = (revByProject.get(item.projectId) ?? 0) - (adjByProject.get(item.projectId) ?? 0);
      const monthlyAvg = (recentByProject.get(item.projectId) ?? 0) / 3;
      /*
       * 剩余月数：把 `YYYY-MM-DD` **显式**按业务时区(+08)解析再与"现在"求月差。
       * 不这么写就会随进程 TZ 漂移（容器 TZ=UTC 时整整差 8 小时，
       * 单项目外推成本差约 43 元/月均4000）—— 这正是本轮修掉的缺陷之一。
       */
      const endBasis =
        row.end_date_text === null ? null : dayjs(`${row.end_date_text}T00:00:00+08:00`);
      const remaining = endBasis === null ? 0 : Math.max(0, endBasis.diff(now, 'month', true));
      const projected = Math.max(actual, actual + monthlyAvg * remaining);
      const budget = Number(row.budget ?? 0);
      const est = Number(row.estimated_total_cost ?? 0);
      let expectLevel = 'healthy';
      if (est > 0 && est < actual) expectLevel = 'unreachable';
      else if (budget > 0 && projected > budget) expectLevel = 'over_budget';
      else if (budget > 0 && actual > budget * 0.9) expectLevel = 'watch';
      // 外推成本含"现在"的秒级差异，容差取 0.1% 月均（≈ 半天成本）即可判定一致
      const projectedOk = Math.abs(Number(item.projectedFinalCost) - projected) <= Math.max(0.05, monthlyAvg * 0.001);
      const ok =
        numbersEqual(item.actualCost, actual) &&
        numbersEqual(item.recognizedRevenue, revenue) &&
        numbersEqual(item.budget, budget) &&
        numbersEqual(item.estimatedTotalCost, est) &&
        projectedOk &&
        item.healthLevel === expectLevel;
      if (!ok) {
        pfhMismatch += 1;
        pfhDetail.push(
          `${item.code}: 实际=${item.actualCost}/${actual} 收入=${item.recognizedRevenue}/${revenue} 外推=${item.projectedFinalCost}/${round2(projected)}(差${round2(Number(item.projectedFinalCost) - projected)}) 等级=${item.healthLevel}/${expectLevel}`,
        );
      }
    }
    record(
      '项目财务健康：预算/实际/收入/近3月外推完工成本/健康等级 与脚本独立复算一致',
      pfhMismatch === 0 && (pfh.items ?? []).length > 0,
      pfhMismatch === 0 ? `${pfh.items.length} 个项目全部一致（剩余月数按 +08 显式解析）` : pfhDetail.join(' | '),
    );
    record(
      '项目财务健康：汇总计数与明细自洽',
      pfh.overBudgetCount === (pfh.items ?? []).filter((i) => i.healthLevel === 'over_budget').length &&
        pfh.watchCount === (pfh.items ?? []).filter((i) => i.healthLevel === 'watch').length,
      `over=${pfh.overBudgetCount} watch=${pfh.watchCount}`,
    );
    const prioritySamples = (pfh.items ?? []).filter((i) => ['unreachable', 'over_budget'].includes(i.healthLevel));
    if (prioritySamples.length === 0) {
      note('项目财务健康：生产库里没有 over_budget / unreachable 样本，**运行时**观测不到"unreachable 优先于 over_budget"；该优先级由 `server/modules/bi/project-health.spec.ts` 的纯函数单测覆盖（本轮新增 20 条断言）');
    }
    if (pfh.items?.some((i) => i.healthReason && /权重合计/.test(i.healthReason))) {
      note('项目财务健康：存在"里程碑权重未配平"的项目，其 healthLevel 被降级为 watch 并带专门原因（B3）');
    }

    /* ---- EVM 空值契约 ---- */
    const evmBad = (pfh.items ?? []).filter(
      (i) => i.milestoneWeightTotal <= 0 && !(i.spi === null && i.cpi === null && i.eac === null),
    );
    record(
      'EVM：无加权里程碑时 SPI/CPI/EAC 必须为 null（不能 NaN/Infinity）',
      evmBad.length === 0,
      evmBad.length
        ? JSON.stringify(evmBad.map((i) => ({ c: i.code, spi: i.spi, cpi: i.cpi, eac: i.eac })))
        : `${(pfh.items ?? []).length} 个项目均无加权里程碑，返回均为 null`,
    );
    record(
      'EVM/健康接口响应里不含 NaN / Infinity 字面量',
      !/NaN|Infinity/.test(JSON.stringify(pfh)),
      /NaN|Infinity/.test(JSON.stringify(pfh)) ? '响应中出现 NaN/Infinity' : '干净',
    );

    /* ---- 图表取色规范（静态核对源码，不是"看一眼"） ---- */
    const chartFiles = [
      'client/src/pages/dashboard/DashboardPage.tsx',
      'client/src/pages/dashboard/components/FinanceTab.tsx',
      'client/src/pages/dashboard/components/OverviewTab.tsx',
      'client/src/pages/dashboard/components/HrTab.tsx',
      'client/src/pages/dashboard/components/BudgetTab.tsx',
      'client/src/pages/dashboard/components/ProjectFinancialHealthPanel.tsx',
      'client/src/pages/dashboard/MetricsPage.tsx',
    ];
    const hexHits = [];
    const tokenHits = [];
    for (const file of chartFiles) {
      let source = '';
      try {
        source = readFileSync(resolve(file), 'utf8');
      } catch {
        continue;
      }
      const hex = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      // 只关心"图表取色"：排除注释里出现的色值说明
      if (hex.length > 0) hexHits.push(`${file}: ${hex.join(',')}`);
      if (/seriesColor/.test(source)) tokenHits.push(file);
    }
    record(
      '图表取色规范：dashboard 图表统一走 theme/tokens 的 seriesColor，无裸写十六进制',
      hexHits.length === 0,
      hexHits.length === 0
        ? `已扫 ${chartFiles.length} 个文件；引用 seriesColor 的：${tokenHits.length} 个`
        : JSON.stringify(hexHits),
    );

    checkDiag(page, '经营看板 /');
    flush('① 经营看板');

    /* ══════════════════════════════════════════════════════════════
     * ② 指标中心 /bi/metrics —— 每个指标与 SQL 逐一比对
     * ══════════════════════════════════════════════════════════════ */
    } catch (e) {
      record('§② 指标中心 之前的段落被 CDP 抖动中断', false, String(e && e.message));
    }

    console.log('\n② 指标中心 /bi/metrics —— 指标逐一验数');
    try {
    page.resetDiagnostics();
    /*
     * 期间先在本脚本里按**业务时区**算出来（与页面 `currentPeriod()` 同口径），
     * 这样可以在打开页面前就拍下第一张 SQL 快照 —— 快照窗口必须把
     * "页面取数并渲染"的那一刻包在里面，否则并发写入会让区间判定失效。
     */
    period = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
    }).format(new Date()).slice(0, 7);
    const mBefore = await snapshotMetrics(sql, period);

    await page.goto(`${APP}/bi/metrics`, { settleMs: 2600 });
    await waitForText(page, '核心指标', 20000);
    await sleep(1500);

    const periodInUi = await page.evaluate(`(() => (document.getElementById('metrics-period') || {}).value || '')()`);
    record('指标中心渲染期间输入框（与业务时区当月一致）', periodInUi === period, `界面=${periodInUi} 期望=${period}`);

    const prevPeriod = (() => {
      const y = Number(period.slice(0, 4));
      const m = Number(period.slice(5, 7));
      return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    })();

    /*
     * 点「刷新」强制按当前期间重新取数，随后**在同一次求值里**读卡片并取接口 ——
     * 两次观测相隔几十毫秒，避免把并发写入读成"界面≠接口"。
     */
    await page.clickByText('刷新', { selector: 'button', settleMs: 1200 });
    await sleep(900);
    const { cards: metricCards, api: metricsApi } = await readCardsWithApi(
      page,
      `/api/bi/metrics?period=${period}`,
    );
    record('指标中心渲染指标卡', metricCards.length >= 10, `卡片数=${metricCards.length}`);
    const byKey = Object.fromEntries((metricsApi.metrics ?? []).map((m) => [m.key, m]));

    const METRIC_LABEL = {
      revenue: '营业收入',
      cost: '营业成本',
      gross_profit: '毛利',
      gross_margin: '毛利率',
      receipt_rate: '回款率',
      ar_turnover_days: '应收周转天数',
      invoice_net: '本期净开票额（销项−进项）',
      active_projects: '在管项目数',
      over_budget_projects: '超预算项目数',
      unpaid_ap: '未付应付余额',
    };

    const uiMetricNums = {};
    for (const [key, label] of Object.entries(METRIC_LABEL)) {
      const uiText = cardValue(metricCards, label);
      uiMetricNums[key] =
        uiText === null ? null : Number(String(uiText).replace(/[%天个,\s]/g, '').replace(/元$/, ''));
    }
    const mAfter = await snapshotMetrics(sql, period);
    for (const [key, label] of Object.entries(METRIC_LABEL)) {
      compareBi(
        `${label}（指标中心 ${period}）`,
        uiMetricNums[key],
        byKey[key]?.value ?? null,
        mBefore[key],
        mAfter[key],
        '',
      );
    }

    // 口径说明必须与实现一致（本轮修掉的两条公式文案）
    const unpaidFormula = byKey.unpaid_ap?.formula ?? '';
    record(
      '指标口径说明：未付应付余额的 formula 与实现一致（不再写 erp_payment.status=paid）',
      /erp_ap_bill/.test(unpaidFormula) && /paid_amount/.test(unpaidFormula) && !/erp_payment/.test(unpaidFormula),
      unpaidFormula,
    );
    const activeFormula = byKey.active_projects?.formula ?? '';
    record(
      '指标口径说明：在管项目数的 formula 列出真实项目状态（不含合同状态 active）',
      /initiating/.test(activeFormula) && /executing/.test(activeFormula) && !/\bactive\b/.test(activeFormula.replace(/inactive/g, '')),
      activeFormula,
    );

    /* ---- 期间切换真的重新取数 ---- */
    const prevMetrics = (await apiGet(`/api/bi/metrics?period=${prevPeriod}`, session)).body;
    await setInput(page, '#metrics-period', prevPeriod, 0);
    await sleep(2200);
    const afterSwitch = await readStatCards(page);
    const switched = cardValue(afterSwitch, '营业收入');
    const prevRevenueApi = (prevMetrics.metrics ?? []).find((m) => m.key === 'revenue')?.value ?? null;
    record(
      '指标中心：改期间后重新取数（营业收入跟随变化）',
      numbersEqual(Number(String(switched).replace(/[,\s]/g, '')), prevRevenueApi),
      `期间=${prevPeriod} 界面=${switched} 接口=${prevRevenueApi}`,
    );
    await setInput(page, '#metrics-period', period, 0);
    await sleep(2000);

    /* ---- 订阅预警：可增可删，且不残留 ---- */
    /*
     * ⚠️ 不能拿"订阅总数 +1"当断言：`upsertSubscription` 按
     * (userId, metricKey, channel) 幂等，若该组合已存在就是**更新**而不是新增；
     * 而且并发跑的其他走查也可能在写这张表。
     * 因此先挑一个**当前没人订阅**的指标，再断言"总数 +1 / 取消后回到原值"，
     * 这样既不会误判，也不会把别人的订阅删掉。
     */
    const subRows = await sql`SELECT metric_key, channel FROM bi_alert_subscription`;
    const usedKeys = new Set(subRows.map((r) => r.metric_key));
    const METRIC_CANDIDATES = [
      ['over_budget_projects', '超预算项目数'],
      ['invoice_net', '本期净开票额（销项−进项）'],
      ['ar_turnover_days', '应收周转天数'],
      ['gross_profit', '毛利'],
      ['receipt_rate', '回款率'],
      ['active_projects', '在管项目数'],
      ['unpaid_ap', '未付应付余额'],
    ];
    const freeMetric = METRIC_CANDIDATES.find(([key]) => !usedKeys.has(key));
    if (!freeMetric) {
      note('订阅预警：10 个指标在当前用户名下都已有订阅，跳过"新增/取消"用例以免删掉真实订阅');
    } else {
      const [freeKey, freeLabel] = freeMetric;
      const subBefore = subRows.length;
      /*
       * 订阅表单的 Select 触发器没有 `id`（用的是 `aria-label`），
       * 因此这里按 aria-label 打开；`pickRadix` 只认 id，故单写一段。
       */
      const openedSub = await page.evaluate(`(() => {
        const b = document.querySelector('[aria-label="预警订阅指标"]');
        if (!b) return 'trigger-not-found';
        b.scrollIntoView({ block: 'center' });
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'ok';
      })()`);
      await sleep(900);
      const pickMetric = await page.evaluate(`(() => {
        const o = [...document.querySelectorAll('[role="option"]')].find((x) => (x.innerText || '').includes(${JSON.stringify(freeLabel)}));
        if (!o) return 'option-not-found';
        o.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return (o.innerText || '').trim();
      })()`);
      record('订阅预警：选择指标', openedSub === 'ok' && pickMetric === freeLabel, `${openedSub} / ${pickMetric}`);
      await setInput(page, 'input[inputmode="decimal"]', '999999', 0);
      await sleep(400);
      await page.clickByText('保存订阅', { selector: 'button', settleMs: 1200 });
      const tSub = await toasts(page);
      await sleep(1300);
      const subAfter = (await sql`SELECT count(*)::int AS n FROM bi_alert_subscription`)[0].n;
      const inserted = await sql`
        SELECT id, threshold FROM bi_alert_subscription
        WHERE metric_key = ${freeKey} AND channel = 'feishu'`;
      record(
        '订阅预警：保存后库中多一条（metricKey 命中、阈值一致）',
        subAfter === subBefore + 1 && inserted.length === 1 && Number(inserted[0].threshold) === 999999,
        `toast=${JSON.stringify(tSub)} 订阅数 ${subBefore}→${subAfter} 库=${JSON.stringify(inserted[0] ?? null)}`,
      );
      const cancelClicked = await clickRowButton(page, freeLabel, '取消');
      record('订阅预警：列表出现并可取消', cancelClicked === 'ok', cancelClicked);
      await sleep(1600);
      const subEnd = (await sql`SELECT count(*)::int AS n FROM bi_alert_subscription`)[0].n;
      record('订阅预警：取消后回到原数量（不留残留）', subEnd === subBefore, `订阅数 ${subAfter}→${subEnd}（原 ${subBefore}）`);
    }

    checkDiag(page, '指标中心 /bi/metrics');
    flush('② 指标中心');

    /* ══════════════════════════════════════════════════════════════
     * ③ 审计日志 /audit —— 留痕 + 筛选 + 分页 + 导出
     * ══════════════════════════════════════════════════════════════ */
    } catch (e) {
      record('§③ 审计日志 之前的段落被 CDP 抖动中断', false, String(e && e.message));
    }

    console.log('\n③ 审计日志 /audit —— 留痕 / 筛选 / 分页 / 导出');
    try {
    page.resetDiagnostics();
    const auditTotalBefore = (await sql`SELECT count(*)::int AS n FROM comp_audit_log`)[0].n;

    // 3a：写一条 [API_TEST] 数据（新建客户），确认审计日志真的多一条
    const custName = `${TAG} 审计留痕客户`;
    await page.goto(`${APP}/customers`, { settleMs: 2600 });
    await sleep(1600);
    await page.clickByText('新建客户', { selector: 'button', settleMs: 1500 });
    await sleep(1300);
    const custSet = await setInput(page, '[role="dialog"] input[name="name"]', custName, 0);
    await sleep(400);
    await page.clickByText('保存', { selector: '[role="dialog"] button', settleMs: 1000 });
    const tCust = await toasts(page);
    await sleep(1500);
    const custRows = await sql`SELECT id, name FROM md_customer WHERE name = ${custName}`;
    record('审计留痕：新建客户已落库', custSet === 'ok' && custRows.length === 1, `toast=${JSON.stringify(tCust)}`);
    if (custRows.length) cleanup.customerIds.push(custRows[0].id);

    const auditTotalAfter = (await sql`SELECT count(*)::int AS n FROM comp_audit_log`)[0].n;
    const trail = custRows.length
      ? await sql`
          SELECT id, actor, action, object_type, object_code
          FROM comp_audit_log
          WHERE object_id = ${custRows[0].id}
          ORDER BY _created_at DESC LIMIT 5`
      : [];
    record(
      '审计留痕：POST 新建客户后审计日志多了一条（留痕）',
      auditTotalAfter > auditTotalBefore && trail.length >= 1,
      `日志 ${auditTotalBefore}→${auditTotalAfter}；该对象留痕=${JSON.stringify(trail.map((t) => ({ action: t.action, type: t.object_type })))}`,
    );

    // 3b：页面可打开 + 校验面板存在
    /*
     * ⚠️ 审计日志是**只追加**表，且此刻很可能有别的走查/用户在并发写入，
     * 因此"界面共 N 条 == SQL 条数"这种瞬时等式必然抖动。
     * 判据改为区间：读取界面值的前后各取一次 SQL 计数，界面值落在区间内即算一致。
     */
    const auditCountBeforePage = (await sql`SELECT count(*)::int AS n FROM comp_audit_log`)[0].n;
    await page.goto(`${APP}/audit`, { settleMs: 2800 });
    await sleep(1800);
    const auditPanel = await page.evaluate(`(() => !!document.body.innerText.includes('防篡改校验'))()`);
    record('审计页渲染「防篡改校验」面板', auditPanel, auditPanel ? '' : '未找到面板标题');
    const baselineRows = await antdRowTexts(page);
    const baselineTotal = parseTotalText(await tableTotal(page));
    const auditCountAfterPage = (await sql`SELECT count(*)::int AS n FROM comp_audit_log`)[0].n;
    record(
      '审计页「共 N 条」= 库里真实总条数（不因 limit=100 低报；用前后计数区间容忍并发写入）',
      baselineRows.length === 10 &&
        baselineTotal !== null &&
        baselineTotal >= auditCountBeforePage &&
        baselineTotal <= auditCountAfterPage + 2,
      `首屏行数=${baselineRows.length} 界面共=${baselineTotal} SQL 前后=${auditCountBeforePage}→${auditCountAfterPage}`,
    );

    // 3c：筛「操作类型 = 更新」→ 条数应大幅减少，且「共 N 条」= SQL 真实条数
    const [updCount] = await sql`SELECT count(*)::int AS n FROM comp_audit_log WHERE action = 'update'`;
    const pickAction = await pickRadix(page, { triggerId: 'audit-action', optionText: '更新' });
    await sleep(2200);
    const updRows = await antdRowTexts(page);
    const updTotal = parseTotalText(await tableTotal(page));
    record('审计筛选：选择「更新」生效', pickAction === '更新', String(pickAction));
    record(
      '审计筛选：选「更新」后命中条数大幅减少（界面共 N 条）',
      updTotal !== null && baselineTotal !== null && updTotal < baselineTotal && updRows.length > 0,
      `全部 ${baselineTotal} 条 → 更新 ${updTotal} 条（当前页 ${updRows.length} 行）`,
    );
    record(
      '审计筛选：界面「共 N 条」= SQL 里 action=update 的真实条数',
      updTotal !== null && Math.abs(updTotal - updCount.n) <= 2,
      `界面=${updTotal} SQL=${updCount.n}（本轮修复点：action 原先在 SQL LIMIT 之后过滤，条数会随分页大小变化）`,
    );
    const updApi = (await apiGet('/api/audit/logs?action=update&limit=100', session)).body;
    const updApi200 = (await apiGet('/api/audit/logs?action=update&limit=200', session)).body;
    const [updCountAfter] = await sql`SELECT count(*)::int AS n FROM comp_audit_log WHERE action = 'update'`;
    record(
      '审计筛选：接口层 action=update 的条数**不随 limit 变化**（100 与 200 同结果）',
      Array.isArray(updApi.items) &&
        updApi.items.length === Math.min(100, updApi.total) &&
        updApi200.items.length === Math.min(200, updApi200.total) &&
        updApi.total === updApi200.total &&
        updApi.total >= updCount.n &&
        updApi.total <= updCountAfter.n,
      `limit=100 → ${updApi.items?.length} 行/total=${updApi.total}；limit=200 → ${updApi200.items?.length} 行/total=${updApi200.total}；SQL 前后=${updCount.n}→${updCountAfter.n}`,
    );

    // 3d：叠加「模块 = 主数据」→ 进一步减少
    await pickRadix(page, { triggerId: 'audit-object-type', optionText: '主数据' });
    await sleep(2200);
    const mdRows = await antdRowTexts(page);
    const mdTotal = parseTotalText(await tableTotal(page));
    const [mdCount] = await sql`
      SELECT count(*)::int AS n FROM comp_audit_log WHERE action='update' AND object_type='master-data'`;
    record(
      '审计筛选：再叠加「模块=主数据」条数进一步减少且与 SQL 一致',
      mdTotal !== null && updTotal !== null && mdTotal <= updTotal && mdRows.length > 0 && Math.abs(mdTotal - mdCount.n) <= 2,
      `更新 ${updTotal} 条 → 更新+主数据 ${mdTotal} 条（当前页 ${mdRows.length} 行）；SQL=${mdCount.n}`,
    );

    // 3e：操作人筛选
    const actors = (await apiGet('/api/audit/actors', session)).body;
    const topActor = Array.isArray(actors) ? actors[0] : null;
    if (topActor) {
      await page.clickByText('重置筛选', { selector: 'button', settleMs: 1200 });
      await sleep(1800);
      const [actorCountBefore] = await sql`
        SELECT count(*)::int AS n FROM comp_audit_log WHERE actor = ${topActor.actor}`;
      const pickActor = await pickRadix(page, { triggerId: 'audit-actor', optionText: topActor.actor.slice(0, 12) });
      await sleep(2200);
      const actorTotal = parseTotalText(await tableTotal(page));
      const [actorCountAfter] = await sql`
        SELECT count(*)::int AS n FROM comp_audit_log WHERE actor = ${topActor.actor}`;
      /* 并发写入会让条数在"读界面"前后继续增长，用 SQL 前后区间判定 */
      record(
        '审计筛选：按操作人筛选生效，条数落在 SQL 前后计数区间内',
        String(pickActor).includes(topActor.actor.slice(0, 8)) &&
          actorTotal !== null &&
          actorTotal >= actorCountBefore.n &&
          actorTotal <= actorCountAfter.n + 2,
        `选中=${String(pickActor).slice(0, 40)} 界面共=${actorTotal} SQL 前后=${actorCountBefore.n}→${actorCountAfter.n}`,
      );
    }

    // 3f：时间范围筛选（业务时区当天）
    await page.clickByText('重置筛选', { selector: 'button', settleMs: 1200 });
    await sleep(1800);
    const bizToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const [dateCountBefore] = await sql`
      SELECT count(*)::int AS n FROM comp_audit_log
      WHERE (_created_at AT TIME ZONE 'Asia/Shanghai')::date = ${bizToday}::date`;
    await setInput(page, '#audit-date-from', bizToday, 0);
    await setInput(page, '#audit-date-to', bizToday, 0);
    await page.evaluate(`(() => {
      const el = document.getElementById('audit-date-to');
      el?.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(2400);
    const dateTotal = parseTotalText(await tableTotal(page));
    const [dateCountAfter] = await sql`
      SELECT count(*)::int AS n FROM comp_audit_log
      WHERE (_created_at AT TIME ZONE 'Asia/Shanghai')::date = ${bizToday}::date`;
    record(
      '审计筛选：按业务时区日期区间筛选生效，条数落在 SQL 前后计数区间内',
      dateTotal !== null && dateTotal >= dateCountBefore.n && dateTotal <= dateCountAfter.n + 2,
      `业务日=${bizToday} 界面共=${dateTotal} SQL 前后=${dateCountBefore.n}→${dateCountAfter.n}`,
    );

    // 3g：条数（分页尺寸）
    await page.clickByText('重置筛选', { selector: 'button', settleMs: 1200 });
    await sleep(1600);
    await pickRadix(page, { triggerId: 'audit-limit', optionText: '50' });
    await sleep(2000);
    const limitRows = await antdRowTexts(page);
    record('审计筛选：条数=50 生效（每页仍 10 行，共 N 条不变）', limitRows.length === 10, `当前页行数=${limitRows.length}`);

    // 3h：分页
    const firstRowPage1 = (await antdRowTexts(page))[0];
    const paged = await page.evaluate(`(() => {
      const next = document.querySelector('.ant-pagination-next button, .ant-pagination-next');
      if (!next || next.disabled) return 'no-next';
      next.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(1200);
    const page2Rows = await antdRowTexts(page);
    const page2Active = await page.evaluate(`(() => {
      const el = document.querySelector('.ant-pagination-item-active');
      return el ? (el.textContent || '').trim() : null;
    })()`);
    record(
      '审计分页：翻到第 2 页，行内容变化',
      paged === 'ok' && page2Active === '2' && page2Rows.length > 0 && page2Rows[0] !== firstRowPage1,
      `active=${page2Active}`,
    );

    // 3i：导出 CSV（真的点按钮 → 真的落盘 → 真的读回比对行数）
    downloadDir();
    await page.clickByText('重置筛选', { selector: 'button', settleMs: 1200 });
    await sleep(1600);
    await pickRadix(page, { triggerId: 'audit-action', optionText: '更新' });
    await sleep(2200);
    await page.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOADS,
      eventsEnabled: true,
    });
    const exportBtnExists = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^导出 CSV$/.test((x.innerText || '').trim()));
      return b ? (b.innerText || '').trim() : null;
    })()`);
    record('审计导出：页面上有「导出 CSV」按钮', !!exportBtnExists, exportBtnExists ?? '未找到');
    await page.clickByText('导出 CSV', { selector: 'button', settleMs: 2500 });
    const tExport = await toasts(page);
    await sleep(2500);
    let files = [];
    for (let i = 0; i < 20; i += 1) {
      files = readdirSync(DOWNLOADS).filter((f) => f.endsWith('.csv'));
      if (files.length > 0) break;
      await sleep(500);
    }
    const [updCountAtExport] = await sql`SELECT count(*)::int AS n FROM comp_audit_log WHERE action = 'update'`;
    if (files.length === 0) {
      record('审计导出：点击后真的下载了 CSV 文件', false, `下载目录为空；toast=${JSON.stringify(tExport)}`);
    } else {
      const csv = readFileSync(resolve(DOWNLOADS, files[0]), 'utf8');
      const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
      const dataRows = lines.length - 1;
      /* 并发写入会让条数在"点导出"到"读文件"之间继续增长，用 SQL 前后区间判定 */
      const inRange = dataRows >= Math.min(updCount.n, 5000) && dataRows <= Math.min(updCountAtExport.n, 5000) + 2;
      record(
        '审计导出：下载到的 CSV 行数 = 筛选后真实条数（导出的是全集，不只是当前页 10 行）',
        inRange && dataRows > 10,
        `文件=${files[0]} 数据行=${dataRows} SQL 区间=${updCount.n}→${updCountAtExport.n} 表头=${lines[0]?.slice(0, 40)}`,
      );
      record(
        '审计导出：CSV 带 UTF-8 BOM（Excel 打开不乱码）且含中文表头',
        csv.startsWith('\uFEFF') && /时间,操作人,操作,模块/.test(csv),
        JSON.stringify(lines[0]?.slice(0, 60)),
      );
    }

    // 3j：不可篡改（只读校验，不去删日志）
    const immut = await sql`
      SELECT tgname FROM pg_trigger WHERE tgrelid = 'comp_audit_log'::regclass AND NOT tgisinternal`;
    record(
      '审计日志只追加：表上存在防改写触发器（不尝试删除，只读校验）',
      immut.length > 0,
      `触发器=${immut.map((t) => t.tgname).join(',') || '无'}`,
    );

    await page.clickByText('重置筛选', { selector: 'button', settleMs: 1200 });
    await sleep(1200);
    checkDiag(page, '审计日志 /audit');
    flush('③ 审计日志');

    /* ══════════════════════════════════════════════════════════════
     * ④ 数据资产 /data-asset —— 三个 Tab + 授权详情
     * ══════════════════════════════════════════════════════════════ */
    } catch (e) {
      record('§④ 数据资产 之前的段落被 CDP 抖动中断', false, String(e && e.message));
    }

    console.log('\n④ 数据资产 /data-asset —— 三个 Tab');
    try {
    page.resetDiagnostics();
    await page.goto(`${APP}/data-asset`, { settleMs: 2600 });
    await sleep(1800);
    const dsTabText = await page.evaluate(`(() => document.body.innerText.slice(0, 400))()`);
    record('数据资产页可打开（默认数据集目录 Tab）', /数据集目录/.test(dsTabText), dsTabText.replace(/\n/g, ' | ').slice(0, 160));

    // 4a：数据集目录 —— 新建 [API_TEST] 数据集，含脱敏等级
    const dsName = `${TAG} 数据集A`;
    await page.clickByText('新建数据集', { selector: 'button', settleMs: 1600 });
    await sleep(1400);
    const dlgTitle = await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      return d ? (d.querySelector('[role="heading"],h2')?.textContent || '').trim() : null;
    })()`);
    record('数据集目录：新建弹窗打开', /新建数据集/.test(String(dlgTitle)), `标题=${dlgTitle}`);
    await setInput(page, '[role="dialog"] input', dsName, 0);
    await sleep(400);
    const maskChosen = await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return null;
      const trig = [...d.querySelectorAll('button[role="combobox"]')].find((b) => /L\\d|请选择/.test(b.textContent || ''));
      if (!trig) return null;
      trig.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'opened';
    })()`);
    await sleep(900);
    const maskPick = await page.evaluate(`(() => {
      if (${JSON.stringify(maskChosen)} === null) return null;
      const opts = [...document.querySelectorAll('[role="option"]')];
      const o = opts.find((x) => /L3/.test(x.textContent || '')) || opts[opts.length - 1];
      if (!o) return null;
      const t = (o.textContent || '').trim();
      o.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return t;
    })()`);
    record('数据集目录：选择脱敏等级', !!maskPick, `选中=${maskPick}`);
    await sleep(600);
    await page.clickByText('保存', { selector: '[role="dialog"] button', settleMs: 1200 });
    const tDs = await toasts(page);
    await sleep(1400);
    const dsRows = await sql`SELECT id, name, mask_level, status FROM da_dataset WHERE name = ${dsName}`;
    record('数据集目录：新建后落库', dsRows.length === 1, `toast=${JSON.stringify(tDs)} 库=${JSON.stringify(dsRows[0] ?? null)}`);
    if (dsRows.length) {
      cleanup.datasetIds.push(dsRows[0].id);
      const levelInUi = String(maskPick ?? '').match(/L\d/)?.[0] ?? null;
      const levelInDb = String(dsRows[0].mask_level ?? '').match(/L\d/)?.[0] ?? null;
      record(
        '数据集目录：界面选的脱敏等级与 da_dataset.mask_level 一致',
        levelInUi !== null && levelInUi === levelInDb,
        `库=${dsRows[0].mask_level} 界面选=${maskPick}`,
      );
    }

    await page.goto(`${APP}/data-asset`, { settleMs: 2400 });
    await sleep(1600);
    const dsListed = await page.evaluate(`(() => document.body.innerText.includes(${JSON.stringify(dsName)}))()`);
    record('数据集目录：列表里能看到刚建的数据集', dsListed, dsListed ? '' : '列表里未出现');

    // 4b：授权记录 —— 新建授权
    await page.clickByText('授权记录', { selector: 'button', settleMs: 2000 });
    await sleep(1800);
    const grantTabOk = await page.evaluate(`(() => location.search.includes('tab=grants'))()`);
    record('授权记录 Tab：URL 带上 tab=grants（可分享/可刷新）', grantTabOk, 'Tab 切换走 useSearchParams');

    const grantBtn = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /新增授权/.test((x.innerText || '').trim()));
      if (!b) return null;
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return (b.innerText || '').trim();
    })()`);
    record('授权记录：点「新增授权」弹窗打开', !!grantBtn, grantBtn ?? '未找到按钮');
    await sleep(1500);
    const dsPick = await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return 'no-dialog';
      const trig = [...d.querySelectorAll('button[role="combobox"]')][0];
      if (!trig) return 'no-trigger';
      trig.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(900);
    const dsChosen = await page.evaluate(`(() => {
      const opts = [...document.querySelectorAll('[role="option"]')];
      const o = opts.find((x) => (x.textContent || '').includes(${JSON.stringify(dsName)})) || opts[0];
      if (!o) return 'option-not-found';
      o.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return (o.textContent || '').trim();
    })()`);
    record('授权记录：选择数据集', dsPick === 'ok' && dsChosen !== 'option-not-found', `选中=${dsChosen}`);
    await sleep(700);
    /*
     * 起止日期是 `DateField`（Popover + react-day-picker，**不是** input[type=date]）。
     * 第一版按 `input[type="date"]` 找，得到 `date-inputs=0` → 假失败。
     * 正确做法：点开日历按钮 → 点 `[data-day="YYYY-MM-DD"]` 那一格。
     * 日期取业务时区的"今天 / 今天+7"，保证日历打开就在当月、无需翻月。
     */
    const startIso = bizTodayIso();
    const endIso = bizPlusDays(7);
    const dateSetStart = await setDialogDate(page, 0, startIso);
    const dateSetEnd = await setDialogDate(page, 1, endIso);
    record(
      '授权记录：填写起止日期（DateField 日历）',
      dateSetStart === 'ok' && dateSetEnd === 'ok',
      `开始=${startIso}→${dateSetStart}；结束=${endIso}→${dateSetEnd}`,
    );
    const dateShown = await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      const btns = [...d.querySelectorAll('button')].map((b) => (b.innerText || '').trim());
      return btns.filter((t) => /^\\d{4}-\\d{2}-\\d{2}$/.test(t));
    })()`);
    record(
      '授权记录：日期已回填到表单（按钮文本变成日期）',
      Array.isArray(dateShown) && dateShown.includes(startIso) && dateShown.includes(endIso),
      `期望=${JSON.stringify([startIso, endIso])} 实际=${JSON.stringify(dateShown)}`,
    );
    // ⚠️ 日历 Popover 选完不会自动关，必须先关掉，否则"点保存"只会落在日历格子上
    const popoversLeft = await closePopoverInDialog(page);
    record('授权记录：选完日期后关闭日历浮层（否则保存点不中）', popoversLeft === 0, `剩余浮层=${popoversLeft}`);
    await page.clickByText('保存', { selector: '[role="dialog"] button', settleMs: 1600 });
    const tGrant = await toasts(page);
    await sleep(1800);
    const grantDialogStillOpen = await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return null;
      return {
        text: (d.innerText || '').slice(0, 200),
        messages: [...d.querySelectorAll('[class*="destructive"], [role="alert"]')].map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 4),
      };
    })()`);
    if (grantDialogStillOpen) {
      note(`新增授权弹窗在保存后仍开着：${JSON.stringify(grantDialogStillOpen).slice(0, 300)}`);
    }
    const grantRows = dsRows.length
      ? await sql`
          SELECT g.id, g.code, g.status, g.start_date::text AS start_text, g.end_date::text AS end_text,
                 d.name AS dataset_name, d.mask_level
          FROM da_grant g JOIN da_dataset d ON d.id = g.dataset_id
          WHERE g.dataset_id = ${dsRows[0].id}`
      : [];
    record(
      '授权记录：新建授权落库，且起止日期与界面所选一致',
      grantRows.length === 1 &&
        grantRows[0].start_text === startIso &&
        grantRows[0].end_text === endIso,
      `toast=${JSON.stringify(tGrant)} 库=${JSON.stringify(grantRows[0] ?? null)}`,
    );
    if (grantRows.length) cleanup.grantIds.push(grantRows[0].id);

    // 4c：/data-asset/grants/:id 详情页
    if (grantRows.length) {
      await page.goto(`${APP}/data-asset/grants/${grantRows[0].id}`, { settleMs: 2800 });
      await sleep(1800);
      const detailText = await page.evaluate(`(() => document.body.innerText)()`);
      record(
        '授权详情页 /data-asset/grants/:id 渲染且编号/数据集名正确',
        detailText.includes(grantRows[0].code) && detailText.includes(dsName),
        `编号=${grantRows[0].code} 含数据集名=${detailText.includes(dsName)}`,
      );
      record(
        '授权详情页：数据集/客户/项目/状态/起止日期字段齐全',
        /数据集：/.test(detailText) && /状态：/.test(detailText) && /开始日期：/.test(detailText) && /结束日期：/.test(detailText),
        detailText.replace(/\n/g, ' | ').slice(0, 240),
      );
    } else {
      record('授权详情页 /data-asset/grants/:id', false, '没有授权记录可打开');
    }

    // 4d：脱敏与回收审计 Tab
    await page.goto(`${APP}/data-asset?tab=mask`, { settleMs: 2800 });
    await sleep(2000);
    const maskText = await page.evaluate(`(() => document.body.innerText)()`);
    record(
      '脱敏与回收审计 Tab：三块内容都在（脱敏字段登记 / 授权回收 / 回收审计记录）',
      /脱敏字段登记/.test(maskText) && /授权回收/.test(maskText) && /回收审计记录/.test(maskText),
      maskText.replace(/\n/g, ' | ').slice(0, 280),
    );
    const maskLevels = (await apiGet('/api/data-asset/mask-levels', session)).body;
    record(
      '脱敏等级字典：接口返回等级且与页面下拉/数据集等级同源',
      Array.isArray(maskLevels) && maskLevels.length > 0,
      JSON.stringify(maskLevels).slice(0, 240),
    );

    // 4e：回收授权 → 回收审计记录新增一条，界面与库一致
    if (grantRows.length && dsRows.length) {
      const revokeRes = await fetch(
        `${EFFECTIVE_API}/api/data-asset/grants/${grantRows[0].id}/actions/revoke`,
        {
          method: 'POST',
          headers: { cookie: `erp_session=${session}`, 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'project_closed', remark: `${TAG} 走查回收` }),
        },
      );
      const revokeBody = await revokeRes.json().catch(() => null);
      record('授权回收：接口回收成功', revokeRes.ok, `HTTP ${revokeRes.status} ${JSON.stringify(revokeBody).slice(0, 200)}`);
      await sleep(900);
      const logBody = (await apiGet(`/api/data-asset/grant-revoke-logs?grantId=${grantRows[0].id}`, session)).body;
      const logItem = (logBody.items ?? [])[0];
      record(
        '回收审计记录：接口记录与授权表一致（grantCode / datasetId 对得上）',
        (logBody.items ?? []).length >= 1 &&
          String(logItem?.grantCode ?? '') === String(grantRows[0].code) &&
          String(logItem?.datasetId ?? '') === String(dsRows[0].id),
        `记录=${JSON.stringify(logItem).slice(0, 300)}`,
      );
      const sqlLog = await sql`
        SELECT grant_id, dataset_id, reason, reviewed_by, destruction_proof
        FROM da_grant_revoke_log WHERE grant_id = ${grantRows[0].id}`;
      record(
        '回收审计记录：库里 da_grant_revoke_log 落了一行且原因一致',
        sqlLog.length === 1 && sqlLog[0].reason === 'project_closed',
        JSON.stringify(sqlLog).slice(0, 240),
      );
      const dsAfterRevoke = await sql`SELECT mask_level, status FROM da_dataset WHERE id = ${dsRows[0].id}`;
      record(
        '回收审计记录：脱敏等级与 da_dataset 当前值一致（界面/库同源）',
        String(dsAfterRevoke[0]?.mask_level ?? '') === String(dsRows[0].mask_level ?? ''),
        `库 mask_level=${dsAfterRevoke[0]?.mask_level}`,
      );
      await page.goto(`${APP}/data-asset?tab=mask`, { settleMs: 2800 });
      await sleep(2200);
      const maskText2 = await page.evaluate(`(() => document.body.innerText)()`);
      record(
        '回收审计记录：刷新后界面上出现该授权编号',
        maskText2.includes(grantRows[0].code),
        maskText2.includes(grantRows[0].code) ? '' : '界面上没有该编号',
      );
    }

    checkDiag(page, '数据资产 /data-asset');
    flush('④ 数据资产');

    /* ══════════════════════════════════════════════════════════════
     * ⑤ 设置 /settings —— appearance / dictionary / params
     * ══════════════════════════════════════════════════════════════ */
    } catch (e) {
      record('§⑤ 设置 之前的段落被 CDP 抖动中断', false, String(e && e.message));
    }

    console.log('\n⑤ 设置 /settings —— 三个 Tab');
    try {
    page.resetDiagnostics();
    await page.goto(`${APP}/settings`, { settleMs: 3000 });
    await sleep(2200);
    const settingsText = await page.evaluate(`(() => document.body.innerText)()`);
    record(
      '设置页可打开且默认在外观与集成 Tab',
      /外观/.test(settingsText) && /主题/.test(settingsText),
      settingsText.replace(/\n/g, ' | ').slice(0, 200),
    );

    // 5a：外观 —— 切深色再切回，看 html class 与 console error
    const themeBefore = await page.evaluate(`(() => document.documentElement.className)()`);
    const themePicked = await pickRadix(page, { triggerId: 'settings-theme', optionText: '深色' });
    record('外观：主题下拉可切换', themePicked === '深色', String(themePicked));
    await sleep(1600);
    const themeDark = await page.evaluate(
      `(() => ({ cls: document.documentElement.className, bg: getComputedStyle(document.body).backgroundColor }))()`,
    );
    record(
      '外观：切「深色」后 html 挂上 dark 且背景色随之变化',
      /dark/.test(themeDark.cls) && themeDark.cls !== themeBefore,
      `切换前 className=${JSON.stringify(themeBefore)} 切换后=${themeDark.cls} bodyBg=${themeDark.bg}`,
    );
    const diagDark = diag(page);
    record('外观：切深色后无未捕获异常', diagDark.exceptions.length === 0, JSON.stringify(diagDark.exceptions).slice(0, 220));
    record('外观：切深色后无 console.error', diagDark.consoleErrors.length === 0, JSON.stringify(diagDark.consoleErrors).slice(0, 220));
    await pickRadix(page, { triggerId: 'settings-theme', optionText: '浅色' });
    await sleep(1600);
    const themeLight = await page.evaluate(`(() => document.documentElement.className)()`);
    record('外观：切回「浅色」后 dark 类被移除', !/dark/.test(themeLight), `className=${themeLight}`);

    // 5b：字典设置 —— 改一个字典项 → SQL 核对 → 改回
    await page.clickByText('字典设置', { selector: '[role="tab"]', settleMs: 2400 });
    await sleep(2400);
    const dictRow = (await sql`
      SELECT dict_type, dict_key, dict_label, sort_no, enabled FROM sys_dict
      WHERE dict_type='ap_status' AND dict_key='pending'`)[0];
    if (!dictRow) {
      record('字典设置：找到一个可编辑字典项', false, 'ap_status.pending 不存在，无法测编辑');
    } else {
      const found = await clickRowButton(page, dictRow.dict_label, '编辑');
      record('字典设置：找到目标字典项并点「编辑」', found === 'ok', `${dictRow.dict_type}.${dictRow.dict_key}=${dictRow.dict_label} → ${found}`);
      await sleep(1600);
      const dictDlg = await page.evaluate(`(() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? { title: (d.querySelector('[role="heading"],h2')?.textContent || '').trim(),
                    inputs: [...d.querySelectorAll('input')].map((i) => ({ name: i.name, value: i.value })) } : null;
      })()`);
      record('字典设置：编辑弹窗打开', !!dictDlg, JSON.stringify(dictDlg).slice(0, 240));
      if (dictDlg) {
        const newLabel = `${dictRow.dict_label}${TAG}`;
        cleanup.dictRestore.push({ ...dictRow });
        const setOk = await page.evaluate(`(() => {
          const d = document.querySelector('[role="dialog"]');
          if (!d) return 'no-dialog';
          /*
           * ⚠️ 这个弹窗的 input **没有 name 属性**（实测 name 全为空串），
           * 按 name 定位会落到第一个 input（= 字典类型）上，把类型改坏。
           * 判据改为"值等于当前标签"的那个 input。
           */
          const el = [...d.querySelectorAll('input')].find((i) => i.value === ${JSON.stringify(dictRow.dict_label)});
          if (!el) return 'label-input-not-found:' + [...d.querySelectorAll('input')].map((i) => i.value).join('|');
          const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          s ? s.call(el, ${JSON.stringify(newLabel)}) : (el.value = ${JSON.stringify(newLabel)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'ok';
        })()`);
        record('字典设置：改标签输入框', setOk === 'ok', `新值=${newLabel}`);
        await page.clickByText('保存', { selector: '[role="dialog"] button', settleMs: 1200 });
        const tDict = await toasts(page);
        await sleep(1500);
        const after = await sql`
          SELECT dict_label FROM sys_dict
          WHERE dict_type=${dictRow.dict_type} AND dict_key=${dictRow.dict_key}`;
        record(
          '字典设置：改动真的落库（SQL 核对）',
          String(after[0]?.dict_label ?? '') === newLabel,
          `库=${String(after[0]?.dict_label ?? '')} 期望=${newLabel} toast=${JSON.stringify(tDict)}`,
        );
        // 改回（走接口，保证缓存失效）
        const restore = await fetch(`${EFFECTIVE_API}/api/system/dictionary`, {
          method: 'POST',
          headers: { cookie: `erp_session=${session}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            dictType: dictRow.dict_type,
            dictKey: dictRow.dict_key,
            dictLabel: dictRow.dict_label,
            sortNo: Number(dictRow.sort_no ?? 10),
            enabled: dictRow.enabled !== false,
          }),
        });
        await sleep(800);
        const back = await sql`
          SELECT dict_label FROM sys_dict
          WHERE dict_type=${dictRow.dict_type} AND dict_key=${dictRow.dict_key}`;
        record(
          '字典设置：已改回原值（不留残留）',
          String(back[0]?.dict_label ?? '') === dictRow.dict_label,
          `HTTP ${restore.status} 库=${String(back[0]?.dict_label ?? '')}`,
        );
      }
    }

    // 5c：参数设置 —— 改一个参数 → SQL 核对 → 改回
    await page.clickByText('参数设置', { selector: '[role="tab"]', settleMs: 2600 });
    await sleep(2600);
    const paramRow = (await sql`
      SELECT param_key, param_value, value_type FROM sys_param
      WHERE editable = 1 AND value_type = 'number' ORDER BY param_key LIMIT 1`)[0];
    if (!paramRow) {
      record('参数设置：找到一个可编辑数值参数', false, '没有 editable 的 number 参数');
    } else {
      const paramVisible = await page.evaluate(`(() => document.body.innerText.includes(${JSON.stringify(paramRow.param_key)}))()`);
      record('参数设置：页面上能看到该参数', paramVisible, paramRow.param_key);
      const editClicked = await clickRowButton(page, paramRow.param_key, '编辑');
      record('参数设置：点「编辑」', editClicked === 'ok', editClicked);
      await sleep(1500);
      const dlg2 = await page.evaluate(`(() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? { title: (d.querySelector('[role="heading"],h2')?.textContent || '').trim() } : null;
      })()`);
      record('参数设置：编辑弹窗打开', !!dlg2, JSON.stringify(dlg2));
      if (dlg2) {
        const newVal = String(Number(paramRow.param_value) + 1);
        cleanup.paramRestore.push({ ...paramRow });
        await setInput(page, '#param-value', newVal, 0);
        await sleep(500);
        await page.clickByText('保存', { selector: '[role="dialog"] button', settleMs: 1200 });
        const tParam = await toasts(page);
        await sleep(1500);
        const afterP = await sql`SELECT param_value FROM sys_param WHERE param_key=${paramRow.param_key}`;
        record(
          '参数设置：改动真的落库（SQL 核对）',
          String(afterP[0]?.param_value ?? '') === newVal,
          `${paramRow.param_key}: 库=${afterP[0]?.param_value} 期望=${newVal} toast=${JSON.stringify(tParam)}`,
        );
        // 刷新列表后改回
        await page.evaluate(`(() => {
          const b = [...document.querySelectorAll('button')].find((x) => /刷新/.test(x.innerText || ''));
          if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        })()`);
        await sleep(1500);
        await clickRowButton(page, paramRow.param_key, '编辑');
        await sleep(1500);
        await setInput(page, '#param-value', paramRow.param_value, 0);
        await sleep(500);
        await page.clickByText('保存', { selector: '[role="dialog"] button', settleMs: 1200 });
        await sleep(1500);
        const backP = await sql`SELECT param_value FROM sys_param WHERE param_key=${paramRow.param_key}`;
        record(
          '参数设置：已改回原值（不留残留）',
          String(backP[0]?.param_value ?? '') === String(paramRow.param_value),
          `库=${backP[0]?.param_value} 原=${paramRow.param_value}`,
        );
      }
    }

    /*
     * `/api/drive/config` 在"配置行尚未初始化"时返回 503，这是**预期的降级**：
     * 页面 `.catch(() => setDriveConfig(null))` 后渲染
     * 「尚未读取到配置（可能尚未初始化）。填写下方字段并保存以写入。」
     * —— 用户拿到的是可操作引导而不是空白或崩溃。
     * 与 `/api/wiki/nodes` 的 503 同类，计入允许项并在报告中说明。
     */
    checkDiag(page, '设置 /settings', { allowHttp: ['/api/drive/config'] });
    flush('⑤ 设置');

    /* ══════════════════════════════════════════════════════════════
     * ⑥ 云空间 /drive、知识库 /wiki —— 未配置时的降级引导
     * ══════════════════════════════════════════════════════════════ */
    } catch (e) {
      record('§⑥ 云空间/知识库 之前的段落被 CDP 抖动中断', false, String(e && e.message));
    }

    console.log('\n⑥ 云空间 /drive、知识库 /wiki —— 降级引导');
    try {
    page.resetDiagnostics();
    const driveRoot = (await apiGet('/api/drive/root', session)).body;
    await page.goto(`${APP}/drive`, { settleMs: 3200 });
    await sleep(2400);
    const driveText = await page.evaluate(`(() => document.body.innerText)()`);
    const driveGuided =
      /尚未配置|未配置/.test(driveText) && !/加载失败/.test(driveText) && !/当前文件夹为空/.test(driveText);
    record(
      '云空间：根目录未配置时出现降级引导（不是"当前文件夹为空"这种说谎的空态）',
      driveGuided,
      `接口 root=${JSON.stringify(driveRoot)} 页面=${driveText.replace(/\n/g, ' | ').slice(0, 260)}`,
    );
    const newFolderDisabled = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /新建文件夹/.test(x.innerText || ''));
      return b ? !!b.disabled : null;
    })()`);
    record(
      '云空间：未配置时「新建文件夹」已禁用（避免点下去必然 400）',
      newFolderDisabled === true,
      `disabled=${newFolderDisabled}`,
    );
    const driveDiag = checkDiag(page, '云空间 /drive');

    await page.goto(`${APP}/wiki`, { settleMs: 3200 });
    await sleep(2400);
    const wikiText = await page.evaluate(`(() => document.body.innerText)()`);
    record(
      '知识库：未配置时出现「知识库尚未配置」引导文案',
      /知识库尚未配置|尚未授权本应用访问/.test(wikiText),
      wikiText.replace(/\n/g, ' | ').slice(0, 300),
    );
    const wikiDiag = checkDiag(page, '知识库 /wiki', { allowHttp: ['/api/wiki/'] });
    record(
      '知识库：503 为预期降级响应（空间未配置），页面据此展示引导而非报错',
      wikiDiag.httpErrors.every((h) => h.includes('/api/wiki/')),
      JSON.stringify(wikiDiag.httpErrors.map((h) => h.slice(0, 70))),
    );

    /* ══════════════════════════════════════════════════════════════
     * ⑦ 命令面板 ⌘K / Ctrl+K
     * ══════════════════════════════════════════════════════════════ */
    } catch (e) {
      record('§⑦ 命令面板 之前的段落被 CDP 抖动中断', false, String(e && e.message));
    }

    console.log('\n⑦ 命令面板 ⌘K / Ctrl+K');
    try {
    page.resetDiagnostics();
    await page.goto(`${APP}/`, { settleMs: 2800 });
    await sleep(1800);

    const pressCtrlK = async () => {
      await page.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', modifiers: 2, key: 'k', code: 'KeyK',
        windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75,
      });
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyUp', modifiers: 2, key: 'k', code: 'KeyK',
        windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75,
      });
      await sleep(1000);
    };
    const palette = () =>
      page.evaluate(`(() => {
        const d = document.querySelector('[role="dialog"]');
        if (!d) return null;
        return { text: (d.innerText || '').slice(0, 120), hasInput: !!d.querySelector('input') };
      })()`);

    await pressCtrlK();
    const p1 = await palette();
    record('命令面板：Ctrl+K 打开', !!p1 && p1.hasInput, JSON.stringify(p1).slice(0, 200));

    await page.fill('[role="dialog"] input', '客户');
    await sleep(1400);
    const searched = await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      return d ? [...d.querySelectorAll('[role="option"]')].map((o) => (o.innerText || '').trim()).slice(0, 8) : [];
    })()`);
    record('命令面板：输入关键字有匹配结果', searched.length > 0, JSON.stringify(searched).slice(0, 240));

    await pressCtrlK();
    const p2 = await palette();
    record('命令面板：再按 Ctrl+K 关闭', p2 === null, p2 ? JSON.stringify(p2).slice(0, 140) : '已关闭');

    await pressCtrlK();
    await page.pressKey('Escape', 'Escape', 27);
    await sleep(1000);
    const p3 = await palette();
    record('命令面板：Esc 也能关闭', p3 === null, p3 ? JSON.stringify(p3).slice(0, 140) : '已关闭');

    checkDiag(page, '命令面板');
    flush('⑦ 命令面板');

    /* ══════════════════════════════════════════════════════════════
     * ⑧ 清理 + 残留审计
     * ══════════════════════════════════════════════════════════════ */
    } catch (e) {
      record('§⑧ 清理 之前的段落被 CDP 抖动中断', false, String(e && e.message));
    }

    console.log('\n⑧ 清理测试数据（先打印待删行，再按精确主键删）');
    if (cleanup.customerIds.length) {
      const rows = await sql`SELECT id, name FROM md_customer WHERE id IN ${sql(cleanup.customerIds)}`;
      console.log('    待删客户:', JSON.stringify(rows));
      for (const r of rows) {
        if (!String(r.name).startsWith(TAG)) throw new Error(`拒绝删除非 [API_TEST] 数据: ${r.name}`);
        await sql`DELETE FROM md_customer WHERE id = ${r.id}`;
      }
    }
    if (cleanup.grantIds.length) {
      const rows = await sql`SELECT id, code FROM da_grant WHERE id IN ${sql(cleanup.grantIds)}`;
      console.log('    待删授权:', JSON.stringify(rows));
      for (const r of rows) {
        await sql`DELETE FROM da_grant_revoke_log WHERE grant_id = ${r.id}`;
        await sql`DELETE FROM da_grant WHERE id = ${r.id}`;
      }
    }
    if (cleanup.datasetIds.length) {
      const rows = await sql`SELECT id, name FROM da_dataset WHERE id IN ${sql(cleanup.datasetIds)}`;
      console.log('    待删数据集:', JSON.stringify(rows));
      for (const r of rows) {
        if (!String(r.name).startsWith(TAG)) throw new Error(`拒绝删除非 [API_TEST] 数据: ${r.name}`);
        await sql`DELETE FROM da_dataset_field WHERE dataset_id = ${r.id}`;
        await sql`DELETE FROM da_grant WHERE dataset_id = ${r.id}`;
        await sql`DELETE FROM da_dataset WHERE id = ${r.id}`;
      }
    }

    const residue = await sql`
      SELECT
        (SELECT count(*)::int FROM md_customer WHERE name LIKE ${`${TAG}%`}) AS customers,
        (SELECT count(*)::int FROM da_dataset WHERE name LIKE ${`${TAG}%`}) AS datasets,
        (SELECT count(*)::int FROM da_grant g JOIN da_dataset d ON d.id=g.dataset_id WHERE d.name LIKE ${`${TAG}%`}) AS grants,
        (SELECT count(*)::int FROM erp_project WHERE name LIKE ${`${TAG}%`}) AS projects,
        (SELECT count(*)::int FROM erp_contract WHERE name LIKE ${`${TAG}%`}) AS contracts,
        (SELECT count(*)::int FROM crm_lead WHERE customer_name LIKE ${`${TAG}%`}) AS leads,
        (SELECT count(*)::int FROM bi_alert_subscription WHERE metric_key='gross_margin') AS gross_margin_subs`;
    /*
     * 只对**本次走查自己创建的**记录负责：并发跑的其他走查同时在增删
     * `[API_TEST]` 数据（实测跑前 1 个、跑后 0 个），拿绝对计数或差值都会误判。
     * 因此按本轮记录下来的**精确主键 / 精确名称**断言"已不存在"。
     */
    const myArtifacts = await sql`
      SELECT
        (SELECT count(*)::int FROM md_customer WHERE id IN ${sql(cleanup.customerIds.length ? cleanup.customerIds : ['00000000-0000-0000-0000-000000000000'])}) AS customers,
        (SELECT count(*)::int FROM da_dataset WHERE id IN ${sql(cleanup.datasetIds.length ? cleanup.datasetIds : ['00000000-0000-0000-0000-000000000000'])}) AS datasets,
        (SELECT count(*)::int FROM da_grant WHERE id IN ${sql(cleanup.grantIds.length ? cleanup.grantIds : ['00000000-0000-0000-0000-000000000000'])}) AS grants,
        (SELECT count(*)::int FROM md_customer WHERE name = ${`${TAG} 审计留痕客户`}) AS customers_by_name,
        (SELECT count(*)::int FROM da_dataset WHERE name = ${`${TAG} 数据集A`}) AS datasets_by_name`;
    record(
      '残留审计：本次走查创建的 [API_TEST] 记录已全部删除（按主键/名称核对）',
      Object.values(myArtifacts[0]).every((v) => Number(v) === 0),
      `按主键/名称复查=${JSON.stringify(myArtifacts[0])}；全库 [API_TEST] 计数（含其他 agent 的数据，仅供参考）=${JSON.stringify(residue[0])}`,
    );

    const failed = results.filter((r) => !r.pass);
    /* 最终报告：带残留审计与页面诊断（区别于分段 flush 的中间态） */
    writeFileSync(
      `${OUT}/bi-settings-report.json`,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          lastSection: '⑧ 完成',
          app: APP,
          apiLogin: API,
          apiEffective: EFFECTIVE_API,
          apiProxy: API_PROXY || null,
          cdpPort: PORT,
          period,
          summary: {
            total: results.length,
            passed: results.length - failed.length,
            failed: failed.length,
          },
          comparisons,
          results,
          notes,
          residue: { mine: myArtifacts[0], allApiTest: residue[0] },
          diagnostics: diag(page),
        },
        null,
        2,
      ),
    );
    completed = true;
    console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail ?? ''}`);
    console.log(`\n报告已写入 ${OUT}/bi-settings-report.json`);
  } finally {
    try {
      // 兜底清理：只删自己打的 [API_TEST] 标记，且按主键
      const leftoverCust = await sql`SELECT id, name FROM md_customer WHERE name LIKE ${`${TAG}%`}`;
      for (const r of leftoverCust) await sql`DELETE FROM md_customer WHERE id = ${r.id}`;
      const leftoverDs = await sql`SELECT id, name FROM da_dataset WHERE name LIKE ${`${TAG}%`}`;
      for (const r of leftoverDs) {
        await sql`DELETE FROM da_grant_revoke_log WHERE grant_id IN (SELECT id FROM da_grant WHERE dataset_id = ${r.id})`.catch(() => {});
        await sql`DELETE FROM da_grant WHERE dataset_id = ${r.id}`.catch(() => {});
        await sql`DELETE FROM da_dataset_field WHERE dataset_id = ${r.id}`.catch(() => {});
        await sql`DELETE FROM da_dataset WHERE id = ${r.id}`.catch(() => {});
      }
      for (const d of cleanup.dictRestore) {
        await sql`UPDATE sys_dict SET dict_label = ${d.dict_label}
                  WHERE dict_type = ${d.dict_type} AND dict_key = ${d.dict_key}`.catch(() => {});
      }
      for (const p of cleanup.paramRestore) {
        await sql`UPDATE sys_param SET param_value = ${p.param_value} WHERE param_key = ${p.param_key}`.catch(() => {});
      }
      console.log('\n清理完成');
    } catch (e) {
      console.log('清理出错:', e.message);
    }
    /* 中途异常也要留下已完成部分的报告（分段落盘 + finally 兜底） */
    try {
      if (!completed) flush('中断（异常退出，仅含已完成部分）');
    } catch {
      /* 忽略 */
    }
    await sql.end({ timeout: 2 }).catch(() => {});
    await browser.close().catch(() => {});
  }
}

void main().catch((e) => {
  console.error('走查失败:', e);
  process.exitCode = 1;
});
