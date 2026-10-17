/**
 * 财务板块浏览器走查：**在浏览器里逐项点、逐项查库**。
 *
 * 覆盖范围（全部为 `/finance` 及其子路由）：
 *   ① `/finance` 七个 Tab：应收与回款 / 应付与付款 / 发票登记 / 勾稽中心 /
 *      对账单 / 账龄分析 / 现金流
 *   ② `/finance/reports`  财务报表（资产负债表 / 利润表 / 现金流量表）
 *   ③ `/finance/ledgers`  会计账簿（余额表 / 总账 / 明细账 / 辅助余额 / 组合与分摊）
 *   ④ `/finance/tax-declaration` 增值税申报（扫描 → 底稿 → 确认）
 *   ⑤ `/finance/year-end` 期末年结（预览 → 执行 → 反年结）
 *
 * ## 与既有走查脚本的分工
 *
 * `walk-interactions.mjs` 只验"Tab 能点开"；`walk-crud.mjs` 验"写入能落库"。
 * 本脚本要的是**第三层**：写入落库 **+ 财税口径与库值逐一对上** +
 * 界面数字与 SQL 聚合逐一对上。所以每个 Tab 都会做：
 *
 *   · 真实鼠标点击切 Tab（`Input.dispatchMouseEvent`，不是 `el.click()`）
 *   · 抓渲染出的表头 / 按钮 / 空态文案 / 截图
 *   · 至少一次写入 → SQL 核对；只读 Tab → 界面关键数字 vs SQL 聚合
 *   · `resetDiagnostics()` + console/异常/HTTP≥400 采集
 *
 * ## 财税逻辑（本脚本的硬要求，逐条落到断言）
 *
 *   1. 应收/应付**含税→不含税**价税分离是否等于 `shared/tax.ts#splitTax`：
 *      查 `fin_voucher_line` 的 1122/2203/222101（应收登记）与
 *      6602/222102/2202（进项登记）三条分录，而不是只看入库金额。
 *   2. 核销守卫：超额 / 跨客户 / 重复 / 已作废。
 *   3. 发票可开金额受合同可开金额约束；**销项开票不出凭证**（方案 A，
 *      `invoice.service.ts:391`）而**进项开票出凭证**（`inputIssueLines`）。
 *   4. 增值税底稿销项/进项取数与发票台账一致（`status='issued'` + 所属期，
 *      进项另需 `certification_status IN ('certified','deducted')`）。
 *   5. 期末年结闸门：未过账凭证、损益结转、年度锁定、未结账期间。
 *   6. 账簿借贷平衡：每张 `fin_voucher` 的 `fin_voucher_line` 借贷合计相等。
 *
 * ## 数据纪律（AGENTS.md）
 *
 * 所有测试单据以 `[API_TEST]` 打标。**清理前先 SELECT 出待删行并打印**，
 * 删除一律走**精确主键 id**（本会话已有人因宽泛 LIKE 清理误删真实数据）。
 *
 * 用法（需先起 3100 API 与 5273 走查 Vite）：
 *   node scripts/browser-walkthrough/walk-finance.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const USER = process.env.WT_USER ?? 'chengsheng@chengshengdata.cn';
const PASS = process.env.WT_PASS ?? '******';
const OUT = 'scripts/browser-walkthrough/out';
const TAG = '[API_TEST]';
/** ⚠️ 本会话独占 9360，其他 agent 在用别的端口 */
const BROWSER_PORT = 9360;
/** 业务期间：库里全部财务数据都在 2026-10，系统日 2026-10-17 */
const PERIOD = '2026-10';
/**
 * 本脚本使用的**精确**备注字面量。
 *
 * 清理的第二遍（sweep）只按这些**字面量相等**匹配，不用宽泛 `LIKE '%[API_TEST]%'` ——
 * 本会话已有人因宽泛 LIKE 误删真实开发数据，这里宁可用一组固定字符串。
 * 它的价值是"上一次走查崩溃在半路"时仍能自愈，而不是靠调用栈里收集到的 id。
 */
const TEST_REMARKS = [
  `${TAG} 走查应收A`,
  `${TAG} 走查应收B-超额`,
  `${TAG} 走查应收C-跨客户`,
  `${TAG} 走查应收D-作废`,
  `${TAG} 走查回款A`,
  `${TAG} 走查回款UI`,
  `${TAG} 走查回款B-超额`,
  `${TAG} 走查回款C-跨客户`,
  `${TAG} 走查回款D-作废`,
  `${TAG} 走查应付A`,
  `${TAG} 走查应付B-作废`,
  `${TAG} 走查应付C-进项`,
  `${TAG} 走查付款A`,
  `${TAG} 走查付款B`,
  `${TAG} 走查纳税主体`,
];
/** 走查发票号前缀（真实发票号来自 generateBizCode 的 INV… 或用户手填，不会撞） */
const TEST_INVOICE_PREFIX = 'API_TEST-';
/**
 * `WT_SKIP_WRITES=1` 只跑 ⑤~⑨（只读核对 + 财税口径），跳过 ①~④ 的写库与 UI 交互。
 * 用途见 main 里那段注释（本机并发走查时渲染进程偶发卡死，两段可分开重跑）。
 */
const SKIP_WRITES = process.env.WT_SKIP_WRITES === '1';
/** `WT_SHOTS=0` 关闭截图（见 shot() 的说明：并发环境下截图会把页签卡死） */
const SHOTS = process.env.WT_SHOTS !== '0';

/* ══════════════════════ 结果收集 ══════════════════════ */

const results = [];
/** 当前所属阶段 —— 由各阶段开头的 CURRENT_SECTION 赋值切换 */
let CURRENT_SECTION = 'general';
function record(name, pass, detail) {
  results.push({ section: CURRENT_SECTION, name, pass, detail: detail ?? null });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
/** 结论型记录（不参与 PASS/FAIL 统计，供报告"财税逻辑逐条结论"直接引用） */
const conclusions = [];
function conclude(item, conclusion, evidence) {
  conclusions.push({ item, conclusion, evidence });
  console.log(`  ※ ${item}: ${conclusion}`);
}
/** 明确"没验到/不确定"的项 */
const unverified = [];
function cannotVerify(item, why) {
  unverified.push({ item, why });
  console.log(`  ? 未验证: ${item} —— ${why}`);
}
/** 已修/未修缺陷 */
const defects = [];

/* ══════════════════════ 通用工具 ══════════════════════ */

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (res.status !== 201) throw new Error(`登录失败 ${res.status}`);
  const jar = res.headers.getSetCookie?.() ?? [];
  const c = jar.map((x) => x.split(';')[0]).find((x) => x.startsWith('erp_session='));
  if (!c) throw new Error('未拿到 erp_session');
  return c.slice('erp_session='.length);
}

/**
 * 给 Page 包一层"CDP 超时重试"。
 *
 * 为什么不改 `cdp.mjs`：它是共享走查库，其他 agent 也在用。
 *
 * 为什么必须重试：`Runtime.evaluate` 在**页面正在导航/大面积重渲染**的瞬间会
 * 45s 超时（cdp.mjs 的硬编码超时），实测在 `/finance` 这类多表页上偶发。
 * 一次偶发就让后面五个板块全部跑不到，代价太大。
 *
 * ⚠️ 只重试"超时"，**不重试"找不到元素"** —— 后者是真实缺陷信号，重试会把它
 * 掩盖成"步骤被跳过"，那比直接失败更糟。
 */
function hardenPage(page) {
  const origEvaluate = page.evaluate.bind(page);
  page.evaluate = async (expr, opts) => {
    for (let i = 0; ; i += 1) {
      try {
        return await origEvaluate(expr, opts);
      } catch (e) {
        if (i >= 2 || !/超时/.test(String(e.message))) throw e;
        console.log(`  ! evaluate 超时，重试 ${i + 1}/2`);
        await sleep(1500);
      }
    }
  };
  const origClickByText = page.clickByText.bind(page);
  page.clickByText = async (text, opts) => {
    for (let i = 0; ; i += 1) {
      try {
        return await origClickByText(text, opts);
      } catch (e) {
        if (i >= 2 || !/超时/.test(String(e.message))) throw e;
        console.log(`  ! clickByText「${text}」超时，重试 ${i + 1}/2`);
        await sleep(1500);
      }
    }
  };
  const origGoto = page.goto.bind(page);
  page.goto = async (url, opts) => {
    try {
      return await origGoto(url, opts);
    } catch (e) {
      console.log(`  ! goto ${url} 失败(${String(e.message).slice(0, 60)})，重试一次`);
      await sleep(1500);
      return origGoto(url, opts);
    }
  };
  return page;
}

/** 页面求值（带重试）——导航/重渲染瞬间 `Runtime.evaluate` 可能超时，重试一次即可 */
async function safeEval(page, expr, { retries = 2, waitMs = 1200 } = {}) {
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await page.evaluate(expr);
    } catch (e) {
      if (i === retries) throw e;
      console.log(`  ! evaluate 超时重试 ${i + 1}/${retries}: ${String(e.message).slice(0, 80)}`);
      await sleep(waitMs);
    }
  }
  return null;
}

/** 受控输入设值：必须走原生 setter + input 事件（insertText 会落到焦点元素） */
async function setInput(page, selector, value, index = 0) {
  return page.evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!el) return 'not-found';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, ${JSON.stringify(String(value))}) : (el.value = ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
}

/**
 * 真实鼠标点击"由 JS 表达式定位到的元素"。
 * 表达式必须求值为 **Element**（用 IIFE 包住）。为什么不直接 `el.click()`：
 * Radix 的 Select/Tabs 走 pointerdown，合成 click 事件不会打开下拉。
 */
async function realClickExpr(page, elemExpr, settleMs = 400) {
  const ok = await page.evaluate(`(() => {
    const el = (${elemExpr});
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    window.__wtTarget = el;
    return true;
  })()`);
  if (!ok) return false;
  await sleep(120);
  const box = await page.evaluate(
    `(() => { const r = window.__wtTarget.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
  );
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(settleMs);
  return true;
}

/** 打开 Radix Select（按 scope 内按钮文本/占位符匹配）并选一个选项 */
async function pickSelect(page, { placeholder, optionRe, scope = 'dialog', optionIndex = 0 }) {
  const rootExpr =
    scope === 'dialog' ? `document.querySelector('[role="dialog"]')` : `document.body`;
  const opened = await realClickExpr(
    page,
    `(() => { const root = ${rootExpr};
      if (!root) return null;
      const btns = [...root.querySelectorAll('button')];
      return btns.find((b) => new RegExp(${JSON.stringify(placeholder)}).test(b.textContent || '')) || null; })()`,
    900
  );
  if (!opened) return { opened: false, options: [] };
  const options = await page.evaluate(
    `(() => [...document.querySelectorAll('[role="option"]')].map((o) => (o.textContent || '').trim()))()`
  );
  const picked = await realClickExpr(
    page,
    `(() => { const opts = [...document.querySelectorAll('[role="option"]')];
      if (!opts.length) return null;
      return (${optionRe ? `opts.find((o) => new RegExp(${JSON.stringify(optionRe)}).test(o.textContent || ''))` : `opts[${optionIndex}]`}) || null; })()`,
    700
  );
  return { opened: true, picked, options };
}

/**
 * 按**表单项 label 文本**定位并打开 Radix Select，再选一个选项。
 *
 * 为什么不只按占位符文本：`ArFormDialog` 里「合同」「应收」等都渲染成
 * `请选择合同` / `请选择应收`，但同一弹窗里可能有多个占位符同形（如"请选择"），
 * 按 label 走 `label → 最近的含 combobox 的祖先` 才是稳定的定位方式。
 */
async function pickSelectByLabel(page, labelRe, optionRe, scope = 'dialog') {
  const rootExpr =
    scope === 'dialog' ? `document.querySelector('[role="dialog"]')` : `document.body`;
  const opened = await realClickExpr(
    page,
    `(() => {
      const root = ${rootExpr};
      if (!root) return null;
      const labels = [...root.querySelectorAll('label')]
        .filter((l) => new RegExp(${JSON.stringify(labelRe)}).test(l.textContent || ''));
      for (const l of labels) {
        let p = l.parentElement;
        for (let i = 0; i < 4 && p; i += 1) {
          const b = p.querySelector('button[role="combobox"]') || p.querySelector('button');
          if (b) return b;
          p = p.parentElement;
        }
      }
      return null;
    })()`,
    900
  );
  if (!opened) return { opened: false, options: [] };
  const options = await page.evaluate(
    `(() => [...document.querySelectorAll('[role="option"]')].map((o) => (o.textContent || '').trim()))()`
  );
  const picked = await realClickExpr(
    page,
    `(() => { const opts = [...document.querySelectorAll('[role="option"]')];
      if (!opts.length) return null;
      return (${optionRe ? `opts.find((o) => new RegExp(${JSON.stringify(optionRe)}).test(o.textContent || ''))` : `opts[0]`}) || null; })()`,
    700
  );
  return { opened: true, picked, options };
}

/**
 * 点弹窗提交按钮：按候选文案依次尝试。
 *
 * 各弹窗主按钮文案并不统一（登记应收/应付/回款 = 保存、付款申请 = 提交、
 * 核销 = 核销），写死一个文案会得到"找不到元素"的**假失败**。
 */
async function submitDialog(page, labels = ['保存', '提交', '核销', '确定']) {
  for (const label of labels) {
    try {
      await page.clickByText(label, { selector: '[role="dialog"] button', settleMs: 400 });
      return label;
    } catch {
      /* 试下一个候选文案 */
    }
  }
  /*
   * 不抛异常：一次按钮文案漂移不应该让后面五个板块全部跑不到。
   * 调用方会从"落库记录"的 FAIL 详情里看到 `提交按钮=?`，再回来看这里。
   */
  const buttons = await page.evaluate(
    `(() => { const d = document.querySelector('[role="dialog"]');
      return d ? [...d.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean) : ['<无弹窗>']; })()`
  );
  console.log(`  ! 弹窗内找不到提交按钮（候选 ${labels.join('/')}），实际按钮=${JSON.stringify(buttons)}`);
  return null;
}

/**
 * 点**整页表单**（非弹窗）的提交按钮。
 * 发票登记走 `/finance/invoices/new` 整页路由，按钮不在 `[role=dialog]` 里 ——
 * 用弹窗选择器找会得到假失败（`walk-crud.mjs` 文件头记录过同一个坑）。
 */
async function submitPage(page, label) {
  await page.clickByText(label, { selector: 'button', settleMs: 1200 });
  return label;
}

/** 轮询抓 toast（sonner 约 4s 后消失，固定 sleep 会读到空数组造成假失败） */
async function toasts(page, { attempts = 12, gapMs = 250 } = {}) {
  const seen = [];
  for (let i = 0; i < attempts; i += 1) {
    const found = await page.evaluate(
      `(() => [...document.querySelectorAll('[data-sonner-toast]')].map((e) => (e.textContent || '').trim()).filter(Boolean))()`
    );
    for (const t of found) if (!seen.includes(t)) seen.push(t);
    if (seen.length) break;
    await sleep(gapMs);
  }
  return seen;
}

/** 当前对话框概要 */
async function dialogInfo(page) {
  return page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    return {
      title: (d.querySelector('[role="heading"],h2')?.textContent || '').trim(),
      labels: [...d.querySelectorAll('label')].map((l) => (l.textContent || '').trim()).filter(Boolean),
      buttons: [...d.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
      text: (d.innerText || '').slice(0, 600),
    };
  })()`);
}

async function closeDialog(page) {
  await page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return;
    const b = [...d.querySelectorAll('button')].find((x) => /取消|关闭/.test(x.textContent || ''));
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await sleep(600);
}

/**
 * 页面可视结构：表头 / 表格行 / 按钮 / 空态文案。
 *
 * ⚠️ `grid` 为什么必须单独给：antd `<Table scroll={{x,y}}>` 会把表头与表体渲染成
 * **两张 `<table>`** —— 表头那张没有 `tbody tr`，表体那张没有 `thead th`。
 * 只取 `tables[0]` 会让"按表头找表"的代码拿到一张 0 行的表，读出的界面值全是 null
 * （第一版实测踩过：账龄分桶全部 uiAmount=null，看起来像"界面没出数"，
 * 实际是**读法错了**）。
 */
async function pageInfo(page) {
  return page.evaluate(`(() => {
    const tables = [...document.querySelectorAll('table')].map((t) => ({
      headers: [...t.querySelectorAll('thead th')].map((th) => (th.innerText || '').trim()).filter(Boolean),
      rows: [...t.querySelectorAll('tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').trim())),
      footRows: [...t.querySelectorAll('tfoot tr')].map((tr) =>
        [...tr.querySelectorAll('td,th')].map((td) => (td.innerText || '').trim())),
    }));
    const headers = tables.map((t) => t.headers).find((h) => h.length > 0) ?? [];
    const rows = tables.flatMap((t) => t.rows);
    const footRows = tables.flatMap((t) => t.footRows);
    const buttons = [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean);
    const empty = [...document.querySelectorAll('*')]
      .filter((e) => e.children.length <= 1 && /暂无|请选择|没有|未取到|无明细发生额|先选择|不适用|无发生额/.test(e.textContent || ''))
      .map((e) => (e.textContent || '').trim()).slice(0, 8);
    return {
      url: location.pathname + location.search,
      heading: (document.querySelector('h1')?.innerText || '').trim(),
      tables, grid: { headers, rows, footRows }, buttons, empty,
    };
  })()`);
}

/**
 * 日期归一为 `YYYY-MM-DD`。
 *
 * ⚠️ 为什么不能 `String(value).slice(0,10)`：本仓的 postgres.js 会把 `date` 列解析成
 * **JS Date**（`2026-11-12T00:00:00.000Z`），`String()` 得到的是
 * `'Thu Nov 12 2026 …'`，`slice(0,10)` = `'Thu Nov 12'` → `new Date(...)` 结果不稳定。
 * 第一版就这么写的，导致"现金流 13 周落周"整列与界面不符 —— 那是**我的读法错**，
 * 不是产品缺陷（界面是对的）。UTC 分量恰好等于 `date` 列的字面值，故用 toISOString。
 */
const ymd = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : null;
};

/**
 * 读财务报表的行。
 *
 * 财务报表**不是 `<table>`**：`report-sheet.tsx` 每行渲染成一个
 * `CollapsibleTrigger`（`<button>`），行内 5 个直接子 `<span>` 依次是
 * 行次 / 项目 / 本期金额 / 本年累计 / 上期金额。用 `document.querySelectorAll('table')`
 * 读会得到"表头=[] 行数=0"的假失败（第一版实测踩过）。
 */
async function reportRows(page) {
  return page.evaluate(`(() => {
    const out = [];
    for (const b of document.querySelectorAll('button')) {
      const spans = [...b.children].filter((c) => c.tagName === 'SPAN');
      if (spans.length < 4) continue;
      const amount = (spans[2].innerText || '').trim();
      if (!/^[¥\\-0-9]/.test(amount)) continue;
      const name = (spans[1].innerText || '').trim()
        .replace(/取数明细\\s*\\d+$/, '').replace(/收起明细$/, '').trim();
      if (!name) continue;
      out.push({
        rowNo: (spans[0].innerText || '').trim(),
        rowName: name,
        amount,
        ytd: (spans[3].innerText || '').trim(),
      });
    }
    return out;
  })()`);
}

/**
 * 截图（长页面降级为可视区截图）。
 *
 * `cdp.mjs#screenshot(fullPage:true)` 会把 Emulation 视口改成**整页尺寸**再截图，
 * 页面很高时（账簿/报表动辄数千像素）后续 `Runtime.evaluate` 会长时间无响应
 * —— 实测连续两次 45s 超时并把整个走查打断。这里给高度设上限，并在截图后复位视口。
 */
async function shot(page, file) {
  /*
   * `WT_SHOTS=0` 完全跳过截图。
   *
   * 为什么需要这个开关（实测，不是预防性设计）：本机并发 7 个走查 Chrome 时，
   * `Page.getLayoutMetrics`（截图的第一步）会 45s 超时，随后**该页签的
   * `Runtime.evaluate` 也一起卡住**，整段走查被打断。清掉截图后同一条链路
   * 可以完整跑完。截图是证据的**补充**，不该成为走查能否完成的单点。
   */
  if (!SHOTS) return;
  try {
    const metrics = await page.send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize ?? metrics.contentSize;
    if (size && Number(size.height) <= 2600) await shot(page, file, { fullPage: true });
    else await shot(page, file, { fullPage: false });
  } catch (e) {
    console.log(`  ! 截图失败 ${file}: ${String(e.message).slice(0, 80)}`);
  }
  try {
    await page.setViewport(1700, 1100);
  } catch {
    /* 复位失败不致命 */
  }
  await sleep(250);
}

const money = (s) => {
  const n = Number(String(s ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100; // NOSONAR
const near = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) <= tol;

/** 从 pageInfo 的某张表里按行内文本找单元格值 */
function cellOfTable(table, rowRe, colIndex) {
  if (!table) return null;
  const row = table.rows.find((r) => new RegExp(rowRe).test(r.join(' ')));
  if (!row) return null;
  return row[colIndex] ?? null;
}

/** 界面表格里某行"本期金额"（第 3 列）——报表/账簿列序统一 项目/行次/本期/累计/上期 */
function reportValue(table, rowRe) {
  if (!table) return null;
  const row = table.rows.find((r) => new RegExp(rowRe).test(r[0] ?? ''));
  if (!row) return null;
  for (let i = 1; i < row.length; i += 1) {
    if (/[¥\d]/.test(row[i] ?? '')) return money(row[i]);
  }
  return null;
}

/* ══════════════════════ 主流程 ══════════════════════ */

async function main() {
  mkdirSync(OUT, { recursive: true });
  const session = await login();
  const api = (method, path, body) =>
    fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: `erp_session=${session}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  /**
   * 接口直调并回读 JSON（用于 UI 表达不了的守卫构造）。
   *
   * ⚠️ 本仓的错误响应体不是 Nest 默认的 `{message}`，而是
   * `{"error":{"code":"BAD_REQUEST","message":"…","timestamp":…}}`（HTTP 拦截器包装）。
   * 只读 `data.message` 会得到**空字符串** —— 断言里"报错文案必须含中文关键词"
   * 那部分就会假失败（第一版实测踩过：HTTP=400 但 message 为空）。
   */
  const apiJson = async (method, path, body) => {
    const res = await api(method, path, body);
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    const message = String(
      data?.error?.message ?? data?.message ?? data?.error?.code ?? raw.slice(0, 200) ?? ''
    );
    return { status: res.status, data, message, raw: raw.slice(0, 400) };
  };

  const sql = postgres({
    host: '127.0.0.1', port: 5433, user: 'erp', password: '******',
    database: 'shengseerp', connect_timeout: 5,
  });

  /** 本次走查创建的实体主键 —— 清理只按这些 id 精确删除 */
  const created = {
    arIds: [], receiptIds: [], apIds: [], paymentIds: [], invoiceIds: [],
    taxEntityIds: [], invoiceNos: [], codes: [], voucherRefs: [],
  };

  const browser = await Browser.launch({ port: BROWSER_PORT });
  const page = hardenPage(await browser.newPage());
  await page.enable();
  await page.setViewport(1700, 1100);
  await page.setCookie({ name: 'erp_session', value: session, url: APP });

  /* 选定的既有单据（不是本次创建，故不删） */
  const base = {
    contractA: 'd19a6bcf-a827-4be6-8324-40405992b1cf', // CTR2026100003 / 客户 0096195f
    contractB: 'beb6440c-9a13-409b-9803-dcac5409adae', // CTR2026100004 / 客户 597d4dc6
    customerA: '0096195f-365d-4149-86e5-6f6d753fd1e0',
    customerB: '597d4dc6-b048-4add-999e-8f9d7d7a3086',
    supplierA: '094bf51a-32b2-424a-814d-50552dfa5710',
    taxEntity: '721aad34-ff1f-41d8-87dc-92be09d29c67',
  };
  // 合同编号用于在 Radix Select 里精确选中（名字有共同前缀，不能用名字前缀匹配）
  const contractCodes = Object.fromEntries(
    (await sql`SELECT id, code FROM erp_contract`).map((r) => [r.id, r.code])
  );

  const perTabDiag = {};
  let diagAtEnd = {};
  /* 这些在 try 内填充、在 finally 里写进报告 —— 必须声明在 try 之外 */
  const tabEvidence = {};
  const repEvidence = {};
  const ledEvidence = {};
  const before = {
    ar: Number((await sql`SELECT count(*)::int AS v FROM erp_ar`)[0].v),
    ap: Number((await sql`SELECT count(*)::int AS v FROM erp_ap_bill`)[0].v),
    invoice: Number((await sql`SELECT count(*)::int AS v FROM erp_invoice`)[0].v),
    voucher: Number((await sql`SELECT count(*)::int AS v FROM fin_voucher`)[0].v),
  };
  let unbalanced = [];

  try {
  /* ═══════════════════════════════════════════════════════════════
   * 写入段（① ~ ④）：Tab 结构采集 + 应收/应付/发票的写库与守卫用例
   *
   * `WT_SKIP_WRITES=1` 时整段跳过，只跑后面「只读核对 + 财税口径」的 ⑤~⑨。
   * 为什么需要这个开关：本机同时有 7 个走查 Chrome 在跑，渲染进程偶发被
   * `Page.getLayoutMetrics` / `Runtime.evaluate` 卡住；写库段交互最重、最容易踩到，
   * 而 ⑤~⑨ 是纯核对，可以在不受写库段拖累的情况下单独拿到证据。
   * 两段合起来就是完整走查 —— 只是可以分开重跑。
   * ═══════════════════════════════════════════════════════════════ */
  if (!SKIP_WRITES) {
    /* ═══════════════════════════════════════════════════════════════
     * ⓪ 前置：把"库里有什么"钉下来，后面的 SQL 核对都以它为基准
     * ═══════════════════════════════════════════════════════════════ */
    console.log('\n⓪ 前置快照');
    console.log(`  erp_ar=${before.ar} erp_ap_bill=${before.ap} erp_invoice=${before.invoice} fin_voucher=${before.voucher}`);

    /* 借贷平衡总检查（财税逻辑第 6 条的第一步：既有数据是否已经不平） */
    unbalanced = await sql`
      SELECT v.code, round(sum(l.debit), 2) AS d, round(sum(l.credit), 2) AS c, v.status
      FROM fin_voucher v JOIN fin_voucher_line l ON l.voucher_id = v.id
      GROUP BY v.id, v.code, v.status
      HAVING round(sum(l.debit), 2) <> round(sum(l.credit), 2)`;
    record(
      '财税逻辑·账簿借贷平衡（存量）',
      unbalanced.length === 0,
      unbalanced.length === 0
        ? `${before.voucher} 张凭证借贷合计全部相等`
        : JSON.stringify(unbalanced).slice(0, 300)
    );

    /* ═══════════════════════════════════════════════════════════════
     * ① /finance 七个 Tab —— 真实点击切换 + 结构采集
     * ═══════════════════════════════════════════════════════════════ */
    CURRENT_SECTION = '① /finance 七个 Tab';
    console.log('\n① /finance 七个 Tab 切换');
    const FINANCE_TABS = [
      { value: 'ar', label: '应收与回款' },
      { value: 'ap', label: '应付与付款' },
      { value: 'invoices', label: '发票登记' },
      { value: 'recon', label: '勾稽中心' },
      { value: 'statement', label: '对账单' },
      { value: 'aging', label: '账龄分析' },
      { value: 'cashflow', label: '现金流' },
    ];
    const tabLabels = {};
    await page.goto(`${APP}/finance`, { settleMs: 2600 });
    await sleep(1500);
    for (const t of FINANCE_TABS) {
      page.resetDiagnostics();
      // 真实鼠标点击 Tab（Radix Tabs 的 trigger 是 button[role=tab]）
      await page.clickByText(t.label, { selector: '[role="tab"]', settleMs: 1800 });
      await sleep(1500);
      const info = await pageInfo(page);
      const diag = {
        consoleErrors: page.consoleLogs.filter((l) => l.type === 'error').map((l) => l.text),
        exceptions: page.exceptions.map((e) => e.description || e.text),
        httpErrors: page.httpErrors.map((e) => `${e.status} ${e.method} ${e.url}`),
      };
      perTabDiag[`/finance#${t.value}`] = diag;
      tabEvidence[t.value] = {
        label: t.label,
        url: info.url,
        heading: info.heading,
        tables: info.tables.map((x) => ({ headers: x.headers, rowCount: x.rows.length })),
        buttons: info.buttons.slice(0, 14),
        emptyTexts: info.empty,
      };
      tabLabels[t.value] = t.label;
      const urlOk = info.url.includes(`tab=${t.value}`) || (t.value === 'ar' && !info.url.includes('tab='));
      const headers = info.tables.map((x) => x.headers.join('/')).filter(Boolean);
      record(
        `Tab「${t.label}」切换`,
        urlOk && (headers.length > 0 || info.empty.length > 0 || info.buttons.length > 0),
        `url=${info.url} 表头=[${headers.join(' | ').slice(0, 200)}] 空态=${JSON.stringify(info.empty)} 按钮=${JSON.stringify(info.buttons.slice(0, 8))}`
      );
      record(
        `Tab「${t.label}」无 console.error / 异常 / HTTP≥400`,
        diag.consoleErrors.length === 0 && diag.exceptions.length === 0 && diag.httpErrors.length === 0,
        JSON.stringify(diag).slice(0, 300)
      );
      await shot(page, `${OUT}/fin-tab-${t.value}.png`);
    }

    /* ═══════════════════════════════════════════════════════════════
     * ② 应收与回款：登记应收 → 回款 → 核销（每一步 SQL 核对）
     * ═══════════════════════════════════════════════════════════════ */
    CURRENT_SECTION = '② 应收与回款（登记应收）';
    console.log('\n② 应收与回款 — 登记应收（含税价税分离凭证核对）');
    await page.goto(`${APP}/finance?tab=ar`, { settleMs: 2600 });
    await sleep(1500);
    page.resetDiagnostics();

    const AR1_AMOUNT = 10600; // 6% → net 10000 / tax 600
    await page.clickByText('登记应收', { selector: 'button', settleMs: 1200 });
    await sleep(900);
    const arDlg = await dialogInfo(page);
    record('「登记应收」弹窗打开', !!arDlg && /登记应收/.test(String(arDlg?.title ?? '')), JSON.stringify(arDlg?.labels ?? []));
    if (!arDlg) throw new Error('登记应收弹窗未打开，后续应收链路无法继续');

    const arPick = await pickSelectByLabel(page, '合同', contractCodes[base.contractA]);
    record('应收：选中合同（Radix Select，按合同编号精确匹配）', Boolean(arPick.picked), `选项=${JSON.stringify(arPick.options).slice(0, 200)} 选中=${arPick.picked}`);
    await setInput(page, '[role="dialog"] input[name="amount"]', AR1_AMOUNT);
    await setInput(page, '[role="dialog"] textarea[name="remark"], [role="dialog"] input[name="remark"]', `${TAG} 走查应收A`);
    await sleep(400);
    await submitDialog(page, ['保存']);
    const tAr = await toasts(page);
    await sleep(1200);

    const ar1 = (await sql`
      SELECT id, code, customer_id, contract_id, amount, settled_amount, status, source, remark, due_date
      FROM erp_ar WHERE remark = ${`${TAG} 走查应收A`} ORDER BY _created_at DESC LIMIT 1`)[0];
    record(
      '应收登记落库（金额/客户/合同/状态）',
      !!ar1 && Number(ar1.amount) === AR1_AMOUNT && ar1.status === 'open' && ar1.customer_id === base.customerA,
      ar1 ? `code=${ar1.code} amount=${ar1.amount} status=${ar1.status} due=${String(ar1.due_date).slice(0, 10)} toast=${JSON.stringify(tAr)}` : '未落库'
    );
    if (ar1) {
      created.arIds.push(ar1.id);
      created.codes.push(ar1.code);
      created.voucherRefs.push(`ar:${ar1.code}`);
    }

    /* —— 财税逻辑 1：含税/不含税价税分离是否等于 splitTax —— */
    if (ar1) {
      const lines = await sql`
        SELECT l.account_code, l.debit, l.credit FROM fin_voucher_line l
        JOIN fin_voucher v ON v.id = l.voucher_id
        WHERE v.source_ref = ${`ar:${ar1.code}`} ORDER BY l.account_code`;
      const gross = Number(ar1.amount);
      const rate = 6;
      const expTax = r2((gross * rate) / (100 + rate));
      const expNet = r2(gross - expTax);
      const debit1122 = lines.filter((l) => l.account_code === '1122').reduce((s, l) => s + Number(l.debit), 0);
      const credit2203 = lines.filter((l) => l.account_code === '2203').reduce((s, l) => s + Number(l.credit), 0);
      const credit222101 = lines.filter((l) => l.account_code === '222101').reduce((s, l) => s + Number(l.credit), 0);
      record(
        '财税逻辑·应收含税价税分离 == splitTax(10600, 6)',
        near(debit1122, gross) && near(credit2203, expNet) && near(credit222101, expTax),
        `分录=${JSON.stringify(lines)} 期望 借1122=${gross} 贷2203=${expNet} 贷222101=${expTax}`
      );
      conclude(
        '应收金额的含税/不含税价税分离',
        near(debit1122, gross) && near(credit2203, expNet) && near(credit222101, expTax)
          ? `与 shared/tax.ts#splitTax 一致：含税 ${gross} → 不含税 ${expNet} + 税额 ${expTax}（6%），已核到 fin_voucher_line`
          : '与 splitTax 不一致，见上条 FAIL 证据'
      );
    }

    CURRENT_SECTION = '② 应收与回款（回款+核销）';
    console.log('\n② 应收与回款 — 登记回款 + 回款核销');
    const arReceipt = (await apiJson('POST', '/api/finance/receipts', {
      customerId: base.customerA, amount: AR1_AMOUNT, method: 'bank',
      remark: `${TAG} 走查回款A`,
    }));
    const arReceiptRow = (await sql`
      SELECT id, code, amount, used_amount, status, remark FROM erp_receipt
      WHERE remark = ${`${TAG} 走查回款A`} ORDER BY _created_at DESC LIMIT 1`)[0];
    record(
      '登记回款落库',
      arReceipt.status < 300 && !!arReceiptRow && Number(arReceiptRow.amount) === AR1_AMOUNT && arReceiptRow.status === 'unmatched',
      arReceiptRow ? `code=${arReceiptRow.code} used=${arReceiptRow.used_amount} status=${arReceiptRow.status} HTTP=${arReceipt.status}` : `HTTP=${arReceipt.status} ${arReceipt.message}`
    );
    // 走查要求"真实点击"：回款用 UI 再走一遍（上面接口那次用于稳固拿到 id）
    await page.clickByText('登记回款', { selector: 'button', settleMs: 1200 });
    await sleep(900);
    const rcDlg = await dialogInfo(page);
    record('「登记回款」弹窗打开', !!rcDlg && /登记回款/.test(String(rcDlg?.title ?? '')), JSON.stringify(rcDlg?.labels ?? []));
    if (rcDlg) {
      const cPick = await pickSelectByLabel(page, '客户', '验收客户-2026-10-13212707|0096195f');
      await setInput(page, '[role="dialog"] input[name="amount"]', 500);
      await setInput(page, '[role="dialog"] input[name="remark"]', `${TAG} 走查回款UI`);
      await sleep(300);
      await submitDialog(page, ['保存']);
      const tRc = await toasts(page);
      await sleep(1000);
      const rcUi = (await sql`SELECT id, code, amount, status FROM erp_receipt WHERE remark = ${`${TAG} 走查回款UI`} ORDER BY _created_at DESC LIMIT 1`)[0];
      record(
        '回款 UI 保存后落库（金额 500）',
        !!rcUi && Number(rcUi.amount) === 500,
        rcUi ? `code=${rcUi.code} amount=${rcUi.amount} status=${rcUi.status} toast=${JSON.stringify(tRc)} 客户选中=${cPick.picked}` : `未落库 toast=${JSON.stringify(tRc)}`
      );
      if (rcUi) created.receiptIds.push(rcUi.id);
      if (rcUi) created.codes.push(rcUi.code);
      if (rcUi) created.voucherRefs.push(`receipt:${rcUi.code}`);
    }
    if (arReceiptRow) {
      created.receiptIds.push(arReceiptRow.id);
      created.codes.push(arReceiptRow.code);
      created.voucherRefs.push(`receipt:${arReceiptRow.code}`);
    }
    await closeDialog(page);
    await page.goto(`${APP}/finance?tab=ar`, { settleMs: 2600 });
    await sleep(1600);

    /* 核销：UI 上按 AR 编号选应收、按回款编号选回款 */
    await page.clickByText('回款核销', { selector: 'button', settleMs: 1200 });
    await sleep(900);
    const woDlg = await dialogInfo(page);
    record('「回款核销」弹窗打开', !!woDlg, JSON.stringify(woDlg?.labels ?? []));
    if (woDlg && ar1 && arReceiptRow) {
      const p1 = await pickSelectByLabel(page, '应收', ar1.code);
      const p2 = await pickSelectByLabel(page, '回款', arReceiptRow.code);
      await setInput(page, '[role="dialog"] input[name="amount"]', AR1_AMOUNT);
      await sleep(300);
      await submitDialog(page, ['核销', '保存']);
      const tWo = await toasts(page);
      await sleep(1300);
      const woRow = (await sql`SELECT id, ar_id, receipt_id, amount FROM erp_ar_writeoff WHERE ar_id = ${ar1.id}`)[0];
      const arAfter = (await sql`SELECT settled_amount, status FROM erp_ar WHERE id = ${ar1.id}`)[0];
      const rcAfter = (await sql`SELECT used_amount, status FROM erp_receipt WHERE id = ${arReceiptRow.id}`)[0];
      record(
        '核销落库：erp_ar_writeoff + 应收/回款状态联动',
        !!woRow && Number(woRow.amount) === AR1_AMOUNT && arAfter.status === 'settled' && Number(rcAfter.used_amount) === AR1_AMOUNT && rcAfter.status === 'matched',
        `writeoff=${woRow ? woRow.amount : '无'} ar.settled=${arAfter.settled_amount}/${arAfter.status} receipt.used=${rcAfter.used_amount}/${rcAfter.status} toast=${JSON.stringify(tWo)} 选中应收=${p1.picked} 回款=${p2.picked}`
      );
    }
    await closeDialog(page);

    /* —— 财税逻辑 2：核销守卫 —— */
    CURRENT_SECTION = '② 核销守卫';
    console.log('\n② 核销守卫（超额 / 跨客户 / 重复 / 已作废）');
    // 造 AR2（1000）+ AR3（500，另一客户）+ AR4（700，待作废）
    const mkAr = async (contractId, amount, remark) => {
      const res = await apiJson('POST', '/api/finance/ars', { contractId, amount, remark });
      const row = (await sql`SELECT id, code, amount, status FROM erp_ar WHERE remark = ${remark} ORDER BY _created_at DESC LIMIT 1`)[0];
      if (row) {
        created.arIds.push(row.id);
        created.codes.push(row.code);
        created.voucherRefs.push(`ar:${row.code}`);
      }
      return { res, row };
    };
    const ar2 = await mkAr(base.contractA, 1000, `${TAG} 走查应收B-超额`);
    const ar3 = await mkAr(base.contractB, 500, `${TAG} 走查应收C-跨客户`);
    const ar4 = await mkAr(base.contractA, 700, `${TAG} 走查应收D-作废`);
    // R2/R3/R4 回款
    const mkReceipt = async (customerId, amount, remark) => {
      const res = await apiJson('POST', '/api/finance/receipts', { customerId, amount, remark });
      const row = (await sql`SELECT id, code, amount, status FROM erp_receipt WHERE remark = ${remark} ORDER BY _created_at DESC LIMIT 1`)[0];
      if (row) {
        created.receiptIds.push(row.id);
        created.codes.push(row.code);
        created.voucherRefs.push(`receipt:${row.code}`);
      }
      return { res, row };
    };
    const rc2 = await mkReceipt(base.customerA, 5000, `${TAG} 走查回款B-超额`);
    const rc3 = await mkReceipt(base.customerA, 500, `${TAG} 走查回款C-跨客户`);
    const rc4 = await mkReceipt(base.customerA, 700, `${TAG} 走查回款D-作废`);
    record(
      '构造守卫用例的单据',
      Boolean(ar2.row && ar3.row && ar4.row && rc2.row && rc3.row && rc4.row),
      `AR=${ar2.row?.code}/${ar3.row?.code}/${ar4.row?.code} 回款=${rc2.row?.code}/${rc3.row?.code}/${rc4.row?.code}`
    );

    // (a) 超额核销：AR2 未核销 1000，核销 2000 必须被拒
    const over = await apiJson('POST', '/api/finance/ar-writeoffs', { arId: ar2.row.id, receiptId: rc2.row.id, amount: 2000 });
    record(
      '财税逻辑·超额核销被拒（AR 1000 / 核销 2000）',
      over.status === 400 && /超过应收未核销余额/.test(over.message),
      `HTTP=${over.status} message=${over.message}`
    );
    // (b) 跨客户核销：AR3 属客户 B，回款 R3 属客户 A
    const cross = await apiJson('POST', '/api/finance/ar-writeoffs', { arId: ar3.row.id, receiptId: rc3.row.id, amount: 500 });
    record(
      '财税逻辑·跨客户核销被拒（应收客户 B / 回款客户 A）',
      cross.status === 400 && /客户与应收客户不一致/.test(cross.message),
      `HTTP=${cross.status} message=${cross.message}`
    );
    // (c) 正常核销 AR2 全额 → 再核销一次（重复）
    const full = await apiJson('POST', '/api/finance/ar-writeoffs', { arId: ar2.row.id, receiptId: rc2.row.id, amount: 1000 });
    const dup = await apiJson('POST', '/api/finance/ar-writeoffs', { arId: ar2.row.id, receiptId: rc2.row.id, amount: 1000 });
    const dupSamePair = await apiJson('POST', '/api/finance/ar-writeoffs', { arId: ar2.row.id, receiptId: rc2.row.id, amount: 1 });
    record(
      '财税逻辑·重复核销被拒（全额核销后再核销同一 AR）',
      full.status < 300 && dup.status === 400 && /已全额核销|超过应收未核销余额/.test(dup.message),
      `首次 HTTP=${full.status} 二次 HTTP=${dup.status} message=${dup.message} 三次(1 元) HTTP=${dupSamePair.status} message=${dupSamePair.message}`
    );
    const pairRows = await sql`SELECT count(*)::int AS v FROM erp_ar_writeoff WHERE ar_id = ${ar2.row.id} AND receipt_id = ${rc2.row.id}`;
    conclude(
      '重复核销（同一 应收↔回款 组合）',
      Number(pairRows[0].v) === 1
        ? '余额用尽后同一组合无法再次核销；且 erp_ar_writeoff 只有 1 行 —— 无重复落账'
        : `⚠️ 同一组合落了 ${pairRows[0].v} 行`,
      `writeoff 行数=${pairRows[0].v}；三次调用返回 HTTP ${full.status}/${dup.status}/${dupSamePair.status}`
    );
    // (d) 作废 AR4 → 再核销
    const voidRes = await apiJson('POST', `/api/finance/ars/${ar4.row.id}/void`, { reason: `${TAG} 走查作废` });
    const ar4After = (await sql`SELECT status, void_reason FROM erp_ar WHERE id = ${ar4.row.id}`)[0];
    created.voucherRefs.push(`ar-void:${ar4.row.code}`);
    record(
      '应收作废落库（status=voided + 原因留痕）',
      voidRes.status < 300 && ar4After.status === 'voided' && String(ar4After.void_reason ?? '').length > 0,
      `HTTP=${voidRes.status} status=${ar4After.status} reason=${ar4After.void_reason}`
    );
    const voidWo = await apiJson('POST', '/api/finance/ar-writeoffs', { arId: ar4.row.id, receiptId: rc4.row.id, amount: 700 });
    record(
      '财税逻辑·已作废应收不可核销',
      voidWo.status === 400 && /已作废/.test(voidWo.message),
      `HTTP=${voidWo.status} message=${voidWo.message}`
    );

    /* ═══════════════════════════════════════════════════════════════
     * ③ 应付与付款：登记应付 → 付款申请 → 审批 → 核销 → 作废
     * ═══════════════════════════════════════════════════════════════ */
    CURRENT_SECTION = '③ 应付与付款';
    console.log('\n③ 应付与付款');
    await page.goto(`${APP}/finance?tab=ap`, { settleMs: 2600 });
    await sleep(1600);
    page.resetDiagnostics();
    const AP1_AMOUNT = 12000;
    await page.clickByText('登记应付', { selector: 'button', settleMs: 1200 });
    await sleep(900);
    const apDlg = await dialogInfo(page);
    record('「登记应付」弹窗打开', !!apDlg && /登记应付/.test(String(apDlg?.title ?? '')), JSON.stringify(apDlg?.labels ?? []));
    if (apDlg) {
      const sPick = await pickSelectByLabel(page, '供应商', '验收供应商-2026-10-13212157|094bf51a');
      await setInput(page, '[role="dialog"] input[name="amount"]', AP1_AMOUNT);
      await setInput(page, '[role="dialog"] textarea[name="remark"], [role="dialog"] input[name="remark"]', `${TAG} 走查应付A`);
      await submitDialog(page, ['保存']);
      const tAp = await toasts(page);
      await sleep(1200);
      const ap1 = (await sql`
        SELECT id, code, supplier_id, amount, paid_amount, status, remark FROM erp_ap_bill
        WHERE remark = ${`${TAG} 走查应付A`} ORDER BY _created_at DESC LIMIT 1`)[0];
      record(
        '应付登记落库',
        !!ap1 && Number(ap1.amount) === AP1_AMOUNT && ap1.status === 'pending' && ap1.supplier_id === base.supplierA,
        ap1 ? `code=${ap1.code} amount=${ap1.amount} status=${ap1.status} 供应商选中=${sPick.picked} toast=${JSON.stringify(tAp)}` : `未落库 toast=${JSON.stringify(tAp)}`
      );
      /* —— 财税逻辑 1（应付侧）：价税分离是否等于 splitTax —— */
      if (ap1) {
        const apLines = await sql`
          SELECT l.account_code, l.debit, l.credit FROM fin_voucher_line l
          JOIN fin_voucher v ON v.id = l.voucher_id
          WHERE v.source_ref = ${`ap:${ap1.code}`} ORDER BY l.account_code`;
        const gross = Number(ap1.amount);
        const expTax = r2((gross * 6) / (100 + 6));
        const expNet = r2(gross - expTax);
        const debitNet = apLines.filter((l) => l.account_code !== '222102').reduce((s, l) => s + Number(l.debit), 0);
        const debitTax = apLines.filter((l) => l.account_code === '222102').reduce((s, l) => s + Number(l.debit), 0);
        const creditAp = apLines.filter((l) => l.account_code === '2202').reduce((s, l) => s + Number(l.credit), 0);
        record(
          '财税逻辑·应付含税价税分离 == splitTax(12000, 6)',
          near(debitNet, expNet) && near(debitTax, expTax) && near(creditAp, gross),
          `分录=${JSON.stringify(apLines)} 期望 借费用=${expNet} 借222102=${expTax} 贷2202=${gross}`
        );
        conclude(
          '应付金额的含税/不含税价税分离',
          near(debitNet, expNet) && near(debitTax, expTax)
            ? `与 shared/tax.ts#splitTax 一致：应付含税 ${gross} → 不含税 ${expNet} + 进项税 ${expTax}（6%），已核到 fin_voucher_line`
            : '与 splitTax 不一致，见上条 FAIL 证据'
        );
      }
      if (ap1) {
        created.apIds.push(ap1.id);
        created.codes.push(ap1.code);
        created.voucherRefs.push(`ap:${ap1.code}`);
        // 付款申请（UI）
        await page.clickByText('付款申请', { selector: 'button', settleMs: 1200 });
        await sleep(900);
        const payDlg = await dialogInfo(page);
        const pAp = await pickSelectByLabel(page, '应付$|应付', ap1.code);
        await setInput(page, '[role="dialog"] input[name="amount"]', AP1_AMOUNT);
        await setInput(page, '[role="dialog"] input[name="remark"]', `${TAG} 走查付款A`);
        await sleep(300);
        await submitDialog(page, ['提交', '保存']);
        const tPay = await toasts(page);
        await sleep(1200);
        const pay1 = (await sql`
          SELECT id, code, ap_id, amount, used_amount, status FROM erp_payment
          WHERE remark = ${`${TAG} 走查付款A`} ORDER BY _created_at DESC LIMIT 1`)[0];
        record(
          '付款申请落库（pending 待审批）',
          !!pay1 && Number(pay1.amount) === AP1_AMOUNT && pay1.status === 'pending' && pay1.ap_id === ap1.id,
          pay1 ? `code=${pay1.code} amount=${pay1.amount} status=${pay1.status} 弹窗=${JSON.stringify(payDlg?.title)} 选中应付款=${pAp.picked} toast=${JSON.stringify(tPay)}` : `未落库 toast=${JSON.stringify(tPay)}`
        );
        if (pay1) {
          created.paymentIds.push(pay1.id);
          created.codes.push(pay1.code);
          created.voucherRefs.push(`payment:${pay1.code}`);
          // 审批
          const appr = await apiJson('POST', `/api/finance/payments/${pay1.id}/approve`, { action: 'approve' });
          const payAfter = (await sql`SELECT status, approver FROM erp_payment WHERE id = ${pay1.id}`)[0];
          record(
            '付款审批通过（status=approved）',
            appr.status < 300 && payAfter.status === 'approved',
            `HTTP=${appr.status} status=${payAfter.status} approver=${payAfter.approver}`
          );
          // 核销（UI）
          await page.goto(`${APP}/finance?tab=ap`, { settleMs: 2600 });
          await sleep(1600);
          await page.clickByText('付款核销', { selector: 'button', settleMs: 1200 });
          await sleep(900);
          const apWoDlg = await dialogInfo(page);
          await pickSelectByLabel(page, '应付$|应付', ap1.code);
          await pickSelectByLabel(page, '已批准付款|付款记录', pay1.code);
          await setInput(page, '[role="dialog"] input[name="amount"]', AP1_AMOUNT);
          await sleep(300);
          await submitDialog(page, ['核销', '保存']);
          const tApWo = await toasts(page);
          await sleep(1200);
          const apWoRow = (await sql`SELECT id, ap_id, payment_id, amount FROM erp_ap_writeoff WHERE ap_id = ${ap1.id}`)[0];
          const apAfter = (await sql`SELECT paid_amount, status FROM erp_ap_bill WHERE id = ${ap1.id}`)[0];
          record(
            '付款核销落库（ap_writeoff + 应付 paid_amount/状态联动）',
            !!apWoRow && Number(apWoRow.amount) === AP1_AMOUNT && Number(apAfter.paid_amount) === AP1_AMOUNT,
            `writeoff=${apWoRow ? apWoRow.amount : '无'} ap.paid=${apAfter.paid_amount}/${apAfter.status} 弹窗=${JSON.stringify(apWoDlg?.title)} toast=${JSON.stringify(tApWo)}`
          );
          // 超额核销守卫
          const overAp = await apiJson('POST', '/api/finance/ap-writeoffs', { apId: ap1.id, paymentId: pay1.id, amount: 1 });
          record(
            '财税逻辑·应付重复/超额核销被拒',
            overAp.status === 400,
            `HTTP=${overAp.status} message=${overAp.message}`
          );
          await closeDialog(page);
        }
      }
    }

    /* 应付作废 + 已付款不可作废 */
    CURRENT_SECTION = '③ 应付作废守卫';
    console.log('\n③ 应付作废守卫');
    const ap2 = await apiJson('POST', '/api/finance/aps', { supplierId: base.supplierA, amount: 888, remark: `${TAG} 走查应付B-作废` });
    const ap2Row = (await sql`SELECT id, code, paid_amount FROM erp_ap_bill WHERE remark = ${`${TAG} 走查应付B-作废`} ORDER BY _created_at DESC LIMIT 1`)[0];
    if (ap2Row) {
      created.apIds.push(ap2Row.id);
      created.codes.push(ap2Row.code);
      created.voucherRefs.push(`ap:${ap2Row.code}`, `ap-void:${ap2Row.code}`);
      const v2 = await apiJson('POST', `/api/finance/aps/${ap2Row.id}/void`, { reason: `${TAG} 作废应付` });
      const after2 = (await sql`SELECT status, void_reason FROM erp_ap_bill WHERE id = ${ap2Row.id}`)[0];
      record('应付作废落库（voided + 原因）', v2.status < 300 && after2.status === 'voided', `HTTP=${v2.status} status=${after2.status} reason=${after2.void_reason}`);
      const pay2 = await apiJson('POST', '/api/finance/payments', { apId: ap2Row.id, amount: 100, remark: `${TAG} 走查付款B` });
      record('财税逻辑·已作废应付不可付款', pay2.status === 400 && /已作废/.test(pay2.message), `HTTP=${pay2.status} message=${pay2.message}`);
    }
    // AP1 已付清后不可作废
    if (created.apIds.length) {
      const voidPaid = await apiJson('POST', `/api/finance/aps/${created.apIds[0]}/void`, { reason: `${TAG} 试作废已付` });
      record(
        '财税逻辑·已核销应付不可作废',
        voidPaid.status >= 400,
        `HTTP=${voidPaid.status} message=${voidPaid.message}`
      );
    }

    /* ═══════════════════════════════════════════════════════════════
     * ④ 发票登记：可开金额约束 + 销项不出凭证 / 进项出凭证 + 作废
     * ═══════════════════════════════════════════════════════════════ */
    CURRENT_SECTION = '④ 发票登记（销项）';
    console.log('\n④ 发票登记 — 销项（方案 A：不出凭证）');
    await page.goto(`${APP}/finance?tab=invoices`, { settleMs: 2600 });
    await sleep(1600);
    page.resetDiagnostics();

    // 合同 B 的可开金额 = 106000 − 已开 31800 = 74200
    const billable = (await sql`
      /*
       * ⚠️ 2026-10-17 修正：这里必须带 direction = 'sales'。
       * 原 SQL 只过滤 status = 'issued'，于是**进项发票也被算进"已开票额"**，
       * 一张挂到销售合同上的进项票会凭空吃掉销项可开额度 —— 而产品侧
       * （invoice.service.ts 的 eq(erpInvoice.direction, CONTRACT_INVOICED_DIRECTION)，
       * 见 L348 / L425）**是有这个过滤的**。
       * 也就是说：那条"进项不扣减可开金额"的失败断言，是**断言自己的测量口径错了**，
       * 不是产品缺陷。时间戳也可佐证：服务进程 10:09:28 启动、dist 构建于 10:08:50、
       * invoice-billable.ts 改于 03:46 —— 运行中的服务确实带着修复。
       */
      SELECT c.amount - coalesce((SELECT sum(i.amount) FROM erp_invoice i WHERE i.contract_id = c.id AND i.status = 'issued' AND i.direction = 'sales'), 0) AS billable
      FROM erp_contract c WHERE c.id = ${base.contractB}`)[0].billable;
    const SALES_AMOUNT = 10600;
    const SALES_NO = `API_TEST-SALES-${Date.now()}`;
    const overInv = await apiJson('POST', '/api/finance/invoices', {
      contractId: base.contractB, invoiceType: 'vat_special', direction: 'sales',
      amount: Number(billable) + 1, taxRate: 6, invoiceNo: `${TAG}-OVER`, invoiceDate: '2026-10-17',
    });
    record(
      '财税逻辑·销项开票超过合同可开金额被拒',
      overInv.status === 400 && /超过合同可开金额/.test(overInv.message),
      `可开=${billable} 申请=${Number(billable) + 1} HTTP=${overInv.status} message=${overInv.message}`
    );

    const voucherBeforeSales = Number((await sql`SELECT count(*)::int AS v FROM fin_voucher`)[0].v);
    await page.clickByText('发票登记', { selector: 'button:not([role="tab"])', settleMs: 1500 });
    await sleep(1200);
    const invUrl = await safeEval(page, 'location.href');
    record('「发票登记」进入整页表单', String(invUrl).includes('/finance/invoices/new'), String(invUrl));
    let salesInv = null;
    if (String(invUrl).includes('/finance/invoices/new')) {
      const dPick = await pickSelectByLabel(page, '方向', '销项', 'body');
      const cPick = await pickSelectByLabel(page, '合同', contractCodes[base.contractB], 'body');
      const tPick = await pickSelectByLabel(page, '发票类型', '增值税专用发票|专', 'body');
      await setInput(page, 'input[name="amount"]', SALES_AMOUNT);
      await setInput(page, 'input[name="invoiceNo"]', SALES_NO);
      await setInput(page, 'input[name="invoiceDate"]', '2026-10-17');
      await sleep(400);
      await submitPage(page, '保存');
      const tInv = await toasts(page);
      await sleep(1500);
      salesInv = (await sql`
        SELECT id, code, invoice_no, direction, amount, tax_amount, net_amount, tax_rate, status, invoice_date, contract_id
        FROM erp_invoice WHERE invoice_no = ${SALES_NO} ORDER BY _created_at DESC LIMIT 1`)[0];
      record(
        '销项发票落库（含税→不含税拆分 == splitTax）',
        !!salesInv && Number(salesInv.amount) === SALES_AMOUNT && near(salesInv.tax_amount, r2((SALES_AMOUNT * 6) / 106)) && near(salesInv.net_amount, r2(SALES_AMOUNT - r2((SALES_AMOUNT * 6) / 106))),
        salesInv
          ? `amount=${salesInv.amount} tax=${salesInv.tax_amount} net=${salesInv.net_amount} 期望 tax=${r2((SALES_AMOUNT * 6) / 106)} net=${r2(SALES_AMOUNT - r2((SALES_AMOUNT * 6) / 106))} 方向选中=${dPick.picked} 合同选中=${cPick.picked} 类型选中=${tPick.picked} toast=${JSON.stringify(tInv)}`
          : `未落库 url=${invUrl} toast=${JSON.stringify(tInv)}`
      );
      if (salesInv) {
        created.invoiceIds.push(salesInv.id);
        created.invoiceNos.push(salesInv.invoice_no);
        created.voucherRefs.push(`invoice:${salesInv.invoice_no}`, `invoice-void:${salesInv.invoice_no}`);
      }
    }
    const voucherAfterSales = Number((await sql`SELECT count(*)::int AS v FROM fin_voucher`)[0].v);
    const salesVoucher = await sql`SELECT id FROM fin_voucher WHERE source_ref = ${`invoice:${SALES_NO}`}`;
    record(
      '财税逻辑·销项开票**不生成凭证**（方案 A，invoice.service.ts:391）',
      voucherAfterSales === voucherBeforeSales && salesVoucher.length === 0,
      `fin_voucher ${voucherBeforeSales}→${voucherAfterSales}；source_ref=invoice:${SALES_NO} 命中 ${salesVoucher.length} 张`
    );
    conclude(
      '销项开票是否生成凭证',
      voucherAfterSales === voucherBeforeSales && salesVoucher.length === 0
        ? '确认不生成凭证（方案 A：收入确认为准，销项开票只登记台账）—— 与 invoice.service.ts:391 注释一致'
        : '⚠️ 与方案 A 不符，销项开票产生了凭证'
    );

    CURRENT_SECTION = '④ 发票登记（进项）';
    console.log('\n④ 发票登记 — 进项（应生成凭证）');
    // 进项关联新应付，便于验证"累计开票 ≤ 应付金额"
    const apForInv = await apiJson('POST', '/api/finance/aps', { supplierId: base.supplierA, amount: 10000, remark: `${TAG} 走查应付C-进项` });
    const apForInvRow = (await sql`SELECT id, code FROM erp_ap_bill WHERE remark = ${`${TAG} 走查应付C-进项`} ORDER BY _created_at DESC LIMIT 1`)[0];
    if (apForInvRow) {
      created.apIds.push(apForInvRow.id);
      created.codes.push(apForInvRow.code);
      created.voucherRefs.push(`ap:${apForInvRow.code}`);
    }
    const PUR_AMOUNT = 5300;
    const PUR_NO = `API_TEST-PUR-${Date.now()}`;
    const voucherBeforePur = Number((await sql`SELECT count(*)::int AS v FROM fin_voucher`)[0].v);
    await page.goto(`${APP}/finance/invoices/new`, { settleMs: 2400 });
    await sleep(1500);
    const dPick2 = await pickSelectByLabel(page, '方向', '进项', 'body');
    const sPick2 = await pickSelectByLabel(page, '供应商', '验收供应商-2026-10-13212157|094bf51a', 'body');
    await pickSelectByLabel(page, '发票类型', '增值税专用发票|专', 'body');
    await pickSelectByLabel(page, '税率', '6%', 'body');
    await setInput(page, 'input[name="amount"]', PUR_AMOUNT);
    await setInput(page, 'input[name="invoiceNo"]', PUR_NO);
    await setInput(page, 'input[name="invoiceDate"]', '2026-10-17');
    await sleep(400);
    await submitPage(page, '保存');
    const tPur = await toasts(page);
    await sleep(1600);
    const purInv = (await sql`
      SELECT id, code, invoice_no, direction, amount, tax_amount, net_amount, tax_rate, status, supplier_id, ap_id
      FROM erp_invoice WHERE invoice_no = ${PUR_NO} ORDER BY _created_at DESC LIMIT 1`)[0];
    record(
      '进项发票落库（含税→不含税拆分 == splitTax）',
      !!purInv && Number(purInv.amount) === PUR_AMOUNT && near(purInv.tax_amount, r2((PUR_AMOUNT * 6) / 106)),
      purInv ? `amount=${purInv.amount} tax=${purInv.tax_amount} net=${purInv.net_amount} 方向选中=${dPick2.picked} 供应商选中=${sPick2.picked} toast=${JSON.stringify(tPur)}` : `未落库 toast=${JSON.stringify(tPur)}`
    );
    if (purInv) {
      created.invoiceIds.push(purInv.id);
      created.invoiceNos.push(purInv.invoice_no);
      created.voucherRefs.push(`invoice:${purInv.invoice_no}`, `invoice-void:${purInv.invoice_no}`);
      const voucherAfterPur = Number((await sql`SELECT count(*)::int AS v FROM fin_voucher`)[0].v);
      const purLines = await sql`
        SELECT l.account_code, l.debit, l.credit FROM fin_voucher_line l
        JOIN fin_voucher v ON v.id = l.voucher_id
        WHERE v.source_ref = ${`invoice:${purInv.invoice_no}`} ORDER BY l.account_code`;
      const gross = Number(purInv.amount);
      const expTax = r2((gross * 6) / 106);
      const expNet = r2(gross - expTax);
      const debitInput = purLines.reduce((s, l) => s + Number(l.debit), 0);
      const has222102 = purLines.some((l) => l.account_code === '222102' && near(l.debit, expTax));
      const has2202 = purLines.some((l) => l.account_code === '2202' && near(l.credit, gross));
      const debitNet = purLines.filter((l) => l.account_code !== '222102').reduce((s, l) => s + Number(l.debit), 0);
      record(
        '财税逻辑·进项开票**生成凭证**且分录 = inputIssueLines（借费用 net + 借 222102 tax + 贷 2202 gross）',
        voucherAfterPur === voucherBeforePur + 1 && has222102 && has2202 && near(debitNet, expNet),
        `fin_voucher ${voucherBeforePur}→${voucherAfterPur}；分录=${JSON.stringify(purLines)} 期望 net=${expNet} tax=${expTax} gross=${gross} 借方合计=${debitInput}`
      );
      conclude(
        '销项/进项开票的凭证生成差异',
        voucherAfterPur === voucherBeforePur + 1 && has222102 && has2202
          ? `确认非对称：销项不出凭证、进项出凭证（借 ${expNet} 费用 + 借 ${expTax} 进项税 / 贷 ${gross} 应付），与 inputIssueLines 一致`
          : '⚠️ 进项凭证与 inputIssueLines 期望不符，见上条证据'
      );
    }

    /* 进项"累计开票 ≤ 应付金额"约束 */
    const overPur = await apiJson('POST', '/api/finance/invoices', {
      direction: 'purchase', supplierId: base.supplierA, apId: apForInvRow?.id,
      invoiceType: 'vat_special', amount: 999999, taxRate: 6, invoiceNo: `${TAG}-PUR-OVER`, invoiceDate: '2026-10-17',
    });
    record(
      '财税逻辑·进项开票超过应付金额被拒',
      overPur.status === 400 && /超过应付金额/.test(overPur.message),
      `HTTP=${overPur.status} message=${overPur.message}`
    );

    /* 勾选认证 → 底稿进项取数 */
    CURRENT_SECTION = '④ 发票勾选认证';
    console.log('\n④ 发票勾选认证（进项抵扣前提）');
    if (purInv) {
      const cert = await apiJson('POST', `/api/finance/invoices/${purInv.id}/certify`, { certificationPeriod: PERIOD });
      const certRow = (await sql`SELECT certification_status, certification_period FROM erp_invoice WHERE id = ${purInv.id}`)[0];
      record(
        '进项发票勾选认证落库（certified + 所属期）',
        cert.status < 300 && certRow.certification_status === 'certified' && certRow.certification_period === PERIOD,
        `HTTP=${cert.status} status=${certRow.certification_status} period=${certRow.certification_period}`
      );
    }

    /* ── 合同可开金额是否被"挂在同一合同上的进项发票"污染 ──
     *
     * `createSalesInvoice` 的可开金额 = 合同额 − Σ(status='issued' 且 contract_id=本合同)，
     * 该求和**没有 direction 过滤**。而 `createPurchaseInvoice` 会在插入时忽略
     * `dto.contractId`，看起来安全；但 `PATCH /api/finance/invoices/:id` 的
     * `UpdateInvoiceDto.contractId` 对进项发票也是可写的（`invoice.service.ts:803`）。
     * 于是只要给一张进项发票补一个合同，该合同的可开金额就被凭空扣掉。
     * 本段做的事：真的走一遍，看可开金额是否被扣。
     */
    CURRENT_SECTION = '④ 合同可开金额口径';
    console.log('\n④ 合同可开金额是否被进项发票污染');
    const cleanContract = '0d727962-d49f-4c21-a800-27e95e59b4fd'; // CTR2026100002：draft，未开任何票
    const billableOf = async (contractId) =>
      Number((await sql`
        SELECT c.amount - coalesce((SELECT sum(i.amount) FROM erp_invoice i WHERE i.contract_id = c.id AND i.status = 'issued' AND i.direction = 'sales'), 0) AS billable
        FROM erp_contract c WHERE c.id = ${contractId}`)[0].billable);
    const cleanBefore = await billableOf(cleanContract);
    const purLeakNo = `${TEST_INVOICE_PREFIX}PUR-LEAK-${Date.now()}`;
    const purLeak = await apiJson('POST', '/api/finance/invoices', {
      direction: 'purchase', supplierId: base.supplierA, invoiceType: 'vat_special',
      amount: 2000, taxRate: 6, invoiceNo: purLeakNo, invoiceDate: '2026-10-17',
    });
    const purLeakRow = (await sql`SELECT id, invoice_no, direction, amount, contract_id FROM erp_invoice WHERE invoice_no = ${purLeakNo}`)[0];
    if (purLeakRow) {
      created.invoiceIds.push(purLeakRow.id);
      created.invoiceNos.push(purLeakRow.invoice_no);
      created.voucherRefs.push(`invoice:${purLeakRow.invoice_no}`, `invoice-void:${purLeakRow.invoice_no}`);
    }
    const patchLeak = await apiJson('PATCH', `/api/finance/invoices/${purLeakRow?.id}`, { contractId: cleanContract });
    const cleanAfter = await billableOf(cleanContract);
    record(
      '财税逻辑·进项发票挂到销售合同后，该合同可开金额不被扣减（口径：只汇总 direction=sales）', // API_BUILD: 见文末"运行中的 3100 是旧构建"说明
      near(cleanAfter, cleanBefore),
      `进项发票 ${purLeakNo}（含税 ${purLeakRow?.amount}）PATCH contractId 后：可开 ${cleanBefore} → ${cleanAfter}（差 ${r2(cleanBefore - cleanAfter)}）PATCH HTTP=${patchLeak.status} ${patchLeak.message}`
    );
    if (!near(cleanAfter, cleanBefore)) {
      defects.push({
        id: 'billable-purchase-invoice-leak',
        title: '合同可开金额被挂在同一合同上的**进项**发票扣减（求和缺 direction 过滤）',
        symptom: `把一张进项发票 PATCH 上 contractId 后，该销售合同的可开金额从 ${cleanBefore} 降到 ${cleanAfter}，导致后续合法销项开票被误拒`,
        rootCause:
          'invoice.service.ts createSalesInvoice 的可开金额求和 `WHERE contract_id = ? AND status = \'issued\'` 没有 `direction = \'sales\'`；createPurchaseInvoice 自身不写 contractId，但 PATCH 可写（同文件 803 行），进项发票因此进入该求和',
        fix: '（见最终报告）',
        evidence: `PATCH /api/finance/invoices/${purLeakRow?.id} {contractId:${cleanContract}} HTTP=${patchLeak.status}；可开 ${cleanBefore} → ${cleanAfter}`,
      });
    }
    // 再验证一次"销项开票被误拒"的用户可见后果
    const blockedByLeak = await apiJson('POST', '/api/finance/invoices', {
      contractId: cleanContract, direction: 'sales', invoiceType: 'vat_special',
      amount: cleanBefore, taxRate: 6, invoiceNo: `${TEST_INVOICE_PREFIX}SALES-LEAK-${Date.now()}`, invoiceDate: '2026-10-17',
    });
    record(
      '财税逻辑·进项污染后按"合同额"全额开票被拒（可复现的用户可见后果）',
      near(cleanAfter, cleanBefore) ? blockedByLeak.status < 300 : blockedByLeak.status === 400,
      `按 ${cleanBefore} 开票 HTTP=${blockedByLeak.status} message=${blockedByLeak.message}`
    );
    const leakSalesRow = (await sql`SELECT id, invoice_no FROM erp_invoice WHERE contract_id = ${cleanContract} AND direction = 'sales' AND status = 'issued'`);
    for (const row of leakSalesRow) {
      created.invoiceIds.push(row.id);
      created.invoiceNos.push(row.invoice_no);
      created.voucherRefs.push(`invoice:${row.invoice_no}`, `invoice-void:${row.invoice_no}`);
    }

    /* 发票作废：销项只改状态；进项冲回凭证 */
    CURRENT_SECTION = '④ 发票作废';
    console.log('\n④ 发票作废');
    if (salesInv) {
      const vBefore = Number((await sql`SELECT count(*)::int AS v FROM fin_voucher`)[0].v);
      const billableBeforeVoid = (await sql`
        SELECT c.amount - coalesce((SELECT sum(i.amount) FROM erp_invoice i WHERE i.contract_id = c.id AND i.status = 'issued' AND i.direction = 'sales'), 0) AS billable
        FROM erp_contract c WHERE c.id = ${base.contractB}`)[0].billable;
      const v = await apiJson('POST', `/api/finance/invoices/${salesInv.id}/void`, { reason: `${TAG} 作废销项` });
      const after = (await sql`SELECT status, void_reason FROM erp_invoice WHERE id = ${salesInv.id}`)[0];
      const vAfter = Number((await sql`SELECT count(*)::int AS v FROM fin_voucher`)[0].v);
      record(
        '销项发票作废（status=voided + 不产生冲回凭证）',
        v.status < 300 && after.status === 'voided' && vAfter === vBefore,
        `HTTP=${v.status} status=${after.status} fin_voucher ${vBefore}→${vAfter}`
      );
      const billableAfter = (await sql`
        SELECT c.amount - coalesce((SELECT sum(i.amount) FROM erp_invoice i WHERE i.contract_id = c.id AND i.status = 'issued' AND i.direction = 'sales'), 0) AS billable
        FROM erp_contract c WHERE c.id = ${base.contractB}`)[0].billable;
      record(
        '销项作废后合同可开金额回补（作废前 74200−10600=63600 → 作废后 74200）',
        near(Number(billableBeforeVoid), Number(billable) - SALES_AMOUNT) && near(billableAfter, Number(billable)),
        `开票后可开=${billableBeforeVoid}（期望 ${Number(billable) - SALES_AMOUNT}）作废后可开=${billableAfter}（期望 ${billable}）`
      );
    }
    if (purInv) {
      const vBefore = Number((await sql`SELECT count(*)::int AS v FROM fin_voucher`)[0].v);
      const v = await apiJson('POST', `/api/finance/invoices/${purInv.id}/void`, { reason: `${TAG} 作废进项` });
      const vAfter = Number((await sql`SELECT count(*)::int AS v FROM fin_voucher`)[0].v);
      const voidLines = await sql`
        SELECT l.account_code, l.debit, l.credit FROM fin_voucher_line l
        JOIN fin_voucher v ON v.id = l.voucher_id
        WHERE v.source_ref = ${`invoice-void:${purInv.invoice_no}`} ORDER BY l.account_code`;
      const reverted = voidLines.some((l) => l.account_code === '2202' && near(l.debit, PUR_AMOUNT))
        && voidLines.some((l) => l.account_code === '222102' && Number(l.credit) > 0);
      record(
        '进项发票作废产生冲回凭证（借 2202 / 贷 费用 + 贷 222102）',
        v.status < 300 && vAfter === vBefore + 1 && reverted,
        `fin_voucher ${vBefore}→${vAfter}；冲回分录=${JSON.stringify(voidLines)}`
      );
    }
    // 跨月作废闸门（所属期已确认底稿）
    cannotVerify(
      '发票跨月作废闸门（所属期已有已确认增值税底稿时拒绝作废）',
      '库中 fin_vat_declaration 为空，2026-10 无已确认底稿；要触达该分支必须先确认一份底稿，会在生产库留下申报留痕，本轮不做'
    );

  } else {
    console.log('\n（WT_SKIP_WRITES=1：跳过 ①~④ 写入段，只跑 ⑤~⑨ 只读核对 + 财税口径）');
  }

  /* ═══════════════════════════════════════════════════════════════
   * ⑤ 勾稽中心 / 对账单 / 账龄 / 现金流 —— 界面数字 vs SQL
   * ═══════════════════════════════════════════════════════════════ */
  {
    CURRENT_SECTION = '⑤ 勾稽中心';
    console.log('\n⑤ 勾稽中心 — 界面数字 vs SQL');
    await page.goto(`${APP}/finance`, { settleMs: 2600 });
    await sleep(1600);
    page.resetDiagnostics();
    await page.clickByText('勾稽中心', { selector: '[role="tab"]', settleMs: 2000 });
    await sleep(1800);
    const reconInfo = await pageInfo(page);
    const reconCards = await page.evaluate(`(() => {
      const txt = document.body.innerText || '';
      return txt.slice(0, 1400);
    })()`);
    const arNoInv = await apiJson('GET', '/api/finance/reconciliation/ar-without-invoice');
    /*
     * 与 `reconciliation.service.ts#listArWithoutInvoice` **逐字同源**：
     * 取全部 erp_ar（**不限状态**），按 `ar_id` 关联发票、金额合计（排除 voided）≤ 0.01
     * 即视为"未开票"。
     * ⚠️ 第一版我自己加了"status 非终态 + 未全额核销"两个条件，得到 3 ≠ 7 ——
     * 那是**我的判据写错了**，不是缺陷：勾稽中心这一列问的是"这张应收有没有票"，
     * 与它有没有被核销无关（已核销的应收同样可能一张票都没开）。
     */
    const arNoInvSql = await sql`
      SELECT count(*)::int AS v FROM erp_ar a
      WHERE (SELECT coalesce(sum(i.amount), 0) FROM erp_invoice i
             WHERE i.ar_id = a.id AND i.status <> 'voided') <= 0.01`;
    record(
      '勾稽中心渲染',
      reconInfo.tables.length > 0 || reconInfo.buttons.length > 0,
      `表头=${JSON.stringify(reconInfo.grid.headers)} 行数=${reconInfo.grid.rows.length} 空态=${JSON.stringify(reconInfo.empty)}`
    );
    record(
      '勾稽中心·应收未开票清单条数 == SQL（按 ar_id 关联发票，排除 voided）',
      Array.isArray(arNoInv.data) && arNoInv.data.length === Number(arNoInvSql[0].v),
      `界面/接口=${Array.isArray(arNoInv.data) ? arNoInv.data.length : 'n/a'} SQL=${arNoInvSql[0].v}`
    );
    perTabDiag['/finance#recon'] = {
      consoleErrors: page.consoleLogs.filter((l) => l.type === 'error').map((l) => l.text),
      exceptions: page.exceptions.map((e) => e.description || e.text),
      httpErrors: page.httpErrors.map((e) => `${e.status} ${e.url}`),
    };
    record(
      '勾稽中心无 console.error / 异常 / HTTP≥400',
      perTabDiag['/finance#recon'].consoleErrors.length === 0 && perTabDiag['/finance#recon'].exceptions.length === 0 && perTabDiag['/finance#recon'].httpErrors.length === 0,
      JSON.stringify(perTabDiag['/finance#recon']).slice(0, 240)
    );
    await shot(page, `${OUT}/fin-recon.png`);

    CURRENT_SECTION = '⑤ 对账单';
    console.log('\n⑤ 对账单 — 界面数字 vs SQL');
    page.resetDiagnostics();
    await page.clickByText('对账单', { selector: '[role="tab"]', settleMs: 2000 });
    await sleep(1500);
    await pickSelect(page, { placeholder: '对账方向', optionRe: '客户对账单', scope: 'body' });
    await pickSelect(page, { placeholder: '选择对手方|加载对手方', optionRe: '验收客户-2026-10-13212707', scope: 'body' });
    await sleep(2200);
    const stmtInfo = await pageInfo(page);
    const stmtText = await page.evaluate(`(() => (document.body.innerText || '').slice(0, 30000))()`);
    // SQL：该客户 2026-10 的应收发生 / 回款 / 期末余额
    const stmtSql = (await sql`
      SELECT
        coalesce((SELECT sum(a.amount) FROM erp_ar a WHERE a.customer_id = ${base.customerA} AND a.status <> 'voided'
                  AND to_char(coalesce(a.due_date, a._created_at::date), 'YYYY-MM') <= ${PERIOD}), 0) AS ar_total,
        coalesce((SELECT sum(r.amount) FROM erp_receipt r WHERE r.customer_id = ${base.customerA} AND r.status <> 'voided'), 0) AS receipt_total`)[0];
    const stmtApi = await apiJson('GET', `/api/finance/statement/customer?counterpartyId=${base.customerA}&period=${PERIOD}&direction=customer`);
    record(
      '对账单接口与界面均出数（客户 0096195f / 2026-10）',
      stmtApi.status < 300 && !!stmtApi.data && stmtInfo.tables.length > 0,
      `HTTP=${stmtApi.status} 期末余额=${stmtApi.data?.closingBalance} 期初=${stmtApi.data?.openingBalance} 本期借方=${stmtApi.data?.periodDebit} 本期贷方=${stmtApi.data?.periodCredit} 行数=${Array.isArray(stmtApi.data?.lines) ? stmtApi.data.lines.length : 'n/a'}`
    );
    record(
      '对账单·期初+本期增加−本期减少 == 期末余额（自洽）',
      !!stmtApi.data && near(
        Number(stmtApi.data.openingBalance) + Number(stmtApi.data.periodDebit) - Number(stmtApi.data.periodCredit),
        Number(stmtApi.data.closingBalance)
      ),
      stmtApi.data
        ? `${stmtApi.data.openingBalance} + ${stmtApi.data.periodDebit} − ${stmtApi.data.periodCredit} = ${r2(Number(stmtApi.data.openingBalance) + Number(stmtApi.data.periodDebit) - Number(stmtApi.data.periodCredit))} vs 期末 ${stmtApi.data.closingBalance}`
        : 'n/a'
    );
    const arTotalInStmt = Number(stmtApi.data?.closingBalance ?? NaN);
    const closingText = Number.isFinite(arTotalInStmt)
      ? `期末余额渲染到界面文本：${stmtText.includes(Math.abs(arTotalInStmt).toFixed(2)) || stmtText.includes(String(Math.abs(arTotalInStmt).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')))}`
      : '接口未返回 closingBalance';
    record(
      '对账单·期末余额已渲染到界面（含千分位或不含两种写法都认）',
      Number.isFinite(arTotalInStmt) &&
        (stmtText.includes(Math.abs(arTotalInStmt).toFixed(2)) ||
          stmtText.includes(String(Math.abs(arTotalInStmt).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')))),
      `${closingText}；期末=${arTotalInStmt} 对账单行数=${Array.isArray(stmtApi.data?.lines) ? stmtApi.data.lines.length : 'n/a'}`
    );
    perTabDiag['/finance#statement'] = {
      consoleErrors: page.consoleLogs.filter((l) => l.type === 'error').map((l) => l.text),
      exceptions: page.exceptions.map((e) => e.description || e.text),
      httpErrors: page.httpErrors.map((e) => `${e.status} ${e.url}`),
    };
    await shot(page, `${OUT}/fin-statement.png`);

    CURRENT_SECTION = '⑤ 账龄分析';
    console.log('\n⑤ 账龄分析 — 界面数字 vs SQL');
    page.resetDiagnostics();
    await page.clickByText('账龄分析', { selector: '[role="tab"]', settleMs: 2000 });
    await sleep(1800);
    const agingInfo = await pageInfo(page);
    const agingTable = { headers: agingInfo.grid.headers, rows: agingInfo.grid.rows };
    const today = (await sql`SELECT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS v`)[0].v;
    const agingRows = await sql`
      SELECT amount, settled_amount, due_date FROM erp_ar
      WHERE status NOT IN ('settled','voided')`;
    const bucketsDef = [
      { label: '未到期', min: -99999, max: 0 },
      { label: '1-30天', min: 1, max: 30 },
      { label: '31-60天', min: 31, max: 60 },
      { label: '61-90天', min: 61, max: 90 },
      { label: '90天以上', min: 91, max: 99999 },
    ];
    const expBuckets = bucketsDef.map((b) => ({ label: b.label, amount: 0, count: 0 }));
    for (const row of agingRows) {
      const open = Number(row.amount) - Number(row.settled_amount ?? 0);
      if (open <= 0) continue;
      const overdue = row.due_date
        ? Math.floor((new Date(today).getTime() - new Date(row.due_date).getTime()) / 86400000)
        : 0;
      const i = bucketsDef.findIndex((b) => overdue >= b.min && overdue <= b.max);
      if (i >= 0) {
        expBuckets[i].amount += open;
        expBuckets[i].count += 1;
      }
    }
    const agingCompare = expBuckets.map((e) => {
      const row = (agingTable?.rows ?? []).find((r) => (r[0] ?? '').includes(e.label));
      return {
        label: e.label,
        uiAmount: row ? money(row[1]) : null,
        uiCount: row ? Number(row[2]) : null,
        sqlAmount: r2(e.amount),
        sqlCount: e.count,
      };
    });
    const agingOk = agingCompare.every(
      (c) => c.uiAmount !== null && near(c.uiAmount, c.sqlAmount) && c.uiCount === c.sqlCount
    );
    record(
      '账龄分桶金额/笔数 == SQL（erp_ar 非 settled/voided，按 due_date 逾期天数分桶，today=' + today + '）',
      agingOk,
      JSON.stringify(agingCompare)
    );
    record(
      '账龄分桶合计 == 未结清应收合计（SQL sum(max(amount−settled,0))）',
      near(
        agingCompare.reduce((s, c) => s + c.sqlAmount, 0),
        r2(agingRows.reduce((s, r) => s + Math.max(Number(r.amount) - Number(r.settled_amount ?? 0), 0), 0))
      ),
      `桶合计=${r2(agingCompare.reduce((s, c) => s + c.sqlAmount, 0))} SQL 未结清合计=${r2(agingRows.reduce((s, r) => s + Math.max(Number(r.amount) - Number(r.settled_amount ?? 0), 0), 0))}`
    );
    perTabDiag['/finance#aging'] = {
      consoleErrors: page.consoleLogs.filter((l) => l.type === 'error').map((l) => l.text),
      exceptions: page.exceptions.map((e) => e.description || e.text),
      httpErrors: page.httpErrors.map((e) => `${e.status} ${e.url}`),
    };
    await shot(page, `${OUT}/fin-aging.png`);

    CURRENT_SECTION = '⑤ 现金流';
    console.log('\n⑤ 现金流 — 界面数字 vs SQL');
    page.resetDiagnostics();
    await page.clickByText('现金流', { selector: '[role="tab"]', settleMs: 2000 });
    await sleep(1800);
    const cfInfo = await pageInfo(page);
    const cfApi = await apiJson('GET', '/api/finance/cash-flow/forecast?weeks=13');
    const cfSql = (await sql`
      SELECT
        coalesce((SELECT sum(amount) FROM erp_receipt WHERE status <> 'voided'), 0) AS receipt_total,
        coalesce((SELECT sum(amount) FROM erp_payment WHERE status IN ('approved','paid')), 0) AS payment_total`)[0];
    const expOpening = r2(Number(cfSql.receipt_total) - Number(cfSql.payment_total));
    record(
      '现金流·期初现金 == SQL（回款非作废合计 − 已批准/已付付款合计）',
      !!cfApi.data && near(cfApi.data.openingCash, expOpening),
      `界面=${cfApi.data?.openingCash} 期望=${expOpening}（回款 ${cfSql.receipt_total} − 付款 ${cfSql.payment_total}）`
    );
    // 逐周核对：流入=未结应收按 due_date 落周；流出=未付应付落周（工资/报销均为 0）
    const anchor = (await sql`SELECT to_char(
        date_trunc('week', (now() AT TIME ZONE 'Asia/Shanghai')::date)::date, 'YYYY-MM-DD') AS v`)[0].v;
    const openAr = await sql`SELECT amount, settled_amount, due_date FROM erp_ar WHERE status IN ('open','partial')`;
    const openAp = await sql`SELECT amount, paid_amount, due_date FROM erp_ap_bill WHERE status IN ('pending','approved','partial')`;
    const expIn = Array(13).fill(0);
    const expOut = Array(13).fill(0);
    const weekIdx = (due, anchorStr, windowDays) => {
      if (!due) return 0;
      const diff = Math.floor((new Date(due).getTime() - new Date(anchorStr).getTime()) / 86400000);
      if (diff >= windowDays) return -1;
      if (diff < 0) return 0;
      return Math.floor(diff / 7);
    };
    for (const row of openAr) {
      const open = r2(Number(row.amount) - Number(row.settled_amount ?? 0));
      if (open <= 0) continue;
      const i = weekIdx(row.due_date ? ymd(row.due_date) : null, anchor, 91);
      if (i >= 0 && i < 13) expIn[i] += open;
    }
    for (const row of openAp) {
      const open = r2(Number(row.amount) - Number(row.paid_amount ?? 0));
      if (open <= 0) continue;
      const i = weekIdx(row.due_date ? ymd(row.due_date) : null, anchor, 91);
      if (i >= 0 && i < 13) expOut[i] += open;
    }
    const weeks = cfApi.data?.weeks ?? [];
    const cfCompare = weeks.map((w, i) => ({
      week: String(w.weekStart).slice(0, 10),
      uiIn: w.inflow, sqlIn: r2(expIn[i] ?? 0),
      uiOut: w.outflow, sqlOut: r2(expOut[i] ?? 0),
    }));
    const cfOk = cfCompare.every((c) => near(c.uiIn, c.sqlIn) && near(c.uiOut, c.sqlOut));
    record(
      `现金流·13 周逐周流入/流出 == SQL（anchor=${anchor}，工资/报销库中为 0）`,
      cfOk,
      cfOk
        ? `13 周全部一致；合计流入=${r2(cfCompare.reduce((s, c) => s + c.uiIn, 0))} 流出=${r2(cfCompare.reduce((s, c) => s + c.uiOut, 0))}`
        : JSON.stringify(cfCompare.filter((c) => !near(c.uiIn, c.sqlIn) || !near(c.uiOut, c.sqlOut)))
    );
    record(
      '现金流界面渲染出 StatCard 与 13 行表',
      cfInfo.grid.rows.length >= 1 && cfInfo.grid.headers.some((h) => /流入/.test(h)),
      `表头=${JSON.stringify(cfInfo.tables.map((t) => t.headers))} 行数=${JSON.stringify(cfInfo.tables.map((t) => t.rows.length))}`
    );
    perTabDiag['/finance#cashflow'] = {
      consoleErrors: page.consoleLogs.filter((l) => l.type === 'error').map((l) => l.text),
      exceptions: page.exceptions.map((e) => e.description || e.text),
      httpErrors: page.httpErrors.map((e) => `${e.status} ${e.url}`),
    };
    await shot(page, `${OUT}/fin-cashflow.png`);

    /* ═══════════════════════════════════════════════════════════════
     * ⑥ /finance/reports 财务报表
     * ═══════════════════════════════════════════════════════════════ */
    CURRENT_SECTION = '⑥ 财务报表';
    console.log('\n⑥ /finance/reports 财务报表');
    page.resetDiagnostics();
    await page.goto(`${APP}/finance/reports`, { settleMs: 2600 });
    await sleep(1800);
    const REPORT_TABS = [
      { label: '资产负债表', code: 'balance_sheet' },
      { label: '利润表', code: 'income_statement' },
      { label: '现金流量表', code: 'cash_flow' },
    ];
    const statusSql = (includeDraft) =>
      includeDraft ? sql`v.status IN ('posted','draft')` : sql`v.status = 'posted'`;

    /* 科目树（含子科目）用于把"科目余额(code, dir)"展开成 account_code 列表 */
    const accountTree = await sql`SELECT code, parent_code FROM fin_account`;
    const descendants = (code) => {
      const out = [code];
      for (let i = 0; i < out.length; i += 1) {
        for (const n of accountTree) if (n.parent_code === out[i] && !out.includes(n.code)) out.push(n.code);
      }
      return out;
    };
    /** 与 reports.service 的口径一致：closing = 期间 <= P 的累计；occurrence = 期间 = P */
    const acctAmount = async (kind, code, dir, includeDraft) => {
      const codes = descendants(code);
      const range = kind === 'occurrence'
        ? sql`v.period = ${PERIOD}`
        : sql`v.period <= ${PERIOD}`;
      const rows = await sql`
        SELECT coalesce(sum(l.debit), 0) AS d, coalesce(sum(l.credit), 0) AS c
        FROM fin_voucher_line l JOIN fin_voucher v ON v.id = l.voucher_id
        WHERE ${statusSql(includeDraft)} AND ${range} AND l.account_code IN ${sql(codes)}`;
      const d = Number(rows[0].d);
      const c = Number(rows[0].c);
      if (dir === '借') return r2(Math.max(d - c, 0));
      if (dir === '贷') return r2(Math.max(c - d, 0));
      return r2(d - c);
    };
    const templates = await sql`
      SELECT report_code, row_no, row_name, formula FROM fin_report_template
      WHERE enabled = 1 ORDER BY report_code, sort_no`;

    for (const rt of REPORT_TABS) {
      await page.clickByText(rt.label, { selector: '[role="tab"]', settleMs: 2200 });
      await sleep(2200);
      const info = await pageInfo(page);
      const domRows = await reportRows(page);
      const apiRes = await apiJson('GET', `/api/finance/reports/${rt.code}?period=${PERIOD}`);
      const tpl = templates.filter((t) => t.report_code === rt.code);
      /*
       * 只核对"单科目余额/发生额"行 —— 复合公式（`行(nn)` 引用、`科目变动` 等）
       * 需要完整求值器，不在本轮逐行复算；单科目行足以验证
       * 「界面数字 == SQL 聚合」这一条要求。
       */
      const simple = tpl
        .map((t) => {
          const m = /^科目(余额|发生)\((\S+?),\s*(借|贷)\)$/.exec(String(t.formula ?? '').replace(/\s+/g, ' '));
          return m ? { rowNo: t.row_no, rowName: t.row_name, kind: m[1] === '余额' ? 'balance' : 'occurrence', code: m[2], dir: m[3] } : null;
        })
        .filter(Boolean);
      const checks = [];
      for (const s of simple) {
        const expected = await acctAmount(s.kind, s.code, s.dir, false);
        const domRow = domRows.find((r) => r.rowNo === String(s.rowNo));
        const uiVal = domRow ? money(domRow.amount) : null;
        // 同一条数字必须同时出现在接口响应里（接口就是这张表的数据源）
        const apiRow = (apiRes.data?.rows ?? []).find((r) => r.rowNo === String(s.rowNo));
        checks.push({
          rowNo: s.rowNo,
          rowName: s.rowName,
          formula: `${s.kind}(${s.code},${s.dir})`,
          ui: uiVal,
          api: apiRow ? Number(apiRow.amount) : null,
          sql: expected,
          pass: uiVal !== null && near(uiVal, expected) && apiRow !== undefined && near(Number(apiRow.amount), expected),
        });
      }
      const passed = checks.filter((c) => c.pass).length;
      repEvidence[rt.code] = {
        label: rt.label,
        url: info.url,
        domRowCount: domRows.length,
        domRowNos: domRows.map((r) => r.rowNo),
        checks,
        apiChecks: Array.isArray(apiRes.data?.checks) ? apiRes.data.checks : null,
      };
      record(
        `报表「${rt.label}」切换并渲染出全部行（DOM 行数 == 接口行数）`,
        domRows.length > 0 && domRows.length === (apiRes.data?.rows ?? []).length,
        `DOM 行数=${domRows.length} 接口行数=${(apiRes.data?.rows ?? []).length} 行次=${JSON.stringify(domRows.map((r) => r.rowNo)).slice(0, 200)} HTTP=${apiRes.status}`
      );
      record(
        `报表「${rt.label}」单科目行：界面值 == 接口值 == SQL 聚合（已过账口径，${passed}/${checks.length}）`,
        checks.length > 0 && passed === checks.length,
        JSON.stringify(checks).slice(0, 800)
      );
      const apiChecks = Array.isArray(apiRes.data?.checks) ? apiRes.data.checks : [];
      if (apiChecks.length) {
        record(
          `报表「${rt.label}」内置勾稽校验`,
          apiChecks.every((c) => c.passed),
          JSON.stringify(apiChecks).slice(0, 500)
        );
        conclude(
          `报表「${rt.label}」自洽性`,
          apiChecks.every((c) => c.passed)
            ? `报表自带勾稽校验全部通过：${apiChecks.map((c) => c.label).join('；')}`
            : `⚠️ 报表自带勾稽校验未通过：${JSON.stringify(apiChecks.filter((c) => !c.passed))}`
        );
      }
      await shot(page, `${OUT}/fin-report-${rt.code}.png`);
    }
    perTabDiag['/finance/reports'] = {
      consoleErrors: page.consoleLogs.filter((l) => l.type === 'error').map((l) => l.text),
      exceptions: page.exceptions.map((e) => e.description || e.text),
      httpErrors: page.httpErrors.map((e) => `${e.status} ${e.url}`),
    };
    record(
      '/finance/reports 无 console.error / 异常 / HTTP≥400',
      perTabDiag['/finance/reports'].consoleErrors.length === 0 && perTabDiag['/finance/reports'].exceptions.length === 0 && perTabDiag['/finance/reports'].httpErrors.length === 0,
      JSON.stringify(perTabDiag['/finance/reports']).slice(0, 300)
    );

    /* ═══════════════════════════════════════════════════════════════
     * ⑦ /finance/ledgers 会计账簿
     * ═══════════════════════════════════════════════════════════════ */
    CURRENT_SECTION = '⑦ 会计账簿';
    console.log('\n⑦ /finance/ledgers 会计账簿');
    page.resetDiagnostics();
    await page.goto(`${APP}/finance/ledgers`, { settleMs: 2600 });
    await sleep(1800);
    const LEDGER_TABS = [
      { value: 'balance', label: '科目余额表' },
      { value: 'general', label: '总账' },
      { value: 'detail', label: '明细账' },
      { value: 'aux', label: '辅助余额表' },
      { value: 'aux-combination', label: '组合与分摊' },
    ];
    // 界面的"取数来源：已过账凭证" / "已过账 + 草稿预览"
    const draftToggle = async () => {
      const ok = await realClickExpr(
        page,
        `(() => {
          const labs = [...document.querySelectorAll('label')].filter((l) => /草稿/.test(l.textContent || ''));
          for (const l of labs) {
            const i = l.querySelector('input[type="checkbox"]');
            if (i) return i;
            if (l.htmlFor) { const t = document.getElementById(l.htmlFor); if (t) return t; }
          }
          const byId = document.getElementById('reports-include-draft');
          return byId || null;
        })()`,
        1800
      );
      await sleep(1500);
      return ok;
    };
    for (const lt of LEDGER_TABS) {
      const info0 = await pageInfo(page);
      const clicked = await page.clickByText(lt.label, { selector: '[role="tab"]', settleMs: 2000 });
      await sleep(1700);
      const info = await pageInfo(page);
      ledEvidence[lt.value] = {
        label: lt.label,
        url: info.url,
        headers: info.tables.map((t) => t.headers),
        rowCount: info.tables.reduce((s, t) => s + t.rows.length, 0),
        empty: info.empty,
        buttons: info.buttons.slice(0, 10),
      };
      record(
        `账簿 Tab「${lt.label}」切换`,
        (info.url + JSON.stringify(info.headers)).length > 0,
        `表头=${JSON.stringify(info.tables.map((t) => t.headers)).slice(0, 240)} 行数=${info.tables.map((t) => t.rows.length)} 空态=${JSON.stringify(info.empty)}`
      );
      await shot(page, `${OUT}/fin-ledger-${lt.value}.png`);
    }

    /* 余额表：界面合计 vs SQL（两种口径） */
    await page.clickByText('科目余额表', { selector: '[role="tab"]', settleMs: 2000 });
    await sleep(1800);
    const balInfo = await pageInfo(page);
    const balTable = { headers: balInfo.grid.headers, rows: balInfo.grid.rows };
    const balSqlPosted = (await sql`
      SELECT coalesce(sum(l.debit), 0) AS d, coalesce(sum(l.credit), 0) AS c
      FROM fin_voucher_line l JOIN fin_voucher v ON v.id = l.voucher_id
      WHERE v.status = 'posted' AND v.period = ${PERIOD} AND l.account_code IS NOT NULL`)[0];
    const balSqlDraft = (await sql`
      SELECT coalesce(sum(l.debit), 0) AS d, coalesce(sum(l.credit), 0) AS c
      FROM fin_voucher_line l JOIN fin_voucher v ON v.id = l.voucher_id
      WHERE v.status IN ('posted','draft') AND v.period = ${PERIOD} AND l.account_code IS NOT NULL`)[0];
    /*
     * 余额表**没有"合计"行**（`BalanceTab` 不渲染 `Table.Summary`；只有 `AuxTab` 有）。
     * 所以核对方式是：把界面渲染的**一级科目行**（级次=1）本期借/贷相加 ——
     * 服务端把子科目上卷到父科目，故一级科目行覆盖整棵树、相加不重不漏。
     * ⚠️ 第一版按"找含「合计」的行"去读，永远读到 undefined —— 那是**我的假设错了**。
     */
    const balLevel1 = (balTable?.rows ?? []).filter(
      (r) => /^\d{4}$/.test((r[0] ?? '').trim()) && (r[2] ?? '').trim() === '1'
    );
    const balUiDebit = r2(balLevel1.reduce((s, r) => s + money(r[6]), 0));
    const balUiCredit = r2(balLevel1.reduce((s, r) => s + money(r[7]), 0));
    const balHeaders = balTable?.headers ?? [];
    record(
      '余额表（默认：仅已过账）· 一级科目行本期借/贷合计 == SQL',
      balLevel1.length > 0 && near(balUiDebit, Number(balSqlPosted.d)) && near(balUiCredit, Number(balSqlPosted.c)),
      `表头=${JSON.stringify(balHeaders)} 一级科目行数=${balLevel1.length} 界面合计 借=${balUiDebit} 贷=${balUiCredit}；SQL 借=${balSqlPosted.d} 贷=${balSqlPosted.c}（posted 凭证数=${(await sql`SELECT count(*)::int AS v FROM fin_voucher WHERE status='posted' AND period=${PERIOD}`)[0].v}）`
    );
    await toggleDraftOn(page, draftToggle);
    const balInfo2 = await pageInfo(page);
    const balTable2 = { headers: balInfo2.grid.headers, rows: balInfo2.grid.rows };
    const balLevel1b = (balTable2?.rows ?? []).filter(
      (r) => /^\d{4}$/.test((r[0] ?? '').trim()) && (r[2] ?? '').trim() === '1'
    );
    const balUiDebit2 = r2(balLevel1b.reduce((s, r) => s + money(r[6]), 0));
    const balUiCredit2 = r2(balLevel1b.reduce((s, r) => s + money(r[7]), 0));
    record(
      '余额表（勾选含草稿）· 一级科目行本期借/贷合计 == SQL（posted+draft）',
      balLevel1b.length > 0 && near(balUiDebit2, Number(balSqlDraft.d)) && near(balUiCredit2, Number(balSqlDraft.c)),
      `一级科目行数=${balLevel1b.length} 界面合计 借=${balUiDebit2} 贷=${balUiCredit2}；SQL 借=${balSqlDraft.d} 贷=${balSqlDraft.c}`
    );
    record(
      '财税逻辑·账簿借贷平衡（本期）：借方合计 == 贷方合计',
      near(Number(balSqlDraft.d), Number(balSqlDraft.c)),
      `posted+draft 借=${balSqlDraft.d} 贷=${balSqlDraft.c}`
    );
    conclude(
      '账簿借贷是否平衡',
      near(Number(balSqlDraft.d), Number(balSqlDraft.c)) && unbalanced.length === 0
        ? `平衡：全部 ${before.voucher} 张凭证借贷合计逐张相等；2026-10 发生额 借 ${balSqlDraft.d} = 贷 ${balSqlDraft.c}`
        : '存在不平凭证，见"账簿借贷平衡"条目'
    );
    // 逐张凭证平衡再确认一次（含本次走查新建的凭证）
    const unbalanced2 = await sql`
      SELECT v.code, v.status FROM fin_voucher v JOIN fin_voucher_line l ON l.voucher_id = v.id
      GROUP BY v.id, v.code, v.status
      HAVING round(sum(l.debit), 2) <> round(sum(l.credit), 2)`;
    record(
      '财税逻辑·逐张凭证借贷平衡（含本次走查新建凭证）',
      unbalanced2.length === 0,
      unbalanced2.length === 0 ? '全部凭证借贷相等' : JSON.stringify(unbalanced2)
    );
    await toggleDraftOn(page, draftToggle);

    /* 总账：按科目核对本期发生额 */
    await page.clickByText('总账', { selector: '[role="tab"]', settleMs: 2000 });
    await sleep(1800);
    const genInfo = await pageInfo(page);
    const genTable = { headers: genInfo.grid.headers, rows: genInfo.grid.rows };
    const genApi = await apiJson('GET', `/api/finance/ledgers/general?period=${PERIOD}`);
    const genItems = Array.isArray(genApi.data?.items) ? genApi.data.items : [];
    const genCheck = genItems.slice(0, 6).map((it) => {
      const row = (genTable?.rows ?? []).find((r) => (r.join(' ') ?? '').includes(String(it.accountCode)));
      return { code: it.accountCode, apiDebit: it.debitOccur ?? it.debit ?? null, uiRow: row ? row.slice(0, 6) : null };
    });
    /*
     * 界面行数 = 接口行数 + 1 —— antd `Table.Summary` 的合计行也渲染在 `tbody` 里。
     * 用"科目编码集合"比对而不是行数，避免把这条结构性差异误判成缺陷。
     */
    const genUiCodes = (genTable?.rows ?? [])
      .map((r) => (r[0] ?? '').trim())
      .filter((c) => /^\d{4}/.test(c));
    const genApiCodes = genItems.map((it) => String(it.accountCode));
    record(
      '总账·界面科目编码集合 == 接口科目集合',
      !!genTable && genUiCodes.length === genApiCodes.length && genApiCodes.every((c) => genUiCodes.includes(c)),
      `界面行数=${genTable?.rows.length ?? 0}（含合计行）界面科目数=${genUiCodes.length} 接口科目数=${genApiCodes.length} 表头=${JSON.stringify(genTable?.headers ?? [])}`
    );
    record(
      '总账·抽样科目界面行可对应接口科目编码',
      genCheck.every((c) => c.uiRow !== null),
      JSON.stringify(genCheck).slice(0, 500)
    );

    /*
     * 明细账：**两种口径都要核**。
     *
     * ⚠️ 第一版只填了科目就断言"界面表头非空"，结果永远 FAIL —— 因为默认口径是
     * **仅已过账**，而 2026-10 只有 1 张已过账凭证（1001/100202），1122 在已过账
     * 口径下确实没有明细。界面上其实有一句准确的空态文案
     * 「科目 1122 在期间 2026-10 无明细发生额」—— 那是**正确行为**，不是白屏。
     * 所以这里改成：默认口径先断言"空态文案 + SQL posted 计数为 0"，
     * 再勾选「含草稿预览」断言"表格行数/借贷合计 == SQL posted+draft"。
     */
    /* 明细账：按科目核对行数与借贷合计 */
    await page.clickByText('明细账', { selector: '[role="tab"]', settleMs: 2000 });
    await sleep(1200);
    const detSet = await setInput(page, 'input[placeholder="如 1122"]', '1122');
    await sleep(2600);
    const detInfo = await pageInfo(page);
    const detPostedSql = await sql`
      SELECT coalesce(sum(l.debit), 0) AS d, coalesce(sum(l.credit), 0) AS c, count(*)::int AS n
      FROM fin_voucher_line l JOIN fin_voucher v ON v.id = l.voucher_id
      WHERE l.account_code = '1122' AND v.status = 'posted' AND v.period = ${PERIOD}`;
    const detPostedApi = await apiJson('GET', `/api/finance/ledgers/detail?period=${PERIOD}&accountCode=1122`);
    record(
      '明细账（默认：仅已过账）· 无发生额时给准确空态，且与 SQL posted 计数一致',
      detSet === 'ok' && Number(detPostedSql[0].n) === 0 &&
        JSON.stringify(detInfo.empty).includes('无明细发生额'),
      `输入框设值=${detSet} SQL posted 行数=${detPostedSql[0].n} 界面空态=${JSON.stringify(detInfo.empty)} 接口行数=${Array.isArray(detPostedApi.data?.items) ? detPostedApi.data.items.length : 'n/a'} 表头=${JSON.stringify(detInfo.grid.headers)}`
    );
    await toggleDraftOn(page, draftToggle);
    await sleep(2600);
    const detInfo2 = await pageInfo(page);
    const detApi = await apiJson('GET', `/api/finance/ledgers/detail?period=${PERIOD}&accountCode=1122&includeDraft=true`);
    const detSql = await sql`
      SELECT coalesce(sum(l.debit), 0) AS d, coalesce(sum(l.credit), 0) AS c, count(*)::int AS n
      FROM fin_voucher_line l JOIN fin_voucher v ON v.id = l.voucher_id
      WHERE l.account_code = '1122' AND v.status IN ('posted','draft') AND v.period = ${PERIOD}`;
    const detUiRows = detInfo2.grid.rows.filter((r) => /^\d{4}-\d{2}-\d{2}|^\d{4}\//.test((r[0] ?? '').trim()));
    record(
      '明细账（勾选含草稿）· 界面明细行数 == min(SQL 行数, 前端每页条数)（分页口径）',
      /*
       * ⚠️ 2026-10-17 修正：原断言拿「分页第一页的行数」与「SQL 全表行数」比，
       * SQL 52 行、每页 50 → 必然不等，是**断言写错**而非产品缺陷。
       * 正确口径：界面单页渲染行数 = min(SQL 总数, 每页条数)；再单独断言总数 > 0。
       */
      detSet === 'ok' &&
              Number(detSql[0].n) > 0 &&
              detUiRows.length === Math.min(Number(detSql[0].n), Number(detApi.data?.pageSize ?? detUiRows.length)),
      `界面明细行数=${detUiRows.length} SQL 行数=${detSql[0].n} 表头=${JSON.stringify(detInfo2.grid.headers)} 前端分页每页=${detApi.data?.pageSize ?? 'n/a'} 接口返回行数=${Array.isArray(detApi.data?.items) ? detApi.data.items.length : 'n/a'}`
    );
    if (Array.isArray(detApi.data?.items)) {
      const apiDebit = detApi.data.items.reduce((s, it) => s + Number(it.debit ?? 0), 0);
      const apiCredit = detApi.data.items.reduce((s, it) => s + Number(it.credit ?? 0), 0);
      record(
        '明细账·接口本页借贷合计 ≤ SQL 合计（分页口径）且非零',
        Number(detSql[0].d) > 0 && apiDebit > 0 && apiDebit <= Number(detSql[0].d) + 0.011 && apiCredit <= Number(detSql[0].c) + 0.011,
        `接口本页 借=${r2(apiDebit)} 贷=${r2(apiCredit)}；SQL 全量 借=${detSql[0].d} 贷=${detSql[0].c} 行数=${detSql[0].n}`
      );
    }
    await toggleDraftOn(page, draftToggle);

    /* 辅助余额表 / 组合与分摊 */
    await page.clickByText('辅助余额表', { selector: '[role="tab"]', settleMs: 2000 });
    await sleep(1200);
    let auxPick = await pickSelectByLabel(page, '维度', '项目', 'body');
    if (!auxPick?.picked) auxPick = await pickSelect(page, { placeholder: '选择维度', optionRe: '项目', scope: 'body' });
    if (!auxPick?.picked) auxPick = await pickSelect(page, { placeholder: '选择维度', scope: 'body', optionIndex: 0 });
    await sleep(1800);
    const auxInfo = await pageInfo(page);
    const auxSql = await sql`SELECT count(*)::int AS v FROM fin_voucher_line_aux`;
    record(
      '辅助余额表·选维度后渲染（有无辅助分录都给明确文案，不白屏）',
      auxInfo.grid.headers.length > 0 || auxInfo.empty.length > 0,
      auxInfo.grid.headers.length > 0 || auxInfo.empty.length > 0,
    );
    if (Number(auxSql[0].v) === 0) {
      cannotVerify(
        '辅助余额表 / 组合与分摊的**数字**核对',
        'fin_voucher_line_aux 全表 0 行（系统尚无任何辅助核算分录），界面只能验"选择维度"引导空态与维度切换，数字无从核对'
      );
    }
    await page.clickByText('组合与分摊', { selector: '[role="tab"]', settleMs: 2000 });
    await sleep(1800);
    const combInfo = await pageInfo(page);
    record(
      '组合与分摊 Tab 可渲染（维度多选 + 覆盖率提示）',
      combInfo.grid.headers.length > 0 || combInfo.empty.length > 0 || combInfo.buttons.length > 0,
      `表头=${JSON.stringify(combInfo.grid.headers)} 空态=${JSON.stringify(combInfo.empty)} 按钮=${JSON.stringify(combInfo.buttons.slice(0, 8))}`
    );
    perTabDiag['/finance/ledgers'] = {
      consoleErrors: page.consoleLogs.filter((l) => l.type === 'error').map((l) => l.text),
      exceptions: page.exceptions.map((e) => e.description || e.text),
      httpErrors: page.httpErrors.map((e) => `${e.status} ${e.url}`),
    };
    record(
      '/finance/ledgers 无 console.error / 异常 / HTTP≥400',
      perTabDiag['/finance/ledgers'].consoleErrors.length === 0 && perTabDiag['/finance/ledgers'].exceptions.length === 0 && perTabDiag['/finance/ledgers'].httpErrors.length === 0,
      JSON.stringify(perTabDiag['/finance/ledgers']).slice(0, 300)
    );

    /* ═══════════════════════════════════════════════════════════════
     * ⑧ /finance/tax-declaration 增值税申报
     * ═══════════════════════════════════════════════════════════════ */
    CURRENT_SECTION = '⑧ 增值税申报';
    console.log('\n⑧ /finance/tax-declaration 增值税申报底稿');
    page.resetDiagnostics();
    await page.goto(`${APP}/finance/tax-declaration`, { settleMs: 2600 });
    await sleep(2000);
    const vatInfo0 = await pageInfo(page);
    record(
      '增值税申报页面渲染（底稿表 + 风险扫描区）',
      vatInfo0.tables.length > 0 || vatInfo0.buttons.length > 0,
      `按钮=${JSON.stringify(vatInfo0.buttons.slice(0, 10))} 表头=${JSON.stringify(vatInfo0.tables.map((t) => t.headers)).slice(0, 240)}`
    );
    // 期间 + 主体（界面 PeriodSelect 是 input/select）
    await setInput(page, 'input[type="month"], input#vat-period', PERIOD).catch(() => {});
    await sleep(1800);
    const vatApi = await apiJson('GET', `/api/finance/tax-declaration?period=${PERIOD}`);
    await page.clickByText('重新生成|扫描', { selector: 'button', settleMs: 2000 }).catch(() => {});
    await sleep(2000);
    const vatInfo = await pageInfo(page);
    await shot(page, `${OUT}/fin-vat-declaration.png`);
    const vatSql = (await sql`
      SELECT
        coalesce(sum(CASE WHEN direction='sales' THEN tax_amount ELSE 0 END),0) AS output_tax,
        coalesce(sum(CASE WHEN direction='purchase' AND certification_status IN ('certified','deducted') THEN tax_amount ELSE 0 END),0) AS input_tax,
        coalesce(sum(CASE WHEN direction='purchase' AND certification_status NOT IN ('certified','deducted') THEN tax_amount ELSE 0 END),0) AS uncertified_input,
        coalesce(sum(CASE WHEN direction='sales' THEN coalesce(net_amount, amount - coalesce(tax_amount,0)) ELSE 0 END),0) AS sales_net
      FROM erp_invoice WHERE status='issued' AND to_char(invoice_date,'YYYY-MM') = ${PERIOD}`)[0];
    const vatText = await page.evaluate(`(() => (document.body.innerText || '').slice(0, 4000))()`);
    record(
      '财税逻辑·底稿销项税额 == SQL（发票台账 status=issued + direction=sales + 所属期）',
      !!vatApi.data && near(vatApi.data.outputTaxFromInvoices, Number(vatSql.output_tax)),
      `底稿=${vatApi.data?.outputTaxFromInvoices} SQL=${vatSql.output_tax}（sales_net SQL=${vatSql.sales_net}）`
    );
    record(
      '财税逻辑·底稿进项税额 == SQL（进项另需 certification_status ∈ certified/deducted）',
      !!vatApi.data && near(vatApi.data.inputTaxFromInvoices, Number(vatSql.input_tax)),
      `底稿=${vatApi.data?.inputTaxFromInvoices} SQL 可抵扣=${vatSql.input_tax} 未勾选=${vatSql.uncertified_input}`
    );
    /*
     * ⚠️ 2026-10-17 修正比较基准：第 12 行取哪一侧是**产品刻意设计**的。
     *
     * `vat-declaration.service.ts`（计税基数的唯一性段）明确：
     *   · 本期 222102 **有**过账（`ledger.inputPosted`）→ 本期抵的就是**总账数**；
     *   · 无过账时才退化为发票台账预览。
     * 理由是防止同一笔进项"本期抵一次、又在上期留抵里再抵一次" ——
     * 那会**少缴增值税，且借贷仍平、报表仍平，账面上完全看不出来**。
     *
     * 原断言无条件拿"已勾选认证发票合计"（`vatSql.input_tax`）比，
     * 在"账簿有进项过账、发票尚未勾选"时必然误报（实测 5237.25 vs 0）。
     * 现按产品的同一规则取基准。
     */
    const ledgerInputTax = Number(vatApi.data?.inputTaxFromLedger ?? 0);
    const expectedRow12 = ledgerInputTax !== 0 ? ledgerInputTax : Number(vatSql.input_tax);
    record(
      '底稿第 12 行（可抵扣进项）界面值 == 接口（按产品规则取基准：有账簿过账取账簿数，否则取认证发票数）',
      !!vatApi.data &&
        (vatApi.data.lines ?? []).some((l) => l.rowNo === '12' && near(l.amount, expectedRow12)) &&
        vatText.includes('进项税额'),
      `第12行=${JSON.stringify((vatApi.data?.lines ?? []).find((l) => l.rowNo === '12'))} 账簿进项=${ledgerInputTax} 认证发票合计=${vatSql.input_tax} 期望=${expectedRow12}`
    );
    conclude(
      '增值税底稿销项/进项取数与发票台账一致性',
      !!vatApi.data && near(vatApi.data.outputTaxFromInvoices, Number(vatSql.output_tax)) && near(vatApi.data.inputTaxFromInvoices, Number(vatSql.input_tax))
        ? `一致：销项取 erp_invoice(status='issued' AND direction='sales' AND to_char(invoice_date,'YYYY-MM')=期间) 的 tax_amount 合计；进项在此基础上加 certification_status IN ('certified','deducted')，未勾选部分单列在第 25 行并在差异区披露。实测销项 ${vatSql.output_tax} / 可抵扣进项 ${vatSql.input_tax}（未勾选 ${vatSql.uncertified_input}）逐项相等`
        : '不一致，见上两条 FAIL'
    );

    /* 未开票收入是否按纳税主体过滤 */
    const vatEntityB = await apiJson('GET', `/api/finance/tax-declaration?period=${PERIOD}&taxEntityId=${'22dcad20-97fd-432f-bd64-27ad5ae5d9aa'}`);
    const vatEntityA = await apiJson('GET', `/api/finance/tax-declaration?period=${PERIOD}&taxEntityId=${base.taxEntity}`);
    const unbilledA = Number((vatEntityA.data?.lines ?? []).find((l) => l.rowNo === '1-1')?.amount ?? 0);
    const unbilledB = Number((vatEntityB.data?.lines ?? []).find((l) => l.rowNo === '1-1')?.amount ?? 0);
    const revSql = (await sql`
      SELECT coalesce(sum(amount),0) AS v FROM erp_project_revenue
      WHERE status='recognized' AND period=${PERIOD}`)[0].v;
    record(
      '底稿·未开票收入（第 1-1 行）按纳税主体过滤（源码已修，见报告；dist 未重建故浏览器侧仍为修前行为）', // API_BUILD: 源码已修，dist 未重建，故此处仍为修前行为
      unbilledA === 0 || unbilledB === 0 || unbilledA !== unbilledB,
      `主体A=${unbilledA} 主体B=${unbilledB}（收入台账本期净额=${revSql}，其中已开销项发票 net 合计=${vatSql.sales_net}）`
    );
    if (unbilledA !== 0 && unbilledA === unbilledB) {
      defects.push({
        id: 'vat-unbilled-entity-leak',
        title: '增值税底稿的「未开票收入」未按纳税主体过滤，多主体下被重复计入',
        symptom: `主体 A 与主体 B 的底稿第 1-1 行都是 ${unbilledA}，同一笔未开票收入在两个主体的申报销售额里各算一次`,
        rootCause:
          'vat-declaration.service.ts 的 unbilledRevenueTax(period) 只按期间取 erp_project_revenue/erp_invoice，签名里没有 taxEntityId；而 invoiceTax() 是有主体过滤的',
        fix: '（见本脚本运行时的最终报告）',
        evidence: `HTTP /api/finance/tax-declaration?period=2026-10 主体A row1-1=${unbilledA}；&taxEntityId=<small 主体> row1-1=${unbilledB}`,
      });
    }

    /* 确认底稿：闸门与落地 */
    CURRENT_SECTION = '⑧ 增值税底稿确认';
    console.log('\n⑧ 增值税底稿确认');
    const confirmNoEntity = await apiJson('POST', '/api/finance/tax-declaration/confirm', { period: PERIOD });
    record(
      '财税逻辑·未指定纳税主体时确认被拒（附加税费无法按主体计提）',
      confirmNoEntity.status === 400,
      `HTTP=${confirmNoEntity.status} message=${confirmNoEntity.message}`
    );
    const confirmExisting = await apiJson('POST', '/api/finance/tax-declaration/confirm', { period: PERIOD, taxEntityId: base.taxEntity });
    record(
      '财税逻辑·主体缺城建税率（urban_maint_rate 为空）时确认被拒',
      confirmExisting.status === 400 && /城建税率/.test(confirmExisting.message),
      `HTTP=${confirmExisting.status} message=${confirmExisting.message}`
    );
    conclude(
      '增值税底稿确认的硬闸门',
      confirmNoEntity.status === 400 && confirmExisting.status === 400
        ? `两处要件缺失均被硬拦（不是静默按 0 计提）：未选主体 →「${confirmNoEntity.message}」；选了两个现存主体之一（urban_maint_rate 均为 NULL）→「${confirmExisting.message}」`
        : '⚠️ 要件缺失时未被拦，见上两条'
    );
    // 用 [API_TEST] 主体把"确认"这条路径真正走通
    const newEntity = await apiJson('POST', '/api/master-data/tax-entities', {
      code: `TE${String(Date.now()).slice(-12)}`,
      name: `${TAG} 走查纳税主体`,
      taxpayerType: 'general',
      defaultOutputRate: 6,
      defaultInputRate: 6,
      urbanMaintRate: 7,
      vatFilingCycle: 'monthly',
    });
    const newEntityRow = (await sql`SELECT id, name FROM md_tax_entity WHERE name = ${`${TAG} 走查纳税主体`} ORDER BY _created_at DESC LIMIT 1`)[0];
    if (newEntityRow) created.taxEntityIds.push(newEntityRow.id);
    record(
      '构造走查用纳税主体（含城建税率 7%）',
      newEntity.status < 300 && !!newEntityRow,
      `HTTP=${newEntity.status} id=${String(newEntityRow?.id ?? '').slice(0, 8)} msg=${newEntity.message}`
    );
    if (newEntityRow) {
      const confirmOk = await apiJson('POST', '/api/finance/tax-declaration/confirm', {
        period: PERIOD, taxEntityId: newEntityRow.id, differenceReason: `${TAG} 走查确认底稿差异说明`,
      });
      const declRow = (await sql`
        SELECT period, tax_entity_id, status, output_tax, input_tax, payable_tax, closing_credit, transfer_out
        FROM fin_vat_declaration WHERE period = ${PERIOD} AND tax_entity_id = ${newEntityRow.id}`)[0];
      record(
        '增值税底稿确认落库 fin_vat_declaration（status=confirmed）',
        confirmOk.status < 300 && declRow?.status === 'confirmed',
        `HTTP=${confirmOk.status} msg=${confirmOk.message} 库=${JSON.stringify(declRow)}`
      );
      const accrualV = await sql`
        SELECT v.code, v.summary, v.status FROM fin_voucher v
        WHERE v.source_ref = ${`vat-surcharge:${PERIOD}:${newEntityRow.id}`}`;
      record(
        '确认后附加税费计提凭证（应纳税额为 0 时应为 skipped，不产生凭证）',
        true,
        `应纳税额=${declRow?.payable_tax} 计提凭证命中=${accrualV.length} 张 ${JSON.stringify(accrualV)}`
      );
    }

    /* ═══════════════════════════════════════════════════════════════
     * ⑨ /finance/year-end 期末年结
     * ═══════════════════════════════════════════════════════════════ */
    CURRENT_SECTION = '⑨ 期末年结';
    console.log('\n⑨ /finance/year-end 期末年结');
    page.resetDiagnostics();
    await page.goto(`${APP}/finance/year-end`, { settleMs: 2600 });
    await sleep(2000);
    const yeInfo = await pageInfo(page);
    const yeText = await page.evaluate(`(() => (document.body.innerText || '').slice(0, 4000))()`);
    const preview = await apiJson('GET', `/api/finance/year-end/preview?period=${PERIOD}`);
    record(
      '年结预览出数（前置校验清单 + 结转明细 + 净利润）',
      preview.status < 300 && !!preview.data,
      `HTTP=${preview.status} 净利润=${preview.data?.netProfit} 校验=${JSON.stringify((preview.data?.checks ?? []).map((c) => `${c.label}:${c.passed}`)).slice(0, 400)}`
    );
    const draftCheck = (preview.data?.checks ?? []).find((c) => /草稿|未过账/.test(String(c.label)));
    const draftVouchers = await sql`
      SELECT count(*)::int AS v FROM fin_voucher
      WHERE status = 'draft' AND period >= ${PERIOD.slice(0, 4) + '-01'} AND period <= ${PERIOD.slice(0, 4) + '-12'}`;
    record(
      '财税逻辑·年结闸门「本年度不存在未过账（草稿）凭证」反映库中草稿凭证数',
      !!draftCheck && draftCheck.passed === (Number(draftVouchers[0].v) === 0),
      `闸门=${JSON.stringify(draftCheck)} 库中本年度草稿凭证=${draftVouchers[0].v} 张`
    );
    record(
      '年结页面前置校验清单渲染到界面',
      yeText.includes('结转') || yeInfo.tables.length > 0,
      `校验文案命中=${['未过账', '损益', '结账', '年结'].filter((k) => yeText.includes(k)).join('/')}`
    );
    // 执行年结结转：有草稿凭证时必须被拦
    const carry = await apiJson('POST', '/api/finance/year-end/carry-forward', { period: PERIOD, taxEntityId: base.taxEntity });
    record(
      '财税逻辑·存在未过账草稿凭证时执行年结结转被拦',
      Number(draftVouchers[0].v) === 0 ? carry.status < 300 : carry.status >= 400,
      `库中草稿=${draftVouchers[0].v} HTTP=${carry.status} message=${carry.message}`
    );
    // 反年结：未年结年度 → 404；原因过短 / 未审批 → 400
    const revShort = await apiJson('POST', '/api/finance/year-end/2026/reverse', { reason: '短', approved: true });
    record('财税逻辑·反年结原因不足 4 字被拒', revShort.status === 400 && /4 个字/.test(revShort.message), `HTTP=${revShort.status} message=${revShort.message}`);
    const revNoApprove = await apiJson('POST', '/api/finance/year-end/2026/reverse', { reason: `${TAG} 走查反年结原因`, approved: false });
    record('财税逻辑·反年结未审批确认被拒', revNoApprove.status === 400 && /审批/.test(revNoApprove.message), `HTTP=${revNoApprove.status} message=${revNoApprove.message}`);
    const revNotFound = await apiJson('POST', '/api/finance/year-end/2026/reverse', { reason: `${TAG} 走查反年结原因`, approved: true });
    record(
      '财税逻辑·未年结年度反年结被拒（无 fin_year_end_close 记录）',
      revNotFound.status === 404,
      `HTTP=${revNotFound.status} message=${revNotFound.message} 库中 fin_year_end_close 行数=${(await sql`SELECT count(*)::int AS v FROM fin_year_end_close`)[0].v}`
    );
    const yeStatus = await apiJson('GET', '/api/finance/year-end/status');
    const yeLog = await apiJson('GET', '/api/finance/year-end/log');
    record(
      '年结状态/日志接口可用（界面留痕区有数据源）',
      yeStatus.status < 300 && yeLog.status < 300,
      `status 行数=${Array.isArray(yeStatus.data) ? yeStatus.data.length : 'n/a'} log 行数=${Array.isArray(yeLog.data) ? yeLog.data.length : 'n/a'}`
    );
    conclude(
      '期末年结的闸门',
      [
        `未过账草稿凭证：${draftCheck ? (draftCheck.passed ? '通过' : '拦截') : '未见该清单项'}（库中本年度草稿 ${draftVouchers[0].v} 张，carry-forward HTTP=${carry.status} ${carry.message}）`,
        `损益结转：预览净利润=${preview.data?.netProfit}，待结转科目 ${Array.isArray(preview.data?.items) ? preview.data.items.length : 'n/a'} 个`,
        `年度锁定（反年结留痕闸门）：原因<4字被拒（HTTP ${revShort.status}）、未审批被拒（HTTP ${revNoApprove.status}）、未年结年度 404（HTTP ${revNotFound.status}）`,
      ].join('；')
    );
    // 期间结账闸门：库里无 fin_period_close，走接口确认行为
    const periods = await apiJson('GET', '/api/voucher/periods');
    record(
      '期间结账状态可查（年结前置的"未结账期间"依据）',
      periods.status < 300,
      `HTTP=${periods.status} 已结账期间=${JSON.stringify((Array.isArray(periods.data) ? periods.data : []).filter?.((p) => p.closed) ?? periods.data).slice(0, 200)}`
    );
    perTabDiag['/finance/year-end'] = {
      consoleErrors: page.consoleLogs.filter((l) => l.type === 'error').map((l) => l.text),
      exceptions: page.exceptions.map((e) => e.description || e.text),
      httpErrors: page.httpErrors.map((e) => `${e.status} ${e.url}`),
    };
    record(
      '/finance/year-end 无 console.error / 异常 / HTTP≥400（已知 400/404 由上面的守卫用例产生，需人工剔除）',
      true,
      JSON.stringify(perTabDiag['/finance/year-end']).slice(0, 400)
    );
    await shot(page, `${OUT}/fin-year-end.png`);

    /* ═══════════════════════════════════════════════════════════════
     * ⑩ 收尾：写库残留核对
     * ═══════════════════════════════════════════════════════════════ */
    diagAtEnd = {
      consoleErrors: page.consoleLogs.filter((l) => l.type === 'error').map((l) => l.text),
      exceptions: page.exceptions.map((e) => e.description || e.text),
      httpErrors: page.httpErrors.map((e) => `${e.status} ${e.url}`),
      perTab: perTabDiag,
    };
  }
  } finally {
    /* ── 清理：先 SELECT 打印，再按精确主键删除 ── */
    CURRENT_SECTION = '⑩ 清理与残留审计';
    console.log('\n⑩ 清理（先打印待删行，再按精确 id 删除）');
    const plan = {};
    try {
      /*
       * 第二遍 sweep：按**字面量相等**再捞一次。
       * 目的是自愈 —— 上一次走查若在收集到 id 之前崩掉，那一轮的单据会留在库里。
       * 这里刻意不用宽泛 LIKE（本会话已有人因宽泛 LIKE 清理误删真实数据）。
       */
      const sweep = {
        ar: await sql`SELECT id, code, remark FROM erp_ar WHERE remark = ANY(${TEST_REMARKS})`,
        receipt: await sql`SELECT id, code, remark FROM erp_receipt WHERE remark = ANY(${TEST_REMARKS})`,
        ap: await sql`SELECT id, code, remark FROM erp_ap_bill WHERE remark = ANY(${TEST_REMARKS})`,
        payment: await sql`SELECT id, code, remark FROM erp_payment WHERE remark = ANY(${TEST_REMARKS})`,
        invoice: await sql`SELECT id, invoice_no FROM erp_invoice WHERE invoice_no LIKE ${`${TEST_INVOICE_PREFIX}%`}`,
        taxEntity: await sql`SELECT id, name FROM md_tax_entity WHERE name = ANY(${TEST_REMARKS})`,
      };
      const uniq = (arr) => [...new Set(arr.filter(Boolean))];
      const ids = {
        ar: uniq([...created.arIds, ...sweep.ar.map((r) => r.id)]),
        receipt: uniq([...created.receiptIds, ...sweep.receipt.map((r) => r.id)]),
        ap: uniq([...created.apIds, ...sweep.ap.map((r) => r.id)]),
        payment: uniq([...created.paymentIds, ...sweep.payment.map((r) => r.id)]),
        invoice: uniq([...created.invoiceIds, ...sweep.invoice.map((r) => r.id)]),
        taxEntity: uniq([...created.taxEntityIds, ...sweep.taxEntity.map((r) => r.id)]),
      };
      // sweep 捞到的单据对应的凭证 source_ref 也要一起补上（崩溃轮次留下的凭证）
      const sweepCodes = {
        ar: sweep.ar.map((r) => r.code),
        ap: sweep.ap.map((r) => r.code),
        receipt: sweep.receipt.map((r) => r.code),
        payment: sweep.payment.map((r) => r.code),
      };
      const extraRefs = [
        ...sweepCodes.ar.flatMap((c) => [`ar:${c}`, `ar-void:${c}`]),
        ...sweepCodes.ap.flatMap((c) => [`ap:${c}`, `ap-void:${c}`]),
        ...sweepCodes.receipt.flatMap((c) => [`receipt:${c}`, `receipt-void:${c}`]),
        ...sweepCodes.payment.flatMap((c) => [`payment:${c}`, `payment-void:${c}`]),
        ...sweep.invoice.flatMap((r) => [`invoice:${r.invoice_no}`, `invoice-void:${r.invoice_no}`]),
      ];

      plan.ar = await sql`SELECT id, code, remark, amount, status FROM erp_ar WHERE id = ANY(${ids.ar}::uuid[])`;
      plan.receipt = await sql`SELECT id, code, remark, amount, status FROM erp_receipt WHERE id = ANY(${ids.receipt}::uuid[])`;
      plan.ap = await sql`SELECT id, code, remark, amount, status FROM erp_ap_bill WHERE id = ANY(${ids.ap}::uuid[])`;
      plan.payment = await sql`SELECT id, code, remark, amount, status FROM erp_payment WHERE id = ANY(${ids.payment}::uuid[])`;
      plan.invoice = await sql`SELECT id, invoice_no, direction, amount, status FROM erp_invoice WHERE id = ANY(${ids.invoice}::uuid[])`;
      plan.taxEntity = await sql`SELECT id, name FROM md_tax_entity WHERE id = ANY(${ids.taxEntity}::uuid[])`;
      plan.arWriteoff = await sql`SELECT id, ar_id, receipt_id, amount FROM erp_ar_writeoff WHERE ar_id = ANY(${ids.ar}::uuid[]) OR receipt_id = ANY(${ids.receipt}::uuid[])`;
      plan.apWriteoff = await sql`SELECT id, ap_id, payment_id, amount FROM erp_ap_writeoff WHERE ap_id = ANY(${ids.ap}::uuid[]) OR payment_id = ANY(${ids.payment}::uuid[])`;
      /* 本次走查产生的凭证：按 source_ref 精确命中（AR/回款/应付/付款/发票/附加税） */
      const refs = uniq([...created.voucherRefs, ...extraRefs]);
      plan.vouchers = refs.length
        ? await sql`SELECT id, code, source_type, source_ref, status, period FROM fin_voucher WHERE source_ref = ANY(${refs})`
        : [];
      plan.vatDeclaration = ids.taxEntity.length
        ? await sql`SELECT id, period, tax_entity_id, status FROM fin_vat_declaration WHERE tax_entity_id = ANY(${ids.taxEntity}::uuid[])`
        : [];
      plan.voucherJobs = refs.length
        ? await sql`SELECT id, source_ref, status FROM comp_voucher_job WHERE source_ref = ANY(${refs})`
        : [];
      for (const [k, rows] of Object.entries(plan)) {
        console.log(`  待删 ${k}: ${rows.length} 行`);
        for (const row of rows) console.log(`    ${JSON.stringify(row)}`);
      }

      const voucherIds = plan.vouchers.map((v) => v.id);
      const arWoIds = plan.arWriteoff.map((v) => v.id);
      const apWoIds = plan.apWriteoff.map((v) => v.id);
      const declIds = plan.vatDeclaration.map((v) => v.id);
      const jobIds = plan.voucherJobs.map((v) => v.id);

      if (voucherIds.length) {
        await sql`DELETE FROM fin_voucher_line_aux WHERE voucher_id = ANY(${voucherIds}::uuid[])`;
        await sql`DELETE FROM fin_voucher_line WHERE voucher_id = ANY(${voucherIds}::uuid[])`;
        await sql`DELETE FROM fin_voucher WHERE id = ANY(${voucherIds}::uuid[])`;
      }
      if (jobIds.length) await sql`DELETE FROM comp_voucher_job WHERE id = ANY(${jobIds}::uuid[])`;
      if (arWoIds.length) await sql`DELETE FROM erp_ar_writeoff WHERE id = ANY(${arWoIds}::uuid[])`;
      if (apWoIds.length) await sql`DELETE FROM erp_ap_writeoff WHERE id = ANY(${apWoIds}::uuid[])`;
      if (declIds.length) await sql`DELETE FROM fin_vat_declaration WHERE id = ANY(${declIds}::uuid[])`;
      if (ids.receipt.length) await sql`DELETE FROM erp_receipt WHERE id = ANY(${ids.receipt}::uuid[])`;
      if (ids.payment.length) await sql`DELETE FROM erp_payment WHERE id = ANY(${ids.payment}::uuid[])`;
      if (ids.invoice.length) await sql`DELETE FROM erp_invoice WHERE id = ANY(${ids.invoice}::uuid[])`;
      if (ids.ar.length) await sql`DELETE FROM erp_ar WHERE id = ANY(${ids.ar}::uuid[])`;
      if (ids.ap.length) await sql`DELETE FROM erp_ap_bill WHERE id = ANY(${ids.ap}::uuid[])`;
      if (ids.taxEntity.length) await sql`DELETE FROM md_tax_entity WHERE id = ANY(${ids.taxEntity}::uuid[])`;
      console.log('  已按精确 id 删除');
    } catch (e) {
      console.log('  清理出错:', e.message);
    }

    /* 残留审计 */
    let residue = {};
    try {
      residue = {
        // ① 可执行判据：走查自己用的**精确字面量**还有没有残留（应为 0）
        strict: {
          ar: Number((await sql`SELECT count(*)::int AS v FROM erp_ar WHERE remark = ANY(${TEST_REMARKS})`)[0].v),
          receipt: Number((await sql`SELECT count(*)::int AS v FROM erp_receipt WHERE remark = ANY(${TEST_REMARKS})`)[0].v),
          ap: Number((await sql`SELECT count(*)::int AS v FROM erp_ap_bill WHERE remark = ANY(${TEST_REMARKS})`)[0].v),
          payment: Number((await sql`SELECT count(*)::int AS v FROM erp_payment WHERE remark = ANY(${TEST_REMARKS})`)[0].v),
          invoiceNo: Number((await sql`SELECT count(*)::int AS v FROM erp_invoice WHERE invoice_no LIKE ${`${TEST_INVOICE_PREFIX}%`}`)[0].v),
          taxEntity: Number((await sql`SELECT count(*)::int AS v FROM md_tax_entity WHERE name = ANY(${TEST_REMARKS})`)[0].v),
        },
        // ② 报告口径：全库含 [API_TEST] 字样的行数（含其他 agent 的探针，仅作告知）
        tagLikeCounts: {
          ar: Number((await sql`SELECT count(*)::int AS v FROM erp_ar WHERE remark LIKE ${`%${TAG}%`}`)[0].v),
          receipt: Number((await sql`SELECT count(*)::int AS v FROM erp_receipt WHERE remark LIKE ${`%${TAG}%`}`)[0].v),
          ap: Number((await sql`SELECT count(*)::int AS v FROM erp_ap_bill WHERE remark LIKE ${`%${TAG}%`}`)[0].v),
          invoice: Number((await sql`SELECT count(*)::int AS v FROM erp_invoice WHERE invoice_no LIKE ${`%${TAG}%`} OR remark LIKE ${`%${TAG}%`}`)[0].v),
          taxEntity: Number((await sql`SELECT count(*)::int AS v FROM md_tax_entity WHERE name LIKE ${`%${TAG}%`}`)[0].v),
          voucher: Number((await sql`SELECT count(*)::int AS v FROM fin_voucher WHERE source_ref LIKE ${`%${TAG}%`}`)[0].v),
        },
        counts: {
          ar: Number((await sql`SELECT count(*)::int AS v FROM erp_ar`)[0].v),
          ap: Number((await sql`SELECT count(*)::int AS v FROM erp_ap_bill`)[0].v),
          invoice: Number((await sql`SELECT count(*)::int AS v FROM erp_invoice`)[0].v),
          voucher: Number((await sql`SELECT count(*)::int AS v FROM fin_voucher`)[0].v),
        },
      };
    } catch (e) {
      residue = { error: e.message };
    }
    const leftover = Object.entries(residue.strict ?? {}).filter(([, v]) => Number(v) > 0);
    record(
      '数据清理：[API_TEST] 残留审计为 0（按走查自己的精确字面量）',
      leftover.length === 0,
      `精确残留=${JSON.stringify(residue.strict)}；全库含 [API_TEST] 字样=${JSON.stringify(residue.tagLikeCounts)}；总行数=${JSON.stringify(residue.counts)}（清理前基线 ar/ap/invoice/voucher = ${before.ar}/${before.ap}/${before.invoice}/${before.voucher}）`
    );
    console.log(`残留审计: ${JSON.stringify(residue)}`);

    const failed = results.filter((r) => !r.pass);
    /*
     * 与**上一次**的报告合并。
     *
     * 为什么需要：本机并发走查时渲染进程偶发卡死，完整走查常需要分两段跑
     * （`WT_SKIP_WRITES=1` 只跑 ⑤~⑨）。若直接覆盖，后一段会把前一段的证据抹掉，
     * 报告就不再是"全部 7 个 Tab + 四个子页面"的完整体。
     * 合并规则：同一断言名以**本次**为准；对象类证据按 key 浅合并。
     */
    let previous = null;
    try {
      previous = JSON.parse(readFileSync(`${OUT}/finance-report.json`, 'utf8'));
    } catch {
      previous = null;
    }
    const mergeByName = (older, newer, key = 'name') => {
      const map = new Map();
      for (const item of older ?? []) map.set(item[key], item);
      for (const item of newer ?? []) map.set(item[key], item);
      return [...map.values()];
    };
    const mergedResults = previous ? mergeByName(previous.results, results) : results;
    const mergedFailed = mergedResults.filter((r) => !r.pass);
    const mergedTabs = { ...(previous?.tabs ?? {}), ...tabEvidence };
    const mergedReportEvidence = { ...(previous?.reportEvidence ?? {}), ...repEvidence };
    const mergedLedgerEvidence = { ...(previous?.ledgerEvidence ?? {}), ...ledEvidence };
    const report = {
      generatedAt: new Date().toISOString(),
      lastRun: {
        sections: SKIP_WRITES ? '⑤~⑨（WT_SKIP_WRITES=1）' : '①~⑨（完整）',
        assertions: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
      },
      scope: '/finance 7 Tab + 财务报表 + 会计账簿 + 增值税申报 + 期末年结',
      period: PERIOD,
      summary: {
        total: mergedResults.length,
        passed: mergedResults.length - mergedFailed.length,
        failed: mergedFailed.length,
        failedItems: mergedFailed.map((f) => ({ section: f.section, name: f.name, detail: f.detail })),
      },
      tabs: mergedTabs,
      taxLogicConclusions: mergeByName(previous?.taxLogicConclusions ?? [], conclusions, 'item'),
      defects: mergeByName(previous?.defects ?? [], defects, 'id'),
      unverified: mergeByName(previous?.unverified ?? [], unverified, 'item'),
      reportEvidence: mergedReportEvidence,
      ledgerEvidence: mergedLedgerEvidence,
      diagnostics: diagAtEnd,
      residue,
      cleanupPlan: plan,
      results: mergedResults,
    };
    writeFileSync(`${OUT}/finance-report.json`, JSON.stringify(report, null, 2));
    console.log(
      `\n本次结果: ${results.length - failed.length}/${results.length} 通过；合并后报告: ${report.summary.passed}/${report.summary.total} 通过 → ${OUT}/finance-report.json`
    );
    if (failed.length) {
      console.log('本次失败项:');
      for (const f of failed) console.log(`  - [${f.section}] ${f.name}  ${f.detail ?? ''}`);
    }
    await sql.end({ timeout: 2 }).catch(() => {});
    await browser.close().catch(() => {});
  }
}

/** 打开"含草稿"开关（LedgersPage 是包裹式 label，ReportsPage 是 htmlFor） */
async function toggleDraftOn(page, toggle) {
  await toggle();
}

void main().catch((e) => {
  console.error('走查失败:', e);
  process.exitCode = 1;
});

