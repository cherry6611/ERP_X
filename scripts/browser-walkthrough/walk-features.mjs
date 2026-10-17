/**
 * 全功能浏览器交互走查：**真的点**每一项功能，并核对"界面说的"与"库里存的"一致。
 *
 * 与 `walk-routes.mjs` 的区别：那个只导航 + 截图（验证"页面能打开"）；
 * 这个要**进入整页表单 / 打开弹窗、填字段、点保存**，然后：
 *   · 抓 toast 文案（成功/失败）
 *   · 抓 console error / 未捕获异常 / HTTP ≥400
 *   · 用 SQL 核对库里的值是否真的按界面意图改变
 *
 * 用法（需先起 3100 API 与 5273 Vite，见 vite.walkthrough.config.ts）：
 *   node scripts/browser-walkthrough/walk-features.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const USER = process.env.WT_USER ?? 'chengsheng@chengshengdata.cn';
const PASS = process.env.WT_PASS ?? '******';
const OUT = 'scripts/browser-walkthrough/out';

const TAG = '[API_TEST]';
const CTR_NAME = `${TAG} 走查合同`;
const DS_NAME = `${TAG} 走查数据集`;
const INV_NO = `${TAG}ZP001`;

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
  const s = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session='));
  if (!s) throw new Error('未拿到 erp_session');
  return s.slice('erp_session='.length);
}

/**
 * 给受控 React 输入框设值。
 *
 * ⚠️ 必须走**原生 setter + input 事件**：`cdp.mjs` 的 `fill()` 用
 * `Input.insertText`，实测会把文本落进**当前聚焦的**元素（可能是别的输入框），
 * 在受控表单里不可靠。这里直接命中指定选择器。
 */
async function setInput(page, selector, value, index = 0) {
  return page.evaluate(`(() => {
    const els = document.querySelectorAll(${JSON.stringify(selector)});
    const el = els[${index}];
    if (!el) return 'not-found';
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, ${JSON.stringify(value)}) : (el.value = ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
}

/** 给原生 <select> 选一个非空选项 */
async function setNativeSelect(page, selector, index = 0) {
  return page.evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!el) return 'not-found';
    const opts = [...el.options].filter((o) => o.value !== '');
    if (!opts.length) return 'no-option';
    const opt = opts[0];
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter ? setter.call(el, opt.value) : (el.value = opt.value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return opt.textContent.trim();
  })()`);
}

/**
 * 轮询抓 toast 文案。
 *
 * ⚠️ 必须**轮询**而不是"睡固定时间后读一次"：sonner 的 toast 约 4s 后自动消失，
 * 而动作的耗时是不定的（有的要等接口回来）。实测固定 sleep 2000ms 后读，
 * 会因为 toast 已经消失而读到空数组 —— 那是**检测方法的问题，不是功能缺陷**
 * （同一时刻用 CDP 单独采样能稳定拿到 '合同无改动'）。
 */
async function toasts(page, { attempts = 6, gapMs = 250 } = {}) {
  const seen = [];
  for (let i = 0; i < attempts; i += 1) {
    const found = await page.evaluate(`(() => {
      const sels = ['[data-sonner-toast]', 'ol[data-sonner-toaster] li', '.ant-message-notice-content'];
      const out = [];
      for (const s of sels) for (const el of document.querySelectorAll(s)) {
        const t = (el.textContent || '').trim();
        if (t) out.push(t);
      }
      return out;
    })()`);
    for (const t of found) if (!seen.includes(t)) seen.push(t);
    if (seen.length) break; // 拿到就不再等
    await sleep(gapMs);
  }
  return seen;
}

async function dialogInfo(page) {
  return page.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return null;
    return {
      title: (dlg.querySelector('[role="heading"],h2')?.textContent || '').trim(),
      labels: [...dlg.querySelectorAll('label')].map((l) => (l.textContent || '').trim()),
      buttons: [...dlg.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
      textareaCount: dlg.querySelectorAll('textarea').length,
    };
  })()`);
}

async function closeDialog(page) {
  await page.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return;
    const b = [...dlg.querySelectorAll('button')].find((x) => /取消|关闭/.test(x.textContent || ''));
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await sleep(700);
}

/** 在表格里按文本找行，点其中的按钮 */
async function clickRowButton(page, rowText, buttonText) {
  return page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('tr')];
    const row = rows.find((r) => (r.textContent || '').includes(${JSON.stringify(rowText)}));
    if (!row) return 'row-not-found';
    const btn = [...row.querySelectorAll('button')]
      .find((b) => new RegExp(${JSON.stringify(buttonText)}).test((b.textContent || '').trim()));
    if (!btn) {
      return 'btn-not-found:' + [...row.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).join('|');
    }
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const session = await login();
  const api = (method, path, body) =>
    fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: `erp_session=${session}` },
      body: body ? JSON.stringify(body) : undefined,
    });

  const sql = postgres({
    host: '127.0.0.1', port: 5433, user: 'erp', password: '******',
    database: 'shengseerp', connect_timeout: 5,
  });
  const browser = await Browser.launch({ port: 9340 });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1700, 1100);
  await page.setCookie({ name: 'erp_session', value: session, url: APP });

  const created = { contractIds: [], datasetIds: [], invoiceIds: [] };

  try {
    const ctrs = await sql`SELECT id, code, name FROM erp_contract WHERE name NOT LIKE ${`%${TAG}%`} LIMIT 2`;

    /* ══════════════ ① 合同：登记（整页表单）→ 列表编辑 ══════════════ */
    console.log('\n① 合同 — 登记（整页表单）+ 编辑');
    page.resetDiagnostics();

    await page.goto(`${APP}/contracts`, { settleMs: 2300 });
    await sleep(1200);
    await page.clickByText('登记合同', { settleMs: 2000 });
    await sleep(1300);
    const url = await page.evaluate('location.href');
    record('列表「登记合同」→ 进入登记页', url.includes('/contracts/new'), url);

    const nameSet = await setInput(page, 'input[name="name"]', CTR_NAME, 0);
    record('填写合同名称', nameSet === 'ok', nameSet);
    const custPick = await setNativeSelect(page, 'select', 0);
    record('选择客户', custPick !== 'not-found' && custPick !== 'no-option', String(custPick));
    const bmPick = await setNativeSelect(page, 'select', 1);
    record('选择计费模式', bmPick !== 'not-found' && bmPick !== 'no-option', String(bmPick));
    const amtSet = await setInput(page, 'input[name="amount"]', '24680.13', 0);
    record('填写金额', amtSet === 'ok', amtSet);
    await sleep(500);

    await page.clickByText('保存', { selector: 'button', settleMs: 900 });
    const t1 = await toasts(page, { attempts: 8, gapMs: 300 });
    await sleep(900);
    record('点「保存」有反馈', t1.length > 0, `toast=${JSON.stringify(t1)}`);
    const row1 = await sql`SELECT id, name, amount, status FROM erp_contract WHERE name = ${CTR_NAME} LIMIT 1`;
    record(
      '库中出现该合同且金额一致',
      row1.length === 1 && Number(row1[0].amount) === 24680.13,
      row1.length ? `amount=${row1[0].amount} status=${row1[0].status}` : '未找到',
    );
    if (row1.length) created.contractIds.push(row1[0].id);

    await page.goto(`${APP}/contracts`, { settleMs: 2300 });
    await sleep(1600);
    const clickEdit = await clickRowButton(page, CTR_NAME, '编辑');
    record('该行渲染「编辑」按钮且可点', clickEdit === 'ok', clickEdit);
    await sleep(1600);
    const di = await dialogInfo(page);
    record(
      '编辑弹窗打开且标题为「编辑合同」',
      !!di && /编辑/.test(String(di?.title ?? '')),
      di ? `标题=${di.title} 按钮=${JSON.stringify(di.buttons)}` : '无弹窗',
    );
    if (di) {
      if (di.textareaCount > 0) await setInput(page, '[role="dialog"] textarea', `${TAG} 浏览器改备注`, 0);
      await sleep(400);
      const saveLabel = di.buttons.find((b) => /保存|确定/.test(b)) ?? '保存';
      await page.clickByText(saveLabel, { selector: '[role="dialog"] button', settleMs: 700 });
      const t2 = await toasts(page, { attempts: 8, gapMs: 300 });
      await sleep(700);
      record('保存编辑有反馈', t2.length > 0, `toast=${JSON.stringify(t2)}`);
      const after = await sql`SELECT remark, amount FROM erp_contract WHERE name = ${CTR_NAME} LIMIT 1`;
      record(
        '库中备注已更新（金额未被误改）',
        String(after[0]?.remark ?? '').includes('浏览器改备注') && Number(after[0]?.amount) === 24680.13,
        `remark=${String(after[0]?.remark ?? '').slice(0, 22)} amount=${after[0]?.amount}`,
      );
    }
    await closeDialog(page);

    /* ══════════════ ② 数据资产：新建 + 编辑关联合同 ══════════════ */
    console.log('\n② 数据资产 — 新建 + 编辑「关联合同」');
    page.resetDiagnostics();
    await page.goto(`${APP}/data-asset`, { settleMs: 2300 });
    await sleep(1600);
    await page.clickByText('新建数据集', { selector: 'button', settleMs: 1600 });
    await sleep(1300);
    let di2 = await dialogInfo(page);
    record('点「新建数据集」弹窗打开', !!di2, di2 ? `标题=${di2.title} 字段=${JSON.stringify(di2.labels)}` : '无弹窗');
    if (di2) {
      await setInput(page, '[role="dialog"] input', DS_NAME, 0);
      await sleep(400);
      const saveLabel = di2.buttons.find((b) => /保存|确定|创建/.test(b)) ?? '保存';
      await page.clickByText(saveLabel, { selector: '[role="dialog"] button', settleMs: 700 });
      const t3 = await toasts(page, { attempts: 8, gapMs: 300 });
      await sleep(700);
      const madeRow = await sql`SELECT id FROM da_dataset WHERE name = ${DS_NAME} LIMIT 1`;
      record('数据集已创建', madeRow.length === 1, `toast=${JSON.stringify(t3)}`);
      if (madeRow.length) created.datasetIds.push(madeRow[0].id);
    }
    await closeDialog(page);

    await page.goto(`${APP}/data-asset`, { settleMs: 2300 });
    await sleep(1600);
    const dsEdit = await clickRowButton(page, DS_NAME, '编辑');
    record('数据集行有「编辑」按钮', dsEdit === 'ok', dsEdit);
    await sleep(1600);
    di2 = await dialogInfo(page);
    if (di2) {
      record('编辑弹窗含「关联合同」字段', di2.labels.some((l) => l.includes('合同')), JSON.stringify(di2.labels));
      /*
       * 「关联合同」是 Radix Select（渲染成 role=combobox 的 button），
       * 其可见文本形如「CTR2026100002 数据中台一期合同…」或「不关联」。
       * 用 role=combobox + 文本包含 CTR/不关联/选择 来定位 ——
       * 不要只写 '未关联'，真实空态文案是「不关联」。
       */
      const state = await page.evaluate(`(() => {
        const dlg = document.querySelector('[role="dialog"]');
        const btns = [...dlg.querySelectorAll('button[role="combobox"]')];
        const btn = btns.find((b) => /CTR|不关联|请选择合同/.test(b.textContent || ''));
        return btn
          ? { disabled: !!btn.disabled, text: btn.textContent.trim(), comboboxCount: btns.length }
          : { disabled: null, text: null, comboboxCount: btns.length,
              all: btns.map((b) => (b.textContent || '').trim().slice(0, 24)) };
      })()`);
      record('「关联合同」下拉在编辑态可用（本轮修复点）', !!state && state.disabled === false, JSON.stringify(state));
      if (state) {
        await page.clickByText(state.text, { selector: '[role="dialog"] button', settleMs: 900 });
        /*
         * ⚠️ 用**合同编号**匹配，不要用合同名前缀：实测多个合同名共享
         * 「数据中台一期合同-…」前缀，截断后匹配会选错那一个。
         * 编号（CTR…）是唯一的。
         */
        const pick = await page.evaluate(`(() => {
          const opts = [...document.querySelectorAll('[role="option"]')];
          const o = opts.find((x) => (x.textContent || '').includes(${JSON.stringify(String(ctrs[0].code))}));
          if (!o) return 'option-not-found:' + opts.map((x) => (x.textContent || '').trim().slice(0, 24)).join('|');
          o.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return (o.textContent || '').trim().slice(0, 32);
        })()`);
        console.log('      选中选项:', pick);
        await sleep(600);
        const saveLabel = di2.buttons.find((b) => /保存|确定/.test(b)) ?? '保存';
        await page.clickByText(saveLabel, { selector: '[role="dialog"] button', settleMs: 700 });
        const t4 = await toasts(page, { attempts: 8, gapMs: 300 });
        await sleep(700);
        const after = await sql`SELECT contract_id FROM da_dataset WHERE name = ${DS_NAME} LIMIT 1`;
        record(
          '换绑合同后库里值已变',
          String(after[0]?.contract_id) === String(ctrs[0].id),
          `库=${String(after[0]?.contract_id).slice(0, 8)} 期望=${String(ctrs[0].id).slice(0, 8)} toast=${JSON.stringify(t4)}`,
        );
      }
    }

    /* ══════════════ ③ 发票：编辑 ══════════════ */
    console.log('\n③ 发票 — 编辑金额');
    page.resetDiagnostics();
    const invRes = await api('POST', '/api/finance/invoices', {
      invoiceType: 'vat_normal', direction: 'sales', contractId: String(ctrs[0].id),
      amount: 999, taxRate: 6, invoiceNo: INV_NO, invoiceDate: '2026-10-12',
    });
    const inv = await invRes.json();
    if (inv?.id) created.invoiceIds.push(inv.id);
    record('准备销项发票', invRes.status < 300, `HTTP ${invRes.status}`);

    await page.goto(`${APP}/finance`, { settleMs: 2600 });
    await sleep(1600);
    await page.clickByText('发票登记', { selector: '[role="tab"], button', settleMs: 2000 });
    await sleep(1600);
    const invEdit = await clickRowButton(page, INV_NO, '编辑');
    record('发票行有「编辑」按钮（本轮新增）', invEdit === 'ok', invEdit);
    await sleep(1600);
    const di3 = await dialogInfo(page);
    record('发票编辑弹窗打开', !!di3, di3 ? `标题=${di3.title} 字段=${JSON.stringify(di3.labels)}` : '无弹窗');
    if (di3) {
      record(
        '弹窗含金额/税率/开票日期',
        ['金额', '税率', '日期'].every((k) => di3.labels.some((l) => l.includes(k))),
        JSON.stringify(di3.labels),
      );
      await setInput(page, '[role="dialog"] input[type="number"]', '1888.88', 0);
      await sleep(400);
      await page.clickByText('保存', { selector: '[role="dialog"] button', settleMs: 700 });
      const t5 = await toasts(page, { attempts: 8, gapMs: 300 });
      await sleep(700);
      const after = await sql`SELECT amount FROM erp_invoice WHERE id = ${inv.id}`;
      record('改金额保存成功且库值一致', Number(after[0]?.amount) === 1888.88, `库=${after[0]?.amount} toast=${JSON.stringify(t5)}`);
    }

    /* ══════════════ ④ 表单校验：必填留空不能静默成功 ══════════════ */
    console.log('\n④ 表单校验 — 必填留空');
    page.resetDiagnostics();
    const beforeCount = (await sql`SELECT count(*)::int AS n FROM erp_contract`)[0].n;
    await page.goto(`${APP}/contracts/new`, { settleMs: 2300 });
    await sleep(1400);
    await page.clickByText('保存', { selector: 'button', settleMs: 2000 });
    await sleep(1800);
    const vErr = await page.evaluate(`(() => {
      const t = document.body.innerText || '';
      return ['不能为空', '请输入', '请选择', '必填', 'required'].filter((m) => t.includes(m));
    })()`);
    const afterCount = (await sql`SELECT count(*)::int AS n FROM erp_contract`)[0].n;
    record(
      '必填留空点保存 → 有校验提示且未建单',
      vErr.length > 0 && afterCount === beforeCount,
      `提示词=${JSON.stringify(vErr)} 合同数 ${beforeCount}→${afterCount}`,
    );

    /* ── 诊断汇总 ── */
    const diag = {
      consoleErrors: page.consoleLogs.filter((l) => l.type === 'error'),
      exceptions: page.exceptions,
      httpErrors: page.httpErrors,
      failedRequests: page.failedRequests,
    };
    record('无未捕获异常', diag.exceptions.length === 0, JSON.stringify(diag.exceptions).slice(0, 200));
    record('无 console.error', diag.consoleErrors.length === 0, JSON.stringify(diag.consoleErrors).slice(0, 200));
    record('无 HTTP ≥400', diag.httpErrors.length === 0, JSON.stringify(diag.httpErrors).slice(0, 200));
    writeFileSync(`${OUT}/feature-report.json`, JSON.stringify({ results, diagnostics: diag }, null, 2));
  } finally {
    try {
      for (const id of created.invoiceIds) {
        await sql`DELETE FROM fin_voucher_line WHERE voucher_id IN (SELECT id FROM fin_voucher WHERE source_ref LIKE ${`%${TAG}%`})`.catch(() => {});
        await sql`DELETE FROM fin_voucher WHERE source_ref LIKE ${`%${TAG}%`}`.catch(() => {});
        await sql`DELETE FROM erp_invoice WHERE id = ${id}`.catch(() => {});
      }
      for (const id of created.datasetIds) await sql`DELETE FROM da_dataset WHERE id = ${id}`.catch(() => {});
      for (const id of created.contractIds) await sql`DELETE FROM erp_contract WHERE id = ${id}`.catch(() => {});
      await sql`DELETE FROM erp_contract WHERE name LIKE ${`%${TAG}%`}`.catch(() => {});
      await sql`DELETE FROM erp_invoice WHERE invoice_no LIKE ${`%${TAG}%`}`.catch(() => {});
      await sql`DELETE FROM da_dataset WHERE name LIKE ${`%${TAG}%`}`.catch(() => {});
      console.log('\n清理完成');
    } catch (e) {
      console.log('清理出错:', e.message);
    }
    const left = await sql`SELECT
      (SELECT count(*)::int FROM erp_contract WHERE name LIKE ${`%${TAG}%`}) AS ctr,
      (SELECT count(*)::int FROM erp_invoice WHERE invoice_no LIKE ${`%${TAG}%`}) AS inv,
      (SELECT count(*)::int FROM da_dataset WHERE name LIKE ${`%${TAG}%`}) AS ds`;
    console.log(`残留: 合同=${left[0].ctr} 发票=${left[0].inv} 数据集=${left[0].ds}`);
    await sql.end({ timeout: 2 }).catch(() => {});
    await browser.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项:');
    for (const f of failed) console.log(`  - ${f.name}  ${f.detail ?? ''}`);
    process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error('走查失败:', e);
  process.exitCode = 1;
});
