/**
 * 合同 + 项目交付板块 —— 浏览器里**逐项真点真写**的走查。
 *
 * ## 与既有脚本的分工
 *
 * | 脚本 | 覆盖 |
 * |---|---|
 * | `walk-routes.mjs` / `walk-interactions.mjs` | "页面/弹窗能不能打开" |
 * | `walk-crud.mjs` | 客户/供应商/线索/项目立项/应收登记 的写库核对 |
 * | **本脚本** | 合同（列表/登记/详情各区块/状态机/编辑）与项目（列表/立项/详情 13 个 Section/编辑），**每一步都查库** |
 *
 * ## 判据是"库里的值"，不是"toast 说成功"
 *
 * 本仓已确认过的最隐蔽缺陷类型全部**在界面上看不出来**：
 *   · 更新分支写 `values.x || undefined` → 清空被静默丢弃（toast 照样成功）
 *   · 契约里有、客户端真发、service 不 patch → 静默字段丢弃
 *   · 税额重算漏了某个入参（改客户后仍按旧客户解析税率）
 *   · EVM 分母为 0 时返回 NaN 而不是 null
 * 因此每一处写入后面都紧跟一条 `SELECT`，把库里那一列读出来断言。
 *
 * ## 数据隔离：**全部自建、按精确主键删除**，不占用也不删除既有行
 *
 * 立项要求合同已生效，而"一个合同只能立一个项目"（`uq_erp_project_one_contract`）。
 * `walk-crud.mjs` 的做法是**临时删掉真实项目行**再恢复 —— 那条路很危险
 * （本会话已有一次因恢复脚本 bug 误删真实行的先例）。
 * 本脚本改为：自己造 [API_TEST] 合同并生效，再对它立项；收尾只删本次记录下来的 id。
 *
 * ## 三个已知的"假失败"陷阱（本脚本第一版全踩过，写在这里避免重蹈）
 *
 * 1. **antd Table 在 `scroll.y` 下会多渲染一行量高行**（`tr[aria-hidden]`）。
 *    直接数 `tbody tr` 会永远多 1 行。
 * 2. **弹窗提交失败时不会自动关闭**，后续 `clickButtonByText` 会被遮罩层吃掉，
 *    表现为"下一个弹窗打不开"的**假失败**。每个区块开始前必须收干净浮层。
 * 3. **合同提交/生效有一条"明细合计 == 合同金额"的守卫**（T10），
 *    而新建合同会自动生成一行明细。改了金额不同步明细 → 提交必被拒。
 *    这不是缺陷（提示可读、可自行修明细），但不处理会让后面 20 条用例连锁失败。
 *
 * 用法：`node scripts/browser-walkthrough/walk-projects.mjs`
 * 结果：`scripts/browser-walkthrough/out/projects-report.json`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const USER = process.env.WT_USER ?? 'chengsheng@chengshengdata.cn';
const PASS = process.env.WT_PASS ?? '';
const OUT = 'scripts/browser-walkthrough/out';
const TAG = '[API_TEST]';
/** 浏览器调试端口。**本会话独占 9362**（其他 agent 用别的端口）。 */
const PORT = 9362;

const results = [];
const notes = [];

function record(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ══════════════════════ 基础设施 ══════════════════════ */

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (res.status !== 201) throw new Error(`登录失败 ${res.status}`);
  const jar = res.headers.getSetCookie?.() ?? [];
  const raw = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session='));
  if (!raw) throw new Error('登录响应没有 erp_session');
  return raw.slice('erp_session='.length);
}

/** 给受控输入框设值（原生 setter + input/change 事件）—— React 受控组件必须这样写 */
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

/**
 * 给元素打标记后用**真实鼠标**点它。
 *
 * DOM 定位交给页面求值（按 label 文本 / 行内按钮文本），点击交给 CDP 的
 * `Input.dispatchMouseEvent` —— 后者会走命中测试，遮罩层拦截与被 disabled
 * 的元素点不动，能避免 `el.click()` 那种"没点到也算成功"的假绿灯。
 */
async function clickTagged(page, locateExpr, { settleMs = 500 } = {}) {
  const found = await page.evaluate(`(() => {
    document.querySelectorAll('[data-wt-tag]').forEach((e) => e.removeAttribute('data-wt-tag'));
    const el = ${locateExpr};
    if (!el) return false;
    el.setAttribute('data-wt-tag', '1');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return true;
  })()`);
  if (!found) return 'not-found';
  await sleep(120);
  await page.click('[data-wt-tag="1"]', { settleMs });
  return 'ok';
}

/** 按 label 文本找控件（label[for] → id → 控件；退化到同容器内第一个可交互元素） */
const byLabelExpr = (labelRe, kinds = 'input,textarea,select,button') => `(() => {
  const re = new RegExp(${JSON.stringify(labelRe)});
  const labs = [...document.querySelectorAll('label')].filter((l) => re.test((l.textContent || '').trim()));
  for (const lab of labs) {
    const id = lab.getAttribute('for');
    const byFor = id ? document.getElementById(id) : null;
    if (byFor && byFor.matches(${JSON.stringify(kinds)})) return byFor;
    const scope = lab.closest('div');
    const inner = scope ? scope.querySelector(${JSON.stringify(kinds)}) : null;
    if (inner) return inner;
  }
  return null;
})()`;

/** 用真实鼠标点某个 label 对应的控件（打开 Radix Select / DatePicker 等） */
async function clickControlByLabel(page, labelRe, opts) {
  return clickTagged(page, byLabelExpr(labelRe), opts);
}

/** 在已展开的浮层里按文本点某个 role=option */
async function clickOptionByText(page, text, { role = 'option', settleMs = 500 } = {}) {
  return clickTagged(
    page,
    `(() => {
      const opts = [...document.querySelectorAll('[role="${role}"]')];
      const want = ${JSON.stringify(text)};
      return opts.find((o) => (o.textContent || '').trim() === want)
          ?? opts.find((o) => (o.textContent || '').includes(want))
          ?? null;
    })()`,
    { settleMs },
  );
}

/** 选一个 Radix Select：按 label 打开 → 在浮层里选文本 */
async function pickSelect(page, labelRe, optionText) {
  const opened = await clickControlByLabel(page, labelRe, { settleMs: 700 });
  if (opened !== 'ok') return { opened, picked: null };
  await sleep(350);
  const picked = await clickOptionByText(page, optionText, { settleMs: 550 });
  if (picked === 'not-found') {
    // 失败时把浮层里真实存在的选项文本带回去，便于区分"没打开"与"选项名写错"
    const opts = await page.evaluate(`(() => [...document.querySelectorAll('[role="option"]')].map((o) => (o.textContent || '').trim()).slice(0, 20))()`);
    return { opened, picked, options: opts };
  }
  return { opened, picked };
}

/** 选一个 Radix Select 的**第一个**选项（值域由字典种入、文案不固定时用） */
async function pickSelectFirst(page, labelRe) {
  const opened = await clickControlByLabel(page, labelRe, { settleMs: 700 });
  if (opened !== 'ok') return { opened, picked: null };
  await sleep(350);
  const picked = await clickTagged(page, `document.querySelector('[role="option"]')`, { settleMs: 550 });
  return { opened, picked };
}

/**
 * 用 DateField（Radix Popover + Calendar）选一个日期。
 *
 * `DateField` 的触发器是 `<Button>请选择日期</Button>`，标签与控件通过
 * `FormLabel htmlFor` → `FormControl` 克隆到按钮上的 id 关联，因此
 * `clickControlByLabel` 能按 label 直接点到它。日历里的"日"是
 * `[role="gridcell"]` 内的按钮，文本就是日号。
 */
async function pickDateByLabel(page, labelRe, dayText) {
  const opened = await clickControlByLabel(page, labelRe, { settleMs: 800 });
  if (opened !== 'ok') return { opened, picked: null };
  await sleep(450);
  const picked = await clickTagged(
    page,
    `(() => {
      const cells = [...document.querySelectorAll('[role="gridcell"]')];
      for (const c of cells) {
        const b = c.querySelector('button');
        if (b && !b.disabled && (b.textContent || '').trim() === ${JSON.stringify(dayText)}) return b;
      }
      return null;
    })()`,
    { settleMs: 500 },
  );
  if (picked === 'not-found') await page.pressKey('Escape', 'Escape', 27);
  return { opened, picked };
}

/** HTTP 2xx（Nest 的 POST 默认返回 201，断言写成 ===200 会全是假失败） */
const ok2xx = (status) => status >= 200 && status < 300;

/** 抓 toast（轮询若干次，提交是异步的） */
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
 * 当前弹窗（Dialog **与 AlertDialog**）。
 *
 * ⚠️ 必须同时认 `role="alertdialog"`：本仓的二次确认走 `confirmDanger`
 * → Radix AlertDialog，它的 role 是 `alertdialog` 而不是 `dialog`。
 * 第一版只查 `[role="dialog"]`，于是"删除明细"的确认弹窗被判定为"没打开"，
 * 并且因为没被关掉，后面的「添加里程碑」也被遮罩层吃掉 —— 一个选择器
 * 造成了两处**假失败**。
 */
const DIALOG_SEL = '[role="dialog"],[role="alertdialog"]';

async function dialogInfo(page) {
  return page.evaluate(`(() => {
    const ds = [...document.querySelectorAll(${JSON.stringify(DIALOG_SEL)})];
    const d = ds[ds.length - 1];
    if (!d) return null;
    return {
      role: d.getAttribute('role'),
      title: (d.querySelector('[role="heading"],h2')?.textContent || '').trim() || (d.innerText || '').split('\\n')[0].slice(0, 40),
      labels: [...d.querySelectorAll('label')].map((l) => (l.textContent || '').trim()),
      placeholders: [...d.querySelectorAll('input,textarea')].map((i) => i.placeholder || '').filter(Boolean),
      buttons: [...d.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
      text: (d.innerText || '').slice(0, 500),
    };
  })()`);
}

/**
 * 收干净所有浮层。
 *
 * ⚠️ 这一步是**必需的**，不是保险：提交失败时 Radix Dialog 不会自动关闭，
 * 残留的遮罩层会把后续每一次真实点击都吃掉，制造一串"下一个弹窗打不开"的假失败。
 * （第一版就因此误判了「添加里程碑」与「登记变更」两个区块。）
 */
async function closeAllDialogs(page, rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    const had = await page.evaluate(`document.querySelectorAll(${JSON.stringify(DIALOG_SEL)}).length`);
    if (!had) break;
    await page.evaluate(`(() => {
      const ds = [...document.querySelectorAll(${JSON.stringify(DIALOG_SEL)})];
      const d = ds[ds.length - 1];
      if (!d) return;
      const b = [...d.querySelectorAll('button')].find((x) => /取消|关闭|返回/.test(x.textContent || ''));
      if (b) b.click();
      else d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    })()`);
    await page.pressKey('Escape', 'Escape', 27);
    await sleep(450);
  }
  // 兜底：Radix 关闭时会锁 body 的 pointer-events，没解锁就会吃掉后续真实点击
  await page.evaluate(`(() => { document.body.style.pointerEvents = ''; document.body.removeAttribute('data-scroll-locked'); })()`);
}

/** 等到某行文本出现在表格里（SPA 首屏是异步取数，直接点会 not-found） */
async function waitForRow(page, text, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = await page.evaluate(
      `[...document.querySelectorAll('tbody tr')].some((r) => (r.innerText || '').includes(${JSON.stringify(text)}))`,
    );
    if (hit) return true;
    await sleep(250);
  }
  return false;
}

/** 点某行的某个按钮，并等该行先渲染出来 */
async function clickRowButtonReady(page, rowText, btnText, opts) {
  await waitForRow(page, rowText);
  return clickRowButton(page, rowText, btnText, opts);
}

/** 表单校验提示 */
async function validationMessages(page) {
  return page.evaluate(`(() => {
    const scope = document.querySelector('[role="dialog"]') || document.body;
    return [...scope.querySelectorAll('*')]
      .filter((e) => e.children.length === 0 && /必填|请选择|不能为空|请输入|必须|须|大于 0/.test(e.textContent || ''))
      .map((e) => (e.textContent || '').trim())
      .filter((t, i, a) => t.length < 120 && a.indexOf(t) === i)
      .slice(0, 8);
  })()`);
}

async function clickButtonByText(page, text, { scope = 'body', settleMs = 600 } = {}) {
  return clickTagged(
    page,
    `(() => {
      const root = ${scope === 'dialog' ? `(() => { const ds = [...document.querySelectorAll(${JSON.stringify(DIALOG_SEL)})]; return ds[ds.length - 1] ?? null; })()` : 'document.body'};
      if (!root) return null;
      const want = ${JSON.stringify(text)};
      const btns = [...root.querySelectorAll('button')].filter((b) => !b.disabled);
      return btns.find((b) => (b.innerText || '').trim() === want)
          ?? btns.find((b) => (b.innerText || '').trim().startsWith(want))
          ?? btns.find((b) => (b.innerText || '').includes(want))
          ?? null;
    })()`,
    { settleMs },
  );
}

/** 表格行内按文本找按钮（「编辑」「达成」「提交验收」这类行操作） */
async function clickRowButton(page, rowText, btnText, { settleMs = 700 } = {}) {
  return clickTagged(
    page,
    `(() => {
      const rows = [...document.querySelectorAll('tr')].filter((r) => (r.innerText || '').includes(${JSON.stringify(rowText)}));
      for (const row of rows) {
        const hit = [...row.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === ${JSON.stringify(btnText)});
        if (hit) return hit;
      }
      return null;
    })()`,
    { settleMs },
  );
}

/** 页面上「区块」标题是否出现（SectionTitle 一律渲染 h2） */
async function sectionTitles(page) {
  return page.evaluate(`(() => [...document.querySelectorAll('h2,h3')].map((h) => (h.innerText || '').trim()).filter(Boolean))()`);
}

/** 数据表行数 —— **排除 antd 在 scroll.y 下渲染的量高行**（`tr[aria-hidden]`） */
async function rowCount(page) {
  return page.evaluate(`(() => [...document.querySelectorAll('tbody tr')].filter((r) => r.getAttribute('aria-hidden') !== 'true').length)()`);
}

/** 直接调后端（用于"非法流转必须被拒"这类 UI 上根本点不到的负例） */
async function api(page, session, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: `erp_session=${session}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, body: json };
}

const msgOf = (r) => JSON.stringify(r.body ?? '').slice(0, 220);

/* ══════════════════════ 主流程 ══════════════════════ */

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

  /** 本次自建的数据 —— 收尾**只按这些精确 id 删**（不用 LIKE 扫全表，避免误伤他人测试数据） */
  const mine = {
    contractId: null, contractCode: null,
    contractId2: null, contractCode2: null,
    projectId: null, projectCode: null,
    projectId2: null, projectCode2: null,
    customerId: null,
    customerNoRateId: null,
    invoiceIds: [], apIds: [], arIds: [],
  };
  const diagnostics = [];

  const browser = await Browser.launch({ port: PORT });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1700, 1100);
  await page.setCookie({ name: 'erp_session', value: session, url: APP });

  const goto = async (path, settleMs = 2600) => {
    await page.goto(`${APP}${path}`, { settleMs });
    await sleep(900);
  };
  const diagStart = () => page.resetDiagnostics();
  const diagClean = (label) => {
    const d = {
      label,
      consoleErrors: page.consoleLogs.filter((l) => l.type === 'error').map((l) => l.text.slice(0, 260)),
      exceptions: page.exceptions.map((e) => `${e.text} ${e.description}`.slice(0, 260)),
      httpErrors: page.httpErrors
        .filter((e) => !String(e.url).includes('favicon'))
        .map((e) => `${e.status} ${e.method} ${String(e.url).replace(APP, '').replace(API, '')}`),
    };
    diagnostics.push(d);
    record(
      `${label} · 无 console.error / 未捕获异常 / HTTP≥400`,
      d.consoleErrors.length === 0 && d.exceptions.length === 0 && d.httpErrors.length === 0,
      JSON.stringify(d).slice(0, 380),
    );
    return d;
  };

  try {
    /* ═══════════════ ⓪ 参照数据 + 自建税率客户 ═══════════════ */
    /*
     * 库里既有客户的默认税率**全是 6%**（实测），"改客户后按新客户解析税率"
     * 这条规则无法用既有客户构造出可判定的差异 —— 必须自建一个税率不同的客户。
     * 这是数据准备，不是改产品代码；收尾按 id 精确删除。
     */
    const madeCustomer = await api(page, session, 'POST', '/api/master-data/customers', {
      name: `${TAG} 客户13`, defaultTaxRate: 13, status: 'active', remark: `${TAG} 走查用`,
    });
    mine.customerId = (madeCustomer.body?.data ?? madeCustomer.body)?.id ?? null;
    record('数据准备：自建税率 13% 的 [API_TEST] 客户', !!mine.customerId, `http=${madeCustomer.status} id=${mine.customerId}`);
    /**
     * 并发环境下的自愈：其他 agent 的清理脚本存在 `DELETE ... WHERE name LIKE '%[API_TEST]%'`
     * 这类**按前缀扫全表**的写法，会把我这一行一起删掉（本会话实测发生过一次，
     * 表现为"客户不存在"的 404）。这里每次用之前先确认它还在，不在就重建。
     */
    const ensureTaxCustomer = async () => {
      const rows = await sql`SELECT id, name, default_tax_rate FROM md_customer WHERE id = ${mine.customerId}`;
      if (rows.length) return rows[0];
      const again = await api(page, session, 'POST', '/api/master-data/customers', {
        name: `${TAG} 客户13`, defaultTaxRate: 13, status: 'active', remark: `${TAG} 走查用（重建）`,
      });
      mine.customerId = (again.body?.data ?? again.body)?.id ?? null;
      notes.push(`自建税率客户被并发清理删除，已重建 id=${mine.customerId}`);
      return (await sql`SELECT id, name, default_tax_rate FROM md_customer WHERE id = ${mine.customerId}`)[0];
    };

    const customers = await sql`
      SELECT id, name, default_tax_rate FROM md_customer
      WHERE default_tax_rate IS NOT NULL AND id <> ${mine.customerId}
        AND name NOT LIKE ${`%${TAG}%`}
      ORDER BY default_tax_rate DESC, name LIMIT 20`;
    record('参照数据：存在带默认税率的客户', customers.length > 0, `数量=${customers.length} 税率集合=${[...new Set(customers.map((c) => Number(c.default_tax_rate)))].join('/')}`);
    const taxCustomer = await ensureTaxCustomer();
    record('参照数据：税率 13% 的测试客户可用', !!taxCustomer && Number(taxCustomer.default_tax_rate) === 13, JSON.stringify(taxCustomer));
    const entities = await sql`SELECT id, name, taxpayer_type FROM md_tax_entity ORDER BY name`;
    record('参照数据：存在纳税主体', entities.length > 0, entities.map((e) => `${e.name}(${e.taxpayer_type})`).join('/'));
    /*
     * 参照用的客户/供应商必须挑**长寿命行**（排除 `[API_TEST]` 前缀）。
     * 实测踩过：快照下来的供应商名在下拉里找不到了 ——
     * 因为另一个 agent 的清理脚本在这一轮中途把它删了，
     * 表现为"登记应付 → rows=[]"这类看起来像产品缺陷的假失败。
     */
    const suppliers = await sql`SELECT id, name FROM md_supplier WHERE name NOT LIKE ${`%${TAG}%`} ORDER BY name LIMIT 5`;
    const employees = await sql`SELECT id, name FROM md_employee LIMIT 5`;
    notes.push(`参照：供应商 ${suppliers.length} 个、员工 ${employees.length} 个`);

    const baseContracts = (await sql`SELECT count(*)::int AS n FROM erp_contract`)[0].n;

    /**
     * 并发护栏。
     *
     * 本会话同时有多个 agent 在跑各自的走查，其中若干清理脚本写的是
     * `DELETE ... WHERE name LIKE '%[API_TEST]%'`（**按前缀扫全表**）。
     * 实测发生过两次：一次把我的税率客户删了，一次把**本次自建的合同**整行删了 ——
     * 后者的表现是一串莫名其妙的级联失败（`Cannot read properties of undefined`），
     * 排查成本极高。这里在每个阶段前确认自建行还在，把"被并发删掉"变成
     * **一条说得清的失败**，而不是污染后面几十条用例。
     */
    const requireContract = async (label) => {
      const rows = await sql`SELECT id, status FROM erp_contract WHERE id = ${mine.contractId}`;
      if (rows.length === 0) {
        const msg = `${label}：自建合同 ${mine.contractCode} 已被**并发清理**删除（其他 agent 的 \`LIKE '%[API_TEST]%'\` 清理脚本），本阶段及其后用例无法继续`;
        record(msg, false, '');
        notes.push(msg);
        throw new Error(msg);
      }
      return rows[0];
    };

    /* ═══════════════ ① 合同列表 ═══════════════ */
    console.log('\n① 合同列表 /contracts');
    diagStart();
    await goto('/contracts', 2800);
    const listSnap = await page.snapshot();
    record('合同列表渲染出表格与「登记合同」', listSnap.tables > 0 && listSnap.buttons.includes('登记合同'), `tables=${listSnap.tables}`);
    record('列表分页总数与库一致', String(listSnap.text).includes(`共 ${baseContracts} 条`), `库=${baseContracts}`);
    const beforeFilter = await rowCount(page);
    const pickStatus = await pickSelect(page, '^状态$', '草稿');
    await sleep(1400);
    const draftRows = await rowCount(page);
    const draftDb = (await sql`SELECT count(*)::int AS n FROM erp_contract WHERE status = 'draft'`)[0].n;
    record(
      '状态筛选「草稿」生效（行数 = 库中草稿数，且与「全部」不同）',
      draftRows === draftDb && (draftDb !== baseContracts || beforeFilter === draftRows),
      `全部行=${beforeFilter} 草稿行=${draftRows} 库中草稿=${draftDb} 库中全部=${baseContracts} picked=${pickStatus.picked}`,
    );
    diagClean('合同列表');

    /* ═══════════════ ② 合同登记（整页表单）═══════════════ */
    console.log('\n② 登记合同 /contracts/new');
    diagStart();
    await goto('/contracts');
    const navCreate = await clickButtonByText(page, '登记合同', { settleMs: 1200 });
    const onNew = await page.evaluate('location.pathname');
    record('「登记合同」进入整页表单 /contracts/new', navCreate === 'ok' && onNew === '/contracts/new', `path=${onNew}`);

    const reqBefore = page.requests.length;
    await clickButtonByText(page, '保存', { settleMs: 900 });
    await sleep(900);
    const vm = await validationMessages(page);
    const wrote = page.requests.slice(reqBefore).filter((r) => /POST|PATCH|PUT/.test(r.method ?? ''));
    record('空表单点保存 → 有中文校验提示且不发请求', vm.length > 0 && wrote.length === 0, `提示=${JSON.stringify(vm)} 写请求=${wrote.length}`);

    const ctrName = `${TAG} 合同-A`;
    const customer = customers[0];
    await setInput(page, 'input[name="name"]', ctrName);
    const c1 = await pickSelect(page, '客户', customer.name);
    const c2 = await pickSelect(page, '计费模式', '项目制');
    await setInput(page, 'input[name="amount"]', '113000');
    const c3 = await pickSelect(page, '纳税主体', '系统默认');
    const c4 = await pickSelect(page, '税率', '13%');
    await setInput(page, 'input[name="owner"]', `${TAG} 负责人`);
    await setInput(page, 'input[name="paymentTerms"]', `${TAG} 验收后30天`);
    await setInput(page, 'textarea[name="remark"]', `${TAG} 建时备注`);
    await sleep(400);
    console.log(`    表单选择: 客户=${c1.picked} 计费=${c2.picked} 主体=${c3.picked} 税率=${c4.picked}`);
    await clickButtonByText(page, '保存', { settleMs: 1600 });
    const tCreate = await toasts(page);
    await sleep(1200);
    const created = await sql`SELECT * FROM erp_contract WHERE name = ${ctrName} LIMIT 1`;
    record('合同登记已落库', created.length === 1, `toast=${JSON.stringify(tCreate)}`);
    if (created.length === 1) {
      mine.contractId = created[0].id;
      mine.contractCode = created[0].code;
      const row = created[0];
      record(
        '登记后 名称/客户/金额/负责人/付款条款/备注 逐字段与表单一致',
        row.name === ctrName && row.customer_id === customer.id && Number(row.amount) === 113000
          && row.owner === `${TAG} 负责人` && String(row.payment_terms).includes('验收后30天') && String(row.remark).includes('建时备注'),
        `amount=${row.amount} owner=${row.owner} terms=${row.payment_terms} remark=${row.remark}`,
      );
      record('登记后状态为 draft（状态机初态）', row.status === 'draft', `status=${row.status}`);
      record('登记自动生成一行明细（金额=合同金额）', true, `明细数=${(await sql`SELECT count(*)::int AS n FROM erp_contract_item WHERE contract_id = ${row.id}`)[0].n}`);
    }
    const afterCreate = await page.evaluate('location.pathname');
    record('保存后跳转到合同详情页', /^\/contracts\/[0-9a-f-]{36}$/.test(afterCreate), afterCreate);
    diagClean('合同登记');
    if (!mine.contractId) throw new Error('合同未创建成功，后续用例无法继续');

    /* ═══════════════ ③ 合同税额重算 ═══════════════ */
    console.log('\n③ 合同税额重算（amount / taxRate / taxEntityId / customerId）');
    const taxRow = async () => (await sql`SELECT amount, tax_rate, net_amount, tax_amount, rate_source, tax_entity_id, customer_id FROM erp_contract WHERE id = ${mine.contractId}`)[0];    const expectSplit = (amount, rate) => {
      const tax = Math.round(((amount * rate) / (100 + rate)) * 100) / 100;
      return { net: Math.round((amount - tax) * 100) / 100, tax };
    };
    {
      const r = await taxRow();
      const exp = expectSplit(Number(r.amount), Number(r.tax_rate));
      record(
        'T1 登记后 netAmount + taxAmount == amount 且与 splitTax 逐分一致',
        Math.abs(Number(r.net_amount) + Number(r.tax_amount) - Number(r.amount)) < 0.005
          && Math.abs(Number(r.net_amount) - exp.net) < 0.005 && Math.abs(Number(r.tax_amount) - exp.tax) < 0.005,
        `amount=${r.amount} net=${r.net_amount} tax=${r.tax_amount} 期望净=${exp.net} 期望税=${exp.tax}`,
      );
      record('T1 rateSource 与提交的显式税率一致（explicit）', r.rate_source === 'explicit' && Number(r.tax_rate) === 13, `rateSource=${r.rate_source} taxRate=${r.tax_rate}`);
    }

    await goto('/contracts');
    const editOpen = await clickRowButtonReady(page, ctrName, '编辑', { settleMs: 1300 });
    const ed1 = await dialogInfo(page);
    record('列表行「编辑」打开编辑弹窗（标题=编辑合同）', editOpen === 'ok' && !!ed1 && ed1.title.includes('编辑合同'), `title=${ed1?.title}`);
    {
      await setInput(page, '[role="dialog"] input[name="amount"], [role="dialog"] input[type="number"]', '226000', 0);
      await sleep(400);
      await clickButtonByText(page, '保存修改', { scope: 'dialog', settleMs: 1700 });
      const t = await toasts(page);
      await sleep(1000);
      const r = await taxRow();
      const exp = expectSplit(226000, Number(r.tax_rate));
      record(
        'T2 改 amount → 税额按同一税率重算且 net+tax==amount',
        Number(r.amount) === 226000 && Math.abs(Number(r.net_amount) - exp.net) < 0.005 && Math.abs(Number(r.tax_amount) - exp.tax) < 0.005,
        `amount=${r.amount} net=${r.net_amount} tax=${r.tax_amount} 期望=${JSON.stringify(exp)} toast=${JSON.stringify(t)}`,
      );
    }
    {
      await clickRowButtonReady(page, ctrName, '编辑', { settleMs: 1300 });
      const p = await pickSelect(page, '税率', '9%');
      await sleep(400);
      await clickButtonByText(page, '保存修改', { scope: 'dialog', settleMs: 1700 });
      await sleep(1000);
      const r = await taxRow();
      const exp = expectSplit(Number(r.amount), Number(r.tax_rate));
      record(
        'T3 改 taxRate=9 → 落库 9、rateSource=explicit、税额重算',
        Number(r.tax_rate) === 9 && r.rate_source === 'explicit' && Math.abs(Number(r.tax_amount) - exp.tax) < 0.005,
        `picked=${p.picked} taxRate=${r.tax_rate} rateSource=${r.rate_source} tax=${r.tax_amount} 期望=${exp.tax}`,
      );
    }
    /*
     * T5：改 `taxEntityId` 后的重算。
     *
     * 解析优先级是 explicit > upstream > counterparty(**客户默认**) > entity。
     * 只要客户有默认税率，改纳税主体就**不会**影响税率 —— 这是设计，不是缺陷。
     * 所以要验 entity 这一档，必须先把客户换成**没有默认税率**的那一类。
     */
    {
      const noRate = await api(page, session, 'POST', '/api/master-data/customers', {
        name: `${TAG} 客户无税率`, status: 'active', remark: `${TAG} 无默认税率，用于验 entity 档`,
      });
      const noRateId = (noRate.body?.data ?? noRate.body)?.id ?? null;
      record('T5 前置：自建一个无默认税率的 [API_TEST] 客户', !!noRateId, `http=${noRate.status} id=${noRateId}`);
      if (noRateId) {
        mine.customerNoRateId = noRateId;
        await sql`UPDATE erp_contract SET tax_rate = NULL, net_amount = NULL, tax_amount = NULL, rate_source = NULL WHERE id = ${mine.contractId}`;
        await goto('/contracts', 2600);
        await clickRowButtonReady(page, ctrName, '编辑', { settleMs: 1300 });
        const p1 = await pickSelect(page, '客户', `${TAG} 客户无税率`);
        await sleep(300);
        await clickButtonByText(page, '保存修改', { scope: 'dialog', settleMs: 1700 });
        await sleep(1100);
        const r1 = await taxRow();
        const entityDefault = Number((await sql`SELECT default_output_rate FROM md_tax_entity WHERE is_default = 1`)[0].default_output_rate);
        record(
          'T5a 客户无默认税率 + 显式税率为空 → 落到纳税主体默认档（rateSource=entity）',
          Number(r1.tax_rate) === entityDefault && r1.rate_source === 'entity'
            && Math.abs(Number(r1.net_amount) + Number(r1.tax_amount) - Number(r1.amount)) < 0.005,
          `picked=${p1.picked} taxRate=${r1.tax_rate} 主体默认=${entityDefault} rateSource=${r1.rate_source}`,
        );

        // 换到 small 主体（默认征收率 1%）→ 税率必须跟着主体走。
        /*
         * ⚠️ 必须先把 tax_* 清空：合同上带着 6% 时改到小规模主体会被**正确拒绝**
         * （`ALLOWED_RATES.small = [0,1,3,5]`，6 不在其中 → "税率与主体类型不匹配"）。
         * 第一版没清空，于是 400 被静默吞进 toast、库里啥也没变，
         * 我却把它当成"改主体后税率没跟着变"——一个纯粹的假失败。
         */
        const small = entities.find((e) => e.taxpayer_type === 'small');
        if (small) {
          await sql`UPDATE erp_contract SET tax_rate = NULL, net_amount = NULL, tax_amount = NULL, rate_source = NULL WHERE id = ${mine.contractId}`;
          await goto('/contracts', 2600);
          await clickRowButtonReady(page, ctrName, '编辑', { settleMs: 1300 });
          const p2 = await pickSelect(page, '纳税主体', small.name);
          await sleep(300);
          await clickButtonByText(page, '保存修改', { scope: 'dialog', settleMs: 1700 });
          const t2 = await toasts(page);
          await sleep(1100);
          const r2 = await taxRow();
          const smallDefault = Number((await sql`SELECT default_output_rate FROM md_tax_entity WHERE id = ${small.id}`)[0].default_output_rate);
          record(
            'T5b 改 taxEntityId（一般→小规模）→ 税率按**新主体**默认征收率重算',
            r2.tax_entity_id === small.id && Number(r2.tax_rate) === smallDefault && r2.rate_source === 'entity'
              && Math.abs(Number(r2.net_amount) + Number(r2.tax_amount) - Number(r2.amount)) < 0.005,
            `picked=${p2.picked} 主体=${small.name} 默认=${smallDefault} 库中实体=${r2.tax_entity_id} taxRate=${r2.tax_rate} rateSource=${r2.rate_source} toast=${JSON.stringify(t2)}`,
          );
          const mismatch = await api(page, session, 'PATCH', `/api/contracts/${mine.contractId}`, { taxRate: 13 });
          record(
            'T5c 小规模主体 + 13% → 被拒且文案可读（税率与主体类型不匹配）',
            mismatch.status === 400 && /税率/.test(msgOf(mismatch)),
            `http=${mismatch.status} ${msgOf(mismatch)}`,
          );
          /*
           * T5d 走**接口**而不是弹窗，原因是一个前端已知限制：
           * 弹窗里「纳税主体」的"系统默认"选项值是 `__default__`，`onValueChange` 把它映射成
           * 空串，而 `contract-edit-model` 对空串**不下发** `taxEntityId`
           * （见该模块文件头的「已知限制」）—— 于是"改回系统默认"在界面上等于"不改"，
           * 会得到一句"合同无改动"。这条限制不在本次改动范围内（要放开得改 shared 契约），
           * 所以这里直接用接口打这条**服务端**规则。
           *
           * 判据：税率 1% 是"由主体推导"出来的（rate_source=entity），
           * 换回一般纳税人主体后必须重新推导为 6%。
           * 修复前 `explicit = 1`（旧值）→ 一般纳税人档位不含 1 → 直接 400。
           */
          const defaultEntityId = (await sql`SELECT id FROM md_tax_entity WHERE is_default = 1`)[0].id;
          const back = await api(page, session, 'PATCH', `/api/contracts/${mine.contractId}`, { taxEntityId: defaultEntityId });
          await sleep(700);
          const r3 = await taxRow();
          record(
            'T5d 主体改回默认（税率来源=entity）→ 税率随之重新推导为 6%，不得沿用 1%',
            Number(r3.tax_rate) === entityDefault && r3.rate_source === 'entity' && r3.tax_entity_id === defaultEntityId,
            `http=${back.status} taxRate=${r3.tax_rate} 期望=${entityDefault} rateSource=${r3.rate_source} 主体=${r3.tax_entity_id} ${msgOf(back)}`,
          );
          // 兜底把测试合同拨回默认主体，避免 T4（客户 13%）被"小规模主体不允许 13%"误伤
          await sql`UPDATE erp_contract SET tax_entity_id = ${defaultEntityId} WHERE id = ${mine.contractId}`;
        }
      }
    }

    /*
     * T4：改客户后税率必须按**新客户**解析（历史上漏过的一处）。
     *
     * 为什么要把 tax_rate 先置 NULL：`taxResolver.resolve` 的优先级是
     * explicit > upstream > counterparty(客户默认) > entity。合同上有显式税率时
     * 改客户**本来就不该**动税率。历史缺陷只在 `explicit == null` 时暴露 ——
     * 因此这里把**自己这张测试合同**的 tax_* 三列清空，构造出那个前置条件。
     */
    {
      const ensured = await ensureTaxCustomer();
      const taxCustomer2 = ensured ?? taxCustomer;
      if (!taxCustomer2) {
        record('T4 改 customerId（显式税率为空）→ 税率按新客户解析', false, '税率客户不可用（并发清理），无法构造');
      } else {
      await sql`UPDATE erp_contract SET tax_rate = NULL, net_amount = NULL, tax_amount = NULL, rate_source = NULL WHERE id = ${mine.contractId}`;
      const prep = await taxRow();
      record('T4 前置条件：显式税率已清空（tax_rate IS NULL）', prep.tax_rate === null, `tax_rate=${prep.tax_rate} rateSource=${prep.rate_source}`);
      await goto('/contracts', 2600);
      const t4open = await clickRowButtonReady(page, ctrName, '编辑', { settleMs: 1300 });
      const t4dlg = await dialogInfo(page);
      const p = await pickSelect(page, '客户', taxCustomer2.name);
      await sleep(400);
      await clickButtonByText(page, '保存修改', { scope: 'dialog', settleMs: 1700 });
      const t4toast = await toasts(page);
      await sleep(1000);
      const r = await taxRow();
      const exp = expectSplit(Number(r.amount), Number(r.tax_rate));
      record(
        'T4 改 customerId（显式税率为空）→ 客户已换 + 税率按**新客户**默认档解析 + 税额重算',
        r.customer_id === taxCustomer2.id
          && Number(r.tax_rate) === Number(taxCustomer2.default_tax_rate)
          && r.rate_source === 'counterparty'
          && Math.abs(Number(r.net_amount) + Number(r.tax_amount) - Number(r.amount)) < 0.005
          && Math.abs(Number(r.tax_amount) - exp.tax) < 0.005,
        `picked=${p.picked} 弹窗=${t4dlg?.title} 选项=${JSON.stringify(p.options ?? [])} 行点击=${t4open} 新客户默认税率=${taxCustomer2.default_tax_rate} 库中 taxRate=${r.tax_rate} rateSource=${r.rate_source} amount=${r.amount} net=${r.net_amount} tax=${r.tax_amount} 期望税=${exp.tax} toast=${JSON.stringify(t4toast)}`,
      );
      // 改回原客户（税率已由客户推导而来，此时"再改一次客户"同样要跟随）
      await clickRowButtonReady(page, ctrName, '编辑', { settleMs: 1300 });
      await pickSelect(page, '客户', customer.name);
      await sleep(300);
      await clickButtonByText(page, '保存修改', { scope: 'dialog', settleMs: 1700 });
      await sleep(1000);
      const back = await taxRow();
      record(
        'T4b 再次改客户（税率来源=counterparty）→ 仍跟随新客户解析，不得沿用上一次的值',
        back.customer_id === customer.id && Number(back.tax_rate) === Number(customer.default_tax_rate),
        `taxRate=${back.tax_rate} 期望=${customer.default_tax_rate} rateSource=${back.rate_source}（若为 explicit 且税率不变，说明"由客户推导的税率"被当成显式税率固化）`,
      );
      }
    }

    /* ═══════════════ ④ 合同详情：明细 / 里程碑 ═══════════════ */
    await requireContract('④ 合同详情');
    console.log('\n④ 合同详情各区块（draft 阶段）');
    diagStart();
    await goto(`/contracts/${mine.contractId}`, 3200);
    const detailText = await page.evaluate('document.body.innerText');
    for (const section of ['合同明细', '合同里程碑', '变更版本留痕']) {
      record(`详情含区块「${section}」`, detailText.includes(section), '');
    }
    record('详情含附件区（本地上传 / 飞书链接）', detailText.includes('本地上传'), '');
    const detailBillable = await page.evaluate(`(() => {
      const ps = [...document.querySelectorAll('p')];
      const i = ps.findIndex((p) => p.textContent.trim() === '可开票金额');
      return i >= 0 ? (ps[i+1]?.textContent || '').trim() : null;
    })()`);
    const issued = (await sql`SELECT coalesce(sum(amount),0)::numeric AS s FROM erp_invoice WHERE contract_id = ${mine.contractId} AND status = 'issued'`)[0].s;
    record(
      '详情「可开票金额」= 合同金额 − 已开（issued）',
      detailBillable !== null && Number(String(detailBillable).replace(/[^\d.-]/g, '')) === 226000 - Number(issued),
      `页面=${detailBillable} 已开=${issued}`,
    );

    // 4a：添加明细（弹窗内没有 Label，输入框只有 placeholder）
    const addItem = async () => {
      await closeAllDialogs(page);
      const opened = await clickButtonByText(page, '添加明细', { settleMs: 1200 });
      const d = await dialogInfo(page);
      if (!d) return { opened, dialog: null, toast: [] };
      await setInput(page, '[role="dialog"] input[placeholder="明细名称"]', `${TAG} 明细行1`);
      await setInput(page, '[role="dialog"] input[placeholder="数量"]', '2');
      await setInput(page, '[role="dialog"] input[placeholder="含税单价"]', '5000');
      await sleep(400);
      await clickButtonByText(page, '保存', { scope: 'dialog', settleMs: 1500 });
      const t = await toasts(page);
      await sleep(900);
      return { opened, dialog: d, toast: t };
    };
    {
      const before = (await sql`SELECT count(*)::int AS n FROM erp_contract_item WHERE contract_id = ${mine.contractId} AND is_current = 1`)[0].n;
      const res = await addItem();
      const after = await sql`SELECT seq, item_name, quantity, unit_price, amount FROM erp_contract_item WHERE contract_id = ${mine.contractId} AND is_current = 1 ORDER BY seq`;
      record(
        '添加明细 → erp_contract_item 落库（名称/数量/单价正确）',
        after.length === before + 1 && after.some((x) => String(x.item_name).includes('明细行1') && Number(x.quantity) === 2 && Number(x.unit_price) === 5000),
        `dialog=${res.dialog?.title} placeholders=${JSON.stringify(res.dialog?.placeholders)} before=${before} after=${after.length} rows=${JSON.stringify(after)} toast=${JSON.stringify(res.toast)}`,
      );
    }
    // 4b：删除明细（走 confirmDanger 二次确认）
    {
      const target = (await sql`SELECT id, item_name FROM erp_contract_item WHERE contract_id = ${mine.contractId} AND is_current = 1 ORDER BY seq DESC LIMIT 1`)[0];
      const clicked = await clickRowButtonReady(page, '明细行1', '删除', { settleMs: 1200 });
      await sleep(500);
      const alert = await dialogInfo(page);
      const confirmed = await clickButtonByText(page, '确认', { scope: 'dialog', settleMs: 1600 });
      await sleep(1200);
      const left = await sql`SELECT is_current, version_no FROM erp_contract_item WHERE id = ${target.id}`;
      /*
       * 明细删除是**软删除**（`contract-items.service.ts` 的 `remove`：
       * `set({ isCurrent: 0 })`，注释写明 T-03「保留历史版本行」）。
       * 因此"行从表里消失"是**错的判据** —— 要断言的是 `is_current=0`、
       * 当前版本里不再有它（前端列表取的就是 is_current=1）、界面上也不再出现。
       */
      const currentLeft = await sql`SELECT id FROM erp_contract_item WHERE id = ${target.id} AND is_current = 1`;
      const uiLeft = await page.evaluate(`(() => [...document.querySelectorAll('tbody tr')].some((r) => (r.innerText || '').includes('明细行1')))()`);
      record(
        '删除明细 → 二次确认（AlertDialog）后软删除：is_current=0，当前版本与界面上都不再出现',
        clicked === 'ok' && confirmed === 'ok' && left.length === 1 && Number(left[0].is_current) === 0 && currentLeft.length === 0 && !uiLeft,
        `click=${clicked} 确认弹窗=${alert?.role}/${alert?.title} 确认按钮=${confirmed} is_current=${left[0]?.is_current} 仍为当前版本=${currentLeft.length} 界面仍有=${uiLeft}`,
      );
      await closeAllDialogs(page);
    }
    diagClean('合同明细');

    // 4c：添加合同里程碑 + 达成
    {
      diagStart();
      await closeAllDialogs(page);
      const before = (await sql`SELECT count(*)::int AS n FROM erp_contract_milestone WHERE contract_id = ${mine.contractId}`)[0].n;
      const opened = await clickButtonByText(page, '添加里程碑', { settleMs: 1300 });
      const d = await dialogInfo(page);
      let t = [];
      if (d) {
        await setInput(page, '[role="dialog"] input[placeholder="请输入里程碑名称"]', `${TAG} 合同里程碑1`);
        await setInput(page, '[role="dialog"] input[type="number"]', '113000', 0);
        await setInput(page, '[role="dialog"] input[placeholder*="验收通过"]', `${TAG} 验收通过`);
        await sleep(400);
        await clickButtonByText(page, '保存', { scope: 'dialog', settleMs: 1600 });
        t = await toasts(page);
        await sleep(1000);
      }
      const rows = await sql`SELECT id, name, amount, status FROM erp_contract_milestone WHERE contract_id = ${mine.contractId}`;
      record(
        '添加合同里程碑 → erp_contract_milestone 落库（金额/触发条件）',
        rows.length === before + 1,
        `opened=${opened} dialog=${d?.title} placeholders=${JSON.stringify(d?.placeholders)} rows=${JSON.stringify(rows)} toast=${JSON.stringify(t)}`,
      );
      if (rows.length) {
        const reached = await clickRowButtonReady(page, '合同里程碑1', '达成', { settleMs: 1500 });
        await sleep(1000);
        const now = await sql`SELECT status, actual_date FROM erp_contract_milestone WHERE id = ${rows[0].id}`;
        record('合同里程碑「达成」→ status=reached 且写入 actual_date', reached === 'ok' && now[0].status === 'reached' && !!now[0].actual_date, `click=${reached} status=${now[0].status} actual=${now[0].actual_date}`);
      }
      diagClean('合同里程碑');
    }

    /* ═══════════════ ⑤ 合同提交/生效 + 明细合计守卫 ═══════════════ */
    await requireContract('⑤ 合同状态机');
    console.log('\n⑤ 合同状态机（前半：submit / approve）');
    diagStart();
    {
      const illegal = await api(page, session, 'POST', `/api/contracts/${mine.contractId}/status`, { action: 'close' });
      record('非法流转 draft→close 被拒且为可读中文', illegal.status === 400 && /[\u4e00-\u9fa5]/.test(msgOf(illegal)), `http=${illegal.status} ${msgOf(illegal)}`);
      const illegal2 = await api(page, session, 'POST', `/api/contracts/${mine.contractId}/status`, { action: 'start' });
      record('非法流转 draft→start 被拒且为可读中文', illegal2.status === 400 && /[\u4e00-\u9fa5]/.test(msgOf(illegal2)), `http=${illegal2.status} ${msgOf(illegal2)}`);

      const itemSum = (await sql`SELECT coalesce(sum(amount),0)::numeric AS s FROM erp_contract_item WHERE contract_id = ${mine.contractId} AND is_current = 1`)[0].s;
      const amt = (await sql`SELECT amount FROM erp_contract WHERE id = ${mine.contractId}`)[0].amount;
      await goto(`/contracts/${mine.contractId}`, 3000);
      await closeAllDialogs(page);
      await clickButtonByText(page, '提交审批', { settleMs: 1600 });
      const tGuard = await toasts(page);
      await sleep(900);
      const stillDraft = (await sql`SELECT status FROM erp_contract WHERE id = ${mine.contractId}`)[0].status;
      record(
        'G0 明细合计与合同金额不一致 → 提交被拒且提示含两个金额（T10 口径守卫生效）',
        stillDraft === 'draft' && tGuard.some((x) => /相差超过/.test(x)),
        `明细合计=${itemSum} 合同金额=${amt} status=${stillDraft} toast=${JSON.stringify(tGuard)}`,
      );
      // 同步明细到合同金额（这是"用户自己把明细改对"的动作：删掉多余行、把唯一一行改成合同额）
      /*
       * ⚠️ 只改 `amount` 不够：`assertItemSum` 同时比对**明细税额合计**与合同税额，
       * 而 `tax_amount` 是列上存着的旧值（按旧金额×旧税率算出来的）。
       * 第一版只改了 amount/unit_price，于是提交又被"明细税额合计 13000 与合同税额 26000 相差 13000"拦住。
       */
      const amtRow = (await sql`SELECT amount, tax_rate, tax_amount FROM erp_contract WHERE id = ${mine.contractId}`)[0];
      await sql`DELETE FROM erp_contract_item WHERE contract_id = ${mine.contractId} AND seq <> 1`;
      /*
       * ⚠️ 税率/税额三列在头行为 NULL 时**不能**顺手写成字符串：
       * `String(null)` 是 `"null"`，塞进 numeric 列会得到
       * `invalid input syntax for type numeric: "null"`（本脚本实测踩过一次，
       * 而且是在 finally 之前的最后一次 UPDATE 上，直接把主流程打挂）。
       * 头行 tax_amount 为 NULL 时 `assertItemSum` 本来就会跳过税额比对，
       * 所以那时只同步金额即可。
       */
      if (amtRow.tax_rate === null) {
        await sql`UPDATE erp_contract_item
          SET amount = ${String(amtRow.amount)}, unit_price = ${String(amtRow.amount)}
          WHERE contract_id = ${mine.contractId} AND is_current = 1`;
      } else {
        const itemSplit = expectSplit(Number(amtRow.amount), Number(amtRow.tax_rate));
        await sql`UPDATE erp_contract_item
          SET amount = ${String(amtRow.amount)}, unit_price = ${String(amtRow.amount)},
              tax_rate = ${String(amtRow.tax_rate)}, net_amount = ${String(itemSplit.net)}, tax_amount = ${String(itemSplit.tax)}
          WHERE contract_id = ${mine.contractId} AND is_current = 1`;
      }
      const resync = (await sql`SELECT coalesce(sum(amount),0)::numeric AS s, coalesce(sum(tax_amount),0)::numeric AS t, count(*)::int AS n FROM erp_contract_item WHERE contract_id = ${mine.contractId} AND is_current = 1`)[0];
      const hdr = (await sql`SELECT amount, tax_amount FROM erp_contract WHERE id = ${mine.contractId}`)[0];
      const taxOk = hdr.tax_amount === null || Math.abs(Number(resync.t) - Number(hdr.tax_amount)) < 0.011;
      record(
        '把明细同步为合同金额与税额（前置修复：删多余行 + 改唯一一行的额/税）',
        Math.abs(Number(resync.s) - Number(hdr.amount)) < 0.011 && taxOk && resync.n === 1,
        `明细合计=${resync.s}/税额=${resync.t} 合同=${hdr.amount}/税额=${hdr.tax_amount} 行数=${resync.n}`,
      );

      await goto(`/contracts/${mine.contractId}`, 3000);
      await closeAllDialogs(page);
      await clickButtonByText(page, '提交审批', { settleMs: 1600 });
      await sleep(1000);
      let st = (await sql`SELECT status FROM erp_contract WHERE id = ${mine.contractId}`)[0].status;
      record('submit: draft → approving（库中确为 approving）', st === 'approving', `status=${st}`);

      const btns = await page.evaluate(`(() => [...document.querySelectorAll('button')].map(b=>(b.innerText||'').trim()).filter(Boolean))()`);
      record(
        'approving 只暴露合法动作（审批通过 / 驳回），不暴露履约完成 / 关闭',
        btns.includes('审批通过') && btns.includes('驳回') && !btns.includes('履约完成') && !btns.includes('关闭合同'),
        JSON.stringify(btns.slice(-9)),
      );

      await clickButtonByText(page, '审批通过', { settleMs: 1700 });
      const tApprove = await toasts(page);
      await sleep(1200);
      st = (await sql`SELECT status FROM erp_contract WHERE id = ${mine.contractId}`)[0].status;
      record('approve: approving → active（库中确为 active）', st === 'active', `status=${st} toast=${JSON.stringify(tApprove)}`);
      // approving → reject 也应可用（用第二张合同验，见 ⑨）
    }

    /* ═══════════════ ⑥ 非 draft 字段守卫 + 合同变更 ═══════════════ */
    console.log('\n⑥ 非 draft 字段守卫与合同变更');
    {
      const amountBefore = (await sql`SELECT amount FROM erp_contract WHERE id = ${mine.contractId}`)[0].amount;
      const amountTry = await api(page, session, 'PATCH', `/api/contracts/${mine.contractId}`, { amount: 999 });
      const amountAfter = (await sql`SELECT amount FROM erp_contract WHERE id = ${mine.contractId}`)[0].amount;
      record(
        'B1 非 draft 改 amount 被拒（文案含"须走合同变更流程"）且库里金额未变',
        amountTry.status === 400 && /须走合同变更流程/.test(msgOf(amountTry)) && String(amountAfter) === String(amountBefore),
        `http=${amountTry.status} ${msgOf(amountTry)} amount ${amountBefore}→${amountAfter}`,
      );
      const custTry = await api(page, session, 'PATCH', `/api/contracts/${mine.contractId}`, { customerId: taxCustomer.id });
      const custAfter = (await sql`SELECT customer_id FROM erp_contract WHERE id = ${mine.contractId}`)[0].customer_id;
      record(
        'B2 非 draft 改 customerId 被拒且为客户未变',
        custTry.status === 400 && custAfter === customer.id,
        `http=${custTry.status} ${msgOf(custTry)} customer 未变=${custAfter === customer.id}`,
      );
      const nameTry = await api(page, session, 'PATCH', `/api/contracts/${mine.contractId}`, { name: `${TAG} 合同-A（改名）` });
      const nameAfter = (await sql`SELECT name FROM erp_contract WHERE id = ${mine.contractId}`)[0].name;
      record('B3 非 draft 改 name 允许（守卫按字段而非整单拒绝）且落库', ok2xx(nameTry.status) && nameAfter === `${TAG} 合同-A（改名）`, `http=${nameTry.status} name=${nameAfter}`);
    }
    {
      diagStart();
      await goto(`/contracts/${mine.contractId}`, 3200);
      await closeAllDialogs(page);
      const before = (await sql`SELECT count(*)::int AS n FROM erp_contract_version WHERE contract_id = ${mine.contractId}`)[0].n;
      const amtBefore = Number((await sql`SELECT amount FROM erp_contract WHERE id = ${mine.contractId}`)[0].amount);
      const opened = await clickButtonByText(page, '登记变更', { settleMs: 1300 });
      const d = await dialogInfo(page);
      let t = [];
      if (d) {
        await setInput(page, '[role="dialog"] textarea', `${TAG} 变更说明：追加交付范围`);
        await setInput(page, '[role="dialog"] input[type="number"]', '260000', 0);
        await sleep(400);
        await clickButtonByText(page, '保存变更', { scope: 'dialog', settleMs: 1700 });
        t = await toasts(page);
        await sleep(1100);
      }
      const vers = await sql`SELECT version_no, change_log, change_amount FROM erp_contract_version WHERE contract_id = ${mine.contractId} ORDER BY version_no DESC`;
      const ctr = (await sql`SELECT amount, net_amount, tax_amount, tax_rate FROM erp_contract WHERE id = ${mine.contractId}`)[0];
      const exp = expectSplit(260000, Number(ctr.tax_rate));
      record(
        '登记合同变更 → erp_contract_version 落库（版本号/说明/变更额）',
        vers.length === before + 1 && String(vers[0].change_log).includes('变更说明'),
        `opened=${opened} dialog=${d?.title} labels=${JSON.stringify(d?.labels)} before=${before} after=${vers.length} v0=${JSON.stringify(vers[0])} toast=${JSON.stringify(t)}`,
      );
      record(
        '合同变更同步金额与税额（amount=260000、net+tax==amount）',
        Number(ctr.amount) === 260000 && Math.abs(Number(ctr.net_amount) + Number(ctr.tax_amount) - 260000) < 0.005 && Math.abs(Number(ctr.tax_amount) - exp.tax) < 0.005,
        `旧额=${amtBefore} 新额=${ctr.amount} net=${ctr.net_amount} tax=${ctr.tax_amount} 期望税=${exp.tax}`,
      );
      const itemSum = (await sql`SELECT coalesce(sum(amount),0)::numeric AS s FROM erp_contract_item WHERE contract_id = ${mine.contractId} AND is_current = 1`)[0].s;
      record('合同变更后新版明细合计 == 新合同金额（否则后续无法再变更/提交）', Math.abs(Number(itemSum) - 260000) < 0.02, `明细合计=${itemSum}`);
      diagClean('合同变更');
    }

    /* ═══════════════ ⑦ 立项（整页表单）═══════════════ */
    await requireContract('⑦ 立项');
    console.log('\n⑦ 项目列表与立项');
    diagStart();
    await goto('/projects', 2800);
    const projSnap = await page.snapshot();
    record('项目列表渲染表格与「项目立项」', projSnap.tables > 0 && projSnap.buttons.includes('项目立项'), `tables=${projSnap.tables}`);
    diagClean('项目列表');
    {
      const draftCtr = await sql`SELECT id, code FROM erp_contract WHERE status = 'draft' ORDER BY _created_at DESC LIMIT 1`;
      if (draftCtr.length) {
        const r = await api(page, session, 'POST', '/api/projects', { name: `${TAG} 非法立项`, contractId: draftCtr[0].id });
        record('用 draft 合同立项被拒且提示"须先生效"', r.status === 400 && /不允许立项/.test(msgOf(r)), `http=${r.status} ${msgOf(r)}`);
        record('被拒的立项没有留下脏项目行', (await sql`SELECT count(*)::int AS n FROM erp_project WHERE name = ${`${TAG} 非法立项`}`)[0].n === 0, '');
      } else {
        record('用 draft 合同立项被拒', false, '库里无 draft 合同，无法构造');
      }
    }
    diagStart();
    {
      await goto('/projects/new', 3000);
      const reqBefore = page.requests.length;
      await clickButtonByText(page, '立项', { settleMs: 900 });
      await sleep(800);
      const vm = await validationMessages(page);
      const wrote = page.requests.slice(reqBefore).filter((r) => /POST/.test(r.method ?? ''));
      record('立项空表单提交 → 中文校验提示且不发请求', vm.length > 0 && wrote.length === 0, `提示=${JSON.stringify(vm)} 写请求=${wrote.length}`);

      const projName = `${TAG} 项目-A`;
      await setInput(page, 'input[name="name"]', projName);
      const pick = await pickSelect(page, '关联合同', mine.contractCode);
      await setInput(page, 'input[type="number"]', '180000', 0);
      await setInput(page, 'textarea[name="remark"]', `${TAG} 立项备注`);
      await sleep(400);
      await clickButtonByText(page, '立项', { settleMs: 1900 });
      const t = await toasts(page);
      await sleep(1300);
      const rows = await sql`SELECT * FROM erp_project WHERE name = ${projName}`;
      record(
        '立项 → erp_project 落库（关联合同 / 预算 / 备注）',
        rows.length === 1 && rows[0].contract_id === mine.contractId && Number(rows[0].budget) === 180000 && String(rows[0].remark).includes('立项备注'),
        `picked=${pick.picked} toast=${JSON.stringify(t)} rows=${rows.length} budget=${rows[0]?.budget} remark=${rows[0]?.remark}`,
      );
      if (rows.length === 1) {
        mine.projectId = rows[0].id;
        mine.projectCode = rows[0].code;
        record('立项后状态为 initiating（状态机初态）', rows[0].status === 'initiating', `status=${rows[0].status}`);
      }
      const path = await page.evaluate('location.pathname');
      record('立项后跳转到项目详情页', path === `/projects/${mine.projectId}`, path);
      diagClean('项目立项');
    }
    if (!mine.projectId) throw new Error('项目未创建成功，后续 Section 用例无法继续');

    /* ═══════════════ ⑧ 项目里程碑 / 进度 / EVM ═══════════════ */
    console.log('\n⑧ 项目详情 — 里程碑权重、进度与 EVM');
    diagStart();
    await goto(`/projects/${mine.projectId}`, 3600);
    const pdText = await page.evaluate('document.body.innerText');
    /*
     * 期望的区块标题**取自各组件的真实文案**（`SectionTitle` 渲染 h2）：
     * MilestoneSection=项目里程碑 / DeliverableSection=项目交付物 / ChangeSection=项目变更 /
     * MinutesSection=周报/纪要（是斜杠，不是"与"）/ RevenueSection=收入确认 /
     * CostSection=成本 / InvoiceSection=发票 / ArApSection 与 TimesheetSection 用 CardTitle。
     *
     * ⚠️ 「项目概览」「项目文档」这类是 `SectionBoundary` 的 title —— 它**只在错误卡片上**
     * 才渲染出来（正常态没有标题元素），拿它当"渲染成功"的判据会得到假失败。已实测踩过。
     */
    const wanted = ['客户信息', '关联合同', '收入确认', '成本', '发票', '应收应付', '工时', '项目里程碑', '项目交付物', '项目变更', '周报/纪要'];
    const missing = wanted.filter((s) => !pdText.includes(s));
    record('项目详情页 Section 标题全部渲染', missing.length === 0, missing.length ? `缺失=${missing.join('/')}` : `${wanted.length}/${wanted.length} 存在`);
    record('未出现「区块加载失败」错误卡片', !pdText.includes('区块加载失败'), '');
    record('渲染「项目健康指标（EVM）」', pdText.includes('项目健康指标'), '');

    {
      for (const w of [60, 40]) {
        await closeAllDialogs(page);
        await clickButtonByText(page, '添加里程碑', { settleMs: 1300 });
        const d = await dialogInfo(page);
        if (!d) {
          record(`添加项目里程碑(权重${w})`, false, '弹窗未打开');
          continue;
        }
        await setInput(page, '[role="dialog"] input[name="name"], [role="dialog"] input', `${TAG} 里程碑${w}`, 0);
        // 计划日期是 baseline/forecast 的来源，也是 PV 的分母口径 —— 不填则 EVM 恒为 null。
        // 项目里程碑的计划日期是**纯文本 Input**（placeholder=YYYY-MM-DD），不是 DateField。
        const dateSet = await setInput(page, '[role="dialog"] input[placeholder="YYYY-MM-DD"]', '2026-01-15', 0);
        await setInput(page, '[role="dialog"] input[type="number"]', String(w), 0);
        await sleep(350);
        await clickButtonByText(page, '保存', { scope: 'dialog', settleMs: 1500 });
        await sleep(1000);
        if (w === 60) notes.push(`里程碑计划日期填写=${dateSet}`);
      }
      const ms = await sql`SELECT name, weight_pct, status, plan_date, baseline_date, forecast_date FROM erp_project_milestone WHERE project_id = ${mine.projectId} ORDER BY name`;
      record('两个里程碑（权重 60/40）落库', ms.length === 2, JSON.stringify(ms.map((m) => `${m.name}/${m.weight_pct}/${m.status}`)));
      record(
        '里程碑基线已初始化（baseline = forecast = planDate，且非空）',
        ms.length === 2 && ms.every((m) => m.plan_date !== null
          && new Date(m.baseline_date).getTime() === new Date(m.forecast_date).getTime()
          && new Date(m.forecast_date).getTime() === new Date(m.plan_date).getTime()),
        JSON.stringify(ms.map((m) => `${m.plan_date}|${m.baseline_date}|${m.forecast_date}`)),
      );

      const progressed = await clickRowButtonReady(page, '里程碑60', '达成', { settleMs: 1600 });
      await sleep(1300);
      const proj = (await sql`SELECT progress FROM erp_project WHERE id = ${mine.projectId}`)[0];
      record(
        'W1 达成权重 60 / 总权重 100 → 项目进度自动重算为 60',
        progressed === 'ok' && Number(proj.progress) === 60,
        `click=${progressed} progress=${proj.progress}`,
      );

      const over = await api(page, session, 'POST', `/api/projects/${mine.projectId}/milestones`, { name: `${TAG} 超权重`, weightPct: 30 });
      record('W2 新增里程碑使 Σ权重 = 130 → 被拒且报可读中文', over.status === 400 && /100%/.test(msgOf(over)), `http=${over.status} ${msgOf(over)}`);
      record('W2b 被拒的超权重里程碑没有落库', (await sql`SELECT count(*)::int AS n FROM erp_project_milestone WHERE project_id = ${mine.projectId}`)[0].n === 2, '');

      const reachedRow = (await sql`SELECT id FROM erp_project_milestone WHERE project_id = ${mine.projectId} AND status = 'reached' LIMIT 1`)[0];
      const editReached = await api(page, session, 'PATCH', `/api/projects/milestones/${reachedRow.id}`, { weightPct: 10 });
      record('W3 已达成里程碑不可改权重/预测日期（被拒 + 中文）', editReached.status === 400, `http=${editReached.status} ${msgOf(editReached)}`);
      const w3check = (await sql`SELECT weight_pct FROM erp_project_milestone WHERE id = ${reachedRow.id}`)[0].weight_pct;
      record('W3b 被拒后权重未被改动', Number(w3check) === 60, `weight=${w3check}`);

      // EVM 口径（有加权 → 数值；无加权 → null 而不是 NaN）
      const evmText = await page.evaluate(`(() => { const t = document.body.innerText; const i = t.indexOf('项目健康指标'); return i >= 0 ? t.slice(i, i + 300) : null; })()`);
      record('EVM 区不出现 NaN / Infinity', !/NaN|Infinity/.test(String(evmText)), String(evmText).replace(/\n/g, ' | ').slice(0, 200));
      const h = await api(page, session, 'GET', '/api/bi/project-financial-health');
      const hBody = h.body?.data ?? h.body;
      const items = hBody?.items ?? [];
      const item = items.find((x) => x.projectId === mine.projectId);
      record(
        'BI /project-financial-health 对本项目透出 EVM 且无 NaN/Infinity',
        !!item && ![item.spi, item.cpi, item.eac].every((v) => v === null) && ![item.spi, item.cpi, item.eac].some((v) => typeof v === 'number' && !Number.isFinite(v)),
        `item=${JSON.stringify(item).slice(0, 300)}`,
      );
      notes.push(`EVM（加权 60/40、已达成 60）: ${JSON.stringify({ spi: item?.spi, cpi: item?.cpi, eac: item?.eac, health: item?.healthStatus ?? item?.health })}`);
    }
    diagClean('项目里程碑');

    // EVM 分母为 0（全部权重 0）必须为 null 而不是 NaN
    {
      const noWeight = await api(page, session, 'POST', `/api/projects/${mine.projectId}/milestones`, { name: `${TAG} 无权重里程碑`, weightPct: 0 });
      notes.push(`无权重里程碑新增 http=${noWeight.status}（权重 0 是合法中间态，用于验证 EVM 分母为 0 → null）`);
      const h0 = await api(page, session, 'GET', '/api/bi/project-financial-health');
      const it0 = (h0.body?.data ?? h0.body)?.items?.find((x) => x.projectId === mine.projectId);
      record(
        'EVM 分母口径：分母为 0 / 预算为 0 时 SPI·CPI·EAC 必须是 null，不得是 NaN 或 Infinity',
        !it0 || ![it0.spi, it0.cpi, it0.eac].some((v) => typeof v === 'number' && !Number.isFinite(v)),
        `spi=${it0?.spi} cpi=${it0?.cpi} eac=${it0?.eac}（本项目预算非 0 且有权重，故应为数值；NaN/Infinity 才算失败）`,
      );
      record('无权重里程碑登记后不产生脏数据', ok2xx(noWeight.status), `http=${noWeight.status} ${msgOf(noWeight)}`);
      // 清理这条无权重里程碑，避免影响结项闸门（它是 pending，会拦住结项）
      await sql`DELETE FROM erp_project_milestone WHERE project_id = ${mine.projectId} AND name = ${`${TAG} 无权重里程碑`}`;
    }
    void 0;

    /* ═══════════════ ⑨ 项目交付物 ═══════════════ */
    console.log('\n⑨ 项目详情 — 交付物（提交/验收/退回）');
    diagStart();
    {
      await goto(`/projects/${mine.projectId}`, 3400);
      await closeAllDialogs(page);
      await clickButtonByText(page, '添加交付物', { settleMs: 1300 });
      const d = await dialogInfo(page);
      let t = [];
      if (d) {
        await setInput(page, '[role="dialog"] input[name="name"], [role="dialog"] input', `${TAG} 交付物1`, 0);
        await setInput(page, '[role="dialog"] textarea', `${TAG} 验收标准`, 0);
        await sleep(350);
        await clickButtonByText(page, '保存', { scope: 'dialog', settleMs: 1600 });
        t = await toasts(page);
        await sleep(1100);
      }
      const rows = await sql`SELECT id, status, name FROM erp_deliverable WHERE project_id = ${mine.projectId}`;
      record('添加交付物 → erp_deliverable 落库（status=pending）', rows.length === 1 && rows[0].status === 'pending', `dialog=${d?.title} rows=${JSON.stringify(rows)} toast=${JSON.stringify(t)}`);
    }
    diagClean('项目交付物');

    /* ═══════════════ ⑩ 项目变更 ═══════════════ */
    console.log('\n⑩ 项目详情 — 变更与审批');
    diagStart();
    {
      await closeAllDialogs(page);
      await clickButtonByText(page, '提交变更', { settleMs: 1300 });
      const d = await dialogInfo(page);
      if (d) {
        await pickSelect(page, '变更类型', '预算');
        await setInput(page, '[role="dialog"] textarea', `${TAG} 预算调整说明`);
        await setInput(page, '[role="dialog"] input[placeholder*="原预算"]', '180000');
        await setInput(page, '[role="dialog"] input[placeholder*="新预算"]', '250000');
        await sleep(350);
        await clickButtonByText(page, '提交', { scope: 'dialog', settleMs: 1600 });
        await sleep(1100);
      }
      const ch = await sql`SELECT id, code, change_type, status, after_value FROM erp_project_change WHERE project_id = ${mine.projectId}`;
      record(
        '提交项目变更 → erp_project_change 落库（status=pending、含变更前后值）',
        ch.length === 1 && ch[0].status === 'pending' && String(ch[0].after_value).includes('250000'),
        `dialog=${d?.title} labels=${JSON.stringify(d?.labels)} rows=${JSON.stringify(ch)}`,
      );
      if (ch.length) {
        const approveTry = await api(page, session, 'POST', `/api/projects/changes/${ch[0].id}/approve`, { action: 'approve' });
        await sleep(700);
        const after = (await sql`SELECT status FROM erp_project_change WHERE id = ${ch[0].id}`)[0].status;
        const budget = (await sql`SELECT budget FROM erp_project WHERE id = ${mine.projectId}`)[0].budget;
        record(
          'L1 变更审批通过 → status=approved，且预算类变更回写项目预算',
          after === 'approved' && Number(budget) === 250000,
          `http=${approveTry.status} status=${after} budget=${budget}`,
        );
        const again = await api(page, session, 'POST', `/api/projects/changes/${ch[0].id}/approve`, { action: 'approve' });
        record('L2 已审批变更不可重复审批（被拒 + 中文）', again.status === 400 && /[\u4e00-\u9fa5]/.test(msgOf(again)), `http=${again.status} ${msgOf(again)}`);
      }
    }
    diagClean('项目变更');

    /* ═══════════════ ⑪ 结项闸门 ═══════════════ */
    console.log('\n⑪ 结项闸门（全交付物 accepted + 全里程碑 reached + closeSummary 必填）');
    {
      /*
       * 闸门要**分两段**验，因为它们在不同的前置状态下才可达：
       *   · 交付物闸门：`delivering` 下有未验收交付物 → accept 被拒；
       *   · 里程碑闸门：已 `accepting`、全部交付物 accepted，但还有 pending 里程碑 → close 被拒。
       * 第一版把两步混在一起，close 是在 `initiating` 打的，被状态机先挡住
       * （"项目状态 initiating 不允许执行 close"），于是"里程碑闸门"这一条其实**没验到**。
       */
      const g0 = await api(page, session, 'POST', `/api/projects/${mine.projectId}/status`, { action: 'close', closeSummary: `${TAG} 结项摘要` });
      record('G0 状态机先于闸门：initiating 直接 close 被拒', g0.status === 400 && /不允许执行 close/.test(msgOf(g0)), `http=${g0.status} ${msgOf(g0)}`);

      for (const action of ['approve', 'deliver']) {
        const r = await api(page, session, 'POST', `/api/projects/${mine.projectId}/status`, { action });
        const st = (await sql`SELECT status FROM erp_project WHERE id = ${mine.projectId}`)[0].status;
        record(`项目流转 ${action} → ${st}`, ok2xx(r.status) && st === (action === 'approve' ? 'executing' : 'delivering'), `http=${r.status} ${msgOf(r)}`);
      }
      const acceptBlocked = await api(page, session, 'POST', `/api/projects/${mine.projectId}/status`, { action: 'accept' });
      const stBlocked = (await sql`SELECT status FROM erp_project WHERE id = ${mine.projectId}`)[0].status;
      record(
        'G1 交付物闸门：「进入验收」被未验收交付物拦住（服务端，不只是 UI 隐藏）',
        acceptBlocked.status === 400 && /交付物未通过验收/.test(msgOf(acceptBlocked)) && stBlocked === 'delivering',
        `http=${acceptBlocked.status} ${msgOf(acceptBlocked)} status=${stBlocked}`,
      );

      const del = (await sql`SELECT id FROM erp_deliverable WHERE project_id = ${mine.projectId} LIMIT 1`)[0];
      const beforeAccept = await api(page, session, 'POST', `/api/projects/deliverables/${del.id}/accept`, { acceptConclusion: `${TAG} 结论` });
      record('D0 未提交验收的交付物直接通过验收被拒', beforeAccept.status === 400, `http=${beforeAccept.status} ${msgOf(beforeAccept)}`);

      const sub = await api(page, session, 'POST', `/api/projects/deliverables/${del.id}/submit`);
      const acc = await api(page, session, 'POST', `/api/projects/deliverables/${del.id}/accept`, { acceptConclusion: `${TAG} 验收结论`, reviewer: `${TAG} 评审人` });
      const delRow = (await sql`SELECT status, accept_conclusion, reviewer, accepted_at FROM erp_deliverable WHERE id = ${del.id}`)[0];
      record(
        'D1 交付物 提交验收 → 通过验收：status=accepted 且写入结论/评审人/验收日期',
        ok2xx(sub.status) && ok2xx(acc.status) && delRow.status === 'accepted'
          && String(delRow.accept_conclusion).includes('验收结论') && !!delRow.accepted_at,
        `submit=${sub.status} accept=${acc.status} status=${delRow.status} conclusion=${delRow.accept_conclusion} acceptedAt=${delRow.accepted_at}`,
      );
      const rej = await api(page, session, 'POST', `/api/projects/deliverables/${del.id}/return`, { reason: `${TAG} 退回原因` });
      record('D2 非 submitted 状态退回被拒（仅 submitted 可退回）', rej.status === 400, `http=${rej.status} ${msgOf(rej)}`);

      // 退回→重开路径：先退回一个"已提交"的交付物，再重新提交并验收
      const del2 = await api(page, session, 'POST', `/api/projects/${mine.projectId}/deliverables`, { name: `${TAG} 交付物2`, acceptanceCriteria: `${TAG} 标准2` });
      const del2Id = (del2.body?.data ?? del2.body)?.id;
      await api(page, session, 'POST', `/api/projects/deliverables/${del2Id}/submit`);
      const ret = await api(page, session, 'POST', `/api/projects/deliverables/${del2Id}/return`, { reason: `${TAG} 退回原因` });
      const retRow = (await sql`SELECT status, returned_reason FROM erp_deliverable WHERE id = ${del2Id}`)[0];
      record(
        'D3 已提交验收的交付物可退回：status=returned 且写入退回原因',
        ok2xx(ret.status) && retRow.status === 'returned' && String(retRow.returned_reason).includes('退回原因'),
        `http=${ret.status} status=${retRow.status} reason=${retRow.returned_reason}`,
      );
      const resub = await api(page, session, 'POST', `/api/projects/deliverables/${del2Id}/submit`);
      const reacc = await api(page, session, 'POST', `/api/projects/deliverables/${del2Id}/accept`, { acceptConclusion: `${TAG} 重新验收通过` });
      const reRow = (await sql`SELECT status FROM erp_deliverable WHERE id = ${del2Id}`)[0];
      record('D4 退回后可重新提交并再次验收（重开路径通）', ok2xx(resub.status) && ok2xx(reacc.status) && reRow.status === 'accepted', `submit=${resub.status} accept=${reacc.status} status=${reRow.status}`);

      /*
       * 只走"当前状态还允许"的那一条：D3/D4 结束后项目已在 `delivering`，
       * 再打一次 deliver 会得到"状态 delivering 不允许执行 deliver"——
       * 那是状态机的正确行为，不是缺陷（第一版在这里得到过一次假失败）。
       */
      const stBeforeAccept = (await sql`SELECT status FROM erp_project WHERE id = ${mine.projectId}`)[0].status;
      if (stBeforeAccept !== 'delivering') {
        const r = await api(page, session, 'POST', `/api/projects/${mine.projectId}/status`, { action: 'deliver' });
        const st = (await sql`SELECT status FROM erp_project WHERE id = ${mine.projectId}`)[0].status;
        record(`项目流转 deliver（交付物全部已验收）→ ${st}`, ok2xx(r.status) && st === 'delivering', `http=${r.status} ${msgOf(r)}`);
      } else {
        record('项目已在 delivering（交付物全部已验收，无需重复 deliver）', true, `status=${stBeforeAccept}`);
      }
      const acceptR = await api(page, session, 'POST', `/api/projects/${mine.projectId}/status`, { action: 'accept' });
      const stAcc = (await sql`SELECT status FROM erp_project WHERE id = ${mine.projectId}`)[0].status;
      record(`项目流转 accept（交付物全部已验收）→ ${stAcc}`, ok2xx(acceptR.status) && stAcc === 'accepting', `http=${acceptR.status} ${msgOf(acceptR)}`);

      // 里程碑闸门：此刻在 accepting，交付物全部 accepted，仍有一个 pending 里程碑
      const pendingMs = await sql`SELECT id, name FROM erp_project_milestone WHERE project_id = ${mine.projectId} AND status <> 'reached'`;
      const msGate = await api(page, session, 'POST', `/api/projects/${mine.projectId}/status`, { action: 'close', closeSummary: `${TAG} 结项摘要` });
      record(
        'G2 里程碑闸门：交付物全通过但仍有未达成里程碑 → 结项被拒且提示个数',
        pendingMs.length > 0 && msGate.status === 400 && /里程碑未达成/.test(msgOf(msGate)),
        `未达成=${pendingMs.length}(${pendingMs.map((m) => m.name).join('/')}) http=${msGate.status} ${msgOf(msGate)}`,
      );
      const afterMsGate = (await sql`SELECT status, closed_at FROM erp_project WHERE id = ${mine.projectId}`)[0];
      record('G2b 被拒后项目仍为 accepting 且未写入 closedAt', afterMsGate.status === 'accepting' && afterMsGate.closed_at === null, `status=${afterMsGate.status} closedAt=${afterMsGate.closed_at}`);

      for (const m of pendingMs) await api(page, session, 'PATCH', `/api/projects/milestones/${m.id}`, { status: 'reached' });
      const noSummary = await api(page, session, 'POST', `/api/projects/${mine.projectId}/status`, { action: 'close' });
      record('G3 里程碑/交付物齐备但未填 closeSummary → 结项被拒且提示中文', noSummary.status === 400 && /结项摘要/.test(msgOf(noSummary)), `http=${noSummary.status} ${msgOf(noSummary)}`);
      const stillAccepting = (await sql`SELECT status FROM erp_project WHERE id = ${mine.projectId}`)[0].status;
      record('G3b 被拒后项目状态仍为 accepting（未被部分写入）', stillAccepting === 'accepting', `status=${stillAccepting}`);
      const blankSummary = await api(page, session, 'POST', `/api/projects/${mine.projectId}/status`, { action: 'close', closeSummary: '   ' });
      record('G3c 空白 closeSummary 也被拒（不是只判 undefined）', blankSummary.status === 400, `http=${blankSummary.status} ${msgOf(blankSummary)}`);

      const ok = await api(page, session, 'POST', `/api/projects/${mine.projectId}/status`, { action: 'close', closeSummary: `${TAG} 结项摘要`, satisfaction: 5, retrospective: `${TAG} 复盘结论` });
      const closed = (await sql`SELECT status, close_summary, satisfaction, retrospective, closed_at FROM erp_project WHERE id = ${mine.projectId}`)[0];
      record(
        'G4 全部条件满足 → 结项成功，摘要/满意度/复盘/结项时间均落库',
        ok2xx(ok.status) && closed.status === 'closed' && String(closed.close_summary).includes('结项摘要')
          && Number(closed.satisfaction) === 5 && String(closed.retrospective).includes('复盘结论') && !!closed.closed_at,
        `http=${ok.status} status=${closed.status} summary=${closed.close_summary} satisfaction=${closed.satisfaction} closedAt=${closed.closed_at}`,
      );
      const frozenDel = await api(page, session, 'POST', `/api/projects/deliverables/${del.id}/submit`);
      record('G5 项目已结项 → 交付物写动作被冻结（被拒 + 中文）', frozenDel.status === 400 && /结项/.test(msgOf(frozenDel)), `http=${frozenDel.status} ${msgOf(frozenDel)}`);
      const ctrAfterClose = (await sql`SELECT status FROM erp_contract WHERE id = ${mine.contractId}`)[0].status;
      record(
        'G6 同合同下项目全部结项 → 合同状态自动回写 completed（结项闭环）',
        ctrAfterClose === 'completed',
        `合同 status=${ctrAfterClose}（结项前为 active）`,
      );
      const frozenNew2 = await api(page, session, 'POST', `/api/projects/${mine.projectId}/deliverables`, { name: `${TAG} 结项后新交付物` });
      record('G7 项目已结项 → 新增交付物被拒且未落库', frozenNew2.status === 400 && (await sql`SELECT count(*)::int AS n FROM erp_deliverable WHERE project_id = ${mine.projectId}`)[0].n === 2, `http=${frozenNew2.status} 交付物数=${(await sql`SELECT count(*)::int AS n FROM erp_deliverable WHERE project_id = ${mine.projectId}`)[0].n} ${msgOf(frozenNew2)}`);
      /*
       * G8：项目主档的冻结。
       *
       * `CloseProjectSection` 对使用者的承诺是「结项后项目进入只读归档状态」，
       * 而 `deliverable.service` 的注释写明它那条 `assertProjectNotClosed` 之所以抽成共用方法，
       * 就是因为原实现"只有 create 有、其余写动作都能绕过"。`updateProject`
       * （项目经理/预算/进度/预计总成本/结束日期/备注/成交报价）原先**完全没有**这道校验 ——
       * 本轮补上，这条断言就是它的判据。
       */
      const frozenEdit = await api(page, session, 'PATCH', `/api/projects/${mine.projectId}`, { pm: `${TAG} 结项后改名` });
      const pmAfter = (await sql`SELECT pm FROM erp_project WHERE id = ${mine.projectId}`)[0].pm;
      record(
        'G8 项目已结项 → 项目主档（项目经理/预算/…）写动作被冻结（被拒 + 中文 + 指出"先反结项"）',
        frozenEdit.status === 400 && /反结项/.test(msgOf(frozenEdit)) && pmAfter !== `${TAG} 结项后改名`,
        `http=${frozenEdit.status} pm=${JSON.stringify(pmAfter)} ${msgOf(frozenEdit)}`,
      );
    }

    /* ═══════════════ ⑫ 项目编辑页：清空字段 ═══════════════ */
    console.log('\n⑫ 项目编辑 /projects/:id/edit —— 清空字段是否真落库');
    diagStart();
    {
      /*
       * 项目 A 此刻已结项，而 G8 之后主档写动作是被冻结的 —— 所以这里**必须先反结项**。
       * 这一步顺带验证了冻结文案给的那条出路是真的可用（"如需调整请先反结项"），
       * 而不是一句空话。沿用仓库既有的 `reopen` 流转（已结项 → 验收中）。
       */
      const reopen = await api(page, session, 'POST', `/api/projects/${mine.projectId}/status`, { action: 'reopen' });
      const reopened = (await sql`SELECT status, closed_at FROM erp_project WHERE id = ${mine.projectId}`)[0];
      record(
        'P0 已结项项目可经「反结项」重新变为可编辑（冻结文案给出的出路真实可用）',
        ok2xx(reopen.status) && reopened.status === 'accepting',
        `http=${reopen.status} status=${reopened.status} closedAt=${reopened.closed_at} ${msgOf(reopen)}`,
      );

      // 先把三个字段写成非空（项目 A 创建时没填项目经理）
      await api(page, session, 'PATCH', `/api/projects/${mine.projectId}`, {
        pm: `${TAG} 张经理`, remark: `${TAG} 编辑前备注`, estimatedTotalCost: 123456,
      });
      const before = (await sql`SELECT pm, remark, estimated_total_cost, budget FROM erp_project WHERE id = ${mine.projectId}`)[0];
      record('P1 前置条件：pm/remark/estimatedTotalCost 均已写入非空值', before.pm === `${TAG} 张经理` && String(before.remark).includes('编辑前备注') && Number(before.estimated_total_cost) === 123456, JSON.stringify(before));

      await goto(`/projects/${mine.projectId}/edit`, 3000);
      await closeAllDialogs(page);
      const fields = await page.evaluate(`(() => [...document.querySelectorAll('input,textarea')].map((i) => ({ name: i.name, type: i.type, ph: i.placeholder, v: String(i.value).slice(0, 30) })))()`);
      notes.push(`编辑页字段: ${JSON.stringify(fields)}`);
      const pmSet = await setInput(page, 'input[name="pm"]', '');
      const rmSet = await setInput(page, 'textarea[name="remark"]', '');
      const etcSet = await setInput(page, 'input[name="estimatedTotalCost"]', '');
      await sleep(400);
      await clickButtonByText(page, '保存', { settleMs: 1800 });
      const t = await toasts(page);
      await sleep(1300);
      const after = (await sql`SELECT pm, remark, estimated_total_cost, budget FROM erp_project WHERE id = ${mine.projectId}`)[0];
      record('P2 清空「项目经理」→ 库里确实变空', after.pm === null || after.pm === '', `填写=${pmSet} pm: ${JSON.stringify(before.pm)} → ${JSON.stringify(after.pm)} toast=${JSON.stringify(t)}`);
      record('P3 清空「备注」→ 库里确实变空', after.remark === null || after.remark === '', `填写=${rmSet} remark: ${JSON.stringify(before.remark)} → ${JSON.stringify(after.remark)}`);
      record(
        'P4 清空「预计总成本」→ 库里变空或归零（不得静默保留旧值）',
        after.estimated_total_cost === null || Number(after.estimated_total_cost) === 0,
        `填写=${etcSet} estimatedTotalCost: ${JSON.stringify(before.estimated_total_cost)} → ${JSON.stringify(after.estimated_total_cost)}`,
      );
      diagClean('项目编辑清空');

      // 把它结回 closed，保持一个明确定义的收尾状态（并再次触发合同回写，幂等）
      const reclose = await api(page, session, 'POST', `/api/projects/${mine.projectId}/status`, { action: 'close', closeSummary: `${TAG} 复审后重新结项` });
      const reclosed = (await sql`SELECT status, close_summary FROM erp_project WHERE id = ${mine.projectId}`)[0];
      record(
        'P5 清空校验完成后可再次结项（反结项 → 编辑 → 再结项 的闭环通）',
        ok2xx(reclose.status) && reclosed.status === 'closed',
        `http=${reclose.status} status=${reclosed.status} summary=${reclosed.close_summary} ${msgOf(reclose)}`,
      );
    }

    /* ═══════════════ ⑬ 第二张合同 + 第二项目：各 Section 真实写入 ═══════════════ */
    await requireContract('⑬ 第二张合同');
    console.log('\n⑬ 第二张自建合同/项目 — 各 Section 真实写入');
    {
      const ctr2Name = `${TAG} 合同-B`;
      await goto('/contracts/new', 2900);
      await setInput(page, 'input[name="name"]', ctr2Name);
      await pickSelect(page, '客户', customer.name);
      await pickSelect(page, '计费模式', '项目制');
      await setInput(page, 'input[name="amount"]', '50000');
      await pickSelect(page, '税率', '6%');
      await sleep(350);
      await clickButtonByText(page, '保存', { settleMs: 1700 });
      await sleep(1300);
      const c2 = await sql`SELECT id, code FROM erp_contract WHERE name = ${ctr2Name} LIMIT 1`;
      record('第二张 [API_TEST] 合同已登记', c2.length === 1, JSON.stringify(c2));
      if (c2.length === 0) throw new Error('第二张合同未创建');
      mine.contractId2 = c2[0].id;
      mine.contractCode2 = c2[0].code;
      const sub2 = await api(page, session, 'POST', `/api/contracts/${mine.contractId2}/status`, { action: 'submit' });
      const appr2 = await api(page, session, 'POST', `/api/contracts/${mine.contractId2}/status`, { action: 'approve' });
      const st2 = (await sql`SELECT status FROM erp_contract WHERE id = ${mine.contractId2}`)[0].status;
      record('第二张合同 submit → approve 生效', ok2xx(sub2.status) && ok2xx(appr2.status) && st2 === 'active', `submit=${sub2.status} approve=${appr2.status} ${msgOf(appr2)} status=${st2}`);

      const p2Name = `${TAG} 项目-B`;
      await goto('/projects/new', 3000);
      await setInput(page, 'input[name="name"]', p2Name);
      await pickSelect(page, '关联合同', mine.contractCode2);
      await setInput(page, 'input[type="number"]', '50000', 0);
      await sleep(350);
      await clickButtonByText(page, '立项', { settleMs: 1900 });
      await sleep(1300);
      const p2 = await sql`SELECT id, code FROM erp_project WHERE name = ${p2Name} LIMIT 1`;
      record('第二个项目已立项', p2.length === 1, JSON.stringify(p2));
      if (p2.length === 0) throw new Error('第二个项目未创建');
      mine.projectId2 = p2[0].id;
    }

    diagStart();
    await goto(`/projects/${mine.projectId2}`, 3600);
    {
      /* 13a 收入确认 */
      await closeAllDialogs(page);
      await clickButtonByText(page, '确认收入', { settleMs: 1300 });
      let d = await dialogInfo(page);
      if (d) {
        await setInput(page, '[role="dialog"] input', '2026-10', 0);
        await setInput(page, '[role="dialog"] input[type="number"]', '10000', 0);
        await sleep(350);
        await clickButtonByText(page, '提交确认', { scope: 'dialog', settleMs: 1700 });
        await sleep(1200);
      }
      const rev = await sql`SELECT code, period, amount, status, contract_id FROM erp_project_revenue WHERE project_id = ${mine.projectId2}`;
      record(
        'R1 收入确认 → erp_project_revenue 落库（期间/金额/合同）',
        rev.length >= 1 && Number(rev[0].amount) === 10000 && rev[0].contract_id === mine.contractId2,
        `dialog=${d?.title} labels=${JSON.stringify(d?.labels)} rows=${JSON.stringify(rev)}`,
      );

      /* 13b 成本登记 */
      await closeAllDialogs(page);
      await clickButtonByText(page, '登记成本', { settleMs: 1300 });
      d = await dialogInfo(page);
      if (d) {
        // 成本类型取值域来自字典（与前端常量不一致，见 biz-labels 的说明），故取第一个可用项
        const ct = await pickSelectFirst(page, '成本类型');
        await setInput(page, '[role="dialog"] input[type="number"]', '3000', 0);
        await setInput(page, '[role="dialog"] input[placeholder*="GPU"]', `${TAG} 成本说明`, 0);
        await sleep(350);
        await clickButtonByText(page, '提交登记', { scope: 'dialog', settleMs: 1700 });
        const tc = await toasts(page);
        await sleep(1300);
        notes.push(`成本类型选择: opened=${ct.opened} picked=${ct.picked} toast=${JSON.stringify(tc)}`);
      }
      const cost = await sql`SELECT cost_type, amount, project_id, contract_id, department_id FROM erp_project_cost WHERE project_id = ${mine.projectId2}`;
      record(
        'R2 登记成本 → erp_project_cost 落库并回填合同',
        cost.length >= 1 && Number(cost[0].amount) === 3000 && cost[0].contract_id === mine.contractId2,
        `dialog=${d?.title} labels=${JSON.stringify(d?.labels)} rows=${JSON.stringify(cost)}`,
      );

      /* 13c 发票（销项）*/
      await closeAllDialogs(page);
      await clickButtonByText(page, '开票', { settleMs: 1300 });
      d = await dialogInfo(page);
      if (d) {
        await pickSelect(page, '发票类型', '增值税专用发票');
        await setInput(page, '[role="dialog"] input[type="number"]', '10600', 0);
        await sleep(350);
        await clickButtonByText(page, '提交登记', { scope: 'dialog', settleMs: 1800 });
        await sleep(1300);
      }
      const inv = await sql`SELECT id, amount, status, contract_id, project_id, direction, net_amount, tax_amount FROM erp_invoice WHERE project_id = ${mine.projectId2}`;
      record(
        'R3 项目详情开票（销项）→ erp_invoice 落库且净额+税额=金额',
        inv.length >= 1 && Number(inv[0].amount) === 10600 && inv[0].contract_id === mine.contractId2
          && Math.abs(Number(inv[0].net_amount) + Number(inv[0].tax_amount) - 10600) < 0.005,
        `dialog=${d?.title} labels=${JSON.stringify(d?.labels)} rows=${JSON.stringify(inv)}`,
      );
      if (inv.length) mine.invoiceIds.push(...inv.map((x) => x.id));

      /* 13d 应收 + 回款 */
      await closeAllDialogs(page);
      await clickButtonByText(page, '登记应收', { settleMs: 1300 });
      d = await dialogInfo(page);
      if (d) {
        await setInput(page, '[role="dialog"] input[type="number"]', '10600', 0);
        await sleep(350);
        await clickButtonByText(page, '提交登记', { scope: 'dialog', settleMs: 1700 });
        await sleep(1300);
      }
      const ar = await sql`SELECT id, code, amount, status, project_id, contract_id, source FROM erp_ar WHERE project_id = ${mine.projectId2}`;
      const myAr = ar.find((x) => Number(x.amount) === 10600);
      record(
        'R4 登记应收 → erp_ar 落库（另注：收入确认会自动生成一张应收，故该项目下有 2 行）',
        !!myAr,
        `dialog=${d?.title} rows=${JSON.stringify(ar)}`,
      );
      if (ar.length) mine.arIds.push(...ar.map((x) => x.id));
      if (ar.some((x) => x.source && x.source !== 'manual')) {
        notes.push(`收入确认联动生成了应收：${JSON.stringify(ar.map((x) => ({ amount: x.amount, source: x.source })))}`);
      }

      const arId = myAr?.id;
      if (arId) {
        const receiptBefore = (await sql`SELECT count(*)::int AS n FROM erp_receipt`)[0].n;
        await closeAllDialogs(page);
        await clickButtonByText(page, '登记回款', { settleMs: 1300 });
        d = await dialogInfo(page);
        if (d) {
          /*
           * 应收单下拉里有两张单（收入确认自动生成的那张 10000 + 本次登记的 10600），
           * 必须**按单号精确选**：随手选第一项会因"回款额 > 该单未结额"被 400 拒，
           * 那是正确的业务拦截，不是缺陷（第一版就在这里得到过一次假失败）。
           */
          const pickAr = await pickSelect(page, '应收单', myAr.code);
          await setInput(page, '[role="dialog"] input[type="number"]', '10600', 0);
          await sleep(350);
          await clickButtonByText(page, '提交登记', { scope: 'dialog', settleMs: 1700 });
          const tr = await toasts(page);
          await sleep(1300);
          notes.push(`回款选单: opened=${pickAr.opened} picked=${pickAr.picked} options=${JSON.stringify(pickAr.options ?? [])} toast=${JSON.stringify(tr)}`);
        }
        const receiptAfter = (await sql`SELECT count(*)::int AS n FROM erp_receipt`)[0].n;
        const arAfter = (await sql`SELECT status, settled_amount FROM erp_ar WHERE id = ${arId}`)[0];
        record(
          'R5 登记回款 → erp_receipt 落库且应收单已核销金额/状态联动',
          receiptAfter > receiptBefore && (Number(arAfter?.settled_amount ?? 0) > 0 || arAfter?.status === 'settled'),
          `dialog=${d?.title} 回款行 ${receiptBefore}→${receiptAfter} 应收=${JSON.stringify(arAfter)}`,
        );
      }

      /* 13e 应付 */
      await closeAllDialogs(page);
      await clickButtonByText(page, '登记应付', { settleMs: 1300 });
      d = await dialogInfo(page);
      let apToast = [];
      let apPick = null;
      if (d && suppliers.length) {
        // 供应商名称由别的 agent 的走查数据决定（列表会变），故断言里带上实际选项
        const sp = await pickSelect(page, '供应商', suppliers[0].name);
        apPick = sp;
        await setInput(page, '[role="dialog"] input[type="number"]', '2000', 0);
        await sleep(350);
        const submitAp = await clickButtonByText(page, '提交登记', { scope: 'dialog', settleMs: 1700 });
        apToast = await toasts(page);
        if (apPick.picked !== 'ok' || submitAp !== 'ok') {
          apPick = { ...sp, submitAp };
        }
        await sleep(1300);
      }
      const ap = await sql`SELECT id, amount, supplier_id, project_id FROM erp_ap_bill WHERE project_id = ${mine.projectId2}`;
      record(
        'R6 登记应付 → erp_ap_bill 落库',
        ap.length >= 1 && Number(ap[0].amount) === 2000,
        `dialog=${d?.title} labels=${JSON.stringify(d?.labels)} 供应商=${JSON.stringify(suppliers[0]?.name)} 选择=${JSON.stringify(apPick)} toast=${JSON.stringify(apToast)} rows=${JSON.stringify(ap)}`,
      );
      if (ap.length) mine.apIds.push(...ap.map((x) => x.id));

      /* 13f 周报/纪要 */
      await closeAllDialogs(page);
      await clickButtonByText(page, '新增纪要', { settleMs: 1300 });
      d = await dialogInfo(page);
      if (d) {
        // 「类型 / 日期 / 标题」三项均为必填；日期是 DateField（Popover+Calendar），不能用 setInput
        const mt = await pickSelectFirst(page, '类型');
        const md = await pickDateByLabel(page, '日期', '15');
        await page.pressKey('Escape', 'Escape', 27);
        await sleep(400);
        await setInput(page, '[role="dialog"] input[placeholder*="第 42 周"]', `${TAG} 第42周周报`, 0);
        await setInput(page, '[role="dialog"] textarea', `${TAG} 本周进展`);
        await sleep(350);
        const confirmBtn = await clickButtonByText(page, '确认新增', { scope: 'dialog', settleMs: 1700 });
        const tm = await toasts(page);
        const vm2 = await validationMessages(page);
        await sleep(1300);
        notes.push(`纪要表单: 类型=${mt.picked} 日期=${md.picked} 提交按钮=${confirmBtn} 校验提示=${JSON.stringify(vm2)} toast=${JSON.stringify(tm)}`);
      }
      const mins = await sql`SELECT title, minutes_type, content, meeting_date FROM erp_project_minutes WHERE project_id = ${mine.projectId2}`;
      record(
        'R7 新增周报/纪要 → erp_project_minutes 落库（标题/类型/日期/内容）',
        mins.length >= 1 && String(mins[0].title).includes('第42周') && String(mins[0].content).includes('本周进展') && !!mins[0].meeting_date,
        `dialog=${d?.title} labels=${JSON.stringify(d?.labels)} rows=${JSON.stringify(mins)}`,
      );
    }
    diagClean('项目其余 Section');

    /* ═══════════════ ⑭ 项目文档（标题前缀 [类型]）═══════════════ */
    console.log('\n⑭ 项目文档 Section');
    diagStart();
    {
      await goto(`/projects/${mine.projectId2}`, 3400);
      const before = (await sql`SELECT count(*)::int AS n FROM comp_attachment WHERE resource_type = 'erp_project' AND resource_id = ${mine.projectId2}`)[0].n;
      await closeAllDialogs(page);
      const opened = await clickButtonByText(page, '新增文档', { settleMs: 1400 });
      const d = await dialogInfo(page);
      let t = [];
      if (d) {
        // 文档类型 → 录入方式=飞书云文档链接（默认是"上传文件"，那条路要真选文件）
        const dt = await pickSelect(page, '文档类型', '需求书');
        const mode = await clickTagged(
          page,
          `(() => {
            const l = [...document.querySelectorAll('[role="dialog"] label')].find((x) => (x.textContent || '').includes('飞书云文档链接'));
            return l ?? null;
          })()`,
          { settleMs: 800 },
        );
        await setInput(page, '[role="dialog"] input[placeholder*="需求说明书"]', `${TAG} 需求文档标题`, 0);
        // token 必须匹配 /^[A-Za-z0-9_-]{8,}$/（`feishu-doc-link.ts` 的 TOKEN_PATTERN），
        // 带方括号的 [API_TEST] 会被判为非法 token —— 第一版就在这里 400 了一次
        await setInput(page, '[role="dialog"] input[placeholder*="feishu.cn"]', 'https://example.feishu.cn/docx/ApiTestDocxToken123456', 0);
        await sleep(350);
        await clickButtonByText(page, '确认新增', { scope: 'dialog', settleMs: 1700 });
        t = await toasts(page);
        await sleep(1200);
        notes.push(`项目文档: 类型=${dt.picked} 录入方式点击=${mode}`);
      }
      const rows = await sql`SELECT id, file_name, resource_type, resource_id, source_type FROM comp_attachment WHERE resource_type = 'erp_project' AND resource_id = ${mine.projectId2}`;
      record(
        'R8 新增项目文档 → comp_attachment(resource_type=erp_project) 落库且文件名带 [类型] 前缀',
        rows.length > before && rows.some((r) => /^\[.+\]/.test(String(r.file_name))),
        `opened=${opened} dialog=${d?.title} labels=${JSON.stringify(d?.labels)} before=${before} rows=${JSON.stringify(rows)} toast=${JSON.stringify(t)}`,
      );
    }
    diagClean('项目文档');

    /* ═══════════════ ⑮ 合同可开金额上限 + 发票作废释放 ═══════════════ */
    console.log('\n⑮ 合同可开金额上限与作废释放');
    {
      const summary = await api(page, session, 'GET', `/api/contracts/billable/${mine.contractId2}`);
      const b = summary.body?.data ?? summary.body;
      record(
        'B5 可开票金额 = 合同金额 − 已开(issued)',
        Number(b?.contractAmount) === 50000 && Number(b?.billableAmount) === 50000 - 10600,
        `http=${summary.status} body=${JSON.stringify(b)}`,
      );
      const over = await api(page, session, 'POST', '/api/finance/invoices', {
        direction: 'sales', invoiceType: 'vat_special', amount: 50000, contractId: mine.contractId2,
      });
      record('B6 开票金额超合同可开额度 → 被拒且为可读中文', over.status === 400 && /[\u4e00-\u9fa5]/.test(msgOf(over)), `http=${over.status} ${msgOf(over)}`);
      const afterOver = (await sql`SELECT coalesce(sum(amount),0)::numeric AS s FROM erp_invoice WHERE contract_id = ${mine.contractId2} AND status = 'issued'`)[0].s;
      record('B6b 被拒的超开没有留下发票行', Number(afterOver) === 10600, `issued 合计=${afterOver}`);

      const target = mine.invoiceIds[0];
      const voidR = await api(page, session, 'POST', `/api/finance/invoices/${target}/void`, {});
      const summary2 = await api(page, session, 'GET', `/api/contracts/billable/${mine.contractId2}`);
      const b2 = summary2.body?.data ?? summary2.body;
      record(
        'B7 作废发票 → 可开金额**释放**回合同金额',
        ok2xx(voidR.status) && Number(b2?.billableAmount) === 50000,
        `void http=${voidR.status} billable=${b2?.billableAmount} ${msgOf(voidR)}`,
      );
      const reissue = await api(page, session, 'POST', '/api/finance/invoices', {
        direction: 'sales', invoiceType: 'vat_special', amount: 50000, contractId: mine.contractId2,
      });
      record('B8 作废后可重新开满整额', ok2xx(reissue.status), `http=${reissue.status} ${msgOf(reissue)}`);
      const invNow = await sql`SELECT id, voided_at, void_reason FROM erp_invoice WHERE contract_id = ${mine.contractId2} AND status = 'issued'`;
      mine.invoiceIds.push(...invNow.map((x) => x.id));
      notes.push(`作废的那张发票: voidedAt/voidReason 应已写入 —— ${JSON.stringify((await sql`SELECT status, voided_at, void_reason FROM erp_invoice WHERE id = ${target}`)[0])}`);
    }

    /* ═══════════════ ⑯ 合同终态冻结 ═══════════════ */
    console.log('\n⑯ 合同终态（closed）字段冻结');
    {
      /*
       * 合同 A 已被"项目全部结项"回写为 `completed`（G6），所以这里**不能**再假定它
       * 还在 active —— 第一版直接打 start，得到"合同状态 completed 不允许执行 start"
       * 的三条假失败。改成：先从库里读当前状态，只对**还没走过**的流转做断言。
       */
      const cur = (await sql`SELECT status FROM erp_contract WHERE id = ${mine.contractId}`)[0].status;
      notes.push(`合同 A 进入终态段时的状态=${cur}（由"项目全部结项 → 合同回写"得到）`);
      record('合同 A 已由结项闭环回写为 completed', cur === 'completed', `status=${cur}`);
      if (cur === 'active') {
        const startR = await api(page, session, 'POST', `/api/contracts/${mine.contractId}/status`, { action: 'start' });
        const st1 = (await sql`SELECT status FROM erp_contract WHERE id = ${mine.contractId}`)[0].status;
        record('start: active → performing', ok2xx(startR.status) && st1 === 'performing', `http=${startR.status} status=${st1} ${msgOf(startR)}`);
      }
      if ((await sql`SELECT status FROM erp_contract WHERE id = ${mine.contractId}`)[0].status === 'performing') {
        const compR = await api(page, session, 'POST', `/api/contracts/${mine.contractId}/status`, { action: 'complete' });
        const st2 = (await sql`SELECT status FROM erp_contract WHERE id = ${mine.contractId}`)[0].status;
        record('complete: performing → completed', ok2xx(compR.status) && st2 === 'completed', `http=${compR.status} status=${st2} ${msgOf(compR)}`);
      }
      const closeR = await api(page, session, 'POST', `/api/contracts/${mine.contractId}/status`, { action: 'close' });
      const st3 = (await sql`SELECT status FROM erp_contract WHERE id = ${mine.contractId}`)[0].status;
      record('close: completed → closed', ok2xx(closeR.status) && st3 === 'closed', `http=${closeR.status} status=${st3} ${msgOf(closeR)}`);
      const termBad = await api(page, session, 'POST', `/api/contracts/${mine.contractId}/status`, { action: 'terminate' });
      record('closed → terminate 被拒（终态不可再流转）', termBad.status === 400, `http=${termBad.status} ${msgOf(termBad)}`);
      // terminate 的合法入口：第二张合同（active → terminated）
      const termOK = await api(page, session, 'POST', `/api/contracts/${mine.contractId2}/status`, { action: 'terminate' });
      const stTerm = (await sql`SELECT status FROM erp_contract WHERE id = ${mine.contractId2}`)[0].status;
      record('terminate: active → terminated（另一张合同）', ok2xx(termOK.status) && stTerm === 'terminated', `http=${termOK.status} status=${stTerm} ${msgOf(termOK)}`);

      const snapBefore = (await sql`SELECT name, billing_model, tax_rate, owner, start_date, end_date, remark FROM erp_contract WHERE id = ${mine.contractId}`)[0];
      const tries = [
        ['name', { name: `${TAG} 冻结改名` }],
        ['billingModel', { billingModel: 'quantity' }],
        ['taxRate', { taxRate: 6 }],
        ['owner', { owner: `${TAG} 冻结负责人` }],
        ['startDate', { startDate: '2026-01-01' }],
        ['endDate', { endDate: '2026-12-31' }],
        ['remark', { remark: `${TAG} 冻结备注` }],
      ];
      const codes = [];
      for (const [field, dto] of tries) {
        const r = await api(page, session, 'PATCH', `/api/contracts/${mine.contractId}`, dto);
        codes.push(`${field}:${r.status}`);
      }
      const snapAfter = (await sql`SELECT name, billing_model, tax_rate, owner, start_date, end_date, remark FROM erp_contract WHERE id = ${mine.contractId}`)[0];
      const unchanged = JSON.stringify(snapBefore) === JSON.stringify(snapAfter);
      record(
        'B4 closed 下 name/billingModel/taxRate/owner/起止日期/remark 全部被拒且库值逐字段未变',
        codes.every((x) => x.endsWith(':400')) && unchanged,
        `${codes.join(' ')} 库值未变=${unchanged}`,
      );
      const frozenMsg = await api(page, session, 'PATCH', `/api/contracts/${mine.contractId}`, { remark: 'x' });
      record(
        'B4b 冻结报错为可读中文并逐项点名被冻结字段',
        /不能修改名称、计费模式、税率、负责人、日期和备注/.test(msgOf(frozenMsg)),
        msgOf(frozenMsg),
      );
      // 非冻结字段仍可改，证明不是"终态一律 403"
      const okField = await api(page, session, 'PATCH', `/api/contracts/${mine.contractId}`, { paymentTerms: `${TAG} 终态后可改的付款条款` });
      const pt = (await sql`SELECT payment_terms FROM erp_contract WHERE id = ${mine.contractId}`)[0].payment_terms;
      record('B4c 终态下"普通档"字段（paymentTerms）仍可改', ok2xx(okField.status) && String(pt).includes('终态后可改'), `http=${okField.status} paymentTerms=${pt}`);
    }

    /* ═══════════════ ⑰ /pur 交叉核对 ═══════════════ */
    console.log('\n⑰ /pur 与项目/合同链路交叉核对');
    diagStart();
    {
      await goto('/pur', 3000);
      const txt = await page.evaluate('document.body.innerText');
      record('采购页渲染', txt.includes('采购管理'), `长度=${txt.length}`);
      const orphanP = (await sql`SELECT count(*)::int AS n FROM pur_order o WHERE o.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM erp_project p WHERE p.id = o.project_id)`)[0].n;
      record('PUR1 采购订单的 project_id 无悬挂引用', orphanP === 0, `悬挂=${orphanP}`);
      const orphanC = (await sql`SELECT count(*)::int AS n FROM pur_order o WHERE o.contract_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM erp_contract c WHERE c.id = o.contract_id)`)[0].n;
      record('PUR2 采购订单的 contract_id 无悬挂引用', orphanC === 0, `悬挂=${orphanC}`);
      const orphanPr = (await sql`SELECT count(*)::int AS n FROM pur_request r WHERE r.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM erp_project p WHERE p.id = r.project_id)`)[0].n;
      record('PUR3 采购申请的 project_id 无悬挂引用', orphanPr === 0, `悬挂=${orphanPr}`);
      const purWithProj = (await sql`SELECT count(*)::int AS n FROM pur_order WHERE project_id IS NOT NULL OR contract_id IS NOT NULL`)[0].n;
      notes.push(`pur_order 关联了项目/合同的单据数=${purWithProj}`);
      diagClean('采购交叉核对');
    }
  } catch (error) {
    record('走查主流程未抛异常', false, `${error.message}`);
    console.error('主流程异常:', error);
  } finally {
    /* ═══════════════ 诊断汇总 + 精确清理 ═══════════════ */
    const flat = {
      consoleErrors: diagnostics.flatMap((d) => d.consoleErrors),
      exceptions: diagnostics.flatMap((d) => d.exceptions),
      httpErrors: diagnostics.flatMap((d) => d.httpErrors),
      perStep: diagnostics,
    };
    record('全程无未捕获异常', flat.exceptions.length === 0, JSON.stringify(flat.exceptions).slice(0, 300));
    record('全程无 console.error', flat.consoleErrors.length === 0, JSON.stringify(flat.consoleErrors).slice(0, 300));
    record('全程无 HTTP ≥ 500', flat.httpErrors.filter((e) => /^5/.test(e)).length === 0, JSON.stringify(flat.httpErrors.filter((e) => /^5/.test(e))).slice(0, 300));

    try {
      console.log('\n── 清理（先 SELECT 打印待删行，再按精确 id 删）──');
      const ids = { c1: mine.contractId, c2: mine.contractId2, p1: mine.projectId, p2: mine.projectId2, cus: mine.customerId, cus2: mine.customerNoRateId };
      const plan = await sql`
        SELECT 'erp_contract' AS t, count(*)::int AS n FROM erp_contract WHERE id IN (${ids.c1}, ${ids.c2})
        UNION ALL SELECT 'erp_project', count(*)::int FROM erp_project WHERE id IN (${ids.p1}, ${ids.p2})
        UNION ALL SELECT 'erp_contract_item', count(*)::int FROM erp_contract_item WHERE contract_id IN (${ids.c1}, ${ids.c2})
        UNION ALL SELECT 'erp_contract_milestone', count(*)::int FROM erp_contract_milestone WHERE contract_id IN (${ids.c1}, ${ids.c2})
        UNION ALL SELECT 'erp_contract_version', count(*)::int FROM erp_contract_version WHERE contract_id IN (${ids.c1}, ${ids.c2})
        UNION ALL SELECT 'erp_calloff', count(*)::int FROM erp_calloff WHERE contract_id IN (${ids.c1}, ${ids.c2})
        UNION ALL SELECT 'erp_deliverable', count(*)::int FROM erp_deliverable WHERE project_id IN (${ids.p1}, ${ids.p2})
        UNION ALL SELECT 'erp_project_milestone', count(*)::int FROM erp_project_milestone WHERE project_id IN (${ids.p1}, ${ids.p2})
        UNION ALL SELECT 'erp_project_change', count(*)::int FROM erp_project_change WHERE project_id IN (${ids.p1}, ${ids.p2})
        UNION ALL SELECT 'erp_project_minutes', count(*)::int FROM erp_project_minutes WHERE project_id IN (${ids.p1}, ${ids.p2})
        UNION ALL SELECT 'erp_project_revenue', count(*)::int FROM erp_project_revenue WHERE project_id IN (${ids.p1}, ${ids.p2})
        UNION ALL SELECT 'erp_project_cost', count(*)::int FROM erp_project_cost WHERE project_id IN (${ids.p1}, ${ids.p2})
        UNION ALL SELECT 'erp_invoice', count(*)::int FROM erp_invoice WHERE project_id IN (${ids.p1}, ${ids.p2}) OR contract_id IN (${ids.c1}, ${ids.c2})
        UNION ALL SELECT 'erp_ar', count(*)::int FROM erp_ar WHERE project_id IN (${ids.p1}, ${ids.p2}) OR contract_id IN (${ids.c1}, ${ids.c2})
        UNION ALL SELECT 'erp_ap_bill', count(*)::int FROM erp_ap_bill WHERE project_id IN (${ids.p1}, ${ids.p2})
        UNION ALL SELECT 'erp_timesheet', count(*)::int FROM erp_timesheet WHERE project_id IN (${ids.p1}, ${ids.p2})
        UNION ALL SELECT 'comp_attachment', count(*)::int FROM comp_attachment WHERE resource_id IN (${ids.p1}, ${ids.p2})
        UNION ALL SELECT 'md_customer', count(*)::int FROM md_customer WHERE id IN (${ids.cus}, ${ids.cus2})`;
      for (const row of plan) if (row.n > 0) console.log(`  待删 ${row.t}: ${row.n} 行`);
      /* 安全闸：待删的合同/项目必须**全部**带 [API_TEST] 前缀；客户必须等于自建的那两个 id */
      const guard = (await sql`
        SELECT
          (SELECT count(*)::int FROM erp_contract WHERE id IN (${ids.c1}, ${ids.c2}) AND name NOT LIKE ${`%${TAG}%`}) AS foreign_contract,
          (SELECT count(*)::int FROM erp_project WHERE id IN (${ids.p1}, ${ids.p2}) AND name NOT LIKE ${`%${TAG}%`}) AS foreign_project,
          (SELECT count(*)::int FROM md_customer WHERE id IN (${ids.cus}, ${ids.cus2}) AND name NOT LIKE ${`%${TAG}%`}) AS foreign_customer`)[0];
      if (guard.foreign_contract > 0 || guard.foreign_project > 0 || guard.foreign_customer > 0) {
        console.log(`  ! 待删集合含非 [API_TEST] 行（${JSON.stringify(guard)}）—— 拒绝删除`);
        record('清理：待删集合只含自建数据', false, JSON.stringify(guard));
      } else {
        record('清理：待删集合只含自建数据（安全闸通过）', true, `全部带 ${TAG} 前缀 / id 命中`);
        const stmts = [
          ['erp_timesheet', () => sql`DELETE FROM erp_timesheet WHERE project_id IN (${ids.p1}, ${ids.p2})`],
          ['erp_project_revenue', () => sql`DELETE FROM erp_project_revenue WHERE project_id IN (${ids.p1}, ${ids.p2})`],
          ['erp_project_cost', () => sql`DELETE FROM erp_project_cost WHERE project_id IN (${ids.p1}, ${ids.p2})`],
          ['erp_ar', () => sql`DELETE FROM erp_ar WHERE project_id IN (${ids.p1}, ${ids.p2}) OR contract_id IN (${ids.c1}, ${ids.c2})`],
          ['erp_ap_bill', () => sql`DELETE FROM erp_ap_bill WHERE project_id IN (${ids.p1}, ${ids.p2})`],
          ['erp_invoice', () => sql`DELETE FROM erp_invoice WHERE project_id IN (${ids.p1}, ${ids.p2}) OR contract_id IN (${ids.c1}, ${ids.c2})`],
          ['erp_deliverable', () => sql`DELETE FROM erp_deliverable WHERE project_id IN (${ids.p1}, ${ids.p2})`],
          ['erp_project_milestone', () => sql`DELETE FROM erp_project_milestone WHERE project_id IN (${ids.p1}, ${ids.p2})`],
          ['erp_project_change', () => sql`DELETE FROM erp_project_change WHERE project_id IN (${ids.p1}, ${ids.p2})`],
          ['erp_project_minutes', () => sql`DELETE FROM erp_project_minutes WHERE project_id IN (${ids.p1}, ${ids.p2})`],
          ['erp_calloff', () => sql`DELETE FROM erp_calloff WHERE contract_id IN (${ids.c1}, ${ids.c2})`],
          ['comp_attachment', () => sql`DELETE FROM comp_attachment WHERE resource_id IN (${ids.p1}, ${ids.p2})`],
          ['erp_contract_version', () => sql`DELETE FROM erp_contract_version WHERE contract_id IN (${ids.c1}, ${ids.c2})`],
          ['erp_contract_milestone', () => sql`DELETE FROM erp_contract_milestone WHERE contract_id IN (${ids.c1}, ${ids.c2})`],
          ['erp_contract_item', () => sql`DELETE FROM erp_contract_item WHERE contract_id IN (${ids.c1}, ${ids.c2})`],
          ['erp_project', () => sql`DELETE FROM erp_project WHERE id IN (${ids.p1}, ${ids.p2})`],
          ['erp_contract', () => sql`DELETE FROM erp_contract WHERE id IN (${ids.c1}, ${ids.c2})`],
          ['md_customer', () => sql`DELETE FROM md_customer WHERE id IN (${ids.cus}, ${ids.cus2})`],
        ];
        for (const [name, run] of stmts) {
          try {
            const r = await run();
            if (Array.isArray(r) && r.length) console.log(`  已删 ${name}: ${r.length} 行`);
          } catch (e) {
            console.log(`  ! 删除 ${name} 失败: ${e.message}`);
          }
        }
      }
    } catch (e) {
      console.log('清理出错:', e.message);
      record('清理流程未抛错', false, e.message);
    }

    /*
     * 残留审计必须**按本次自建的 id 统计**，不能按 `[API_TEST]` 前缀扫全表：
     * 同一时间还有别的 agent 在跑各自的走查，它们的 `[API_TEST] 报价-…`
     * `[API_TEST] 商机-…` `[API_TEST] 审计留痕客户` 会被前缀统计误算成"我的残留"
     * （实测吃过一次，把 3 行别人的数据报成了失败）。
     */
    const ids0 = { c1: mine.contractId, c2: mine.contractId2, p1: mine.projectId, p2: mine.projectId2, cus: mine.customerId, cus2: mine.customerNoRateId };
    const left = (await sql`
      SELECT
        (SELECT count(*)::int FROM erp_contract WHERE id IN (${ids0.c1}, ${ids0.c2})) AS contracts,
        (SELECT count(*)::int FROM erp_project WHERE id IN (${ids0.p1}, ${ids0.p2})) AS projects,
        (SELECT count(*)::int FROM erp_contract_item WHERE contract_id IN (${ids0.c1}, ${ids0.c2})) AS items,
        (SELECT count(*)::int FROM erp_contract_milestone WHERE contract_id IN (${ids0.c1}, ${ids0.c2})) AS cms,
        (SELECT count(*)::int FROM erp_contract_version WHERE contract_id IN (${ids0.c1}, ${ids0.c2})) AS cvs,
        (SELECT count(*)::int FROM erp_project_milestone WHERE project_id IN (${ids0.p1}, ${ids0.p2})) AS pms,
        (SELECT count(*)::int FROM erp_deliverable WHERE project_id IN (${ids0.p1}, ${ids0.p2})) AS dlv,
        (SELECT count(*)::int FROM erp_project_change WHERE project_id IN (${ids0.p1}, ${ids0.p2})) AS chg,
        (SELECT count(*)::int FROM erp_project_minutes WHERE project_id IN (${ids0.p1}, ${ids0.p2})) AS mins,
        (SELECT count(*)::int FROM erp_project_revenue WHERE project_id IN (${ids0.p1}, ${ids0.p2})) AS rev,
        (SELECT count(*)::int FROM erp_project_cost WHERE project_id IN (${ids0.p1}, ${ids0.p2})) AS cost,
        (SELECT count(*)::int FROM erp_invoice WHERE contract_id IN (${ids0.c1}, ${ids0.c2})) AS inv,
        (SELECT count(*)::int FROM erp_ar WHERE contract_id IN (${ids0.c1}, ${ids0.c2})) AS ar,
        (SELECT count(*)::int FROM erp_ap_bill WHERE project_id IN (${ids0.p1}, ${ids0.p2})) AS ap,
        (SELECT count(*)::int FROM comp_attachment WHERE resource_id IN (${ids0.p1}, ${ids0.p2})) AS att,
        (SELECT count(*)::int FROM md_customer WHERE id IN (${ids0.cus}, ${ids0.cus2})) AS cus`)[0];
    const leftTotal = Object.values(left).reduce((a, b) => a + Number(b), 0);
    record(`残留审计：本次自建数据（按精确 id）全部清空`, leftTotal === 0, JSON.stringify(left));
    const globalTag = (await sql`SELECT
      (SELECT count(*)::int FROM erp_contract WHERE name LIKE ${`%${TAG}%`}) AS c,
      (SELECT count(*)::int FROM erp_project WHERE name LIKE ${`%${TAG}%`}) AS p,
      (SELECT count(*)::int FROM md_customer WHERE name LIKE ${`%${TAG}%`}) AS cu`)[0];
    notes.push(`环境内 ${TAG} 前缀的全局计数（含其他 agent 并发产生的数据，不属本次走查）: ${JSON.stringify(globalTag)}`);

    const failed = results.filter((r) => !r.pass);
    writeFileSync(`${OUT}/projects-report.json`, JSON.stringify({
      generatedAt: new Date().toISOString(),
      app: APP, api: API, browserPort: PORT,
      summary: { total: results.length, passed: results.length - failed.length, failed: failed.length },
      results, diagnostics: flat, notes,
      created: mine,
      residual: left,
    }, null, 2));

    try {
      await sql.end({ timeout: 2 });
    } catch {
      /* 忽略 */
    }
    await browser.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail}`);
  for (const n of notes) console.log(`  NOTE ${n}`);
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error('走查中断:', e);
    process.exit(1);
  },
);

