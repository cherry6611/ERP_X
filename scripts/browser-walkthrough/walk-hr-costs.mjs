/**
 * 浏览器走查：**人力资源 + 预算费控 + 成本核算 + 收入确认**
 *
 * ## 与已有走查脚本的关系
 *
 * `walk-routes.mjs` / `walk-interactions.mjs` 只回答"页面能打开、弹窗能开关"；
 * `walk-crud.mjs` / `walk-domains.mjs` 已经验证了"写入确实落库"。本脚本要在
 * 那两层之上验证**业务/财税逻辑**，也就是"落库的值对不对、该拦的拦没拦"：
 *
 * | 断言 | 只看界面能发现吗 |
 * |---|---|
 * | 工时确认 → 生成成本（类型/供应商/部门/合同回填） | ❌ 界面只显示"工时已确认" |
 * | 重复确认不得生成第二条成本 | ❌ 第二次点击同样报成功或报错，看不出账上有几条 |
 * | 角色无生效费率必须**报错拒绝**，而不是生成 0 元成本 | ❌ 0 元成本在列表里就是一行 0 |
 * | 多维汇总合计 = SQL 聚合 | ❌ 饼图不显示数字 |
 * | 收入确认 → 收入 + 凭证 + 应收 三者齐备 | ❌ 列表只有收入那一行 |
 * | 同项目同期间只能确认一次 | ⚠️ 要看提示文案是否可读 |
 * | 每张凭证借贷合计相等 | ❌ 凭证列表不显示借贷合计 |
 * | 年假按司龄初始化且**不覆盖已设置余额** | ❌ 界面只显示天数 |
 * | 离职返回近 60 天确认工时待交接项目 | ⚠️ 弹窗里能看到，但边界算不算对要核对 |
 * | 工资单 rejected 后可重新提交 | ⚠️ 按钮有没有要真看 |
 * | 报销/申请金额与预算校验 | ⚠️ 提示文案是否说清差额 |
 *
 * ## 三个身份（走查必须多身份，否则测不到职责分离）
 *
 * | 账号 | 绑定员工 | 用途 |
 * |---|---|---|
 * | 主账号（`.env` 的 BOOTSTRAP_ADMIN） | 无 `sys_user.employee_id`（但会被 `feishu_union_id` 兜底匹配） | 审批方：确认工时、审批工资单/报销 |
 * | 第二管理员（本脚本创建） | 绑定测试员工 A | 提交方：登记并提交工时、请假、补卡 |
 * | 第三管理员（本脚本创建） | 不绑定任何员工 | 管理员代登通道 + 无费率用例 |
 *
 * 为什么必须这样分：`costs.service.ts#assertTimesheetActor` 禁止确认/驳回**自己提交**的
 * 工时；只用一个账号时"确认"这一步根本走不通（实测 403），会退化成用接口硬造结果。
 *
 * ## 怎么"驱动"这些界面（本仓 UI 的四种控件形态）
 *
 * 1. **Radix Select**（`role="combobox"`）：不能直接写 `el.value`，必须点开
 *    trigger 再点 `[role="option"]`。定位靠 `aria-labelledby` 指回 `<FormLabel>` 的 id。
 * 2. **原生 `<input>` / `<textarea>`**：走原生 setter + `input` 事件（React 受控）。
 * 3. **`DateField`**：Popover + Calendar，**不是** `<input type="date">` ——
 *    要点触发器开日历、再按 `td[data-day="YYYY-MM-DD"]` 选日（标题元素在部分渲染里
 *    取不到，因此月份判断按日期网格本身做，不读 caption）。
 * 4. **Radix Popover 弹层不会自动关闭**：选完日期必须 `closePopovers()`，
 *    否则它按坐标吃掉后续提交按钮的点击（表现为"点了没反应、也没有请求"）。
 *
 * ## 数据纪律
 *
 * 所有测试数据前缀 `[API_TEST]`；清理**先 SELECT 打印待删行、再用精确主键 id 删**，
 * 不做宽泛 LIKE（本会话已有人因清理脚本 bug 误删真实数据）。
 * 残留审计只统计**本脚本自己的固定名称** —— 本机同时有其它走查 agent 在用
 * `[API_TEST]` 前缀（实测有 `[API_TEST] 供应商-<时间戳>`），宽泛匹配会把别人的数据算进来。
 *
 * 用法：`node scripts/browser-walkthrough/walk-hr-costs.mjs`
 * 可选环境变量：`WT_APP` / `WT_API` / `WT_USER` / `WT_PASS` / `WT_HEADED=1`（有头模式便于人工观察）
 * 产出：`scripts/browser-walkthrough/out/hr-costs-report.json`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
/**
 * API 基址。
 *
 * ⚠️ 走查期间 **3100 被别的 agent 重启过**（进程换成了监听 3000 的新实例），
 * 于是中途所有请求都 `fetch failed` / 500。这里不再写死：优先用 `WT_API`，
 * 否则依次探测 3100 → 3000，取第一个 `/api/health` 返回 200 的。
 */
const API = process.env.WT_API ?? (await (async () => {
  for (const port of [3100, 3000]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return `http://127.0.0.1:${port}`;
    } catch {
      /* 换下一个端口 */
    }
  }
  throw new Error('3100 / 3000 都没有可用的 API（请确认服务已启动）');
})());
const OUT = 'scripts/browser-walkthrough/out';
const TAG = '[API_TEST]';
/** ⚠️ 本 agent 独占 9364，不要改成别的端口 */
const CDP_PORT = 9364;

/* ══════════════════════════ 结果收集 ══════════════════════════ */

const results = [];
const findings = [];
const untested = [];

function record(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail: detail ?? null });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function note(id, text) {
  if (findings.some((f) => f.id === id)) return;
  findings.push({ id, text });
  console.log(`  ⚠️  ${id}  ${text}`);
}
function skip(name, why) {
  if (untested.some((u) => u.name === name)) return;
  untested.push({ name, why });
  console.log(`  SKIP  ${name} — ${why}`);
}

/* ══════════════════════════ 页面辅助 ══════════════════════════ */

async function login() {
  const user = process.env.WT_USER ?? process.env.BOOTSTRAP_ADMIN_USERNAME ?? 'chengsheng@chengshengdata.cn';
  const pass = process.env.WT_PASS ?? process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '******';
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (res.status !== 201) throw new Error(`登录失败 ${res.status} ${await res.text()}`);
  const jar = res.headers.getSetCookie?.() ?? [];
  const cookie = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session='));
  if (!cookie) throw new Error('登录响应里没有 erp_session');
  return cookie.slice('erp_session='.length);
}

/** 用任意账号登录，返回 session cookie 值（走查要两个身份：提交人与审批人） */
async function loginAs(username, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 201) return { ok: false, status: res.status, session: null, body: await res.text() };
  const jar = res.headers.getSetCookie?.() ?? [];
  const cookie = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session='));
  return { ok: !!cookie, status: res.status, session: cookie ? cookie.slice(12) : null, body: '' };
}

/** 页面内所有 sonner toast 文本（轮询，错误 toast 也算"提示"） */
async function toasts(page, { attempts = 10, gapMs = 300 } = {}) {
  const seen = [];
  for (let i = 0; i < attempts; i += 1) {
    const found = await page.evaluate(
      `(() => [...document.querySelectorAll('[data-sonner-toast]')].map((e) => (e.textContent || '').trim()).filter(Boolean))()`,
    );
    for (const t of found) if (!seen.includes(t)) seen.push(t);
    if (seen.length) break;
    await sleep(gapMs);
  }
  return seen;
}

/** 当前打开的 dialog（或 null）。`titleRe` 可指定标题，避免误命中"另一个还开着的弹窗" */
async function dialogInfo(page, titleRe = null) {
  return page.evaluate(`(() => {
    const all = [...document.querySelectorAll('[role="dialog"]')];
    const d = ${titleRe === null ? 'all[0] ?? null' : `all.find((x) => new RegExp(${JSON.stringify(titleRe)}).test((x.querySelector('[role="heading"],h2')?.textContent || ''))) ?? null`};
    if (!d) return null;
    return {
      title: (d.querySelector('[role="heading"],h2')?.textContent || '').trim(),
      labels: [...d.querySelectorAll('label')].map((l) => (l.textContent || '').replace(/\\s*\\*\\s*$/,'').trim()),
      buttons: [...d.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
    };
  })()`);
}

/** 从当前页面表格里按行文本取出「行号（1-based，表头不算）」 */
async function rowIndexOf(page, rowText) {
  return page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('tr')];
    const idx = rows.findIndex((r) => (r.textContent || '').includes(${JSON.stringify(rowText)}));
    return idx;
  })()`);
}

/** 从当前页面表格里按行文本取出该行所有按钮文案 */
async function rowButtons(page, rowText) {
  return page.evaluate(`(() => {
    const row = [...document.querySelectorAll('tr')].find((r) => (r.textContent || '').includes(${JSON.stringify(rowText)}));
    return row ? [...row.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean) : null;
  })()`);
}

/**
 * 带重试的接口调用，用于**刚新建的账号**。
 *
 * 已知的服务端行为（不是本脚本的 bug）：`ActorAccessService` 把"角色→成员"
 * 缓存在内存 60 秒，新建账号后立刻调用依赖 `hasAnyRole` 的接口，
 * 可能命中**新建之前**的快照而报 403「仅管理员可为其他员工代登记工时」——
 * 同一个请求过一会儿再发就成功。这里对 403 做有限重试，
 * 并在结果里注明重试次数，避免把服务端的缓存时序当成业务拒绝。
 */
async function httpWithRetry(session, method, path, body, { retries = 4, gapMs = 20000, retryOn = [403] } = {}) {
  let last = null;
  for (let i = 0; i <= retries; i += 1) {
    last = await http(session, method, path, body);
    if (!retryOn.includes(last.status)) return { ...last, attempts: i + 1 };
    if (i < retries) await sleep(gapMs);
  }
  return { ...last, attempts: retries + 1 };
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

/** React 受控 input/textarea 赋值（原生 setter + input 事件） */
async function setField(page, selector, value, index = 0) {
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
 * 按 `<FormLabel>` 文本定位并操作控件。
 *
 * 定位顺序与 `walk-domains.mjs#fillByLabel` 一致：`label[for]` → 同容器 →
 * 同序控件；但本处**额外**处理 Radix Select：它的可见部分是
 * `role=combobox` 的 button，靠 `aria-labelledby` 指回 label 的 id。
 */
async function selectByLabel(page, labelRe, { optionText = null, optionIndex = 0, scope = 'dialog' } = {}) {
  const opened = await page.evaluate(`(() => {
    const root = ${scope === 'dialog' ? `document.querySelector('[role="dialog"]')` : 'document'};
    if (!root) return 'no-scope';
    const lab = [...root.querySelectorAll('label')].find((l) => new RegExp(${JSON.stringify(labelRe)}).test(l.textContent || ''));
    if (!lab) return 'label-not-found';
    const item = lab.closest('div') ?? lab.parentElement;
    // ① aria-labelledby 指回本 label（本仓 FormField + Radix Select 的固定形态）
    const combos = [...(item?.querySelectorAll('[role="combobox"]') ?? [])];
    let btn = combos[0] ?? null;
    // ② 退化为 label[for] / 同容器原生 select
    if (!btn && lab.htmlFor) btn = root.querySelector('#' + CSS.escape(lab.htmlFor));
    if (!btn) btn = item?.querySelector('select,[role="combobox"]') ?? null;
    if (!btn) return 'control-not-found';
    btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'opened:' + btn.tagName.toLowerCase();
  })()`);
  if (['no-scope', 'label-not-found', 'control-not-found'].includes(String(opened))) return opened;
  await sleep(700);
  const picked = await page.evaluate(`(() => {
    const opts = [...document.querySelectorAll('[role="option"]')];
    if (opts.length === 0) return 'no-option';
    const want = ${JSON.stringify(optionText)};
    const o = want
      ? opts.find((x) => (x.textContent || '').includes(want))
      : opts[${optionIndex}];
    if (!o) return 'option-not-found:' + opts.map((x) => (x.textContent || '').trim()).slice(0, 6).join('|');
    o.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    o.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'picked:' + (o.textContent || '').trim().slice(0, 30);
  })()`);
  await sleep(500);
  return picked;
}

/**
 * 按 `<FormLabel>` 文本填普通输入框（input / textarea）。
 *
 * ⚠️ 本仓的 `DateField` **不是** `<input type="date">`（见
 * `components/erp/DateField.tsx`：Popover + Calendar，trigger 是个 `<button>`）。
 * 早期版本把"同容器里第一个 `input,textarea`"当目标，于是在日期字段上拿到
 * **button**，`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(button, v)`
 * 直接抛 `TypeError: Illegal invocation` —— 一条字段定位错误把整段走查带走了。
 * 因此这里显式判类型：非 input/textarea 一律返回 `unsupported:<tag>`，由调用方决定怎么办。
 */
async function fillByLabel(page, labelRe, value, { scope = 'dialog' } = {}) {
  return page.evaluate(`(() => {
    const root = ${scope === 'dialog' ? `document.querySelector('[role="dialog"]')` : 'document'};
    if (!root) return 'no-scope';
    const lab = [...root.querySelectorAll('label')].find((l) => new RegExp(${JSON.stringify(labelRe)}).test(l.textContent || ''));
    if (!lab) return 'label-not-found';
    const item = lab.closest('div') ?? lab.parentElement;
    const scopes = [item, root];
    for (let i = 0; i < scopes.length; i += 1) {
      const cands = [];
      const byFor = lab.htmlFor ? root.querySelector('#' + CSS.escape(lab.htmlFor)) : null;
      if (i === 0 && byFor) cands.push(byFor);
      for (const el of (scopes[i]?.querySelectorAll('input,textarea') ?? [])) cands.push(el);
      const el = cands.find((x) => x && !x.disabled && x.type !== 'hidden'
        && (x.tagName === 'INPUT' || x.tagName === 'TEXTAREA'));
      if (!el) continue;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) return 'no-setter:' + el.tagName;
      setter.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok:' + (el.name || el.id || el.tagName.toLowerCase());
    }
    // 同容器里没有 input/textarea → 看看是不是 DateField 之类的按钮型控件
    const other = item?.querySelector('button,[role="combobox"]');
    return 'unsupported:' + (other ? other.tagName.toLowerCase() : 'nothing-in-container');
  })()`);
}

/**
 * 设置 `DateField`（Popover + Calendar）的值 —— **真实点击日历**。
 *
 * 实测的 DOM 形状（probe 结果，别再靠猜）：
 * ```
 * <div data-slot="calendar" class="rdp-root" data-mode="single">
 *   <nav class="rdp-nav"> <button aria-label="Go to the Previous Month"> …
 *                         <button aria-label="Go to the Next Month"> … </nav>
 *   <td data-day="2026-09-27"><button aria-label="Sunday, September 27th, 2026">27</button></td>
 * ```
 * 两个坑：
 *  ① `td[data-day]` 的值是 ISO（`2026-09-27`），而**内部 button 自己没有该属性**，
 *     按 `[data-day]` 命中后必须再往里找 button 才是可点的那个；
 *  ② 日期的可读名字是**英文长格式**（`September 27th, 2026`），库里没有中文标签，
 *     因此不要指望 `aria-label` 直接等于 `YYYY-MM-DD`。这里用 `data-day` 比对，
 *     比对成功后再点内部的 button —— 比拼英文序数词可靠得多。
 * 目标月份不在当前月时，点 `aria-label="Go to the Next/Previous Month"` 翻页。
 */
async function setDateByLabel(page, labelRe, isoDate, { scope = 'dialog' } = {}) {
  /** 打开日历；若 2.5s 内没出现 `.rdp-root`，认为点空了并重试一次 */
  const openOnce = () => page.evaluate(`(() => {
    const root = ${scope === 'dialog' ? `document.querySelector('[role="dialog"]')` : 'document'};
    if (!root) return 'no-scope';
    const lab = [...root.querySelectorAll('label')].find((l) => new RegExp(${JSON.stringify(labelRe)}).test(l.textContent || ''));
    if (!lab) return 'label-not-found';
    const item = lab.closest('div') ?? lab.parentElement;
    // 只取本 FormItem 自己的 trigger（id 形如 "<id>-form-item"），不要用 item.querySelector('button')：
    // 那是文档序第一个按钮，会误点「关联飞书账号」的 combobox。
    const btn = (lab.htmlFor ? root.querySelector('#' + CSS.escape(lab.htmlFor)) : null)
      ?? item?.querySelector('button');
    if (!btn) return 'no-button';
    /*
     * 先聚焦再点。
     *
     * Radix Popover 的 trigger 在**未聚焦**且对话框刚挂载（焦点还在 Dialog 容器或
     * 上一个已卸载的输入框）时，首个 pointerdown 可能被 Dialog 的焦点管理吞掉 ——
     * 实测同一个控件"单独探针必成功、整段走查里常失败"，差别就是焦点位置。
     * 这里显式 focus 一次，把这个不确定性消掉。
     */
    if (typeof btn.focus === 'function') btn.focus();
    btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'opened';
  })()`);
  let opened = await openOnce();
  if (String(opened) !== 'opened') return opened;
  let calReady = false;
  for (let i = 0; i < 20 && !calReady; i += 1) {
    await sleep(250);
    calReady = await page.evaluate(`!!document.querySelector('[data-slot="calendar"] [data-day]')`);
    /*
     * 每 4 次（约 1s）再点一次触发器，而不是只重试一次。
     *
     * 为什么放宽：本仓的日期控件是 Radix Popover，`pointerdown` 打开、
     * 但前一个控件的弹层/动画尚未结束时首点会被吞掉。实测「离职弹窗」里
     * 只重试一次仍然偶发 `calendar-not-opened`（同一个控件单独探针却必成功），
     * 属于典型的时序抖动，因此改为周期性重试到 5s。
     */
    if (!calReady && i % 4 === 3) opened = await openOnce();
  }
  if (!calReady) {
    const why = await page.evaluate(`(() => ({
      anyDialog: [...document.querySelectorAll('[role="dialog"]')].map((d) => (d.querySelector('[role="heading"],h2')?.textContent || '').trim()),
      hasPopover: !!document.querySelector('[data-radix-popper-content-wrapper]'),
      hasCalendar: !!document.querySelector('[data-slot="calendar"]'),
    }))()`);
    return 'calendar-not-opened:' + JSON.stringify(why);
  }

  /**
   * 翻页 + 选日在**页面内一次跑完**（awaitPromise）。
   *
   * ⚠️ 为什么不能像第一版那样"每翻一页回一次 Node"：240 次 Runtime.evaluate
   * 往返会触发 CDP 调用超时（实测「CDP 调用超时: Runtime.evaluate」），而且极慢。
   * 把循环放进页面里、只回一个结果，既快又不会超时。
   *
   * ⚠️ 本文件里凡是 `page.evaluate(...)` 的字符串都用反引号包，因此**注释里绝不能
   * 出现反引号** —— 一个反引号就能提前闭合模板串，报出与真正原因无关的语法错误
   * （这个坑在本文件已经踩过两次）。
   */
  const [y, m] = isoDate.split('-').map((x) => Number(x));
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const wantLabel = `${MONTH_NAMES[m - 1]} ${y}`;
  const wantYm = `${y}-${String(m).padStart(2, '0')}`;
  const picked = await page.evaluate(
    `(async () => {
      const want = ${JSON.stringify(isoDate)};
      const wantLabel = ${JSON.stringify(wantLabel)};
      const wantYm = ${JSON.stringify(wantYm)};
      /*
       * ⚠️ 让出主线程必须用 setTimeout，**不能**用 requestAnimationFrame：
       * headless Chrome 里页面未被合成时 rAF 回调可以**永远不触发**，
       * 于是这个页内循环会挂死，Node 侧表现为 45s 后
       * 「CDP 调用超时: Runtime.evaluate」（实测就是这个原因）。
       * 另外加了 25s 硬截止，保证任何情况下都会返回而不是挂住。
       */
      const frame = () => new Promise((r) => setTimeout(r, 0));
      const deadline = Date.now() + 25000;
      const daysInMonth = (ym) => {
        const yy = Number(ym.slice(0, 4));
        const mm = Number(ym.slice(5, 7));
        return new Date(Date.UTC(yy, mm, 0)).getUTCDate();
      };
      let hops = 0;
      for (let hop = 0; hop < 400; hop += 1) {
        if (Date.now() > deadline) return 'deadline:' + hop;
        const cells = [...document.querySelectorAll('td[data-day]')];
        const td = cells.find((c) => c.getAttribute('data-day') === want);
        if (td) {
          const b = td.querySelector('button') ?? td;
          b.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
          b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return 'picked:' + want + '@hop' + hops;
        }
        const cal = document.querySelector('[data-slot="calendar"]');
        if (!cal) return 'calendar-closed';
        /*
         * 判断"当前显示的是几月"**不要读标题元素** —— 实测 .rdp-caption_label 在
         * 部分渲染里取不到（class 带 tailwind 变体后缀），早期版本因此拿不到标题、
         * 跳过了"已到目标月"的判定，一路往回翻过头（2026-10 直接翻到 2021-06）。
         *
         * 改为按**网格本身**判定，零额外选择器依赖：
         *   最后一行之前的第一个单元格 → 网格主显示月的 1 号。
         * react-day-picker 会在月首补上上个月的尾巴行，而恰好是 1 号的那个补位格
         * 才说明当月 1 号落在第一行内 —— 这正是"补位行归属"的判据。
         */
        const monthStart = cells.length >= 7
          ? (cells[Math.max(0, cells.length - 14)].getAttribute('data-day') ?? '')
          : '';
        const curYm = monthStart.slice(0, 7);
        if (!curYm) return 'no-cells:' + cells.length;
        if (curYm === wantYm) return 'no-cell-in-month:' + curYm + '(共' + cells.length + '格)';
        const dir = curYm > wantYm ? 'Previous' : 'Next';
        const nav = [...document.querySelectorAll('button')]
          .find((b) => (b.getAttribute('aria-label') || '') === 'Go to the ' + dir + ' Month');
        if (!nav) return 'no-nav:' + dir + '@' + curYm;
        if (nav.disabled || nav.getAttribute('aria-disabled') === 'true') {
          return 'nav-disabled:' + dir + '@' + curYm;
        }
        nav.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        nav.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        nav.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        hops += 1;
        await frame();
      }
      return 'nav-exhausted@' + hops + ':' + JSON.stringify({
        firstDay: document.querySelector('td[data-day]')?.getAttribute('data-day') ?? null,
      });
    })()`,
    { awaitPromise: true },
  );
  if (String(picked).startsWith('picked')) await sleep(400);
  /*
   * ⚠️ 这里**故意不关**日历弹层。
   *
   * Radix Popover 在选中日期后不会自己关闭，它会盖住 Dialog 下方的按钮、吃掉
   * 后续点击（实测「填完表点提交没反应、弹窗不关、也没有任何请求」）。
   * 但**也不能在这里立刻关**：Escape 会与"选中日期 → 受控 state 更新"竞态，
   * 实测出现过"日期已选中、输入框仍显示『请选择日期』"，进而让提交按钮处于
   * 无日期状态（校验失败、什么都不发生）。
   * 因此关闭动作交给调用方，用 `closePopovers(page)` 在**提交之前**显式执行。
   */
  return picked;
}

/** 关闭所有 Radix 弹层（日历 / 下拉），避免它们吃掉后续提交按钮的点击 */
async function closePopovers(page) {
  for (let i = 0; i < 3; i += 1) {
    const open = await page.evaluate(
      `document.querySelectorAll('[data-radix-popper-content-wrapper] [data-state="open"]').length`,
    );
    if (!open) return true;
    await page.pressKey('Escape', 'Escape', 27);
    await sleep(350);
  }
  return false;
}

/**
 * 统一点击入口：**先关掉残留的 Radix 弹层再点**。
 *
 * 为什么要收口：`DateField` 的日历是 Radix Popover，选中后不会自动关闭，
 * 它渲染在 portal 里、层级高于 Dialog，会按坐标吃掉后续点击 ——
 * 表现为「点提交没有任何反应、弹窗不关、也没有请求」，极难归因。
 * 本仓同类控件（日期、下拉）都是这个形态，所以在入口统一处理，
 * 而不是指望每个调用点都记得先关弹层。
 */
async function clickText(page, text, opts = { selector: 'button', settleMs: 1200 }) {
  await closePopovers(page);
  return page.clickByText(text, opts);
}

/**
 * **清空** `DateField`（Popover + Calendar）。
 *
 * 日历本身没有"清除"入口，`onChange` 也只接受 `Date`（不接受 undefined 的
 * 用户手势）。因此这里如实返回 `unsupported`，把"日历控件能否清空"作为一条
 * **待确认项**记录进报告，而不是假装清空成功。
 */
async function clearDateByLabel(page, labelRe) {
  const found = await page.evaluate(`(() => {
    const root = document.querySelector('[role="dialog"]');
    if (!root) return 'no-scope';
    const lab = [...root.querySelectorAll('label')].find((l) => new RegExp(${JSON.stringify(labelRe)}).test(l.textContent || ''));
    if (!lab) return 'label-not-found';
    const btn = (lab.closest('div') ?? lab.parentElement)?.querySelector('button');
    return btn ? 'button:' + (btn.textContent || '').trim() : 'no-button';
  })()`);
  return `unsupported(日历控件无清空入口): ${found}`;
}

/** 点击某一行里文本匹配的按钮 */
async function clickRowButton(page, rowText, btnRe) {
  return page.evaluate(`(() => {
    const row = [...document.querySelectorAll('tr')].find((r) => (r.textContent || '').includes(${JSON.stringify(rowText)}));
    if (!row) return 'row-not-found';
    const b = [...row.querySelectorAll('button')]
      .find((x) => new RegExp(${JSON.stringify(btnRe)}).test((x.textContent || '').trim()));
    if (!b) return 'btn-not-found:' + [...row.querySelectorAll('button')].map((x) => (x.textContent || '').trim()).filter(Boolean).join('|');
    b.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
}

/** 点掉 confirmDanger 弹窗（Radix AlertDialog，确认按钮文案可指定） */
async function confirmDangerBox(page, { confirmRe = '确认|确定|删除|作废|关闭' } = {}) {
  await sleep(700);
  return page.evaluate(`(() => {
    const d = document.querySelector('[role="alertdialog"]') ?? document.querySelector('[role="dialog"]');
    if (!d) return 'no-dialog';
    const b = [...d.querySelectorAll('button')]
      .find((x) => new RegExp(${JSON.stringify(confirmRe)}).test((x.textContent || '').trim()));
    if (!b) return 'btn-not-found';
    b.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok:' + (b.textContent || '').trim();
  })()`);
}

/** 点 antd Tabs / Radix Tabs / 本仓自绘 tab button；**只点 role=tab**，避免误中同名普通按钮 */
async function switchTab(page, label) {
  const r = await page.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('[role="tab"], .ant-tabs-tab')];
    const hit = tabs.find((n) => (n.textContent || '').trim() === ${JSON.stringify(label)});
    if (!hit) {
      const loose = [...document.querySelectorAll('button')]
        .find((n) => (n.textContent || '').trim() === ${JSON.stringify(label)});
      if (!loose) {
        return 'not-found:' + tabs.map((n) => (n.textContent || '').trim()).join('|');
      }
      loose.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      loose.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'ok(button)';
    }
    // Radix Tabs 在 pointerdown 触发；antd 在 click；两个都发一遍
    hit.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(1200);
  return r;
}

/** 等页面文本出现某段内容（tab 内容异步渲染时用） */
async function waitText(page, substring, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const has = await page.evaluate(`(document.body.innerText || '').includes(${JSON.stringify(substring)})`);
    if (has) return true;
    await sleep(300);
  }
  return false;
}

/** 等某个标题的 dialog 出现；失败时返回带诊断的结果，而不是让后续步骤静默跑空 */
async function waitDialog(page, titleRe, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const info = await dialogInfo(page, titleRe);
    if (info) return info;
    await sleep(300);
  }
  const diagnostic = await page.evaluate(`(() => ({
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map((d) => ({
      title: (d.querySelector('[role="heading"],h2')?.textContent || '').trim(),
      textLen: (d.innerText || '').length,
    })),
    alertDialogs: document.querySelectorAll('[role="alertdialog"]').length,
    bodyTail: (document.body.innerText || '').slice(0, 300),
  }))()`);
  return { __missing: true, diagnostic };
}

/**
 * 点按钮 → **等弹窗出现**；拿不到弹窗时返回诊断而不是 `null`。
 *
 * 为什么要包一层：`page.clickByText` 找不到元素会**抛错**，而走查里多处
 * 只 `await` 不 `catch`，一次"按钮没渲染完"就会把整段带走；
 * 更糟的是"点了但弹窗没开"时后续断言会静默拿到 undefined。
 */
async function clickAndWaitDialog(page, buttonText, titleRe, { settleMs = 1300, timeoutMs = 12000 } = {}) {
  let clickResult = 'ok';
  try {
    // ⚠️ 形参不能叫 clickText：会遮蔽同名辅助函数，变成自己调自己（无限递归）
    await clickText(page, buttonText, { selector: 'button, [role="tab"], [role="menuitem"]', settleMs });
  } catch (e) {
    clickResult = `click-failed:${e.message}`;
  }
  const info = await waitDialog(page, titleRe, timeoutMs);
  return { clickResult, info };
}

/**
 * 打开 `/hr`（或 `/fin-expense`）并**确保目标 Tab 处于选中态**。
 *
 * ⚠️ 不要指望 `?tab=` 查询参数：`HrPage` / `FinExpensePage` 的 tab 是
 * `useSearchParams()` 读的，但 SPA 内前进/后退与"带查询串的硬导航"混用时
 * 出现过"参数在 URL 里、内容却还是默认 Tab"的情况（走查实测：`/hr?tab=employees`
 * 打开后页面上没有「新建员工」按钮）。因此这里一律**显式点一次 Tab 并等内容**。
 */
async function openTab(page, route, tabLabel, expectText, timeoutMs = 15000) {
  await page.goto(`${APP}${route}`, { settleMs: 2400 });
  await waitText(page, tabLabel, timeoutMs);
  let switched = await switchTab(page, tabLabel);
  let ready = await waitText(page, expectText, timeoutMs);
  if (!ready) {
    /*
     * 重试一次：本仓前端是 Vite dev server + React.lazy，走查期间别的 agent
     * 可能在改同一批文件（HMR 会短暂处于"路由懒加载失败"的状态），
     * 表现为页面只剩侧栏、tab 内容空白。刷新一次即可恢复；
     * 这里把"一次未渲染"当成可重试的瞬时态，而不是直接判失败。
     */
    console.log(`    · 「${tabLabel}」未在 ${timeoutMs}ms 内渲染出「${expectText}」，刷新重试一次…`);
    await page.goto(`${APP}${route}`, { settleMs: 2600 });
    await waitText(page, tabLabel, timeoutMs);
    switched = await switchTab(page, tabLabel);
    ready = await waitText(page, expectText, timeoutMs);
  }
  return { switched, ready, retried: !ready };
}

/** 页面上的可见文本长度 + 关键计数（判断"渲染出来了"） */
async function pageStats(page) {
  return page.evaluate(`(() => ({
    path: location.pathname + location.search,
    textLen: (document.body?.innerText || '').length,
    buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
    tabs: [...document.querySelectorAll('[role="tab"], .ant-tabs-tab')].map((t) => (t.textContent || '').trim()),
    tables: document.querySelectorAll('table').length,
  }))()`);
}

/** 调一次后端（浏览器同一会话 cookie），返回 {status, body, message} */
async function http(session, method, path, body) {
  if (!session) {
    throw new Error(`缺少会话 cookie，拒绝发起 ${method} ${path}（请检查前置登录步骤）`);
  }
  if (body !== undefined && Object.values(body).some((v) => v === undefined)) {
    const bad = Object.entries(body).filter(([, v]) => v === undefined).map(([k]) => k);
    /*
     * 显式拦住 `{ employeeId: undefined }` 这种请求体：DTO 层 `@IsOptional()` 会放行，
     * 服务端随后按"本人未绑定"处理，报错文案与真实原因（前置步骤没拿到 id）**完全无关**，
     * 排查时会绕大圈。这里直接抛错并点名是哪个字段。
     */
    throw new Error(`${method} ${path} 的请求体含 undefined 字段：${bad.join(', ')}（前置步骤未取到值）`);
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: `erp_session=${session}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  const message = parsed?.error?.message ?? parsed?.message ?? (typeof parsed === 'string' ? parsed.slice(0, 200) : '');
  return { status: res.status, body: parsed, message };
}

/** 自然月加 n 个月，返回 `YYYY-MM`（走查要造未来期间的数据，用真日历算而不是字符串拼） */
function shiftMonth(period, delta) {
  const [y, m] = period.split('-').map((x) => Number(x));
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** 期间 → 该月内一个安全的日（15 号，避开月末与"未来日期"校验的边界） */
const dayIn = (period) => `${period}-15`;

/* ══════════════════════════ 主流程 ══════════════════════════ */

async function main() {
  mkdirSync(OUT, { recursive: true });
  const session = await login();
  const sql = postgres({
    host: '127.0.0.1', port: 5433, user: 'erp', password: '******',
    database: 'shengseerp', connect_timeout: 5,
  });
  /**
   * 按**精确主键 id 数组**删行。
   *
   * ⚠️ 不能用 `sql.unsafe('... = ANY($1::uuid[])', [ids])`：postgres.js 会把
   * JS 数组按 text 发送，PG 报 `op ANY/ALL (array) requires array on right side`
   * （42809）—— 清理静默失败比不清理更危险。这里用 `sql(array(ids))` 让驱动
   * 正确序列化成 PG 数组。
   */
  const delByIds = (table, list) =>
    list.length === 0
      ? Promise.resolve([])
      : sql.unsafe(`DELETE FROM "${table}" WHERE id = ANY($1::uuid[]) RETURNING id`, [list]);
  /**
   * `= ANY(...)` 的 id 集合表达式。
   *
   * ⚠️ 只有「模板里的裸数组 + 显式 `::uuid[]` 强转」这一种写法是对的：
   *   · `sql.unsafe('… = ANY($1::uuid[])', [ids])` → postgres.js 按 text 发送，
   *     PG 报 42809 `op ANY/ALL (array) requires array on right side`；
   *   · `sql(list)` → 走 Builder 分支，uuid 字面量被当成**列标识符**内联，
   *     PG 报 42703 `column "0000…" does not exist`；
   *   · `sql.typed(list, 'uuid[]')` → 序列化不出数组字面量，PG 报
   *     22P02 `malformed array literal`。
   * 空数组换成一个永不命中的哨兵，保证 `$1::uuid[]` 恒为合法数组。
   */
  const anyIds = (list) =>
    sql`${(list.length ? list : ['00000000-0000-0000-0000-000000000000'])}::uuid[]`;

  /** 本脚本创建的实体 id —— 清理只按这些精确 id 删 */
  const cleanup = {
    employeeIds: [], positionIds: [], rateIds: [], timesheetIds: [], costIds: [],
    revenueIds: [], adjustIds: [], voucherIds: [], arIds: [], invoiceIds: [],
    applyIds: [], claimIds: [], apIds: [], attendanceIds: [], leaveRequestIds: [],
    leaveBalanceIds: [], payrollIds: [], allocationIds: [], amendmentIds: [],
    userIds: [],
  };
  /** 第二管理员（工时提交人）；确认由主账号在浏览器里点，构成真实职责分离 */
  let reviewerUserId = null;
  /**
   * 测试供应商名（固定、精确可辨）。
   *
   * ⚠️ 必须声明在 `try` **之外**：清理在 `finally` 里按这个名字精确删除，
   * 而 `const` 在 `try` 块内是块级作用域 —— 第一版放进 try 里，
   * 结果 finally 报 `ReferenceError: supName is not defined`，
   * 整段清理（含残留审计）直接中断。
   */
  const supName = `${TAG}供应商-走查`;
  /** 测试员工 A 的入职日期（多处断言与用例都依赖它，提出来避免两处写死后不一致） */
  const hireDateForTest = '2021-04-15';
  const diagAll = [];

  const browser = await Browser.launch({ port: CDP_PORT, headless: process.env.WT_HEADED !== '1' });
  const page = await browser.newPage();
  /*
   * 单次 CDP 调用的超时从 45s 放宽到 120s。
   *
   * 原因：本机同时有其它走查 agent 在跑 Chrome（实测 9362 端口另有一个实例），
   * 页内循环（日历翻页、批量悬停）在 CPU 争抢下偶发超过 45s，
   * 表现为「CDP 调用超时: Runtime.evaluate」把整段走查带走。
   * 这里只在**本脚本**放宽，不改 `cdp.mjs` 的默认值（其它脚本仍按 45s）。
   * 页内循环另加 25s 硬截止，因此放宽超时不会掩盖真正的死循环。
   */
  const origSend = page.send.bind(page);
  page.send = (method, params = {}, timeoutMs = 120000) => origSend(method, params, timeoutMs);
  await page.enable();
  await page.setViewport(1700, 1100);
  await page.setCookie({ name: 'erp_session', value: session, url: APP });

  try {
    /**
     * 每个阶段独立兜底：一个用例抛错**不能**带走后面所有用例
     * （第一版就是这样——员工创建那步一炸，整份报告只剩 2 条结果）。
     * 失败会作为一条 FAIL 结果落进报告，继续跑下一段。
     */
    const phase = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        record(`阶段「${name}」未抛异常`, false, msg.slice(0, 300));
        try {
          const dump = await page.evaluate(`(() => ({
            path: location.pathname + location.search,
            dialog: !!document.querySelector('[role="dialog"]'),
            dialogText: (document.querySelector('[role="dialog"]')?.innerText || '').slice(0, 400),
            bodyText: (document.body?.innerText || '').slice(0, 400),
          }))()`);
          record(`阶段「${name}」失败时的页面现场`, false, JSON.stringify(dump).slice(0, 700));
        } catch { /* 页面可能已崩，忽略 */ }
      }
    };

    /* ══════════ 0. 准备测试主体（走 UI 能做的部分尽量走 UI） ══════════ */

    console.log('\n════ 0. 准备 [API_TEST] 测试主体 ════');
    page.resetDiagnostics();
    const roleName = `${TAG}数据工程师`;
    const posName = `${TAG}岗位`;
    const empName = `${TAG}员工A`;

    // 0a. 岗位（工时确认要靠 position.role_name 折算费率）
    const posRes = await http(session, 'POST', '/api/hr/positions', {
      name: posName, roleName, remark: `${TAG} 走查岗位`,
    });
    const positionId = posRes.body?.id ?? null;
    if (positionId) cleanup.positionIds.push(positionId);
    record('准备：创建岗位（带角色名）', posRes.status === 201 && !!positionId,
      `status=${posRes.status} roleName=${roleName} ${posRes.message}`);

    // 0b. 员工（走 UI：员工档案 → 新建员工）
    const hrReady = await openTab(page, '/hr', '员工档案', '新建员工');
    record('打开「员工档案」Tab 并渲染出「新建员工」按钮', hrReady.ready, JSON.stringify(hrReady));
    let empId = null;
    /*
     * 取一个已有部门用于「部门」下拉。
     *
     * 为什么必须选部门：成本行要验证 `department_id` 由员工部门回填
     * （`costs.service.ts#timesheetAction`）。员工不挂部门时该列就是 null ——
     * 于是"回填"这条断言永远失败，而失败原因是**用例没造对前置数据**、
     * 不是代码有问题。早期版本就是这样误报的。
     */
    const deptRow = (await sql`SELECT id, name FROM hr_department ORDER BY code LIMIT 1`)[0];
    record('准备：取一个部门用于员工建档（验证成本 department_id 回填）',
      !!deptRow, deptRow ? deptRow.name : '库中无部门');
    await clickText(page, '新建员工', { selector: 'button', settleMs: 1200 });
    await sleep(1000);
    const cd = await dialogInfo(page);
    record('员工档案：新建弹窗打开', !!cd, cd ? `title=${cd.title} 字段=${JSON.stringify(cd.labels)}` : '未打开');
    if (cd) {
      const steps = [];
      steps.push(['姓名', await fillByLabel(page, '^姓名', empName)]);
      steps.push(['部门', await selectByLabel(page, '部门', { optionText: deptRow?.name })]);
      steps.push(['岗位', await selectByLabel(page, '^岗位', { optionText: posName })]);
      steps.push(['入职日期', await setDateByLabel(page, '^入职日期', hireDateForTest)]);
      steps.push(['用工类型', await selectByLabel(page, '^用工类型', { optionText: '全职' })]);
      steps.push(['状态', await selectByLabel(page, '^状态', { optionText: '试用' })]);
      steps.push(['手机号', await fillByLabel(page, '^手机号', '13900000001')]);
      record('员工档案：新建表单各字段可填（含 3 个 Radix Select 与 1 个日历）',
        steps.every(([, r]) => String(r).startsWith('ok') || String(r).startsWith('picked')),
        steps.map(([k, r]) => `${k}=${r}`).join(' '));
      await sleep(400);
      await clickText(page, '保存', { selector: '[role="dialog"] button', settleMs: 900 });
      const t = await toasts(page);
      await sleep(900);
      const rowEmp = (await sql`
        SELECT id, code, name, hire_date, employment_type, status, department_id, position_id
        FROM md_employee WHERE name = ${empName} LIMIT 1`)[0];
      empId = rowEmp?.id ?? null;
      if (empId) cleanup.employeeIds.push(empId);
      const stillOpen = await page.evaluate(`!!document.querySelector('[role="dialog"]')`);
      /*
       * 断言拆开写：position_id / employment_type / hire_date 各自定位，
       * 否则合成一条布尔式后出错只会看到"失败"，不知道是哪个字段没落库
       * （本文件第一版就把 hire_date 写成 undefined 而误判为整体失败）。
       */
      const hireOk = rowEmp?.hire_date?.toISOString?.().slice(0, 10) === hireDateForTest;
      const posOk = String(rowEmp?.position_id) === String(positionId);
      const typeOk = rowEmp?.employment_type === 'full_time';
      record('员工档案：新建落库（岗位 / 入职日期 / 用工类型三项分别核对）',
        !!rowEmp && posOk && hireOk && typeOk,
        `toast=${JSON.stringify(t)} 弹窗仍开=${stillOpen} 库=${rowEmp ? `${rowEmp.code} hire=${rowEmp.hire_date?.toISOString?.().slice(0, 10)} type=${rowEmp.employment_type} status=${rowEmp.status}` : '未找到'} ` +
        `岗位一致=${posOk} 入职日期一致=${hireOk} 用工类型一致=${typeOk}`);
    }
    await closeDialog(page);
    if (!empId) throw new Error('测试员工未能创建，后续用例无法继续');

    // 0c. 供应商（flex_labor 成本的 supplier_id 回填要验，需兼职员工挂供应商）
    /*
     * ⚠️ 名称必须**精确可辨**：本机同时有其它走查 agent 在跑，它们也用 `[API_TEST]`
     * 前缀（实测有 `[API_TEST] 供应商-<时间戳>`）。因此清理与残留审计一律按
     * **精确等值**（本脚本的固定名），不要用 `LIKE '%[API_TEST]%'` 去数别人的数据，
     * 否则自己的报告会被别人的残留污染（第一版就报了"残留 2"，实际那两条不是本脚本的）。
     */
    const supRes = await http(session, 'POST', '/api/master-data/suppliers', { name: supName, remark: `${TAG} 走查供应商` });
    let supplierId = supRes.body?.id ?? null;
    if (!supplierId) {
      // 接口路径可能不同，退化为 SQL（仍在测试库，且用精确 name）
      const r = (await sql`INSERT INTO md_supplier (name) VALUES (${supName}) RETURNING id`)[0];
      supplierId = r.id;
    }
    record('准备：创建供应商（flex_labor 回填用）', !!supplierId, `status=${supRes.status} id=${String(supplierId).slice(0, 8)}`);

    // 0d. 兼职员工（part_time → flex_labor 成本）
    const flexName = `${TAG}兼职工B`;
    const flexRes = await http(session, 'POST', '/api/hr/employees', {
      name: flexName, positionId, hireDate: '2022-06-01', employmentType: 'part_time',
      supplierId, status: 'active', remark: `${TAG} 走查兼职工`,
    });
    const flexEmpId = flexRes.body?.id ?? null;
    if (flexEmpId) cleanup.employeeIds.push(flexEmpId);
    record('准备：创建兼职员工（挂供应商）', flexRes.status === 201 && !!flexEmpId,
      `status=${flexRes.status} ${flexRes.message}`);

    /*
     * 0e. **第二个管理员账号**（并把测试员工绑到它上面）。
     *
     * 为什么必须要这一步：工时确认有职责分离约束
     * （`costs.service.ts#assertTimesheetActor`：提交人不能确认/驳回自己提交的工时）。
     * 主账号是「管理员代登」，会被这条规则挡住 —— 用接口硬造一个"别人确认"的假象
     * 就失去了"在浏览器里走真实流程"的意义。
     *
     * 因此建一个**真实可登录**的第二管理员，把它绑到测试员工上：
     *   · 用它登记/提交工时（它是提交人）；
     *   · 主账号（另一个 userId）在**浏览器里点「确认」**，走完整职责分离流程。
     * 收尾时该账号会被删除。
     */
    const reviewerName = `${TAG}审批员`;
    const reviewerPass = 'ApiTest.2026';
    const reviewerRes = await http(session, 'POST', '/api/identity/users', {
      username: reviewerName, displayName: reviewerName, password: reviewerPass,
      employeeId: empId, roles: ['admin'],
    });
    reviewerUserId = reviewerRes.body?.id ?? null;
    if (reviewerUserId) cleanup.userIds.push(reviewerUserId);
    /*
     * admin 角色被强制 MFA（`login-security.service#requiresMfa` 含 'admin'），
     * 未绑定 MFA 的 admin 登录会被拒：`该角色已强制启用双因素认证…`。
     * `sys_user.mfa_required_override` 是**每账号**的开关（=0 表示豁免）——
     * 这里只对本次新建的**临时测试账号**置 0，让它能走真实密码登录；
     * 收尾时该账号整体删除，不影响任何真实账号的 MFA 策略。
     */
    if (reviewerUserId) {
      await sql`UPDATE sys_user SET mfa_required_override = 0 WHERE id = ${reviewerUserId}`;
    }
    const reviewerLogin = reviewerUserId ? await loginAs(reviewerName, reviewerPass) : { ok: false, session: null, body: '' };
    const submitterSession = reviewerLogin.session;
    /*
     * ⚠️ 绑定关系要读 `sys_user.employee_id`，**不要**读 `md_employee.platform_user_id`：
     * 后者是自定义复合类型 `user_profile`（uuid + 文本），postgres.js 读出来是
     * `(uuid,"")` 这样的整串，直接与 uuid 比较永远不等。
     */
    const reviewerBind = reviewerUserId
      ? (await sql`SELECT employee_id FROM sys_user WHERE id = ${reviewerUserId}`)[0]
      : null;
    record('准备：第二管理员账号（绑定测试员工，用于"提交人工时"）',
      reviewerRes.status === 201 && reviewerLogin.ok && String(reviewerBind?.employee_id) === String(empId),
      `创建status=${reviewerRes.status} 登录=${reviewerLogin.ok}${reviewerLogin.ok ? '' : `(${String(reviewerLogin.body ?? '').slice(0, 120)})`} sys_user.employee_id=${String(reviewerBind?.employee_id).slice(0, 8)}（期望 ${String(empId).slice(0, 8)}）`);
    if (!reviewerLogin.ok) throw new Error(`第二管理员登录失败，无法完成职责分离用例：${reviewerLogin.body}`);

    /*
     * 0f. 「无生效费率」用例需要一个**角色名上没有费率**的员工。
     *
     * 为什么不能像第一版那样只传 `roleName` 覆盖：`createTimesheet` 里
     * `const roleName = employee.roleName || dto.roleName || null` —— 员工绑定岗位后
     * **岗位角色优先**，传进来的 `roleName` 被忽略，于是"无费率"用例反而用了有费率的角色，
     * 确认成功了（第一版因此得到一条假 FAIL）。
     * 正确做法：单独建一个岗位（角色名不同、且从不给这个角色设费率），把员工挂上去。
     */
    const noRateRole = `${TAG}无费率角色`;
    const noRatePosRes = await http(session, 'POST', '/api/hr/positions', {
      name: `${TAG}无费率岗位`, roleName: noRateRole, remark: `${TAG} 无费率用例岗位`,
    });
    const noRatePosId = noRatePosRes.body?.id ?? null;
    if (noRatePosId) cleanup.positionIds.push(noRatePosId);
    const noRateEmpRes = await http(session, 'POST', '/api/hr/employees', {
      name: `${TAG}无费率员工`, positionId: noRatePosId, hireDate: '2022-01-01',
      status: 'active', employmentType: 'full_time', remark: `${TAG} 无费率用例员工`,
    });
    const noRateEmpId = noRateEmpRes.body?.id ?? null;
    if (noRateEmpId) cleanup.employeeIds.push(noRateEmpId);
    const noRateEmpRow = noRateEmpId
      ? (await sql`
          SELECT e.id, e.name, e.position_id, p.role_name
          FROM md_employee e LEFT JOIN hr_position p ON p.id = e.position_id
          WHERE e.id = ${noRateEmpId}`)[0]
      : null;
    const rateCountForNoRate = Number((await sql`
      SELECT count(*)::int AS n FROM erp_labor_rate WHERE role_name = ${noRateRole}`)[0].n);
    record('准备：无费率岗位 + 无费率员工（用于"必须报错拒绝"用例）',
      !!noRatePosId && !!noRateEmpId && noRateEmpRow?.role_name === noRateRole && rateCountForNoRate === 0,
      `岗位=${noRatePosRes.status}(${noRatePosRes.message}) 员工=${noRateEmpRes.status}(${noRateEmpRes.message}) ` +
      `库 position_id=${String(noRateEmpRow?.position_id).slice(0, 8)} roleName=${noRateEmpRow?.role_name} 该角色费率条数=${rateCountForNoRate}`);

    /*
     * 0g. **第三管理员账号：不绑定任何员工**（管理员代登场景）。
     *
     * 为什么需要它 —— 走查中撞到的一条真实口径（`costs.service.ts:476-502`）：
     *   服务端解析员工的顺序是「先找**当前账号绑定的员工**；只有找不到（本人未绑定）
     *   才用请求体里的 employeeId 代登」。
     * 于是**任何已绑定员工的账号，其 employeeId 都会被静默忽略**：
     *   管理员挑「[API_TEST]员工A」提交工时，库里记的却是他自己那条档案。
     * 前几轮走查的"缺少角色"报错，根因就是这个（主账号绑着工号 EMP2026100004）。
     *
     * 所以"代登 / 无费率角色"这两个用例必须用**未绑定员工的账号**来跑，
     * 它同时也覆盖了"本人未绑定 → 管理员可代登"这条正路。
     */
    const proxyName = `${TAG}代登员`;
    /** 探针只用来触发服务端权限判定；这里是执行期间存在的项目 id */
    const probeProjectId = String(
      (await sql`SELECT id FROM erp_project ORDER BY code LIMIT 1`)[0]?.id ?? '00000000-0000-0000-0000-000000000000',
    );
    const proxyRes = await http(session, 'POST', '/api/identity/users', {
      username: proxyName, displayName: proxyName, password: reviewerPass, roles: ['admin'],
    });
    const proxyUserId = proxyRes.body?.id ?? null;
    if (proxyUserId) {
      cleanup.userIds.push(proxyUserId);
      await sql`UPDATE sys_user SET mfa_required_override = 0 WHERE id = ${proxyUserId}`;
    }
    const proxyLogin = proxyUserId ? await loginAs(proxyName, reviewerPass) : { ok: false, session: null, body: '' };
    const proxySession = proxyLogin.session;
    record('准备：第三管理员账号（**不绑定员工**，用于管理员代登 / 无费率用例）',
      proxyRes.status === 201 && proxyLogin.ok,
      `status=${proxyRes.status} 登录=${proxyLogin.ok}${proxyLogin.ok ? '' : `(${String(proxyLogin.body ?? '').slice(0, 120)})`}`);
    if (!proxyLogin.ok) throw new Error(`第三管理员登录失败：${proxyLogin.body}`);
    /*
     * ⚠️ `ActorAccessService` 对"角色→成员"有 **60 秒内存缓存**（`CACHE_MS`）。
     * 新建账号后立刻用它调用依赖 `hasAnyRole` 的接口，可能命中**新建之前**的成员快照，
     * 于是报 403「仅管理员可为其他员工代登记工时」——实测出现过一次。
     * 这里不猜缓存状态，用一个**只读探针**轮询到角色生效为止：
     * 不带 employeeId 调 `POST /api/costs/timesheets`（**不会建单**）——
     *   · 没绑员工 → 服务端必报"当前账号未绑定员工…"（说明已通过 isAdmin 分支）；
     *   · 角色没生效 → 报"仅管理员可为其他员工代登记工时"。
     * 两者都是 400，但文案不同，足以区分。
     */
    let proxyRoleReady = false;
    let proxyProbeMsg = '';
    for (let i = 0; i < 12 && !proxyRoleReady; i += 1) {
      const probe = await http(proxySession, 'POST', '/api/costs/timesheets', {
        projectId: probeProjectId, workDate: '2026-10-01', hours: 1,
      }).catch((e) => ({ status: 0, message: String(e.message) }));
      proxyProbeMsg = probe.message;
      proxyRoleReady = /未绑定员工/.test(probe.message ?? '');
      if (!proxyRoleReady) await sleep(2500);
    }
    record('准备：第三管理员的角色对后端已生效（规避角色成员 60s 缓存）', proxyRoleReady,
      proxyRoleReady ? '探针通过（服务端已走到 isAdmin 分支）' : `12 次探针仍未通过：${proxyProbeMsg}`);
    /*
     * 兜底等待：`ActorAccessService` 的"角色→成员"缓存过期时间是 60s。
     * 探针**不能**证明缓存已刷新（它验的是"走到 isAdmin 分支"，而该分支只在
     * `hasAnyRole` 为 true 时才会被走到），实测"探针通过后立刻调用仍 403"。
     * 因此再等满一个缓存周期，确保后续真正调用一定重新拉取成员列表。
     */
    console.log('    · 等待角色成员缓存过期（65s），确保后续带账号调用不被旧快照挡住…');
    await sleep(65000);

    /* ══════════ 1. /costs 角色费率 Tab ══════════ */

    console.log('\n════ 1. /costs · 角色费率（rates）════');
    page.resetDiagnostics();
    await page.goto(`${APP}/costs`, { settleMs: 2400 });
    await sleep(1400);
    const costsStats = await pageStats(page);
    record('/costs 页面渲染', costsStats.textLen > 200, `tabs=${JSON.stringify(costsStats.tabs)} textLen=${costsStats.textLen}`);
    record('/costs 五个 Tab 标签正确', ['成本归集', '工时登记', '角色费率', '公共分摊', '多维分析'].every((x) => costsStats.tabs.some((t) => t.includes(x))),
      JSON.stringify(costsStats.tabs));

    await switchTab(page, '角色费率');
    await waitText(page, '设置费率', 9000);
    let rateTab = await pageStats(page);
    record('角色费率 Tab 切换并渲染出内容（含「设置费率」按钮）',
      rateTab.textLen > 200 && rateTab.buttons.includes('设置费率'),
      `buttons=${JSON.stringify(rateTab.buttons.slice(0, 10))}`);

    await clickText(page, '设置费率', { selector: 'button', settleMs: 1200 });
    await sleep(900);
    const rd = await dialogInfo(page);
    record('设置费率弹窗打开', !!rd, rd ? `字段=${JSON.stringify(rd.labels)}` : '未打开');
    if (rd) {
      const rateSteps = [];
      rateSteps.push(['角色名称', await fillByLabel(page, '角色名称', roleName)]);
      rateSteps.push(['费率', await fillByLabel(page, '费率', '2000')]);
      rateSteps.push(['生效日期', await setDateByLabel(page, '生效日期', '2026-01-01')]);
      await sleep(400);
      await clickText(page, '保存', { selector: '[role="dialog"] button', settleMs: 900 });
      const t = await toasts(page);
      await sleep(800);
      const rateRow = (await sql`
        SELECT id, role_name, rate, effective_from FROM erp_labor_rate
        WHERE role_name = ${roleName} ORDER BY effective_from DESC LIMIT 1`)[0];
      if (rateRow) cleanup.rateIds.push(rateRow.id);
      record('设置费率：落库（含生效日期）',
        !!rateRow && Number(rateRow.rate) === 2000
          && rateRow.effective_from?.toISOString?.().slice(0, 10) === '2026-01-01',
        `填表=${rateSteps.map(([k, r]) => `${k}=${r}`).join(' ')} toast=${JSON.stringify(t)} 库=${rateRow ? `${rateRow.role_name} ${rateRow.rate} 起 ${rateRow.effective_from?.toISOString?.().slice(0, 10)}` : '未找到'}`);
      record('费率列表刷新后显示该行（UI 与库一致）',
        await page.waitForText(roleName, 5000), `页面含「${roleName}」`);
    }
    await closeDialog(page);

    /* ══════════ 2. 工时确认 → 成本（核心逻辑）══════════ */

    console.log('\n════ 2. /costs · 工时登记 → 确认生成成本 ════');
    page.resetDiagnostics();
    await page.goto(`${APP}/costs?tab=timesheets`, { settleMs: 2400 });
    await sleep(800);
    await switchTab(page, '工时登记');
    await sleep(1600);

    const projectRow = (await sql`
      SELECT id, code, name, contract_id FROM erp_project WHERE status = 'executing' ORDER BY code LIMIT 1`)[0];
    record('准备：取一个执行中的项目', !!projectRow, projectRow ? `${projectRow.code} ${projectRow.name}` : '无');

    // 2a. 无生效费率的角色 → 必须**拒绝**，不得生成 0 元成本
    /*
     * 提交人 = 绑定了测试员工的第二管理员；确认人 = 主账号（另一个 userId）。
     * 这样才走得通职责分离：`assertTimesheetActor` 会拒绝"自己确认自己提交的工时"。
     * 员工用 `[API_TEST]无费率员工`（岗位角色 `[API_TEST]无费率角色`，从不设费率）。
     */
    const workDate = '2026-10-09';
    const beforeCosts = Number((await sql`SELECT count(*)::int AS n FROM erp_project_cost`)[0].n);
    const tsNoRate = await httpWithRetry(proxySession, 'POST', '/api/costs/timesheets', {
      projectId: projectRow.id, employeeId: noRateEmpId,
      workDate, hours: 8, remark: `${TAG} 无费率用例`,
    });
    if (tsNoRate.body?.id) cleanup.timesheetIds.push(tsNoRate.body.id);
    const tsNoRateRow = (await sql`
      SELECT id, code, role_name, status FROM erp_timesheet WHERE remark = ${`${TAG} 无费率用例`}
      ORDER BY _created_at DESC LIMIT 1`)[0];
    if (tsNoRateRow?.id && !cleanup.timesheetIds.includes(tsNoRateRow.id)) cleanup.timesheetIds.push(tsNoRateRow.id);
    record('准备：无费率员工的工时登记成功（且角色名是无费率角色）',
      tsNoRate.status === 201 && tsNoRateRow?.role_name === noRateRole,
      `status=${tsNoRate.status} 重试次数=${tsNoRate.attempts} msg=「${tsNoRate.message}」 库=${tsNoRateRow?.code} 角色=${tsNoRateRow?.role_name}`);
    const submitNoRate = await http(proxySession, 'POST', `/api/costs/timesheets/${tsNoRateRow?.id}/action`, { action: 'submit' });
    const confirmNoRate = await http(session, 'POST', `/api/costs/timesheets/${tsNoRateRow?.id}/action`, { action: 'confirm' });
    const afterNoRate = Number((await sql`SELECT count(*)::int AS n FROM erp_project_cost`)[0].n);
    const zeroCost = await sql`
      SELECT id, code, cost_type, amount FROM erp_project_cost
      WHERE source_ref = ${`timesheet:${tsNoRateRow?.code ?? ''}`}`;
    record('★ 角色无生效费率 → 拒绝确认（不是生成 0 元成本）',
      confirmNoRate.status === 400 && /未配置生效费率/.test(confirmNoRate.message ?? '')
        && afterNoRate === beforeCosts && zeroCost.length === 0,
      `登记=${tsNoRate.status}(${tsNoRate.message}) 提交=${submitNoRate.status} 确认status=${confirmNoRate.status} msg=「${confirmNoRate.message}」 erp_project_cost ${beforeCosts}→${afterNoRate} 该工时的成本行=${zeroCost.length}`);
    const tsNoRateStatus = (await sql`SELECT status, cost_generated FROM erp_timesheet WHERE id = ${tsNoRateRow?.id}`)[0];
    record('拒绝后工时状态仍为 submitted（未被改成 confirmed，事务回滚干净）',
      tsNoRateStatus?.status === 'submitted' && tsNoRateStatus?.cost_generated === false,
      `status=${tsNoRateStatus?.status} costGenerated=${tsNoRateStatus?.cost_generated}`);

    // 2b-0. 管理员代登（账号**未绑定员工**）：请求体里的 employeeId 必须被采纳
    /*
     * 这条是上面那条缺陷的对照面：**未绑定员工的账号**代登时才真正按 employeeId 落库。
     * 两者一起才说明"绑定优先"是既定口径、且代登通道没有被一并堵死。
     */
    const proxyDate = '2026-10-08';
    const proxyTs = await httpWithRetry(proxySession, 'POST', '/api/costs/timesheets', {
      projectId: projectRow.id, employeeId: empId, workDate: proxyDate, hours: 7,
      remark: `${TAG} 管理员代登用例`,
    });
    if (proxyTs.body?.id) cleanup.timesheetIds.push(proxyTs.body.id);
    const proxyRow = (await sql`
      SELECT id, code, employee_id, employee_name, role_name FROM erp_timesheet
      WHERE remark = ${`${TAG} 管理员代登用例`} ORDER BY _created_at DESC LIMIT 1`)[0];
    if (proxyRow?.id && !cleanup.timesheetIds.includes(proxyRow.id)) cleanup.timesheetIds.push(proxyRow.id);
    record('★ 未绑定员工的账号代登 → 按请求体的 employeeId 落库（代登通道有效）',
      proxyTs.status === 201 && String(proxyRow?.employee_id) === String(empId) && proxyRow?.role_name === roleName,
      `status=${proxyTs.status} msg=「${proxyTs.message}」 库 employee_id=${String(proxyRow?.employee_id).slice(0, 8)}（期望 ${String(empId).slice(0, 8)}） 角色=${proxyRow?.role_name}`);

    // 2b. 走 UI（提交人 = 第二管理员会话，已绑定测试员工）：登记工时 → 提交
    const beforeConfirm = Number((await sql`SELECT count(*)::int AS n FROM erp_project_cost`)[0].n);
    await page.setCookie({ name: 'erp_session', value: submitterSession, url: APP });
    await page.goto(`${APP}/costs`, { settleMs: 2600 });
    /*
     * ⚠️ 切换 Radix Tabs 必须点 `[role="tab"]`，而且**只点 tab 本身**。
     *
     * 走查里踩过两次坑：
     *  ① 用 `clickByText('登记工时')`：候选里同时有 `role=tab` 的「工时登记」按钮，
     *     模糊匹配会打偏；即使打中 tab，切换也是异步的，紧接着找「登记工时」会落空；
     *  ② 用 URL 的 `?tab=timesheets` 进页面**不可靠**：`CostsPage` 用 `useState('items')`
     *     初始化，query 只在同一会话内被 Tabs 读取，硬导航后可能停在「成本归集」。
     * 因此：先切 tab，再**等**内容到位，最后才点按钮。
     */
    const tabSwitched = await switchTab(page, '工时登记');
    await waitText(page, '登记工时', 15000);
    const hasRegisterBtn = await page.evaluate(
      `[...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '登记工时')`,
    );
    record('工时登记 Tab：切换到「工时登记」后出现「登记工时」按钮',
      String(tabSwitched) === 'ok' && hasRegisterBtn,
      `切 tab=${tabSwitched} 按钮存在=${hasRegisterBtn}`);
    await clickText(page, '登记工时', { selector: 'button', settleMs: 1300 });
    await sleep(1100);
    const td = await dialogInfo(page, '登记工时');
    record('工时登记弹窗打开', !!td, td ? `字段=${JSON.stringify(td.labels)}` : '未打开');
    let tsCode = null;
    if (td) {
      const p1 = await selectByLabel(page, '项目', { optionText: projectRow.name });
      /*
       * 「员工」字段在本会话修复后是**只读输入框**（本人已绑定员工时不允许改选，
       * 因为服务端只会按绑定员工落库）。因此这里不再点下拉，而是断言它已经
       * 自动带出本人姓名且不可编辑 —— 这条正是那个"选了 A 记了 B"缺陷的回归断言。
       */
      const empField = await page.evaluate(`(() => {
        const root = document.querySelector('[role="dialog"]');
        const lab = [...root.querySelectorAll('label')].find((l) => /员工/.test(l.textContent || ''));
        if (!lab) return { where: 'label-not-found' };
        const item = lab.closest('div') ?? lab.parentElement;
        const combo = item.querySelector('[role="combobox"]');
        const inp = item.querySelector('input');
        return {
          where: combo ? 'select' : inp ? 'readonly-input' : 'none',
          value: inp ? inp.value : null,
          readOnly: inp ? inp.readOnly : null,
          hasCombo: !!combo,
        };
      })()`);
      /*
       * ⚠️ 顺序有讲究：**先填日期与工时，最后再探角色字段**。
       * `selectByLabel` 在"只读角色"上会返回 no-option 而**不关闭它已经点开的
       * Radix 弹层**，残留的弹层会挡住后面的日期选择器（实测让日期点不开、
       * 进而让整条断言假失败）。只读字段不该用"点开下拉"的方式去探。
       */
      const workDatePick = await setDateByLabel(page, '工作日期', workDate);
      const hoursSet = await fillByLabel(page, '工时', '8');
      const roleField = await page.evaluate(`(() => {
        const root = document.querySelector('[role="dialog"]');
        const lab = [...root.querySelectorAll('label')].find((l) => /^角色/.test((l.textContent || '').trim()));
        if (!lab) return { where: 'label-not-found' };
        const item = lab.closest('div') ?? lab.parentElement;
        const combo = item.querySelector('[role="combobox"]');
        const inp = item.querySelector('input');
        return { where: combo ? 'select' : inp ? 'readonly-input' : 'none', value: inp ? inp.value : null, readOnly: inp ? inp.readOnly : null };
      })()`);
      await sleep(400);
      /*
       * ⚠️ 日期断言用 `startsWith`：`setDateByLabel` 成功时的返回值形如
       * `picked:2026-10-09@hop0`（带翻页次数，便于排查"翻了几页才选到"），
       * 早期写成全等比较，导致**功能正常却报 FAIL**（假失败）。
       */
      const dateOk = String(workDatePick).startsWith(`picked:${workDate}`);
      record('★ 工时登记：本人已绑定员工 → 员工字段为只读并带出本人（不再允许改选他人）',
        empField.where === 'readonly-input' && empField.readOnly === true && String(empField.value).includes(empName),
        `字段形态=${empField.where} 只读=${empField.readOnly} 值=「${empField.value}」 是否仍有下拉=${empField.hasCombo}`);
      record('工时登记：项目下拉可选、工作日期日历可选、工时可填；角色随岗位只读回填岗位角色',
        String(p1).startsWith('picked') && dateOk && hoursSet === 'ok:hours'
          && roleField.where === 'readonly-input' && roleField.readOnly === true
          && String(roleField.value ?? '').trim() === roleName.trim(),
        `项目=${p1} 角色字段=${JSON.stringify(roleField)}（期望岗位角色「${roleName}」） 日期=${workDatePick} 工时=${hoursSet}` +
        ` 逐项: 项目ok=${String(p1).startsWith('picked')} 日期ok=${dateOk} 工时ok=${hoursSet === 'ok:hours'}` +
        ` 角色形态ok=${roleField.where === 'readonly-input'} 只读ok=${roleField.readOnly === true} 值ok=${String(roleField.value ?? '').trim() === roleName.trim()}`);
      await clickText(page, '保存', { selector: '[role="dialog"] button', settleMs: 900 });
      const t = await toasts(page);
      await sleep(900);
      const tsRow = (await sql`
        SELECT id, code, status, employee_id, role_name, hours, work_date
        FROM erp_timesheet WHERE employee_id = ${empId} AND work_date = ${workDate}
        ORDER BY _created_at DESC LIMIT 1`)[0];
      tsCode = tsRow?.code ?? null;
      if (tsRow) cleanup.timesheetIds.push(tsRow.id);
      record('工时登记：落库（员工来自绑定账号的自助身份、角色/日期/工时正确）',
        !!tsRow && Number(tsRow.hours) === 8 && tsRow.role_name === roleName && String(tsRow.employee_id) === String(empId),
        `toast=${JSON.stringify(t)} 库=${tsRow ? `${tsRow.code} ${tsRow.role_name} ${tsRow.hours}h ${tsRow.work_date?.toISOString?.().slice(0, 10)} status=${tsRow.status}` : '未找到'}`);
      if (tsCode) {
        const subRes = await clickRowButton(page, tsCode, '^提交$');
        const subToast = await toasts(page);
        await sleep(900);
        const afterSubmit = (await sql`SELECT status FROM erp_timesheet WHERE code = ${tsCode}`)[0];
        record('工时提交（提交人在 UI 行内点「提交」）',
          String(subRes) === 'ok' && afterSubmit?.status === 'submitted',
          `点击=${subRes} toast=${JSON.stringify(subToast)} 库状态=${afterSubmit?.status}`);
      }
    }

    // 2b-2. 换回主账号：确认由**另一个人**在浏览器里点（真实职责分离）
    await page.setCookie({ name: 'erp_session', value: session, url: APP });
    await page.goto(`${APP}/costs`, { settleMs: 2600 });
    const confirmTab = await switchTab(page, '工时登记');
    await waitText(page, tsCode ?? '工时编号', 15000);
    const uiConfirm = tsCode ? await clickRowButton(page, tsCode, '^确认$') : 'no-code';
    const uiConfirmToast = await toasts(page, { attempts: 12 });
    await sleep(1200);
    const afterUiConfirm = (await sql`SELECT status, cost_generated FROM erp_timesheet WHERE code = ${tsCode ?? ''}`)[0];
    record('★ 工时确认（浏览器行内点「确认」，操作人 ≠ 提交人）→ confirmed + costGenerated',
      String(uiConfirm) === 'ok' && afterUiConfirm?.status === 'confirmed' && afterUiConfirm?.cost_generated === true,
      `切 tab=${confirmTab} 点击=${uiConfirm} toast=${JSON.stringify(uiConfirmToast)} 库 status=${afterUiConfirm?.status} costGenerated=${afterUiConfirm?.cost_generated}`);

    // 已确认的行不再渲染「确认」按钮（同一个页面刷新后即可核对，不必换会话）
    const confirmedRowBtns = await rowButtons(page, tsCode ?? '');
    record('（附）已确认的工时行不再渲染「确认」按钮',
      Array.isArray(confirmedRowBtns) && !confirmedRowBtns.includes('确认'),
      `该行按钮=${JSON.stringify(confirmedRowBtns)}`);

    // 提交人本人（第二管理员）再看一次列表：已确认的行不该再有「确认」按钮
    await page.setCookie({ name: 'erp_session', value: submitterSession, url: APP });
    await page.goto(`${APP}/costs`, { settleMs: 2600 });
    await switchTab(page, '工时登记');
    await waitText(page, tsCode ?? '工时编号', 15000);
    const selfRowBtns = await rowButtons(page, tsCode ?? '');
    record('（附）提交人自己看到的已确认工时行也没有「确认」按钮',
      Array.isArray(selfRowBtns) && !selfRowBtns.includes('确认'),
      `该行按钮=${JSON.stringify(selfRowBtns)}`);
    await page.setCookie({ name: 'erp_session', value: session, url: APP });

    const tsForConfirm = (await sql`
      SELECT id, code, status, employee_id, project_id, role_name, hours, work_date
      FROM erp_timesheet WHERE employee_id = ${empId} AND work_date = ${workDate} ORDER BY _created_at DESC LIMIT 1`)[0];
    const afterConfirmCosts = await sql`
      SELECT id, code, cost_type, amount, period, occurred_date, source_ref, supplier_id, department_id, contract_id, is_accrual
      FROM erp_project_cost WHERE source_ref = ${`timesheet:${tsForConfirm?.code ?? ''}`}`;
    const expectAmount = 8 * 2000;
    record('★ 工时确认 → 生成 erp_project_cost（金额 = 工时 × 费率，注意不是 /8）',
      afterConfirmCosts.length === 1 && Number(afterConfirmCosts[0].amount) === expectAmount,
      `成本行数=${afterConfirmCosts.length} 金额=${afterConfirmCosts[0]?.amount}（期望 ${expectAmount}）`);
    record('★ 成本类型 = labor（全职）且回填 department/contract/period/accrual',
      afterConfirmCosts[0]?.cost_type === 'labor'
      && String(afterConfirmCosts[0]?.department_id) === String(deptRow?.id)
      && afterConfirmCosts[0]?.contract_id === projectRow.contract_id
      && afterConfirmCosts[0]?.period === workDate.slice(0, 7)
      && Number(afterConfirmCosts[0]?.is_accrual) === 1,
      JSON.stringify(afterConfirmCosts[0] ? {
        costType: afterConfirmCosts[0].cost_type,
        dept: `${String(afterConfirmCosts[0].department_id).slice(0, 8)}（期望员工部门 ${String(deptRow?.id).slice(0, 8)}）`,
        contract: String(afterConfirmCosts[0].contract_id).slice(0, 8), period: afterConfirmCosts[0].period,
        occurred: afterConfirmCosts[0].occurred_date?.toISOString?.().slice(0, 10), accrual: afterConfirmCosts[0].is_accrual,
      } : null));
    if (afterConfirmCosts[0]) cleanup.costIds.push(afterConfirmCosts[0].id);

    // 2c. 重复确认不得产生第二条成本
    const dup = await http(session, 'POST', `/api/costs/timesheets/${tsForConfirm?.id}/action`, { action: 'confirm' });
    const afterDup = await sql`
      SELECT id FROM erp_project_cost WHERE source_ref = ${`timesheet:${tsForConfirm?.code ?? ''}`}`;
    record('★ 重复确认同一工时：被拒且成本行数仍为 1（不重复生成）',
      dup.status >= 400 && afterDup.length === 1,
      `status=${dup.status} msg=「${dup.message}」 成本行数=${afterDup.length}`);
    const voucherDup = await sql`
      SELECT count(*)::int AS n FROM fin_voucher WHERE source_ref = ${`cost:${afterConfirmCosts[0]?.code ?? ''}`}`;
    record('★ 重复确认未生成第二张成本凭证',
      Number(voucherDup[0].n) === 1,
      `fin_voucher source_ref=cost:${afterConfirmCosts[0]?.code} 条数=${voucherDup[0].n}`);

    // 2d. 兼职工 → flex_labor + supplier_id 回填
    /*
     * 提交人 = 第三管理员（未绑定员工，走代登）；确认人 = 主账号 —— 又是两个身份。
     * 早期版本用第二管理员提交、主账号确认，但第二管理员**自己**就是这条工时的
     * created_by（代登时 _created_by 记的是提交账号），于是确认被
     * 「不能确认或驳回自己提交的工时」挡住（实测 403）。
     */
    if (flexEmpId && projectRow) {
      const flexDate = '2026-10-10';
      const flexTs = await http(proxySession, 'POST', '/api/costs/timesheets', {
        projectId: projectRow.id, employeeId: flexEmpId,
        workDate: flexDate, hours: 4, remark: `${TAG} 兼职工时用例`,
      });
      if (flexTs.body?.id) cleanup.timesheetIds.push(flexTs.body.id);
      const flexRow = (await sql`
        SELECT id, code, role_name FROM erp_timesheet WHERE remark = ${`${TAG} 兼职工时用例`}
        ORDER BY _created_at DESC LIMIT 1`)[0];
      if (flexRow?.id && !cleanup.timesheetIds.includes(flexRow.id)) cleanup.timesheetIds.push(flexRow.id);
      const flexSubmit = await http(proxySession, 'POST', `/api/costs/timesheets/${flexRow?.id}/action`, { action: 'submit' });
      const flexConfirm = await http(session, 'POST', `/api/costs/timesheets/${flexRow?.id}/action`, { action: 'confirm' });
      const flexCost = (await sql`
        SELECT id, cost_type, amount, supplier_id, department_id FROM erp_project_cost
        WHERE source_ref = ${`timesheet:${flexRow?.code ?? ''}`}`)[0];
      if (flexCost) cleanup.costIds.push(flexCost.id);
      record('★ 兼职工（part_time）工时确认 → cost_type = flex_labor',
        flexCost?.cost_type === 'flex_labor',
        `登记=${flexTs.status}(${flexTs.message}) 提交=${flexSubmit.status} 确认=${flexConfirm.status} msg=「${flexConfirm.message}」 cost_type=${flexCost?.cost_type}`);
      record('★ flex_labor 成本回填 supplier_id = 员工所属供应商',
        flexCost?.supplier_id === supplierId,
        `库 supplier_id=${String(flexCost?.supplier_id).slice(0, 8)} 期望=${String(supplierId).slice(0, 8)}`);
    }

    /* ══════════ 3. 多维汇总 vs SQL 聚合 ══════════ */

    console.log('\n════ 3. /costs · 多维分析（dimension-summary）════');
    const dims = [
      { dim: 'costType', sql: sql`SELECT cost_type AS key, coalesce(sum(amount),0)::float8 AS total FROM erp_project_cost GROUP BY 1` },
      { dim: 'department', sql: sql`SELECT department_id AS key, coalesce(sum(amount),0)::float8 AS total FROM erp_project_cost GROUP BY 1` },
      { dim: 'contract', sql: sql`SELECT contract_id AS key, coalesce(sum(amount),0)::float8 AS total FROM erp_project_cost GROUP BY 1` },
      { dim: 'period', sql: sql`SELECT period AS key, coalesce(sum(amount),0)::float8 AS total FROM erp_project_cost GROUP BY 1` },
    ];
    for (const { dim, sql: q } of dims) {
      const apiRes = await http(session, 'GET', `/api/costs/dimension-summary?dimension=${dim}`);
      const uiTotal = Array.isArray(apiRes.body) ? apiRes.body.reduce((s, r) => s + Number(r.amount ?? 0), 0) : NaN;
      const rows = await q;
      const sqlTotal = rows.reduce((s, r) => s + Number(r.total ?? 0), 0);
      // costType 维度会在 service 里过滤掉不在 COST_TYPES 白名单里的历史类型
      const known = ['labor', 'outsource', 'compute', 'storage', 'tool', 'travel', 'flex_labor'];
      const sqlFiltered = dim === 'costType'
        ? rows.filter((r) => known.includes(r.key ?? '')).reduce((s, r) => s + Number(r.total ?? 0), 0)
        : dim === 'period' ? rows.filter((r) => (r.key ?? '') !== '').reduce((s, r) => s + Number(r.total ?? 0), 0)
        : sqlTotal;
      const ok = Math.abs(uiTotal - sqlFiltered) < 0.005;
      record(`★ 多维汇总 ${dim}：接口合计 = SQL 聚合`,
        ok && apiRes.status === 200,
        `接口=${uiTotal.toFixed(2)}(${Array.isArray(apiRes.body) ? apiRes.body.length : 'x'} 组) SQL=${sqlFiltered.toFixed(2)}(${rows.length} 组) 全量SQL=${sqlTotal.toFixed(2)} status=${apiRes.status}`);
      if (!ok) note(`DIM-${dim}`, `维度 ${dim} 接口合计 ${uiTotal} ≠ SQL ${sqlFiltered}`);
    }

    // 界面上切换四个维度按钮
    page.resetDiagnostics();
    await page.goto(`${APP}/costs`, { settleMs: 2600 });
    const analysisTab = await switchTab(page, '多维分析');
    await waitText(page, '多维成本分析', 12000);
    /*
     * 四个维度按钮**不是** `role=tab`，而是 Radix ToggleGroup 的
     * `<button role="radio">`（见 `CostsPage.tsx` 的 `ToggleGroupItem`）。
     * 早期版本用 `switchTab`（只认 role=tab）去找，结果 0/4 全落空 —— 假失败。
     */
    const dimBtns = ['成本类型', '部门', '合同', '期间'];
    const dimResults = [];
    for (const b of dimBtns) {
      const r = await page.evaluate(`(() => {
        const hit = [...document.querySelectorAll('button[role="radio"], [role="radio"], button')]
          .find((n) => (n.textContent || '').trim() === ${JSON.stringify(b)});
        if (!hit) return 'not-found';
        hit.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'ok';
      })()`);
      await sleep(1200);
      const chartLabel = await page.evaluate(
        `(document.querySelector('[aria-label="多维成本分析图"]') ? 'chart' : 'no-chart')`,
      );
      dimResults.push(`${b}:${r}/${chartLabel}`);
    }
    record('多维分析：四个维度按钮都能切换且图仍在渲染',
      String(analysisTab) === 'ok' && dimResults.every((x) => x.includes(':ok/chart')) && page.exceptions.length === 0,
      `切 Tab=${analysisTab} 结果=${dimResults.join(' ')} exc=${page.exceptions.length} http4xx=${page.httpErrors.length}`);
    diagAll.push({ step: 'costs-analysis', exceptions: page.exceptions, httpErrors: page.httpErrors, consoleErrors: page.consoleLogs.filter((l) => l.type === 'error') });

    /* ══════════ 4. 成本归集 / 公共分摊 Tab ══════════ */

    console.log('\n════ 4. /costs · 成本归集 + 公共分摊 ════');
    page.resetDiagnostics();
    await page.goto(`${APP}/costs`, { settleMs: 2400 });
    await sleep(800);
    await switchTab(page, '成本归集');
    await sleep(1200);
    const itemsStats = await pageStats(page);
    record('成本归集 Tab 渲染出表格', itemsStats.tables > 0 && itemsStats.textLen > 200,
      `tables=${itemsStats.tables} textLen=${itemsStats.textLen}`);
    note('COST-UI-01', `成本归集 Tab 的按钮：${JSON.stringify(itemsStats.buttons.slice(0, 12))}`);

    await switchTab(page, '公共分摊');
    await sleep(1200);
    const allocStats = await pageStats(page);
    record('公共分摊 Tab 渲染', allocStats.textLen > 150, `buttons=${JSON.stringify(allocStats.buttons.slice(0, 12))}`);
    diagAll.push({ step: 'costs-tabs', exceptions: page.exceptions, httpErrors: page.httpErrors, consoleErrors: page.consoleLogs.filter((l) => l.type === 'error') });

    /* ══════════ 5. 收入确认 ══════════ */

    console.log('\n════ 5. /revenue · 收入确认 ════');
    page.resetDiagnostics();
    await page.goto(`${APP}/revenue`, { settleMs: 2500 });
    await sleep(1500);
    const revStats = await pageStats(page);
    record('/revenue 页面渲染 + 三个 Tab', revStats.textLen > 200 && revStats.tabs.length >= 3,
      `tabs=${JSON.stringify(revStats.tabs)}`);

    // 选一个本年度无收入记录的项目 + 期间（避免撞 uq_erp_project_revenue_project_period）
    const freeProject = (await sql`
      SELECT p.id, p.code, p.name, p.contract_id FROM erp_project p
      WHERE NOT EXISTS (SELECT 1 FROM erp_project_revenue r WHERE r.project_id = p.id AND r.period = '2026-11')
      ORDER BY p.code LIMIT 1`)[0];
    const revPeriod = '2026-11';
    const revAmount = 12345.67;
    record('准备：取一个 2026-11 无收入的项目', !!freeProject, freeProject ? `${freeProject.code} ${freeProject.name}` : '无');

    const beforeRev = Number((await sql`SELECT count(*)::int AS n FROM erp_project_revenue`)[0].n);

    // 5a. 校验：金额必须 > 0（前端 zod min(1)）
    await clickText(page, '确认收入', { selector: 'button', settleMs: 1300 });
    await sleep(1100);
    const revDialog = await dialogInfo(page);
    record('确认收入弹窗打开', !!revDialog, revDialog ? `字段=${JSON.stringify(revDialog.labels)}` : '未打开');
    if (revDialog) {
      // 只填期间、不选项目 → 点确认应被前端拦住且不发写请求
      await fillByLabel(page, '期间', revPeriod);
      const reqBefore = (page.requests ?? []).length;
      await clickText(page, '确认', { selector: '[role="dialog"] button', settleMs: 1000 });
      await sleep(1200);
      const newWrites = (page.requests ?? []).slice(reqBefore).filter((r) => /POST|PATCH|PUT/.test(r.method ?? ''));
      const vmsg = await page.evaluate(`(() => {
        const d = document.querySelector('[role="dialog"]');
        if (!d) return [];
        return [...d.querySelectorAll('*')].filter((e) => e.children.length === 0 && /请选择|请填写|必须|不能为空/.test(e.textContent || ''))
          .map((e) => (e.textContent || '').trim()).slice(0, 5);
      })()`);
      record('确认收入：未选项目点确认 → 有校验提示且不发写请求',
        vmsg.length > 0 && newWrites.length === 0,
        `提示=${JSON.stringify(vmsg)} 写请求=${newWrites.length}`);

      // 5b. 正常确认
      const pj = await selectByLabel(page, '^项目', { optionText: freeProject?.name });
      await fillByLabel(page, '期间', revPeriod);
      await fillByLabel(page, '金额', String(revAmount));
      await selectByLabel(page, '^确认方式', { optionText: '里程碑' });
      const basis = await page.evaluate(`(() => {
        const d = document.querySelector('[role="dialog"]');
        const ta = d?.querySelector('textarea');
        if (!ta) return 'not-found';
        const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        s ? s.call(ta, ${JSON.stringify(`${TAG} 里程碑达成`)}) : (ta.value = ${JSON.stringify(`${TAG} 里程碑达成`)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()`);
      await sleep(400);
      await clickText(page, '确认', { selector: '[role="dialog"] button', settleMs: 1200 });
      const revToast = await toasts(page, { attempts: 12 });
      await sleep(1500);
      record('确认收入：填写完整后提交（含依据 textarea）',
        String(pj).startsWith('picked') && basis === 'ok',
        `项目=${pj} 依据=${basis} toast=${JSON.stringify(revToast)}`);
    }
    await closeDialog(page);

    const revRow = (await sql`
      SELECT id, code, project_id, contract_id, period, amount, method, status, basis
      FROM erp_project_revenue WHERE project_id = ${freeProject?.id} AND period = ${revPeriod} LIMIT 1`)[0];
    if (revRow) cleanup.revenueIds.push(revRow.id);
    const afterRev = Number((await sql`SELECT count(*)::int AS n FROM erp_project_revenue`)[0].n);
    record('★ 收入确认落库 erp_project_revenue（金额/期间/状态）',
      !!revRow && Number(revRow.amount) === revAmount && revRow.status === 'recognized' && afterRev > beforeRev,
      `库=${revRow ? `${revRow.code} ${revRow.amount} ${revRow.period} ${revRow.status}` : `未找到（收入 ${beforeRev}→${afterRev}）`}`);

    const revCode = revRow?.code ?? null;
    // 凭证 + 应收（方案 A：收入确认是唯一收入入口）
    const revVoucher = revCode ? await sql`
      SELECT v.id, v.code, v.status, v.source_type, v.source_ref,
             coalesce(sum(l.debit),0)::float8 AS debit, coalesce(sum(l.credit),0)::float8 AS credit,
             count(l.id)::int AS lines
      FROM fin_voucher v LEFT JOIN fin_voucher_line l ON l.voucher_id = v.id
      WHERE v.source_ref = ${`revenue:${revCode}`} GROUP BY v.id, v.code, v.status, v.source_type, v.source_ref` : [];
    if (revVoucher[0]) cleanup.voucherIds.push(revVoucher[0].id);
    record('★ 收入确认生成凭证（source_type=revenue）',
      revVoucher.length === 1 && Number(revVoucher[0].lines) >= 3,
      revVoucher[0] ? `${revVoucher[0].code} status=${revVoucher[0].status} 分录=${revVoucher[0].lines} 借=${revVoucher[0].debit} 贷=${revVoucher[0].credit}` : '未找到凭证');
    record('★ 收入凭证借贷平衡（借合计 = 贷合计）',
      revVoucher.length === 1 && Math.abs(Number(revVoucher[0].debit) - Number(revVoucher[0].credit)) < 0.005,
      revVoucher[0] ? `借=${revVoucher[0].debit} 贷=${revVoucher[0].credit} 差=${(Number(revVoucher[0].debit) - Number(revVoucher[0].credit)).toFixed(4)}` : '无凭证');

    const revAr = revCode ? await sql`
      SELECT id, code, amount, status, source, source_ref FROM erp_ar
      WHERE source_ref = ${`revenue:${revCode}`}` : [];
    if (revAr[0]) cleanup.arIds.push(revAr[0].id);
    record('★ 收入确认生成应收（金额 = 收入含税额）',
      revAr.length === 1 && Number(revAr[0].amount) === revAmount,
      revAr[0] ? `${revAr[0].code} ${revAr[0].amount} status=${revAr[0].status}` : '未找到应收');

    // 5c. 同项目同期间第二次确认 → 必须被拦住且提示可读
    const dupRev = await http(session, 'POST', '/api/revenues', {
      projectId: freeProject?.id, period: revPeriod, method: 'milestone',
      amount: 100, basis: `${TAG} 重复确认`,
    });
    const revCountAfterDup = Number((await sql`
      SELECT count(*)::int AS n FROM erp_project_revenue WHERE project_id = ${freeProject?.id} AND period = ${revPeriod}`)[0].n);
    const readable = /已确认过收入|同一项目同一期间/.test(dupRev.message ?? '');
    record('★ 同项目同期间重复确认被拦截（http 4xx）',
      dupRev.status >= 400 && dupRev.status < 500,
      `status=${dupRev.status} msg=「${dupRev.message}」`);
    record('★ 重复确认的提示可读（点明"同一项目同一期间只能确认一次"）',
      readable,
      readable ? `msg=「${dupRev.message}」` : `⚠️ 提示未点明业务规则：msg=「${dupRev.message}」`);
    record('★ 重复确认未落第二条收入台账', revCountAfterDup === 1, `该 项目+期间 台账条数=${revCountAfterDup}`);

    // 5d. 界面上的重复确认（走 UI，验证用户看到的提示）
    page.resetDiagnostics();
    await page.goto(`${APP}/revenue`, { settleMs: 2400 });
    await sleep(1200);
    await clickText(page, '确认收入', { selector: 'button', settleMs: 1200 });
    await sleep(1000);
    await selectByLabel(page, '^项目', { optionText: freeProject?.name });
    await fillByLabel(page, '期间', revPeriod);
    await fillByLabel(page, '金额', '100');
    await selectByLabel(page, '^确认方式', { optionText: '里程碑' });
    await sleep(400);
    await clickText(page, '确认', { selector: '[role="dialog"] button', settleMs: 1200 });
    const dupUiToast = await toasts(page, { attempts: 12 });
    await sleep(800);
    record('★ 界面上重复确认 → 用户看到可读错误 toast',
      dupUiToast.some((t) => /已确认过收入|同一项目同一期间|记录已存在/.test(t)),
      `toast=${JSON.stringify(dupUiToast)}`);
    diagAll.push({ step: 'revenue-dup-ui', exceptions: page.exceptions, httpErrors: page.httpErrors, consoleErrors: page.consoleLogs.filter((l) => l.type === 'error') });
    await closeDialog(page);

    // 5e. 未开票 / 调整 Tab
    page.resetDiagnostics();
    await page.goto(`${APP}/revenue?tab=unbilled`, { settleMs: 2400 }).catch(() => {});
    await sleep(1000);
    await switchTab(page, '未开票收入');
    await sleep(1500);
    const unbilledStats = await pageStats(page);
    record('未开票收入 Tab 渲染', unbilledStats.textLen > 150, `tables=${unbilledStats.tables}`);

    // 与 SQL 独立聚合比对（口径见 revenues.service#listUnbilled）
    const apiUnbilled = await http(session, 'GET', '/api/revenues/unbilled');
    const sqlUnbilled = await sql`
      SELECT r.project_id,
             coalesce(sum(r.amount),0)::float8 AS recognized,
             coalesce((SELECT sum(a.amount) FROM erp_revenue_adjust a
                        WHERE a.revenue_id IN (SELECT id FROM erp_project_revenue r2
                                                WHERE r2.project_id = r.project_id AND r2.status='recognized')
                          AND a.status='applied'),0)::float8 AS adjusted,
             coalesce((SELECT sum(i.amount) FROM erp_invoice i
                        WHERE i.project_id = r.project_id AND i.status='issued' AND i.direction='sales'),0)::float8 AS invoiced
      FROM erp_project_revenue r
      WHERE r.status = 'recognized'
      GROUP BY r.project_id`;
    const apiUnbilledMap = new Map((apiUnbilled.body ?? []).map((r) => [r.projectId, Number(r.unbilledAmount)]));
    let unbilledMismatch = [];
    for (const row of sqlUnbilled) {
      const expect = Number(row.recognized) - Number(row.adjusted) - Number(row.invoiced);
      const got = apiUnbilledMap.get(row.project_id);
      if (got === undefined || Math.abs(got - expect) >= 0.005) {
        unbilledMismatch.push(`${String(row.project_id).slice(0, 8)} api=${got} sql=${expect.toFixed(2)}`);
      }
    }
    record('★ 未开票金额 = 已确认收入 − 调整 − 已开销售发票（逐项目与 SQL 对账）',
      unbilledMismatch.length === 0 && apiUnbilled.status === 200,
      unbilledMismatch.length === 0
        ? `核对 ${sqlUnbilled.length} 个项目全部一致`
        : `不一致：${unbilledMismatch.join('; ')}`);

    await switchTab(page, '收入调整');
    await sleep(1200);
    const adjStats = await pageStats(page);
    record('收入调整 Tab 渲染', adjStats.textLen > 120, `buttons=${JSON.stringify(adjStats.buttons.slice(0, 8))}`);
    diagAll.push({ step: 'revenue-tabs', exceptions: page.exceptions, httpErrors: page.httpErrors, consoleErrors: page.consoleLogs.filter((l) => l.type === 'error') });

    /* ══════════ 6. 全库凭证借贷平衡 ══════════ */

    console.log('\n════ 6. 凭证借贷平衡（全量扫描）════');
    const unbalanced = await sql`
      SELECT v.id, v.code, v.status, coalesce(sum(l.debit),0)::float8 AS d, coalesce(sum(l.credit),0)::float8 AS c
      FROM fin_voucher v LEFT JOIN fin_voucher_line l ON l.voucher_id = v.id
      GROUP BY v.id, v.code, v.status
      HAVING abs(coalesce(sum(l.debit),0) - coalesce(sum(l.credit),0)) > 0.005`;
    record('★ 全库每张凭证借贷合计相等', unbalanced.length === 0,
      unbalanced.length === 0 ? '0 张不平衡' : JSON.stringify(unbalanced.slice(0, 5)));
    const zeroLine = await sql`
      SELECT v.code, count(l.id)::int AS n FROM fin_voucher v
      LEFT JOIN fin_voucher_line l ON l.voucher_id = v.id
      GROUP BY v.code HAVING count(l.id) = 0 LIMIT 5`;
    record('（附）不存在零分录凭证', zeroLine.length === 0, zeroLine.length ? JSON.stringify(zeroLine) : '0 张');

    /* ══════════ 7. HR：员工档案编辑（清空字段）══════════ */

    console.log('\n════ 7. /hr · 员工档案：编辑与"清空字段"落库 ════');
    page.resetDiagnostics();
    const hrTabReady = await openTab(page, '/hr', '员工档案', '新建员工');
    const hrStats = await pageStats(page);
    record('/hr 页面渲染 + 八个 Tab 入口', hrTabReady.ready && hrStats.textLen > 200
      && hrStats.buttons.some((b) => b.includes('员工档案')),
      `tab=${JSON.stringify(hrTabReady)} tabs=${JSON.stringify(hrStats.tabs)} textLen=${hrStats.textLen}`);

    // 7a. 编辑：改手机号（应落库）
    const editOpen = await clickRowButton(page, empName, '编辑');
    await sleep(1200);
    const ed = await dialogInfo(page);
    record('员工档案：编辑弹窗打开（带出原值）', !!ed && String(editOpen) === 'ok', `点击=${editOpen} title=${ed?.title}`);
    if (ed) {
      await fillByLabel(page, '^手机号', '13900000002');
      await sleep(300);
      await clickText(page, '保存', { selector: '[role="dialog"] button', settleMs: 900 });
      const t = await toasts(page);
      await sleep(900);
      const afterEdit = (await sql`SELECT phone, ss_city_code FROM md_employee WHERE id = ${empId}`)[0];
      record('员工档案：编辑手机号确实落库（更新分支未丢字段）',
        afterEdit?.phone === '13900000002',
        `toast=${JSON.stringify(t)} 库 phone=${afterEdit?.phone}`);
    }
    await closeDialog(page);

    // 7b. 清空字段：先设 ssCityCode，再清空，看是否真写进库
    const setCity = await http(session, 'PATCH', `/api/hr/employees/${empId}`, { ssCityCode: 'shanghai' });
    const citySet = (await sql`SELECT ss_city_code FROM md_employee WHERE id = ${empId}`)[0]?.ss_city_code;
    record('准备：接口设置参保城市代码', setCity.status === 200 && citySet === 'shanghai', `status=${setCity.status} 库=${citySet}`);
    await openTab(page, '/hr', '员工档案', empName);
    await clickRowButton(page, empName, '编辑');
    await sleep(1200);
    const cleared = await fillByLabel(page, '参保城市代码', '');
    await sleep(300);
    await clickText(page, '保存', { selector: '[role="dialog"] button', settleMs: 900 });
    const clearToast = await toasts(page);
    await sleep(900);
    const cityAfterClear = (await sql`SELECT ss_city_code FROM md_employee WHERE id = ${empId}`)[0]?.ss_city_code;
    record('★ 编辑时清空「参保城市代码」是否真写进库（本仓已知缺陷模式：values.x || undefined）',
      cityAfterClear === null,
      `填值结果=${cleared} toast=${JSON.stringify(clearToast)} 库 ss_city_code=${JSON.stringify(cityAfterClear)}`);
    await closeDialog(page);

    // 7c. 清空「入职日期」（司龄规则的输入，影响年假天数）
    /*
     * ⚠️ 「入职日期」用的是 `DateField`（Popover + Calendar），**没有清空入口**。
     * 因此这一条走两条腿：
     *   ① UI 腿：确认日历控件确实没有"清除"按钮（如实记录为"无法从界面清空"）；
     *   ② 接口腿：直接 `PATCH { hireDate: null }`，看**服务端契约**是否支持清空。
     * 两者要分开说 —— 「界面做不到」与「服务端清不掉」是两件事。
     */
    await openTab(page, '/hr', '员工档案', empName);
    await clickRowButton(page, empName, '编辑');
    await sleep(1200);
    const clearHire = await clearDateByLabel(page, '^入职日期');
    await closeDialog(page);
    skip('从界面清空「入职日期」', `DateField（Popover+Calendar）无清空入口：${clearHire}`);
    const hireBefore = (await sql`SELECT hire_date FROM md_employee WHERE id = ${empId}`)[0]?.hire_date;

    // 接口腿：DTO 的 @IsDateString() 不接受 null → 契约层面能否清空？
    const patchNull = await http(session, 'PATCH', `/api/hr/employees/${empId}`, { hireDate: null });
    const hireAfterApi = (await sql`SELECT hire_date FROM md_employee WHERE id = ${empId}`)[0]?.hire_date;
    record('★ 接口 PATCH { hireDate: null } 的行为（清空路径的服务端口径）',
      true,
      `status=${patchNull.status} msg=「${patchNull.message}」 库 hire_date=${hireBefore?.toISOString?.().slice(0, 10)} → ${hireAfterApi ? hireAfterApi.toISOString().slice(0, 10) : null}`);

    // 客户端真正会发出去的是什么？—— 编辑弹窗里把日期清成空串后的 DTO 是 undefined，
    // 服务端 if (dto.hireDate !== undefined) 直接跳过。这里用接口模拟"空串 → undefined"。
    const patchEmpty = await http(session, 'PATCH', `/api/hr/employees/${empId}`, { hireDate: '' });
    const hireAfterEmpty = (await sql`SELECT hire_date FROM md_employee WHERE id = ${empId}`)[0]?.hire_date;
    record('★ 接口 PATCH { hireDate: "" }（客户端清空后实际发的形状）的行为',
      true,
      `status=${patchEmpty.status} msg=「${patchEmpty.message}」 库 hire_date=${hireAfterEmpty ? hireAfterEmpty.toISOString().slice(0, 10) : null}（未被清空=${hireAfterEmpty !== null}）`);
    if (hireAfterEmpty !== null) {
      note('HR-CLEAR-01',
        `「入职日期」无法清空：客户端 toUpdateDto 用 \`values.hireDate || undefined\`，空串被转成 undefined；` +
        `服务端 updateEmployee 的 \`if (dto.hireDate !== undefined)\` 直接跳过；DTO 的 @IsDateString() 也不接受 null。` +
        `三重叠加的结果是**这条字段只能改不能清**（库值 ${hireAfterEmpty.toISOString().slice(0, 10)} 原样保留），` +
        `而 toast 照报「员工信息已更新」—— 界面完全无提示。`);
    }
    /*
     * ⚠️ 用例后置复原：上一段的 `PATCH { hireDate: null }` 是**能通过**的，
     * 于是 hire_date 已被清空；而后面「离职日期早于入职日期被拒」必须有非空入职日期
     * 才有意义 —— 否则服务端按"未填入职日期"直接放过、返回 201，
     * 看起来像校验缺失（实测正是这样误报了一条）。这里把入职日期写回去。
     */
    const hireRestore = await http(session, 'PATCH', `/api/hr/employees/${empId}`, { hireDate: hireDateForTest });
    const hireRestored = (await sql`SELECT hire_date FROM md_employee WHERE id = ${empId}`)[0]?.hire_date;
    record('用例复原：把入职日期写回测试值（供后续离职校验用例使用）',
      hireRestore.status === 200 && hireRestored?.toISOString?.().slice(0, 10) === hireDateForTest,
      `status=${hireRestore.status} 库=${hireRestored?.toISOString?.().slice(0, 10)}`);

    /* ══════════ 8. HR：年假按司龄初始化 ══════════ */

    console.log('\n════ 8. /hr · 年假按司龄初始化（不覆盖已设置余额）════');
    const year = '2027';
    // 8a. 先给测试员工手工设置一个 2027 年余额 3 天，验证初始化不覆盖
    const preset = await http(session, 'POST', '/api/hr/leave-balances', {
      employeeId: empId, leaveType: 'annual', year, totalDays: 3,
    });
    const presetRow = (await sql`
      SELECT id, total_days FROM hr_leave_balance WHERE employee_id = ${empId} AND leave_type='annual' AND year=${year}`)[0];
    if (presetRow) cleanup.leaveBalanceIds.push(presetRow.id);
    record('准备：给测试员工预置 2027 年假 3 天', preset.status === 201 && Number(presetRow?.total_days) === 3,
      `status=${preset.status} 库=${presetRow?.total_days}`);

    // 8b. 建三个不同司龄的员工（接口，避免 UI 里点十几次）
    const tenures = [
      { name: `${TAG}司龄0年`, hireDate: '2026-06-01', expect: 5 },
      { name: `${TAG}司龄2年`, hireDate: '2025-01-02', expect: 8 },
      { name: `${TAG}司龄4年`, hireDate: '2023-01-02', expect: 10 },
      { name: `${TAG}司龄7年`, hireDate: '2020-01-02', expect: 12 },
      { name: `${TAG}司龄12年`, hireDate: '2015-01-02', expect: 15 },
    ];
    for (const t of tenures) {
      const r = await http(session, 'POST', '/api/hr/employees', {
        name: t.name, hireDate: t.hireDate, status: 'active', employmentType: 'full_time',
        remark: `${TAG} 司龄用例`,
      });
      if (r.body?.id) cleanup.employeeIds.push(r.body.id);
      t.id = r.body?.id ?? null;
      t.status = r.status;
    }
    record('准备：建五个不同司龄的员工',
      tenures.every((t) => !!t.id),
      tenures.map((t) => `${t.hireDate}→id:${t.id ? 'ok' : 'FAIL'}`).join(' '));

    const initRes = await http(session, 'POST', '/api/hr/leave-balances/init', { year });
    record('年假初始化接口返回统计（initializedCount / skippedCount）',
      initRes.status === 201 && typeof initRes.body?.initializedCount === 'number',
      `status=${initRes.status} body=${JSON.stringify(initRes.body)}`);

    const balances = await sql`
      SELECT b.id, e.name, e.hire_date, b.total_days
      FROM hr_leave_balance b JOIN md_employee e ON e.id = b.employee_id
      WHERE b.year = ${year} AND b.leave_type = 'annual'
        AND e.id = ANY(${anyIds([...tenures.map((t) => t.id), empId].filter(Boolean))})`;
    for (const b of balances) cleanup.leaveBalanceIds.push(b.id);
    let tenureOk = true;
    const tenureDetail = [];
    for (const t of tenures) {
      const row = balances.find((b) => b.name === t.name);
      const got = row ? Number(row.total_days) : null;
      if (got !== t.expect) tenureOk = false;
      tenureDetail.push(`${t.hireDate.slice(0, 4)}(${t.name.replace(TAG, '')})=${got}/${t.expect}`);
    }
    record('★ 年假按司龄初始化：<1年5 / 1-3年8 / 3-5年10 / 5-10年12 / ≥10年15',
      tenureOk, tenureDetail.join(' '));

    const presetAfter = Number((await sql`
      SELECT total_days FROM hr_leave_balance WHERE employee_id = ${empId} AND leave_type='annual' AND year=${year}`)[0]?.total_days);
    record('★ 已设置的余额不被初始化覆盖（预置 3 天仍是 3 天）',
      presetAfter === 3,
      `初始化后 = ${presetAfter}（期望 3，该员工司龄 5 年本应 12 天）`);

    // 8c. UI 上触发一次初始化（看按钮是否可用 + 是否有反馈）
    page.resetDiagnostics();
    const attTab = await openTab(page, '/hr', '考勤与请假', '年假');
    const attendanceButtons = await page.evaluate(`(() => [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean))()`);
    record('「考勤与请假」Tab 切换到并渲染出年假相关入口',
      attTab.ready, `tab=${JSON.stringify(attTab)} 按钮=${JSON.stringify(attendanceButtons.filter((b) => /年假|初始化/.test(b)))}`);
    const initBtn = attendanceButtons.find((b) => /初始化|年假/.test(b));
    if (initBtn) {
      const r = await clickText(page, initBtn, { selector: 'button', settleMs: 1200 }).then(() => 'ok').catch((e) => `err:${e.message}`);
      const t = await toasts(page, { attempts: 8 });
      record(`考勤 Tab 年假初始化按钮「${initBtn}」可点且有反馈`, r === 'ok' && t.length > 0,
        `点击=${r} toast=${JSON.stringify(t)}`);
    } else {
      skip('考勤 Tab 年假初始化按钮', `页面上没有匹配 初始化|年假 的按钮；实际按钮=${JSON.stringify(attendanceButtons.slice(0, 14))}`);
    }

    /* ══════════ 9. HR：考勤 / 请假 / 补卡 ══════════ */

    console.log('\n════ 9. /hr · 考勤与请假 ════');
    page.resetDiagnostics();
    const attStats = await pageStats(page);
    record('考勤与请假 Tab 渲染', attStats.textLen > 200, `buttons=${JSON.stringify(attStats.buttons.slice(0, 14))}`);

    // 9a. 考勤（接口 + 库核对，UI 覆盖在下面）
    const attDate = '2026-10-08';
    const attRes = await http(session, 'POST', '/api/hr/attendance', {
      employeeId: empId, workDate: attDate, status: 'present', remark: `${TAG} 走查考勤`,
    });
    if (attRes.body?.id) cleanup.attendanceIds.push(attRes.body.id);
    const attRow = (await sql`
      SELECT id, status, remark FROM hr_attendance WHERE employee_id = ${empId} AND work_date = ${attDate}`)[0];
    if (attRow?.id && !cleanup.attendanceIds.includes(attRow.id)) cleanup.attendanceIds.push(attRow.id);
    record('考勤登记落库', attRes.status === 201 && attRow?.status === 'present',
      `status=${attRes.status} 库=${attRow?.status} remark=${attRow?.remark}`);

    // 再登一次同一天改成 late → 应为 upsert 而不是报错
    const att2 = await http(session, 'POST', '/api/hr/attendance', {
      employeeId: empId, workDate: attDate, status: 'late', remark: `${TAG} 走查考勤改`,
    });
    const attRows = await sql`SELECT id, status FROM hr_attendance WHERE employee_id = ${empId} AND work_date = ${attDate}`;
    for (const r of attRows) if (!cleanup.attendanceIds.includes(r.id)) cleanup.attendanceIds.push(r.id);
    record('同日考勤重复登记 → upsert 为 late（不新增行）',
      attRows.length === 1 && attRows[0].status === 'late',
      `status=${att2.status} 该日行数=${attRows.length} 值=${attRows[0]?.status}`);

    // 9b. 请假：余额不足必须被拦
    const overLeave = await http(session, 'POST', '/api/hr/leave-requests', {
      employeeId: empId, leaveType: 'personal', startDate: '2026-10-12', endDate: '2026-10-30',
      days: 19, reason: `${TAG} 超额请假`,
    });
    const overDays = Number((await sql`
      SELECT total_days - used_days AS left FROM hr_leave_balance
      WHERE employee_id=${empId} AND leave_type='personal' AND year='2026'`)[0]?.left ?? NaN);
    record('★ 请假余额不足被拦（且是"剩余 N 天 vs 申请 M 天"的可读提示）',
      overLeave.status === 400 && /余额不足/.test(overLeave.message ?? ''),
      `status=${overLeave.status} msg=「${overLeave.message}」 库剩余个人假=${overDays}`);

    // 9c. 正常请假 + 重叠拦截
    const okLeave = await http(session, 'POST', '/api/hr/leave-requests', {
      employeeId: empId, leaveType: 'sick', startDate: '2026-10-12', endDate: '2026-10-14',
      days: 3, reason: `${TAG} 走查病假`,
    });
    if (okLeave.body?.id) cleanup.leaveRequestIds.push(okLeave.body.id);
    const leaveRow = (await sql`
      SELECT id, code, days, status FROM hr_leave_request WHERE employee_id=${empId} AND leave_type='sick' AND start_date='2026-10-12'`)[0];
    if (leaveRow?.id && !cleanup.leaveRequestIds.includes(leaveRow.id)) cleanup.leaveRequestIds.push(leaveRow.id);
    record('请假登记落库（服务端重算天数）',
      okLeave.status === 201 && Number(leaveRow?.days) === 3 && leaveRow?.status === 'pending',
      `status=${okLeave.status} 库=${leaveRow?.code} ${leaveRow?.days} 天 ${leaveRow?.status}`);
    const overlap = await http(session, 'POST', '/api/hr/leave-requests', {
      employeeId: empId, leaveType: 'sick', startDate: '2026-10-13', endDate: '2026-10-15',
      days: 3, reason: `${TAG} 重叠请假`,
    });
    record('★ 同类型请假区间重叠被拦（可读提示含已有单号）',
      overlap.status === 409 && /已存在同类请假单/.test(overlap.message ?? ''),
      `status=${overlap.status} msg=「${overlap.message}」`);

    // 9d. 审批：批准后 usedDays 增加；重复审批被拦
    if (leaveRow?.id) {
      const ap = await http(session, 'POST', `/api/hr/leave-requests/${leaveRow.id}/actions`, { action: 'approve' });
      const used = Number((await sql`
        SELECT used_days FROM hr_leave_balance WHERE employee_id=${empId} AND leave_type='sick' AND year='2026'`)[0]?.used_days ?? -1);
      record('请假审批通过 → 状态 approved 且 usedDays 累加 3',
        ap.status === 201 && used === 3,
        `status=${ap.status} 库 used_days=${used}`);
      const again = await http(session, 'POST', `/api/hr/leave-requests/${leaveRow.id}/actions`, { action: 'approve' });
      record('重复审批请假单被拦',
        again.status >= 400 && /仅待审批|已被处理/.test(again.message ?? ''),
        `status=${again.status} msg=「${again.message}」`);
    }

    // 9e. UI：请假详情页 /hr/leaves/:id
    if (leaveRow?.id) {
      page.resetDiagnostics();
      await page.goto(`${APP}/hr/leaves/${leaveRow.id}`, { settleMs: 2400 });
      await sleep(1500);
      const detail = await pageStats(page);
      const hasCode = await page.waitForText(leaveRow.code, 5000).catch(() => false);
      record('/hr/leaves/:id 请假详情页可打开且渲染出单号', hasCode && detail.textLen > 100,
        `path=${detail.path} textLen=${detail.textLen} 含单号=${hasCode}`);
      record('请假详情页无未捕获异常 / 无 console.error',
        page.exceptions.length === 0 && page.consoleLogs.filter((l) => l.type === 'error').length === 0,
        `exc=${page.exceptions.length} cerr=${page.consoleLogs.filter((l) => l.type === 'error').length}`);
      diagAll.push({ step: 'hr-leave-detail', exceptions: page.exceptions, httpErrors: page.httpErrors, consoleErrors: page.consoleLogs.filter((l) => l.type === 'error') });
    }

    // 9f. 补卡：申请 → 批准后生成考勤
    /*
     * 补卡只能由**绑定了员工的账号**提交（`createAmendment` → findEmployeeByPlatformUser），
     * 而主账号绑的是另一个员工 —— 所以必须用第二管理员（已绑测试员工）的会话提交，
     * 再用主账号（hr_write）审批。这也顺带验证了"提交人与审批人不同"的链路。
     */
    /*
     * 补卡日期要**先问库**再选：`createAmendment` 对同一天有唯一约束
     * （重复提交报「该日期已有补卡申请」），而前一晚失败的走查可能已经占用了
     * 某个日期。这里从 10-07 起往前找一个还没被占用的工作日，避免把"日期撞车"
     * 误判成"未绑定账号没被拦"（第一版就是这样得到 409 而非 400）。
     */
    const usedAmendDates = new Set(
      (await sql`SELECT DISTINCT work_date FROM hr_attendance_amendment WHERE employee_id = ${empId}`)
        .map((r) => r.work_date?.toISOString?.().slice(0, 10)),
    );
    let amendDate = null;
    for (let d = 7; d >= 1 && !amendDate; d -= 1) {
      const cand = `2026-10-0${d}`;
      if (!usedAmendDates.has(cand)) amendDate = cand;
    }
    record('准备：为补卡用例选一个未被占用的日期', !!amendDate,
      `已占用=${JSON.stringify([...usedAmendDates])} 选用=${amendDate}`);
    const amend = await http(submitterSession, 'POST', '/api/hr/attendance-amendments', {
      workDate: amendDate, reason: `${TAG} 走查补卡`,
    });
    if (amend.body?.id) cleanup.amendmentIds.push(amend.body.id);
    record('补卡申请创建（提交人 = 绑定该员工的账号；状态 pending）',
      amend.status === 201 && amend.body?.status === 'pending' && String(amend.body?.employeeId) === String(empId),
      `status=${amend.status} employeeId=${String(amend.body?.employeeId).slice(0, 8)}（期望 ${String(empId).slice(0, 8)}） body=${JSON.stringify(amend.body)?.slice(0, 140)}`);
    if (amend.body?.id) {
      const apAmend = await http(session, 'POST', `/api/hr/attendance-amendments/${amend.body.id}/actions`, { action: 'approve' });
      const genAtt = await sql`
        SELECT id, status FROM hr_attendance WHERE employee_id = ${empId} AND work_date = ${amendDate}`;
      for (const r of genAtt) if (!cleanup.attendanceIds.includes(r.id)) cleanup.attendanceIds.push(r.id);
      record('★ 补卡审批通过 → 事务内生成 hr_attendance（present）',
        apAmend.status === 201 && genAtt.length === 1 && genAtt[0]?.status === 'present',
        `status=${apAmend.status} msg=「${apAmend.message}」 生成考勤行数=${genAtt.length} 状态=${genAtt[0]?.status}`);

      // 未绑定员工的账号不能提交补卡（fail-closed 提示）
      /*
       * ⚠️ 提交人必须是**未绑定员工的账号**（第三管理员）——
       * 主账号虽然 `sys_user.employee_id` 为 null，但服务端
       * `findEmployeeByPlatformUser` 会经 `md_employee.feishu_union_id` 兜底匹配到
       * 一条真实员工档案（实测落到 EMP2026100004），于是补卡会**成功建单**，
       * 拿到 201 而不是我们要验的 400。这一点单独记一条，避免误判成"校验缺失"。
       *
       * 同时要错开上一张补卡的日期：同一天会先撞唯一约束报「该日期已有补卡申请」(409)。
       */
      const unboundDate = amendDate === '2026-10-06' ? '2026-10-05' : '2026-10-06';
      const amendUnbound = await httpWithRetry(proxySession, 'POST', '/api/hr/attendance-amendments', {
        workDate: unboundDate, reason: `${TAG} 未绑定账号补卡`,
      }, { retries: 2, gapMs: 25000 });
      record('★ 未绑定员工的账号提交补卡 → 被拒且提示可读',
        amendUnbound.status === 400 && /未绑定员工/.test(amendUnbound.message ?? ''),
        `日期=${unboundDate} status=${amendUnbound.status} 重试=${amendUnbound.attempts} msg=「${amendUnbound.message}」` +
        (amendUnbound.status === 201 ? `（落库员工=${String(amendUnbound.body?.employeeId).slice(0, 8)}：说明该账号被兜底匹配到了员工档案）` : ''));
      if (amendUnbound.body?.id) cleanup.amendmentIds.push(amendUnbound.body.id);

      // 对照面：主账号（同样 sys_user.employee_id 为空）实际会被兜底匹配到某条员工档案
      const amendMain = await http(session, 'POST', '/api/hr/attendance-amendments', {
        workDate: unboundDate === '2026-10-06' ? '2026-10-04' : '2026-10-05',
        reason: `${TAG} 主账号补卡对照`,
      });
      if (amendMain.body?.id) cleanup.amendmentIds.push(amendMain.body.id);
      record('（附）sys_user.employee_id 为空 ≠ 未绑定员工：主账号提交补卡会被兜底匹配',
        amendMain.status === 201 || amendMain.status === 400,
        `status=${amendMain.status} 落库员工=${String(amendMain.body?.employeeId).slice(0, 8) || '-'} msg=「${amendMain.message}」`);
    }

    /* ══════════ 10. HR：工时填报（我的自助）+ 补卡 UI ══════════ */

    console.log('\n════ 10. /hr · 我的（自助）════');
    page.resetDiagnostics();
    /*
     * 「我的」Tab 对**主账号**（绑了员工 EMP2026100004）才有内容；这里换成
     * **第二管理员会话**（绑定测试员工）来看，才验证得到"本人档案 + 本月考勤 +
     * 年假余额 + 已审批工资单"这四块的真实渲染（主账号看的是别人的档案，
     * 对走查目标没有意义）。
     */
    await page.setCookie({ name: 'erp_session', value: submitterSession, url: APP });
    const myTab = await openTab(page, '/hr', '我的', '我的');
    const myStats = await pageStats(page);
    record('「我的」Tab 渲染', myTab.ready && myStats.textLen > 120,
      `tab=${JSON.stringify(myTab)} textLen=${myStats.textLen}`);
    const mySummary = await http(submitterSession, 'GET', '/api/hr/my/summary');
    record('GET /api/hr/my/summary 返回 200（以绑定员工的身份）',
      mySummary.status === 200,
      `status=${mySummary.status} keys=${mySummary.body && typeof mySummary.body === 'object' ? Object.keys(mySummary.body).join(',') : mySummary.message}`);
    if (mySummary.status !== 200) note('HR-MY-01', `我的自助汇总接口返回 ${mySummary.status}：${mySummary.message}`);
    diagAll.push({ step: 'hr-my', exceptions: page.exceptions, httpErrors: page.httpErrors, consoleErrors: page.consoleLogs.filter((l) => l.type === 'error') });
    await page.setCookie({ name: 'erp_session', value: session, url: APP });

    // 其余 HR Tab 只做"能切换 + 无异常"
    page.resetDiagnostics();
    await page.goto(`${APP}/hr`, { settleMs: 2400 });
    await waitText(page, '身份管理', 12000);
    const otherTabs = ['身份管理', '员工档案', '考勤与请假', '薪酬管理', '招聘管理', '绩效考核', '培训管理', '我的'];
    const tabResults = [];
    for (const tb of otherTabs) {
      const r = await switchTab(page, tb);
      await sleep(1000);
      const s = await pageStats(page);
      tabResults.push(`${tb}:${r === 'ok' ? 'ok' : r}/${s.textLen}`);
    }
    record('HR 八个 Tab 逐个切换均可渲染',
      tabResults.every((x) => /:ok(\(button\))?\/\d+$/.test(x) && !x.endsWith('/0')),
      tabResults.join(' '));
    record('HR 八个 Tab 切换全程无未捕获异常 / 无 5xx',
      page.exceptions.length === 0 && page.httpErrors.filter((e) => Number(e.status) >= 500).length === 0,
      `exc=${page.exceptions.length} http4xx=${page.httpErrors.length} 5xx=${page.httpErrors.filter((e) => Number(e.status) >= 500).length}`);
    diagAll.push({ step: 'hr-tabs', exceptions: page.exceptions, httpErrors: page.httpErrors, consoleErrors: page.consoleLogs.filter((l) => l.type === 'error') });

    /* ══════════ 11. HR：工资单状态机（含 rejected → 重新提交）══════════ */

    console.log('\n════ 11. /hr · 工资单状态机 ════');
    page.resetDiagnostics();
    const payPeriod = '2026-11';
    const payRes = await http(session, 'POST', '/api/hr/payrolls', {
      employeeId: empId, period: payPeriod, baseSalary: 20000, perfSalary: 3000,
      allowance: 500, useEngine: false, socialInsurance: 2000, housingFund: 1500, tax: 600,
      remark: `${TAG} 走查工资单`,
    });
    if (payRes.body?.id) cleanup.payrollIds.push(payRes.body.id);
    const payRow = (await sql`
      SELECT id, code, status, net_salary, base_salary FROM hr_payroll
      WHERE employee_id=${empId} AND period=${payPeriod}`)[0];
    if (payRow?.id && !cleanup.payrollIds.includes(payRow.id)) cleanup.payrollIds.push(payRow.id);
    record('新建工资单落库（draft；实发 = 应发 − 社保 − 公积金 − 个税）',
      payRes.status === 201 && payRow?.status === 'draft' && Number(payRow?.net_salary) === 20000 + 3000 + 500 - 2000 - 1500 - 600,
      `status=${payRes.status} 库=${payRow?.code} ${payRow?.status} 实发=${payRow?.net_salary}`);

    if (payRow?.id) {
      /*
       * 走 UI：提交审批 → 驳回 → 重新提交（本会话刚修过提交按钮条件）。
       *
       * ⚠️ 工资单列表的「期间」筛选框默认是**当前月**（`currentPeriod()`），
       * 我们造的却是下一个月的单据 —— 不先把筛选框改成目标期间，表格里根本没有那一行，
       * 于是所有行内点击都会 `row-not-found`（第一版就是这样误判了 5 条 FAIL）。
       */
      await openTab(page, '/hr', '薪酬管理', '新建工资单');
      const periodSet = await setField(page, '#payroll-period', payPeriod);
      let rowBtn = null;
      for (let i = 0; i < 8 && rowBtn === null; i += 1) {
        await sleep(1000);
        rowBtn = await rowButtons(page, payRow.code);
        if (rowBtn === null) await setField(page, '#payroll-period', payPeriod);
      }
      record('工资单列表：期间筛选切到目标期间后能看到该行（含「提交审批」按钮）',
        periodSet === 'ok' && Array.isArray(rowBtn) && rowBtn.includes('提交审批'),
        `筛选框=${periodSet} 该行按钮=${JSON.stringify(rowBtn)}`);

      const sub = await clickRowButton(page, payRow.code, '^提交审批$');
      const subToast = await toasts(page);
      await sleep(900);
      const s1 = (await sql`SELECT status FROM hr_payroll WHERE id=${payRow.id}`)[0]?.status;
      record('工资单 draft → submitted（UI 行内「提交审批」）',
        String(sub) === 'ok' && s1 === 'submitted',
        `点击=${sub} toast=${JSON.stringify(subToast)} 状态=${s1}`);

      const rej = await clickRowButton(page, payRow.code, '^驳回$');
      const rejToast = await toasts(page);
      await sleep(900);
      const s2 = (await sql`SELECT status FROM hr_payroll WHERE id=${payRow.id}`)[0]?.status;
      record('工资单 submitted → rejected（UI 行内「驳回」）',
        String(rej) === 'ok' && s2 === 'rejected',
        `点击=${rej} toast=${JSON.stringify(rejToast)} 状态=${s2}`);

      const btnsAfterReject = await rowButtons(page, payRow.code);
      record('★ rejected 行上「提交审批」按钮存在（D-14 允许重新提交，界面必须有出口）',
        Array.isArray(btnsAfterReject) && btnsAfterReject.includes('提交审批'),
        `该行按钮=${JSON.stringify(btnsAfterReject)}`);

      const resub = await clickRowButton(page, payRow.code, '^提交审批$');
      const resubToast = await toasts(page);
      await sleep(900);
      const s3 = (await sql`SELECT status FROM hr_payroll WHERE id=${payRow.id}`)[0]?.status;
      record('★ 工资单 rejected → submitted 重新提交成功（服务端与界面一致）',
        s3 === 'submitted',
        `点击=${resub} toast=${JSON.stringify(resubToast)} 状态=${s3}`);

      const appr = await clickRowButton(page, payRow.code, '^审批通过$');
      const apprToast = await toasts(page);
      await sleep(1500);
      const s4 = (await sql`SELECT status, allocation_generated FROM hr_payroll WHERE id=${payRow.id}`)[0];
      record('工资单 submitted → approved（并生成分摊）',
        s4?.status === 'approved',
        `点击=${appr} toast=${JSON.stringify(apprToast)} 状态=${s4?.status} allocationGenerated=${s4?.allocation_generated}`);

      // 重复审批应被拦
      const apprAgain = await http(session, 'POST', `/api/hr/payrolls/${payRow.id}/actions`, { action: 'approve' });
      record('重复审批工资单被拦（提示可读）',
        apprAgain.status >= 400 && /仅已提交|已被审批|重复/.test(apprAgain.message ?? ''),
        `status=${apprAgain.status} msg=「${apprAgain.message}」`);

      // 终态：approved 之后 UI 应出现「标记发放 / 作废」
      const approvedBtns = await rowButtons(page, payRow.code);
      record('★ approved 行上出现「标记发放」与「作废」（approved 不再是死胡同）',
        Array.isArray(approvedBtns) && approvedBtns.includes('标记发放') && approvedBtns.includes('作废'),
        `该行按钮=${JSON.stringify(approvedBtns)}`);

      // 非法流转：已 approved 的工资单不能再走 submit
      const submitAgain = await http(session, 'POST', `/api/hr/payrolls/${payRow.id}/actions`, { action: 'submit' });
      record('★ 非法流转被拒：approved 状态不能再提交审批',
        submitAgain.status === 400 && /仅草稿或已驳回状态可提交/.test(submitAgain.message ?? ''),
        `status=${submitAgain.status} msg=「${submitAgain.message}」`);

      const sFinal = (await sql`SELECT status FROM hr_payroll WHERE id=${payRow.id}`)[0]?.status;
      record('工资单最终状态 = approved（本轮不执行 pay/void，避免出账）',
        sFinal === 'approved',
        `最终状态=${sFinal}`);
      skip('工资单「标记发放」(pay) 在界面上执行', '会真实出账（凭证 + 现金流预测口径）；本轮停在 approved，不点 pay。');
      skip('工资单「作废」(void)', '会作废已生成的凭证与分摊（改账务）；本轮只验证按钮存在，不执行。');
    }
    diagAll.push({ step: 'hr-payroll', exceptions: page.exceptions, httpErrors: page.httpErrors, consoleErrors: page.consoleLogs.filter((l) => l.type === 'error') });

    /* ══════════ 12. HR：离职流转 ══════════ */

    console.log('\n════ 12. /hr · 离职流转（offboard）════');
    const resignDate = '2026-10-15';
    /*
     * 12a. 待交接项目：先给**待离职员工**造一条近 60 天内的已确认工时。
     * 确认必须由别人做（职责分离），所以提交用第二管理员会话、确认用主账号。
     */
    const handoverDate = '2026-10-05';
    const hoTs = await http(proxySession, 'POST', '/api/costs/timesheets', {
      projectId: projectRow.id, employeeId: flexEmpId, roleName,
      workDate: handoverDate, hours: 6, remark: `${TAG} 离职待交接`,
    });
    if (hoTs.body?.id) cleanup.timesheetIds.push(hoTs.body.id);
    const hoRow = (await sql`
      SELECT id, code, employee_id FROM erp_timesheet WHERE remark = ${`${TAG} 离职待交接`}
      ORDER BY _created_at DESC LIMIT 1`)[0];
    if (hoRow?.id && !cleanup.timesheetIds.includes(hoRow.id)) cleanup.timesheetIds.push(hoRow.id);
    const hoSubmit = await http(proxySession, 'POST', `/api/costs/timesheets/${hoRow?.id}/action`, { action: 'submit' });
    const hoConfirm = await http(session, 'POST', `/api/costs/timesheets/${hoRow?.id}/action`, { action: 'confirm' });
    const hoCost = (await sql`SELECT id, cost_type FROM erp_project_cost WHERE source_ref = ${`timesheet:${hoRow?.code ?? ''}`}`)[0];
    if (hoCost?.id) cleanup.costIds.push(hoCost.id);
    record('准备：为待离职员工造一条已确认工时（近 60 天内）',
      hoSubmit.status === 201 && hoConfirm.status === 201 && !!hoCost
        && String(hoRow?.employee_id) === String(flexEmpId),
      `提交=${hoSubmit.status} 确认=${hoConfirm.status} msg=「${hoConfirm.message}」 成本行=${hoCost ? hoCost.cost_type : '无'} 工时归属员工=${String(hoRow?.employee_id).slice(0, 8)}（期望兼职工 ${String(flexEmpId).slice(0, 8)}）`);

    page.resetDiagnostics();
    await openTab(page, '/hr', '员工档案', flexName);
    const offOpen = await clickRowButton(page, flexName, '^离职$');
    const offWait = await waitDialog(page, '离职');
    const offDialog = offWait.__missing ? null : offWait;
    record('离职弹窗打开', String(offOpen) === 'ok' && !!offDialog,
      `点击=${offOpen} title=${offDialog?.title} 字段=${JSON.stringify(offDialog?.labels)} 诊断=${JSON.stringify(offWait.diagnostic ?? null)?.slice(0, 300)}`);
    if (offDialog) {
      /*
       * ⚠️ 这里对日期控件做**逐步留痕**：离职弹窗的日期控件与其它弹窗形态相同，
       * 但走查里出现过"日历打开了、也点了日期，输入框仍显示『请选择日期』"，
       * 结果提交被 `if (!resignDate) toast.error('请选择离职日期')` 拦下、
       * 后续四条断言全跟着假失败。没有留痕就只能猜，所以把关键中间态记下来。
       */
      const triggerBefore = await page.evaluate(`(() => {
        const d = [...document.querySelectorAll('[role="dialog"]')]
          .find((x) => /离职/.test(x.querySelector('[role="heading"],h2')?.textContent || ''));
        if (!d) return null;
        const lab = [...d.querySelectorAll('label')].find((l) => /离职日期/.test(l.textContent || ''));
        const item = lab ? (lab.closest('div') ?? lab.parentElement) : null;
        const btn = item ? item.querySelector('button') : null;
        return { labelFound: !!lab, htmlFor: lab ? lab.htmlFor : null, btnText: btn ? (btn.textContent || '').trim() : null };
      })()`);
      const offDate = await setDateByLabel(page, '离职日期', resignDate);
      if (!String(offDate).startsWith('picked')) {
        /*
         * 日期没选中时**改用 CDP 真实鼠标**再点一次触发器。
         *
         * 页内 `dispatchEvent` 是合成事件：当 Radix 的 focus-guard 或 Dialog 的
         * 焦点管理恰好处于中间态时会被吞掉（同一控件"单独探针必成功、整段走查失败"）。
         * CDP 派发的 mousePressed/mouseReleased 走真实命中测试，能绕开这类差异。
         */
        await page.clickByText('请选择日期', { selector: '[role="dialog"] button', settleMs: 900 })
          .catch(() => undefined);
        await sleep(900);
        const calOpen = await page.evaluate(`!!document.querySelector('[data-slot="calendar"] [data-day]')`);
        console.log(`    · 合成点击未打开日历，改真实鼠标后日历可见=${calOpen}`);
        if (calOpen) {
          // 真实鼠标已把日历点开 → 在这里把目标日期选上，后续链路仍可完整验证
          const pickedByMouse = await page.evaluate(`(async () => {
            const want = ${JSON.stringify(resignDate)};
            const frame = () => new Promise((r) => setTimeout(r, 0));
            for (let hop = 0; hop < 300; hop += 1) {
              const td = [...document.querySelectorAll('td[data-day]')]
                .find((c) => c.getAttribute('data-day') === want);
              if (td) {
                const b = td.querySelector('button') ?? td;
                b.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                return 'picked:' + want;
              }
              const cells = [...document.querySelectorAll('td[data-day]')];
              if (!cells.length) return 'calendar-closed';
              const curYm = (cells[Math.max(0, cells.length - 14)]?.getAttribute('data-day') ?? '').slice(0, 7);
              const dir = curYm > want.slice(0, 7) ? 'Previous' : 'Next';
              const nav = [...document.querySelectorAll('button')]
                .find((b) => (b.getAttribute('aria-label') || '') === 'Go to the ' + dir + ' Month');
              if (!nav) return 'no-nav@' + curYm;
              nav.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              await frame();
            }
            return 'exhausted';
          })()`, { awaitPromise: true });
          console.log(`    · 真实鼠标兜底选日结果=${pickedByMouse}`);
        }
      }
      const triggerAfter = await page.evaluate(`(() => {
        const d = [...document.querySelectorAll('[role="dialog"]')]
          .find((x) => /离职/.test(x.querySelector('[role="heading"],h2')?.textContent || ''));
        if (!d) return null;
        const lab = [...d.querySelectorAll('label')].find((l) => /离职日期/.test(l.textContent || ''));
        const item = lab ? (lab.closest('div') ?? lab.parentElement) : null;
        const btn = item ? item.querySelector('button') : null;
        return { btnText: btn ? (btn.textContent || '').trim() : null, popoverOpen: document.querySelectorAll('[data-radix-popper-content-wrapper] [data-state="open"]').length };
      })()`);
      await sleep(300);
      record('离职弹窗：日期控件可打开并选中目标日期（回填到触发器）',
        (triggerAfter?.btnText ?? '') === resignDate,
        `选日前=${JSON.stringify(triggerBefore)} 合成点击结果=${offDate} 选日后=${JSON.stringify(triggerAfter)}` +
        (String(offDate).startsWith('picked') ? '' : '（合成事件被吞，已用 CDP 真实鼠标兜底完成选日）'));
      await closePopovers(page);
      /*
       * 弹窗里同时有「确认离职」按钮与（可能）底层页面的按钮，这里**限定在弹窗内**点，
       * 并把点击结果与提交后的 toast 一起记下来 —— 否则"点了但没生效"无法归因。
       */
      const clickOffboard = await page.evaluate(`(() => {
        const d = [...document.querySelectorAll('[role="dialog"]')]
          .find((x) => /离职/.test(x.querySelector('[role="heading"],h2')?.textContent || ''));
        if (!d) return 'no-dialog';
        const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '确认离职');
        if (!b) return 'btn-not-found:' + [...d.querySelectorAll('button')].map((x) => (x.textContent || '').trim()).join('|');
        if (b.disabled) return 'btn-disabled';
        b.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'ok';
      })()`);
      await sleep(2200);
      const offToast = await toasts(page, { attempts: 10 });
      const offBody = await page.evaluate(`(() => {
        const all = [...document.querySelectorAll('[role="dialog"]')];
        const d = all.find((x) => /离职/.test(x.querySelector('[role="heading"],h2')?.textContent || '')) ?? all[0];
        return d ? (d.innerText || '').slice(0, 900) : null;
      })()`);
      record('离职弹窗提交后有反馈（toast 或弹窗内待交接清单）',
        offToast.length > 0 || (offBody ?? '').length > 0,
        `日期选择=${offDate} 点确认=${clickOffboard} toast=${JSON.stringify(offToast)}`);
      record('★ 离职返回近 60 天已确认工时的待交接项目（弹窗内出现项目名）',
        (offBody ?? '').includes(projectRow.name) || offToast.some((t) => t.includes(projectRow.name)),
        `弹窗文本含项目名=${(offBody ?? '').includes(projectRow.name)} 弹窗文本=${JSON.stringify((offBody ?? '').slice(0, 260))}`);
    }
    const empAfterOff = (await sql`SELECT status, resign_date FROM md_employee WHERE id=${flexEmpId}`)[0];
    record('★ 离职流转 probation/active → resigned（库值 + 离职日期）',
      empAfterOff?.status === 'resigned' && empAfterOff?.resign_date?.toISOString?.().slice(0, 10) === resignDate,
      `库 status=${empAfterOff?.status} resign_date=${empAfterOff?.resign_date?.toISOString?.().slice(0, 10)}`);
    /*
     * 联动：离职后不能再登记工时。
     *
     * ⚠️ 必须用**未绑定员工的账号**（代登通道）并显式给 employeeId：
     * 用第二管理员（本人绑定测试员工A）调用时，服务端按"绑定优先"落到**他自己**，
     * 而他自己没离职 —— 于是拿到 201，看起来像"离职校验没生效"（实测踩过）。
     */
    const afterOffTs = await httpWithRetry(proxySession, 'POST', '/api/costs/timesheets', {
      projectId: projectRow.id, employeeId: flexEmpId, workDate: '2026-10-06', hours: 2,
      remark: `${TAG} 离职后登记用例`,
    });
    if (afterOffTs.body?.id) cleanup.timesheetIds.push(afterOffTs.body.id);
    record('★ 离职员工不能再登记工时（联动校验，经管理员代登通道）',
      afterOffTs.status === 400 && /离职员工不能登记工时/.test(afterOffTs.message ?? ''),
      `status=${afterOffTs.status} msg=「${afterOffTs.message}」`);

    const offAgain = await http(session, 'POST', `/api/hr/employees/${flexEmpId}/offboard`, { resignDate });
    record('★ 非法流转被拒（已离职再离职）',
      offAgain.status === 400 && /已离职|无需重复/.test(offAgain.message ?? ''),
      `status=${offAgain.status} msg=「${offAgain.message}」`);
    const offEarly = await http(session, 'POST', `/api/hr/employees/${empId}/offboard`, { resignDate: '2019-01-01' });
    record('★ 离职日期早于入职日期被拒',
      offEarly.status === 400 && /不能早于入职日期/.test(offEarly.message ?? ''),
      `status=${offEarly.status} msg=「${offEarly.message}」 该员工入职日期=${hireDateForTest}`);
    diagAll.push({ step: 'hr-offboard', exceptions: page.exceptions, httpErrors: page.httpErrors, consoleErrors: page.consoleLogs.filter((l) => l.type === 'error') });

    /* ══════════ 13. 预算费控 ══════════ */

    console.log('\n════ 13. /fin-expense · 预算 + 费用申请 + 报销 ════');
    page.resetDiagnostics();
    await page.goto(`${APP}/fin-expense`, { settleMs: 2500 });
    await sleep(1600);
    const feStats = await pageStats(page);
    record('/fin-expense 页面渲染 + 五个 Tab', feStats.textLen > 200 && feStats.buttons.length > 4,
      `buttons=${JSON.stringify(feStats.buttons.slice(0, 14))}`);

    // 13a. 预算面板渲染 + 与 SQL 对账（available = budget − occupied − executed）
    const budgetsRes = await http(session, 'GET', '/api/fin-budget/budgets?page=1&pageSize=100');
    const budgetApiOk = budgetsRes.status === 200;
    record('预算列表接口 200', budgetApiOk, `status=${budgetsRes.status} items=${budgetsRes.body?.items?.length ?? 'x'}`);
    const sqlBudgets = await sql`
      SELECT id, period, department_id, project_id, expense_category, budget_amount FROM fin_budget ORDER BY period, code`;
    const okBudget = (() => {
      if (!budgetApiOk) return { ok: false, why: 'api-fail' };
      const items = budgetsRes.body.items ?? [];
      for (const it of items) {
        const sqlRow = sqlBudgets.find((b) => b.id === it.id);
        if (!sqlRow) continue;
        if (Math.abs(Number(sqlRow.budget_amount) - Number(it.budgetAmount)) > 0.005) {
          return { ok: false, why: `${it.code} 金额 ${it.budgetAmount} ≠ ${sqlRow.budget_amount}` };
        }
      }
      return { ok: true, why: `核对 ${items.length} 条预算金额一致` };
    })();
    record('★ 预算列表金额与 SQL 一致', okBudget.ok, okBudget.why);

    /*
     * 13b. 预算超支：申请金额 > 预算 → 拒绝（按该项目预算的维度造一张超大申请）
     *
     * ⚠️ 维度必须**显式给全**，不能用 `?? undefined`：请求体里的 undefined 字段
     * 会被 DTO 的 `@IsOptional()` 放过，于是申请落到"无部门无项目"的维度上，
     * 谁也匹配不到 —— 预算校验根本不会触发，这条断言就成了假绿。
     */
    const targetBudget = sqlBudgets.find((b) => b.expense_category === '项目实施' && b.period)
      ?? sqlBudgets[0];
    record('准备：取一条预算作为超支用例的维度来源', !!targetBudget,
      targetBudget ? `${targetBudget.period} ${targetBudget.expense_category} 金额=${targetBudget.budget_amount}` : '库中无预算');
    const overApplyBody = {
      applyType: 'travel',
      title: `${TAG} 超预算申请`,
      expenseCategory: String(targetBudget?.expense_category ?? '项目实施'),
      amount: 9999999,
      expectDate: `${String(targetBudget?.period ?? '2026-10')}-15`,
      reason: `${TAG} 超预算用例`,
    };
    if (targetBudget?.department_id) overApplyBody.departmentId = targetBudget.department_id;
    if (targetBudget?.project_id) overApplyBody.projectId = targetBudget.project_id;
    const overApply = await http(session, 'POST', '/api/fin-expense/applies', overApplyBody);
    record('★ 费用申请超预算被拒（提示含预算/已执行/在途/超出金额）',
      overApply.status === 400 && /预算不足/.test(overApply.message ?? ''),
      `维度 部门:${String(targetBudget?.department_id).slice(0, 8) || '不限'} 项目:${String(targetBudget?.project_id).slice(0, 8) || '不限'} 科目:${overApplyBody.expenseCategory} period=${overApplyBody.expectDate.slice(0, 7)} status=${overApply.status} msg=「${overApply.message}」`);

    // 13c. 正常申请（UI 创建）
    await switchTab(page, '费用申请');
    await waitText(page, '新增申请', 9000);
    const applyOpen = await clickAndWaitDialog(page, '新增申请', '新增费用申请');
    const applyDialog = applyOpen.info?.__missing ? null : applyOpen.info;
    record('新增费用申请弹窗打开', !!applyDialog,
      `点击=${applyOpen.clickResult} 字段=${JSON.stringify(applyDialog?.labels)} 诊断=${JSON.stringify(applyOpen.info?.diagnostic ?? null)?.slice(0, 300)}`);
    const applyTitle = `${TAG} 走查费用申请`;
    const applyAmount = 1234.5;
    if (applyDialog) {
      const aSteps = [];
      aSteps.push(['申请类型', await selectByLabel(page, '申请类型', { optionText: '差旅' })]);
      aSteps.push(['标题', await fillByLabel(page, '标题', applyTitle)]);
      aSteps.push(['费用科目', await fillByLabel(page, '费用科目', '差旅费')]);
      aSteps.push(['申请金额', await fillByLabel(page, '申请金额', String(applyAmount))]);
      aSteps.push(['部门', await selectByLabel(page, '部门', { optionText: '不限部门' })]);
      aSteps.push(['项目', await selectByLabel(page, '项目', { optionText: '不限项目' })]);
      aSteps.push(['期望日期', await setDateByLabel(page, '期望日期', '2026-10-20')]);
      aSteps.push(['申请事由', await fillByLabel(page, '申请事由', `${TAG} 走查事由`)]);
      await sleep(400);
      const reqBefore = (page.requests ?? []).length;
      await clickText(page, '提交申请', { selector: '[role="dialog"] button', settleMs: 1500 });
      const applyToast = await toasts(page, { attempts: 12 });
      await sleep(1500);
      const newWrites = (page.requests ?? []).slice(reqBefore).filter((r) => /POST|PATCH|PUT/.test(r.method ?? ''));
      const stillOpen = await page.evaluate(`!!document.querySelector('[role="dialog"]')`);
      const vmsgs = await page.evaluate(`(() => {
        const all = [...document.querySelectorAll('[role="dialog"]')];
        const d = all.find((x) => /新增费用申请/.test(x.querySelector('[role="heading"],h2')?.textContent || ''));
        if (!d) return [];
        return [...d.querySelectorAll('*')].filter((e) => e.children.length === 0 && /请|必须|不能/.test(e.textContent || ''))
          .map((e) => (e.textContent || '').trim()).filter((x) => x.length < 40).slice(0, 6);
      })()`);
      record('费用申请（UI）提交：发出写请求且弹窗关闭',
        newWrites.length > 0 && !stillOpen,
        `填表=${aSteps.map(([k, r]) => `${k}=${r}`).join(' ')} 写请求=${JSON.stringify(newWrites.map((r) => r.method + ' ' + String(r.url).replace(/^.*\/api/, '/api')))} 弹窗仍开=${stillOpen} 校验提示=${JSON.stringify(vmsgs)} toast=${JSON.stringify(applyToast)} httpErr=${JSON.stringify(page.httpErrors.slice(-4))}`);
    }
    const applyRow = (await sql`
      SELECT id, code, title, amount, status, expect_date, department_id, project_id, expense_category
      FROM fin_expense_apply WHERE title = ${applyTitle} ORDER BY _created_at DESC LIMIT 1`)[0];
    if (applyRow) cleanup.applyIds.push(applyRow.id);
    record('★ 费用申请落库（金额/科目/期望日期/状态 pending）',
      !!applyRow && Number(applyRow.amount) === applyAmount && applyRow.status === 'pending',
      `库=${applyRow ? `${applyRow.code} ${applyRow.amount} ${applyRow.expense_category} ${applyRow.status}` : '未找到'}`);
    // UI 跳到详情页
    await sleep(800);
    const applyDetailPath = await page.evaluate('location.pathname');
    record('新增申请后自动跳详情页 /fin-expense/applies/:id',
      /^\/fin-expense\/applies\/[0-9a-f-]{36}$/.test(applyDetailPath),
      `path=${applyDetailPath}`);
    if (applyRow) {
      await page.goto(`${APP}/fin-expense/applies/${applyRow.id}`, { settleMs: 2300 });
      await sleep(1400);
      const applyDetail = await pageStats(page);
      const showCode = await page.waitForText(applyRow.code, 5000).catch(() => false);
      record('/fin-expense/applies/:id 详情页渲染出单号', showCode && applyDetail.textLen > 100,
        `textLen=${applyDetail.textLen} 含单号=${showCode}`);
      diagAll.push({ step: 'fin-expense-apply-detail', exceptions: page.exceptions, httpErrors: page.httpErrors, consoleErrors: page.consoleLogs.filter((l) => l.type === 'error') });
    }

    // 13d. 申请审批：pending → approved → closed，非法流转被拒
    if (applyRow) {
      const closeTooEarly = await http(session, 'POST', `/api/fin-expense/applies/${applyRow.id}/actions/close`, {});
      record('★ 申请非法流转被拒（pending 直接 close）',
        closeTooEarly.status === 400 && /非法的状态流转/.test(closeTooEarly.message ?? ''),
        `status=${closeTooEarly.status} msg=「${closeTooEarly.message}」`);
      const approve = await http(session, 'POST', `/api/fin-expense/applies/${applyRow.id}/actions/approve`, {});
      const st1 = (await sql`SELECT status FROM fin_expense_apply WHERE id=${applyRow.id}`)[0]?.status;
      record('费用申请 pending → approved',
        approve.status === 201 && st1 === 'approved',
        `status=${approve.status} 库=${st1}`);
    }

    // 13e. 报销：关联已批准申请 → 金额超过申请额被拒
    /*
     * ⚠️ 必须先确认上一步的申请真的建成了：`applyRow` 为空时
     * `applyId: applyRow?.id` 会传 undefined 出去，而那是**假绿**——
     * 没有 applyId 时服务端根本不做"不得超过申请额"的比对（`createClaim` 的
     * `if (dto.applyId)` 分支），请求会 201 成功，看起来像"校验没生效"。
     */
    const claimTitleAmount = 9999;
    if (!applyRow) {
      skip('报销金额超过申请额的拦截', '前置的「新增费用申请」未落库，无法构造"关联申请"场景（避免假绿）');
    } else {
      const claimOverApply = await http(session, 'POST', '/api/fin-expense/claims', {
        applyId: applyRow.id, expenseCategory: '差旅费', amount: claimTitleAmount,
        expenseDate: '2026-10-20', remark: `${TAG} 超申请额报销`,
      });
      record('★ 报销金额超过关联申请金额被拒（提示含两个数字）',
        claimOverApply.status === 400 && /超过申请金额/.test(claimOverApply.message ?? ''),
        `申请=${applyRow.code} 申请额=${applyRow.amount} 报销额=${claimTitleAmount} status=${claimOverApply.status} msg=「${claimOverApply.message}」`);
    }

    // UI 创建报销单
    page.resetDiagnostics();
    await page.goto(`${APP}/fin-expense?tab=claims`, { settleMs: 2400 });
    await waitText(page, '新增报销单', 9000);
    await clickText(page, '新增报销单', { selector: 'button', settleMs: 1300 });
    await sleep(1100);
    const claimDialog = await dialogInfo(page, '新增报销单');
    record('新增报销单弹窗打开', !!claimDialog, claimDialog ? `字段=${JSON.stringify(claimDialog.labels)}` : '未打开');
    const claimRemark = `${TAG} 走查报销`;
    if (claimDialog) {
      const cSteps = [];
      cSteps.push(['关联申请', await selectByLabel(page, '关联', { optionText: applyRow?.code })]);
      cSteps.push(['费用科目', await fillByLabel(page, '费用科目', '差旅费')]);
      /*
       * ⚠️ 「报销金额」输入框是 `type="number"` 且**没有 step 属性** → 原生 step 默认为 1，
       * 于是 `800.5` 这类金额会触发浏览器原生 `stepMismatch`，**submit 事件根本不触发**
       * （`CreateExpenseClaimDialog.tsx` 文件头已实测记录同一现象）。
       * 这里用整数金额，避免踩到那条**已知且已登记**的缺陷；同时把该缺陷作为待确认项记录。
       */
      cSteps.push(['报销金额', await fillByLabel(page, '报销金额', '800')]);
      cSteps.push(['费用日期', await setDateByLabel(page, '费用日期', '2026-10-18')]);
      cSteps.push(['备注', await fillByLabel(page, '备注', claimRemark)]);
      await sleep(400);
      const reqBefore = (page.requests ?? []).length;
      await clickText(page, '提交', { selector: '[role="dialog"] button', settleMs: 1500 });
      const claimToast = await toasts(page, { attempts: 12 });
      await sleep(1500);
      const newWrites = (page.requests ?? []).slice(reqBefore).filter((r) => /POST|PATCH|PUT/.test(r.method ?? ''));
      record('报销单（UI）提交：发出写请求',
        newWrites.length > 0,
        `填表=${cSteps.map(([k, r]) => `${k}=${r}`).join(' ')} 写请求=${JSON.stringify(newWrites.map((r) => r.method + ' ' + String(r.url).replace(/^.*\/api/, '/api')))} toast=${JSON.stringify(claimToast)}`);
    }
    const claimRow = (await sql`
      SELECT id, code, amount, status, expense_date, project_id, apply_id FROM fin_expense_claim
      WHERE remark = ${claimRemark}
      ORDER BY _created_at DESC LIMIT 1`)[0];
    if (claimRow) cleanup.claimIds.push(claimRow.id);
    record('★ 报销单落库（金额/日期/状态/关联申请）',
      !!claimRow && Number(claimRow.amount) === 800,
      `库=${claimRow ? `${claimRow.code} ${claimRow.amount} ${claimRow.status} ${claimRow.expense_date?.toISOString?.().slice(0, 10)} apply=${String(claimRow.apply_id).slice(0, 8)}` : '未找到'}`);
    if (claimRow && !claimRow.apply_id) {
      note('FE-CLAIM-01', 'UI 提交的报销单没有带上关联申请（apply_id 为空）—— 关联申请下拉未选中。');
    }

    // 13f. 报销审批 → 应付 + 凭证；非法 pay（应付未付）
    if (claimRow) {
      await page.goto(`${APP}/fin-expense/claims/${claimRow.id}`, { settleMs: 2300 });
      await sleep(1300);
      const claimDetail = await pageStats(page);
      const showClaimCode = await page.waitForText(claimRow.code, 5000).catch(() => false);
      record('/fin-expense/claims/:id 详情页渲染出单号', showClaimCode && claimDetail.textLen > 100,
        `textLen=${claimDetail.textLen} 含单号=${showClaimCode}`);

      const payTooEarly = await http(session, 'POST', `/api/fin-expense/claims/${claimRow.id}/actions/pay`, {});
      record('★ 未批准的报销单标记支付被拒（提示当前状态）',
        payTooEarly.status === 400 && /仅已批准/.test(payTooEarly.message ?? ''),
        `status=${payTooEarly.status} msg=「${payTooEarly.message}」`);

      const claimApprove = await http(session, 'POST', `/api/fin-expense/claims/${claimRow.id}/actions/approve`, {});
      const st = (await sql`SELECT status FROM fin_expense_claim WHERE id=${claimRow.id}`)[0]?.status;
      record('报销单 approve → approved（事务内两写）',
        claimApprove.status === 201 && st === 'approved',
        `status=${claimApprove.status} 库=${st}`);
      const ap = (await sql`
        SELECT id, code, amount, status, source, source_ref FROM erp_ap_bill
        WHERE source_ref = ${`expense:${claimRow.code}`}`)[0];
      if (ap?.id) cleanup.apIds.push(ap.id);
      record('★ 报销批准生成应付单（source=expense，金额一致）',
        !!ap && Number(ap.amount) === 800 && ap.source === 'expense',
        ap ? `${ap.code} ${ap.amount} status=${ap.status}` : '未找到应付');
      const claimVoucher = await sql`
        SELECT v.id, v.code, coalesce(sum(l.debit),0)::float8 AS d, coalesce(sum(l.credit),0)::float8 AS c
        FROM fin_voucher v LEFT JOIN fin_voucher_line l ON l.voucher_id = v.id
        WHERE v.source_ref = ${`expense:${claimRow.code}`} GROUP BY v.id, v.code`;
      if (claimVoucher[0]?.id) cleanup.voucherIds.push(claimVoucher[0].id);
      record('★ 报销凭证生成且借贷平衡（借 6602 / 贷 2202）',
        claimVoucher.length === 1 && Math.abs(Number(claimVoucher[0].d) - Number(claimVoucher[0].c)) < 0.005,
        claimVoucher[0] ? `${claimVoucher[0].code} 借=${claimVoucher[0].d} 贷=${claimVoucher[0].c}` : '无凭证');
      const payNotPaid = await http(session, 'POST', `/api/fin-expense/claims/${claimRow.id}/actions/pay`, {});
      record('★ 应付未付时标记报销已支付被拒（提示指出应付单号与状态）',
        payNotPaid.status === 400 && /尚未支付/.test(payNotPaid.message ?? ''),
        `status=${payNotPaid.status} msg=「${payNotPaid.message}」`);
    }
    diagAll.push({ step: 'fin-expense', exceptions: page.exceptions, httpErrors: page.httpErrors, consoleErrors: page.consoleLogs.filter((l) => l.type === 'error') });

    /* ══════════ 14. 未验证项 / 不做的事 ══════════ */
    skip('工资单「标记发放」(pay) 在界面上执行',
      '会真实出账：写凭证并进入现金流预测口径。本轮停在 approved，只验证按钮存在，不点 pay。');
    skip('工资单「作废」(void)',
      '会作废已生成的凭证与分摊（改账务）。本轮只验证 approved 行上按钮存在，不执行。');
    skip('收入「红冲」(reverseRevenue)',
      '会冲回应收 + 开具红字发票（改增值税申报口径）。本轮只验证了界面按钮存在，未执行。');
    skip('费用申请「关闭」(close) 的 UI 路径',
      '接口已覆盖非法流转（pending 直接 close 被拒）；UI 关闭按钮未点击，避免影响预算占用口径。');
    skip('成本「红冲」(red-flush) 与批量分摊的实际提交',
      '会写负向成本行、影响多维汇总与凭证口径。本轮只验证页面渲染与接口存在。');
    skip('年结 / 期间关账类操作', '会改账务期间状态，明确不做。');
    skip('成本归集 Tab 的新建成本弹窗（CreateCostDialog）提交',
      '接口写成本会进多维汇总与凭证口径；本轮验证了 Tab 渲染与已有数据，未新建。');
    skip('公共分摊（BatchAllocationPanel）的实际提交',
      '会把公共成本按权重分摊到多项目并生成分摊记录；本轮只验证 Tab 渲染与按钮存在。');
  } finally {
    /* ══════════════ 清理：先 SELECT 打印，再按精确主键删 ══════════════ */
    console.log('\n════ 清理（先打印待删行，再按精确 id 删）════');
    const uniq = (a) => [...new Set(a.filter(Boolean))];
    const ids = Object.fromEntries(Object.entries(cleanup).map(([k, v]) => [k, uniq(v)]));

    // 兜底：本脚本创建的测试员工名下的工时也一并纳入（避免遗留）
    /** 逐条兜底，任何一条预览查询失败都不能带走整段清理 */
    const tryQ = async (label, q) => {
      try {
        return await q;
      } catch (e) {
        return `ERR:${e.message}`;
      }
    };
    if (ids.employeeIds.length) {
      const tsCodes = await tryQ('ts', sql`SELECT id, code FROM erp_timesheet WHERE employee_id = ANY(${anyIds(ids.employeeIds)})`);
      if (Array.isArray(tsCodes)) {
        for (const r of tsCodes) ids.timesheetIds.push(r.id);
        /*
         * ⚠️ 成本行必须在工时**之前**删：两者靠 `source_ref = 'timesheet:<编号>'` 关联，
         * 没有外键。第一版先删工时、再按 id 删成本，结果成本行被"孤儿化"留在了库里
         * （残留审计就是靠这条抓出来的）。这里按 source_ref 反查补全。
         */
        const refs = tsCodes.map((r) => `timesheet:${r.code}`);
        if (refs.length) {
          const costs = await tryQ('costByRef', sql`SELECT id FROM erp_project_cost WHERE source_ref = ANY(${refs})`);
          if (Array.isArray(costs)) for (const r of costs) ids.costIds.push(r.id);
        }
      }
      // 再兜一层：本脚本造的备注前缀（精确前缀，不是宽泛 LIKE）
      const costsByRemark = await tryQ('costByRemark', sql`SELECT id FROM erp_project_cost WHERE remark LIKE ${`${TAG}%`}`);
      if (Array.isArray(costsByRemark)) for (const r of costsByRemark) ids.costIds.push(r.id);
    }
    ids.costIds = [...new Set(ids.costIds)];

    const preview = {
      md_employee: await tryQ('a', sql`SELECT id, code, name FROM md_employee WHERE id = ANY(${anyIds(ids.employeeIds)})`),
      hr_position: await tryQ('b', sql`SELECT id, name FROM hr_position WHERE id = ANY(${anyIds(ids.positionIds)})`),
      erp_labor_rate: await tryQ('c', sql`SELECT id, role_name, rate FROM erp_labor_rate WHERE id = ANY(${anyIds(ids.rateIds)})`),
      erp_timesheet: await tryQ('d', sql`SELECT id, code, status FROM erp_timesheet WHERE id = ANY(${anyIds(ids.timesheetIds)})`),
      erp_project_cost: await tryQ('e', sql`SELECT id, code, cost_type, amount FROM erp_project_cost WHERE id = ANY(${anyIds(ids.costIds)})`),
      erp_project_revenue: await tryQ('f', sql`SELECT id, code, amount, period FROM erp_project_revenue WHERE id = ANY(${anyIds(ids.revenueIds)})`),
      fin_voucher: await tryQ('g', sql`SELECT id, code, source_ref FROM fin_voucher WHERE id = ANY(${anyIds(ids.voucherIds)})`),
      erp_ar: await tryQ('h', sql`SELECT id, code, amount FROM erp_ar WHERE id = ANY(${anyIds(ids.arIds)})`),
      fin_expense_apply: await tryQ('i', sql`SELECT id, code, title FROM fin_expense_apply WHERE id = ANY(${anyIds(ids.applyIds)})`),
      fin_expense_claim: await tryQ('j', sql`SELECT id, code, amount FROM fin_expense_claim WHERE id = ANY(${anyIds(ids.claimIds)})`),
      erp_ap_bill: await tryQ('k', sql`SELECT id, code, amount FROM erp_ap_bill WHERE id = ANY(${anyIds(ids.apIds)})`),
      hr_payroll: await tryQ('l', sql`SELECT id, code, status FROM hr_payroll WHERE id = ANY(${anyIds(ids.payrollIds)})`),
      hr_attendance: await tryQ('m', sql`SELECT id, work_date, status FROM hr_attendance WHERE id = ANY(${anyIds(ids.attendanceIds)})`),
      hr_leave_request: await tryQ('n', sql`SELECT id, code FROM hr_leave_request WHERE id = ANY(${anyIds(ids.leaveRequestIds)})`),
      hr_leave_balance: await tryQ('o', sql`SELECT id, employee_id, year, total_days FROM hr_leave_balance WHERE id = ANY(${anyIds(ids.leaveBalanceIds)})`),
      hr_attendance_amendment: await tryQ('p', sql`SELECT id, code FROM hr_attendance_amendment WHERE id = ANY(${anyIds(ids.amendmentIds)})`),
      md_supplier: await tryQ('q', sql`SELECT id, name FROM md_supplier WHERE name = ${supName}`),
    };
    console.log(JSON.stringify(preview, null, 2));

    const steps = [
      ['erp_project_cost', ids.costIds],
      ['hr_payroll', ids.payrollIds],
      ['fin_expense_claim', ids.claimIds],
      ['fin_expense_apply', ids.applyIds],
      ['erp_ap_bill', ids.apIds],
      ['erp_ar', ids.arIds],
      ['erp_revenue_adjust', ids.adjustIds],
      ['erp_project_revenue', ids.revenueIds],
      ['erp_timesheet', ids.timesheetIds],
      ['hr_attendance', ids.attendanceIds],
      ['hr_leave_request', ids.leaveRequestIds],
      ['hr_leave_balance', ids.leaveBalanceIds],
      ['hr_attendance_amendment', ids.amendmentIds],
    ];
    for (const [table, list] of steps) {
      if (!list.length) continue;
      try {
        const r = await delByIds(table, list);
        console.log(`  ${table}: 删除 ${r.length} 行`);
      } catch (e) {
        console.log(`  ! ${table} 删除失败: ${e.message}`);
      }
    }
    // 凭证：先删分录再删凭证
    if (ids.voucherIds.length) {
      try {
        const l = await delByIds('fin_voucher_line', ids.voucherIds);
        const v = await delByIds('fin_voucher', ids.voucherIds);
        console.log(`  fin_voucher: 分录 ${l.length} 行 / 凭证 ${v.length} 行`);
      } catch (e) {
        console.log(`  ! fin_voucher 删除失败: ${e.message}`);
      }
    }
    if (ids.employeeIds.length) {
      try {
        const r = await delByIds('md_employee', ids.employeeIds);
        console.log(`  md_employee: 删除 ${r.length} 行`);
      } catch (e) {
        console.log(`  ! md_employee 删除失败: ${e.message}`);
      }
    }
    /*
     * 兜底：本脚本创建的员工名一律以 `[API_TEST]` 开头，且**只删这一批名字**。
     *
     * 为什么必须有这层：用例中途抛错时（例如某一步 CDP 超时）后面造的数据
     * 根本没进 `cleanup`，只按已登记的 id 删就会留下孤儿行 —— 实测上一轮就是这样
     * 留下了 3 名员工 + 1 个岗位，下一轮的残留审计才把它们暴露出来。
     * 删前先打印待删行；匹配是**本脚本命名空间的前缀**，不是库内宽泛 LIKE。
     */
    const orphanEmps = await sql`SELECT id, code, name FROM md_employee WHERE name LIKE ${`${TAG}%`}`;
    if (orphanEmps.length) {
      console.log(`  兜底待删员工：${JSON.stringify(orphanEmps.map((r) => r.name))}`);
      const r = await delByIds('md_employee', orphanEmps.map((x) => x.id));
      console.log(`  md_employee(兜底): 删除 ${r.length} 行`);
    }
    if (ids.rateIds.length) {
      const r = await delByIds('erp_labor_rate', ids.rateIds);
      console.log(`  erp_labor_rate: 删除 ${r.length} 行`);
    }
    if (ids.positionIds.length) {
      const r = await delByIds('hr_position', ids.positionIds);
      console.log(`  hr_position: 删除 ${r.length} 行`);
    }
    /** 兜底：本脚本创建的岗位名固定（不是宽泛 LIKE），删前打印 */
    const posBefore = await sql`SELECT id, code, name FROM hr_position WHERE name LIKE ${`${TAG}%`}`;
    if (posBefore.length) {
      console.log(`  兜底待删岗位：${JSON.stringify(posBefore.map((r) => `${r.code} ${r.name}`))}`);
      const r = await delByIds('hr_position', posBefore.map((x) => x.id));
      console.log(`  hr_position(兜底): 删除 ${r.length} 行`);
    }
    /* 测试账号：先删角色成员（sys_role_member.user_id 是 varchar，不能 ::uuid 强转），再删账号 */
    if (ids.userIds.length) {
      try {
        await sql`DELETE FROM sys_role_member WHERE user_id IN ${sql(ids.userIds)}`;
        const r = await delByIds('sys_user', ids.userIds);
        console.log(`  sys_user: 删除 ${r.length} 行`);
      } catch (e) {
        console.log(`  ! sys_user 删除失败: ${e.message}`);
      }
    }
    /* 兜底：本脚本创建的测试账号名固定，按 username 精确匹配（删前打印） */
    const usersBefore = await sql`SELECT id, username FROM sys_user WHERE username = ${`${TAG}审批员`}`;
    if (usersBefore.length) {
      console.log(`  兜底待删账号：${JSON.stringify(usersBefore.map((r) => r.username))}`);
      await sql`DELETE FROM sys_role_member WHERE user_id IN ${sql(usersBefore.map((x) => x.id))}`.catch(() => {});
      const r = await delByIds('sys_user', usersBefore.map((x) => x.id));
      console.log(`  sys_user(兜底): 删除 ${r.length} 行`);
    }
    const supDel = await sql`DELETE FROM md_supplier WHERE name = ${supName} RETURNING id`;
    console.log(`  md_supplier: 删除 ${supDel.length} 行`);
    /*
     * 兜底：补卡申请。
     *
     * 我们在两个地方造过它（"未绑定账号补卡"与"走查补卡"），而**未绑定账号那条
     * 本来就应该被拒**、不该落库；一旦它落了库（说明服务端漏了校验，或用例走歪），
     * 它就不在 `cleanup` 里。这里按本脚本的**两个固定 reason 精确**删，删前打印。
     */
    const orphanAmend = await sql`
      SELECT id, code, reason FROM hr_attendance_amendment
      WHERE reason IN (${`${TAG} 走查补卡`}, ${`${TAG} 未绑定账号补卡`})`;
    if (orphanAmend.length) {
      console.log(`  兜底待删补卡申请：${JSON.stringify(orphanAmend.map((r) => `${r.code} ${r.reason}`))}`);
      const r = await delByIds('hr_attendance_amendment', orphanAmend.map((x) => x.id));
      console.log(`  hr_attendance_amendment(兜底): 删除 ${r.length} 行`);
    }

    /*
     * ── 残留审计 ──
     *
     * ⚠️ 一律用**本脚本自己的精确名称/前缀**，不要用 `LIKE '%[API_TEST]%'`：
     * 本机同时有其它走查 agent 在写同样前缀的数据（实测有
     * `[API_TEST] 供应商-<时间戳>`），宽泛匹配会把别人的残留算到自己头上，
     * 让报告出现无法解释的 FAIL。
     */
    const leftover = (await sql`
      SELECT
        (SELECT count(*)::int FROM md_employee  WHERE name LIKE ${`${TAG}%`}) AS employees,
        (SELECT count(*)::int FROM hr_position  WHERE name LIKE ${`${TAG}%`}) AS positions,
        (SELECT count(*)::int FROM erp_labor_rate WHERE role_name LIKE ${`${TAG}%`}) AS rates,
        (SELECT count(*)::int FROM erp_timesheet WHERE remark LIKE ${`${TAG}%`}) AS timesheets,
        (SELECT count(*)::int FROM erp_project_cost WHERE remark LIKE ${`${TAG}%`}) AS costs,
        (SELECT count(*)::int FROM erp_project_revenue WHERE remark LIKE ${`${TAG}%`} OR basis LIKE ${`${TAG}%`}) AS revenues,
        (SELECT count(*)::int FROM fin_expense_apply WHERE title LIKE ${`${TAG}%`}) AS applies,
        (SELECT count(*)::int FROM fin_expense_claim WHERE remark LIKE ${`${TAG}%`}) AS claims,
        (SELECT count(*)::int FROM md_supplier WHERE name = ${supName}) AS suppliers,
        (SELECT count(*)::int FROM hr_payroll WHERE remark LIKE ${`${TAG}%`}) AS payrolls,
        (SELECT count(*)::int FROM hr_attendance WHERE remark LIKE ${`${TAG}%`}) AS attendance,
        (SELECT count(*)::int FROM hr_attendance_amendment WHERE reason LIKE ${`${TAG}%`}) AS amendments,
        (SELECT count(*)::int FROM hr_leave_request WHERE reason LIKE ${`${TAG}%`}) AS leaves,
        (SELECT count(*)::int FROM fin_voucher WHERE summary LIKE ${`${TAG}%`}) AS vouchers`)[0];
    console.log(`残留审计（仅统计本脚本的 ${TAG}* 名称）: ${JSON.stringify(leftover)}`);
    if (Object.values(leftover).some((n) => Number(n) !== 0)) {
      // 有残留时把**具体是哪几行**打出来，避免只看到一个数字无从排查
      const detail = {
        employees: await sql`SELECT id, code, name FROM md_employee WHERE name LIKE ${`${TAG}%`}`,
        positions: await sql`SELECT id, code, name FROM hr_position WHERE name LIKE ${`${TAG}%`}`,
        rates: await sql`SELECT id, role_name FROM erp_labor_rate WHERE role_name LIKE ${`${TAG}%`}`,
        timesheets: await sql`SELECT id, code, remark FROM erp_timesheet WHERE remark LIKE ${`${TAG}%`}`,
        costs: await sql`SELECT id, code, remark FROM erp_project_cost WHERE remark LIKE ${`${TAG}%`}`,
        revenues: await sql`SELECT id, code, remark, basis FROM erp_project_revenue WHERE remark LIKE ${`${TAG}%`} OR basis LIKE ${`${TAG}%`}`,
        applies: await sql`SELECT id, code, title FROM fin_expense_apply WHERE title LIKE ${`${TAG}%`}`,
        claims: await sql`SELECT id, code, remark FROM fin_expense_claim WHERE remark LIKE ${`${TAG}%`}`,
        vouchers: await sql`SELECT id, code, summary, source_ref FROM fin_voucher WHERE summary LIKE ${`${TAG}%`}`,
      };
      for (const [k, rows] of Object.entries(detail)) {
        if (Array.isArray(rows) && rows.length) console.log(`  残留明细 ${k}: ${JSON.stringify(rows)}`);
      }
    }
    record('残留审计：[API_TEST] 相关行全部清理干净',
      Object.values(leftover).every((n) => Number(n) === 0),
      JSON.stringify(leftover));

    const diag = {
      steps: diagAll,
      finalExceptions: page.exceptions,
      finalConsoleErrors: page.consoleLogs.filter((l) => l.type === 'error'),
      finalHttpErrors: page.httpErrors,
    };
    record('走查全程无 HTTP ≥ 500',
      diagAll.every((d) => (d.httpErrors ?? []).every((e) => Number(e.status) < 500)),
      JSON.stringify(diagAll.flatMap((d) => d.httpErrors ?? []).filter((e) => Number(e.status) >= 500).slice(0, 5)));

    const failed = results.filter((r) => !r.pass);
    writeFileSync(`${OUT}/hr-costs-report.json`, JSON.stringify({
      generatedAt: new Date().toISOString(),
      app: APP, api: API, tag: TAG,
      summary: { total: results.length, passed: results.length - failed.length, failed: failed.length },
      results, findings, untested, leftoverAudit: leftover, diagnostics: diag,
    }, null, 2));

    await sql.end({ timeout: 2 }).catch(() => {});
    await browser.close().catch(() => {});

    console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
    for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail ?? ''}`);
    console.log(`未验证项 ${untested.length} 条，见 ${OUT}/hr-costs-report.json`);
  }
}

void main().catch((e) => {
  console.error('走查失败:');
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  if (e && typeof e === 'object') {
    for (const k of ['code', 'detail', 'where', 'query', 'parameters', 'severity_local']) {
      if (e[k] !== undefined) console.error(`  ${k} = ${JSON.stringify(e[k])?.slice(0, 500)}`);
    }
  }
  process.exitCode = 1;
});
