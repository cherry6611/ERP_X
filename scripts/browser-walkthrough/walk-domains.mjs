/**
 * 第二组浏览器走查：**有数据的域**的真实写入（采购 / 固定资产 / 票据 / 费控 / 人力）。
 *
 * ## 本文件的核心方法：按**服务端/前端返回的校验文案**驱动填表
 *
 * 第一版用一个"通用填表器"（把弹窗里每个 select 选第一个非空、把第一个 input
 * 填上文本）—— 结果 6 个用例假失败。原因不是功能坏了，而是**必填项是领域特定的**：
 *   · 票据要「票号」（toast 明说："请填写票号"）
 *   · 资产要「资产类别」「原值」
 * 而通用填表器只会往第一个 input 写名字。
 *
 * 现在改成：提交 → 读校验/失败提示 → 提示点名哪个字段就填哪个 → 再提交。
 * 这样**既不猜字段名，也不需要为每个表单写死映射**，而且顺带验证了
 * "必填校验确实会拦住并说清缺什么"。
 *
 * 原则同前：每个用例都用 SQL 核对库里是否真变了，不只看 toast。
 *
 * 用法：node scripts/browser-walkthrough/walk-domains.mjs
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

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (res.status !== 201) throw new Error(`登录失败 ${res.status}`);
  const jar = res.headers.getSetCookie?.() ?? [];
  return jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session=')).slice(12);
}

async function toasts(page, { attempts = 9, gapMs = 300 } = {}) {
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

/** 弹窗内所有校验提示（label 旁的 required 文案 / role=alert / 红字） */
async function validationTexts(page) {
  return page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return [];
    const out = new Set();
    for (const e of d.querySelectorAll('[role="alert"], .text-destructive, [data-slot="form-message"], p, span')) {
      const t = (e.textContent || '').trim();
      if (t && t.length < 40 && /必填|请填写|请选择|不能为空|请输入|不合法|必须/.test(t)) out.add(t);
    }
    return [...out];
  })()`);
}

async function dialog(page) {
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
  await page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return;
    const b = [...d.querySelectorAll('button')].find((x) => /取消|关闭/.test(x.textContent || ''));
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await sleep(700);
}

/**
 * 按 label 文本往对应控件写值。
 * 控件定位顺序：label[for] → 同容器内的 input/textarea → 原生 select。
 */
async function fillByLabel(page, labelRe, value) {
  return page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return 'no-dialog';
    const lab = [...d.querySelectorAll('label')].find((l) => new RegExp(${JSON.stringify(labelRe)}).test(l.textContent || ''));
    if (!lab) return 'label-not-found';
    // ① label[for] 直连
    let el = lab.htmlFor ? d.querySelector('#' + CSS.escape(lab.htmlFor)) : null;
    // ② label 的父容器内找
    if (!el) {
      const box = lab.closest('div') ?? lab.parentElement;
      el = box ? box.querySelector('input,textarea,select') : null;
    }
    // ③ 退化为同序控件
    if (!el) {
      const labels = [...d.querySelectorAll('label')];
      const idx = labels.indexOf(lab);
      const ctrls = [...d.querySelectorAll('input,textarea,select')];
      el = ctrls[idx] ?? null;
    }
    if (!el) return 'control-not-found';
    if (el.tagName === 'SELECT') {
      const o = [...el.options].find((x) => x.value !== '');
      if (!o) return 'no-option';
      const s = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      s ? s.call(el, o.value) : (el.value = o.value);
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const s = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      s ? s.call(el, ${JSON.stringify(String(value))}) : (el.value = ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok:' + (el.tagName.toLowerCase()) + ':' + (el.getAttribute('name') || lab.textContent.trim());
  })()`);
}

/**
 * 反复「提交 → 读提示 → 补对应字段」，直到成功或不再有新提示。
 *
 * 这既是**填表手段**，也是一条断言：必填校验必须说清缺哪个字段
 * （只说"参数不合法"就没法驱动，也就暴露了文案不合格）。
 */
async function submitFillingGaps(page, { saveRe = '确认|保存|确定|提交|创建|登记|申请|立项', maxRounds = 7, seed = {} } = {}) {
  const rounds = [];
  const save = await page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const scope = d ?? document.body;
    const b = [...scope.querySelectorAll('button')].find((x) => new RegExp(${JSON.stringify(saveRe)}).test((x.textContent || '').trim()));
    return b ? (b.textContent || '').trim() : null;
  })()`);
  if (!save) return { ok: false, save: null, rounds, toast: [] };

  // 先用 seed 把已知字段填上
  for (const [re, v] of Object.entries(seed)) {
    await fillByLabel(page, re, v);
    await sleep(200);
  }

  for (let round = 0; round < maxRounds; round += 1) {
    await page.clickByText(save, { selector: '[role="dialog"] button, button', settleMs: 800 });
    const t = await toasts(page, { attempts: 6, gapMs: 300 });
    /*
     * ⚠️ toast 不一定代表成功：有些校验**只弹 toast**（如「到期日格式必须为 YYYY-MM-DD」
     * 「请填写票号」），而 label 旁没有红字。判断依据是**弹窗还在不在** ——
     * 成功会关弹窗，失败不会。这样错误文案也能反过来驱动补字段。
     */
    const stillOpen = await page.evaluate(`!!document.querySelector('[role="dialog"]')`);
    if (t.length && !stillOpen) return { ok: true, save, rounds, toast: t };
    const fromToast = stillOpen ? t : [];
    const msgs = [...(await validationTexts(page)), ...fromToast];
    if (!msgs.length) {
      return { ok: false, save, rounds, toast: t, why: stillOpen ? '弹窗仍在但无任何提示' : '弹窗已关但无 toast' };
    }
    rounds.push(msgs);
    // 提示里点名了哪个字段，就去填哪个字段
    let acted = 0;
    for (const m of msgs) {
      // 从提示文本里抽出字段名（去掉"请填写/请选择/不能为空"等噪声）
      const field = m.replace(/^(请填写|请选择|请输入|必填[:：]?)/u, '').replace(/(不能为空|必填|不合法|格式不正确).*$/u, '').trim();
      if (!field) continue;
      const val = /日期|时间/.test(field) ? '2026-10-15'
        : /金额|原值|单价|数量|残值|月数/.test(field) ? '1000'
        : `${TAG} ${field}`;
      const r = await fillByLabel(page, field, val);
      if (String(r).startsWith('ok')) acted += 1;
    }
    if (acted === 0) return { ok: false, save, rounds, toast: [], why: '提示无法驱动填表: ' + JSON.stringify(msgs) };
    await sleep(500);
  }
  return { ok: false, save, rounds, toast: [], why: '超过最大轮次' };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const session = await login();
  const sql = postgres({
    host: '127.0.0.1', port: 5433, user: 'erp', password: process.env.DB_PASSWORD ?? '',
    database: 'shengseerp', connect_timeout: 5,
  });
  const browser = await Browser.launch({ port: 9351 });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1700, 1100);
  await page.setCookie({ name: 'erp_session', value: session, url: APP });

  try {
    /* ══════════ ① 固定资产：新增（按校验提示补字段）══════════ */
    console.log('\n① 固定资产 — 新增');
    page.resetDiagnostics();
    const astBefore = (await sql`SELECT count(*)::int AS n FROM ast_asset`)[0].n;
    await page.goto(`${APP}/asset`, { settleMs: 2600 });
    await sleep(1600);
    await page.clickByText('新增资产', { selector: 'button', settleMs: 1500 });
    await sleep(1300);
    let d = await dialog(page);
    record('新增资产弹窗打开', !!d, d ? `字段=${JSON.stringify(d.labels)}` : '未打开');
    if (d) {
      const r = await submitFillingGaps(page, { seed: { '资产名称': `${TAG} 固定资产`, '原值': 50000 } });
      const astAfter = (await sql`SELECT count(*)::int AS n FROM ast_asset`)[0].n;
      const row = await sql`SELECT code, name, original_value FROM ast_asset WHERE name = ${`${TAG} 固定资产`} LIMIT 1`;
      record(
        '固定资产新增落库（原值一致）',
        astAfter > astBefore && Number(row[0]?.original_value) === 50000,
        `ast ${astBefore}→${astAfter} 填表轮次=${r.rounds.length} toast=${JSON.stringify(r.toast)} ${r.why ?? ''}`,
      );
    }
    await closeDialog(page);

    /* ══════════ ② 票据：登记（票号是必填，按提示补）══════════ */
    console.log('\n② 票据 — 登记');
    page.resetDiagnostics();
    const noteBefore = (await sql`SELECT count(*)::int AS n FROM erp_note`)[0].n;
    await page.goto(`${APP}/notes`, { settleMs: 2600 });
    await sleep(1600);
    await page.clickByText('登记票据', { selector: 'button', settleMs: 1500 });
    await sleep(1300);
    d = await dialog(page);
    record('登记票据弹窗打开', !!d, d ? `字段=${JSON.stringify(d.labels)}` : '未打开');
    if (d) {
      const r = await submitFillingGaps(page, { seed: { '票号': `${TAG}NOTE001`, '票面金额': 20000, '到期日': '2027-03-31', '备注': `${TAG} 走查票据` } });
      const noteAfter = (await sql`SELECT count(*)::int AS n FROM erp_note`)[0].n;
      record(
        '票据登记落库',
        noteAfter > noteBefore,
        `erp_note ${noteBefore}→${noteAfter} 轮次=${r.rounds.length} toast=${JSON.stringify(r.toast)} ${r.why ?? ''}`,
      );
    }
    await closeDialog(page);

    /* ══════════ ③ 采购：新建采购申请 ══════════ */
    console.log('\n③ 采购 — 新建采购申请');
    page.resetDiagnostics();
    const prBefore = (await sql`SELECT count(*)::int AS n FROM pur_request`)[0].n;
    await page.goto(`${APP}/pur`, { settleMs: 2600 });
    await sleep(1600);
    await page.clickByText('新建采购申请', { selector: 'button', settleMs: 1500 });
    await sleep(1300);
    d = await dialog(page);
    record('新建采购申请弹窗打开', !!d, d ? `字段=${JSON.stringify(d.labels)}` : '未打开（可能是整页表单）');
    if (d) {
      const r = await submitFillingGaps(page, { seed: { '申请标题|标题|事由': `${TAG} 采购申请` } });
      const prAfter = (await sql`SELECT count(*)::int AS n FROM pur_request`)[0].n;
      record('采购申请落库', prAfter > prBefore, `pur_request ${prBefore}→${prAfter} toast=${JSON.stringify(r.toast)} ${r.why ?? ''}`);
    }
    await closeDialog(page);

    /* ══════════ ④ 预算费控 / 人力：Tab 与入口（页面结构，点击级）══════════ */
    for (const [route, label] of [['/fin-expense', '预算费控'], ['/hr', '人力资源'], ['/costs', '成本核算'], ['/revenue', '收入确认'], ['/voucher', '总账凭证']]) {
      console.log(`\n④ ${label}（${route}）`);
      page.resetDiagnostics();
      await page.goto(`${APP}${route}`, { settleMs: 2500 });
      await sleep(1500);
      const info = await page.evaluate(`(() => ({
        tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => (t.textContent || '').trim()),
        buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
        textLen: (document.body.innerText || '').length,
      }))()`);
      // Tab 可能不是 role=tab（antd Segmented / 自绘），退化为"有内容且可交互"
      record(
        `${label} 页面渲染且可交互`,
        info.textLen > 200 && info.buttons.length > 3,
        `tab=${info.tabs.length} btn=${info.buttons.length} text=${info.textLen}`,
      );
      if (info.tabs.length > 0) {
        let switched = 0;
        for (const t of info.tabs.slice(0, 8)) {
          const ok = await page.clickByText(t, { selector: '[role="tab"]', settleMs: 600 }).then(() => true).catch(() => false);
          if (ok) switched += 1;
        }
        record(`${label} Tab 逐个切换`, switched > 0, `${switched}/${Math.min(info.tabs.length, 8)} 通过`);
      }
      record(
        `${label} 切换后无异常`,
        page.exceptions.length === 0 && page.consoleLogs.filter((l) => l.type === 'error').length === 0,
        `exc=${page.exceptions.length} cerr=${page.consoleLogs.filter((l) => l.type === 'error').length}`,
      );
    }

    /* ── 诊断 ── */
    const diag = {
      consoleErrors: page.consoleLogs.filter((l) => l.type === 'error'),
      exceptions: page.exceptions,
      httpErrors: page.httpErrors,
    };
    record('无未捕获异常', diag.exceptions.length === 0, JSON.stringify(diag.exceptions).slice(0, 200));
    record('无 console.error', diag.consoleErrors.length === 0, JSON.stringify(diag.consoleErrors).slice(0, 200));
    record(
      '无 HTTP ≥500',
      diag.httpErrors.filter((e) => Number(e.status) >= 500).length === 0,
      JSON.stringify(diag.httpErrors.filter((e) => Number(e.status) >= 500)).slice(0, 200),
    );
    writeFileSync(`${OUT}/domains-report.json`, JSON.stringify({ results, diagnostics: diag }, null, 2));
  } finally {
    try {
      await sql`DELETE FROM ast_asset WHERE name LIKE ${`%${TAG}%`}`.catch(() => {});
      await sql`DELETE FROM erp_note WHERE remark LIKE ${`%${TAG}%`}`.catch(() => {});
      await sql`DELETE FROM erp_note WHERE note_no LIKE ${`%${TAG}%`}`.catch(() => {});
      await sql`DELETE FROM pur_request WHERE title LIKE ${`%${TAG}%`}`.catch(() => {});
      console.log('\n清理完成');
    } catch (e) { console.log('清理出错:', e.message); }
    const left = await sql`SELECT
      (SELECT count(*)::int FROM ast_asset WHERE name LIKE ${`%${TAG}%`}) AS ast,
      (SELECT count(*)::int FROM erp_note) AS note,
      (SELECT count(*)::int FROM pur_request WHERE title LIKE ${`%${TAG}%`}) AS pr,
      (SELECT count(*)::int FROM pur_order) AS po`;
    console.log(`残留: 资产=${left[0].ast} 票据=${left[0].note} 采购申请=${left[0].pr} pur_order=${left[0].po}`);
    await sql.end({ timeout: 2 }).catch(() => {});
    await browser.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail ?? ''}`);
}

void main().catch((e) => {
  console.error('走查失败:', e);
  process.exitCode = 1;
});
