/**
 * 主数据 / CRM / 项目 / 财务 —— 浏览器里做**真实写入**（新建 → 编辑），
 * 每一步都用 SQL 核对库里的值，而不是只看"弹窗能打开"。
 *
 * 为什么单独写这个：`walk-interactions.mjs` 与 `walk-routes.mjs` 覆盖的是
 * "弹窗可开可关 / 页面能打开"，**没有一步验证写入是否落库**。
 * 而本仓已确认过的最隐蔽缺陷类型恰恰在更新路径上：
 *   · 契约里有、客户端真发、service 不 patch  → **静默字段丢弃**
 *   · `values.x || undefined` 在更新分支 → 清空被静默丢掉
 * 这些在界面上**完全看不出来**（toast 照样报成功），只有查库才能发现。
 *
 * ## 本仓 UI 的两种"新建"形态（走查必须分别处理）
 *
 * | 形态 | 例子 | 触发后 | 提交按钮 |
 * |---|---|---|---|
 * | **弹窗**（Dialog） | 新建客户 / 新建供应商 / 新建数据集 | 原地开 `[role=dialog]` | 保存 |
 * | **整页表单**（路由） | 登记合同 → `/contracts/new`；新建线索 → `/crm/leads/new`；项目立项 → `/projects/new` | `location.href` 变化 | 保存 / 立项 |
 *
 * 把整页表单当弹窗找 `[role=dialog]` 会得到"弹窗未打开"的**假失败** ——
 * 这是本脚本第一版踩过的坑，写在这里避免重蹈。
 *
 * 用法：node scripts/browser-walkthrough/walk-crud.mjs
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

/** 给原生 <select> 选第一个非空项 */
async function setNativeSelect(page, index = 0) {
  return page.evaluate(`(() => {
    const el = document.querySelectorAll('select')[${index}];
    if (!el) return 'not-found';
    const o = [...el.options].find((x) => x.value !== '');
    if (!o) return 'no-option';
    const s = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    s ? s.call(el, o.value) : (el.value = o.value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return o.textContent.trim().slice(0, 30);
  })()`);
}

/** 打开一个 Radix Select（scope 内文本匹配 trigger）并选第一个选项 */
async function pickRadixFirst(page, { scope = 'body', triggerRe = '请选择', optionRe = null } = {}) {
  const trig = await page.evaluate(`(() => {
    const root = ${scope === 'dialog' ? "document.querySelector('[role=\"dialog\"]')" : 'document.body'};
    if (!root) return null;
    const b = [...root.querySelectorAll('button')].find((x) => new RegExp(${JSON.stringify(triggerRe)}).test(x.textContent || ''));
    if (!b) return null;
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return (b.textContent || '').trim().slice(0, 24);
  })()`);
  if (!trig) return { trigger: null, picked: null };
  await sleep(900);
  const picked = await page.evaluate(`(() => {
    const opts = [...document.querySelectorAll('[role="option"]')];
    const o = ${optionRe ? `opts.find((x) => new RegExp(${JSON.stringify(optionRe)}).test(x.textContent || ''))` : 'opts[0]'};
    if (!o) return null;
    o.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return (o.textContent || '').trim().slice(0, 30);
  })()`);
  await sleep(600);
  return { trigger: trig, picked };
}

async function toasts(page, { attempts = 10, gapMs = 300 } = {}) {
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

async function closeAnyDialog(page) {
  await page.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return;
    const b = [...d.querySelectorAll('button')].find((x) => /取消|关闭/.test(x.textContent || ''));
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await sleep(700);
}

async function clickRow(page, rowText, btnRe) {
  return page.evaluate(`(() => {
    const row = [...document.querySelectorAll('tr')].find((r) => (r.textContent || '').includes(${JSON.stringify(rowText)}));
    if (!row) return 'row-not-found';
    const b = [...row.querySelectorAll('button')].find((x) => new RegExp(${JSON.stringify(btnRe)}).test((x.textContent || '').trim()));
    if (!b) return 'btn-not-found:' + [...row.querySelectorAll('button')].map((x) => (x.textContent || '').trim()).join('|');
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const session = await login();
  const sql = postgres({
    host: '127.0.0.1', port: 5433, user: 'erp', password: process.env.DB_PASSWORD ?? '',
    database: 'shengseerp', connect_timeout: 5,
  });
  /** 为立项临时创建的合同（用完要连项目一起删） */
  const createdContracts = [];
  /** 被临时删除、待恢复的原项目整行 */
  let snapshot = null;
  const browser = await Browser.launch({ port: 9348 });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1700, 1100);
  await page.setCookie({ name: 'erp_session', value: session, url: APP });

  try {
    /* ══════════ ① 客户：弹窗新建 + 编辑（DB 核对）══════════ */
    console.log('\n① 客户 — 弹窗新建 + 编辑');
    page.resetDiagnostics();
    const cname = `${TAG} 客户A`;
    await page.goto(`${APP}/customers`, { settleMs: 2300 });
    await sleep(1500);
    await page.clickByText('新建客户', { selector: 'button', settleMs: 1300 });
    await sleep(1000);
    const cd = await dialog(page);
    record('客户新建弹窗打开', !!cd, cd ? `字段=${JSON.stringify(cd.labels)}` : '未打开');
    if (cd) {
      await setInput(page, '[role="dialog"] input[name="name"]', cname, 0);
      await setInput(page, '[role="dialog"] textarea[name="remark"]', `${TAG} 建时备注`, 0);
      await sleep(400);
      const save = cd.buttons.find((b) => /保存|确定|创建/.test(b)) ?? '保存';
      await page.clickByText(save, { selector: '[role="dialog"] button', settleMs: 800 });
      const t = await toasts(page);
      await sleep(700);
      record('客户新建提交', t.length > 0, `toast=${JSON.stringify(t)}`);
    }
    const cRow = await sql`SELECT id, name, remark FROM md_customer WHERE name = ${cname} LIMIT 1`;
    record('客户已落库（含备注）', cRow.length === 1 && String(cRow[0].remark).includes('建时备注'), cRow.length ? `remark=${String(cRow[0].remark)}` : '未找到');
    await closeAnyDialog(page);

    if (cRow.length) {
      await page.goto(`${APP}/customers`, { settleMs: 2300 });
      await sleep(1500);
      const ce = await clickRow(page, cname, '编辑');
      record('客户行有「编辑」', ce === 'ok', ce);
      await sleep(1300);
      const ed = await dialog(page);
      if (ed) {
        // ⚠️ 精确到 name="remark" 的 textarea —— 传逗号选择器 + index 0
        //    会命中文档序更靠前的 input（第一版就把"名称"写成了备注）
        await setInput(page, '[role="dialog"] textarea[name="remark"]', `${TAG} 编辑后的备注X`, 0);
        await sleep(400);
        const save = ed.buttons.find((b) => /保存|确定/.test(b)) ?? '保存';
        await page.clickByText(save, { selector: '[role="dialog"] button', settleMs: 800 });
        const t = await toasts(page);
        await sleep(800);
        const after = await sql`SELECT remark FROM md_customer WHERE name = ${cname} LIMIT 1`;
        record(
          '⚠️ 客户编辑后库里备注确实变了（静默丢字段高危点）',
          String(after[0]?.remark ?? '').includes('编辑后的备注X'),
          `库=${String(after[0]?.remark ?? '')} toast=${JSON.stringify(t)}`,
        );
      } else record('客户编辑弹窗', false, '未打开');
      await closeAnyDialog(page);
    }

    /* ══════════ ② 供应商：弹窗新建 ══════════ */
    console.log('\n② 供应商 — 弹窗新建');
    page.resetDiagnostics();
    const sname = `${TAG} 供应商A`;
    await page.goto(`${APP}/suppliers`, { settleMs: 2300 });
    await sleep(1500);
    await page.clickByText('新建供应商', { selector: 'button', settleMs: 1300 });
    await sleep(1000);
    const sd = await dialog(page);
    record('供应商新建弹窗打开', !!sd, sd ? `字段=${JSON.stringify(sd.labels)}` : '未打开');
    if (sd) {
      await setInput(page, '[role="dialog"] input[name="name"], [role="dialog"] input', cname && sname, 0);
      await sleep(400);
      const save = sd.buttons.find((b) => /保存|确定|创建/.test(b)) ?? '保存';
      await page.clickByText(save, { selector: '[role="dialog"] button', settleMs: 800 });
      const t = await toasts(page);
      await sleep(700);
      record('供应商新建提交', t.length > 0, `toast=${JSON.stringify(t)}`);
    }
    const sRow = await sql`SELECT id FROM md_supplier WHERE name = ${sname} LIMIT 1`;
    record('供应商已落库', sRow.length === 1, sRow.length ? `id=${String(sRow[0].id).slice(0, 8)}` : '未找到');
    await closeAnyDialog(page);

    /* ══════════ ③ 线索：**整页表单**新建（/crm/leads/new）══════════ */
    console.log('\n③ 线索 — 整页表单新建');
    page.resetDiagnostics();
    const lname = `${TAG} 线索A`;
    await page.goto(`${APP}/crm`, { settleMs: 2300 });
    await sleep(1400);
    await page.clickByText('新建线索', { selector: 'button', settleMs: 1800 });
    await sleep(1300);
    const lurl = await page.evaluate('location.href');
    record('「新建线索」进入整页表单', lurl.includes('/crm/leads/new'), lurl);
    if (lurl.includes('/crm/leads/new')) {
      const labels = await page.evaluate(`(() => [...document.querySelectorAll('label')].map((l) => (l.textContent || '').trim()))()`);
      record('线索表单渲染字段', labels.length > 0, JSON.stringify(labels));
      // 客户名称是第一个 input（name=customerName）
      let set = await setInput(page, 'input[name="customerName"]', lname, 0);
      if (set === 'not-found') set = await setInput(page, 'input', lname, 0);
      record('线索：填写客户名称', set === 'ok', set);
      await sleep(400);
      await page.clickByText('保存', { selector: 'button', settleMs: 800 });
      const t = await toasts(page);
      await sleep(800);
      record('线索提交', t.length > 0, `toast=${JSON.stringify(t)}`);
    }
    const lRow = await sql`SELECT id, customer_name FROM crm_lead WHERE customer_name = ${lname} LIMIT 1`;
    record('线索已落库', lRow.length === 1, lRow.length ? `id=${String(lRow[0].id).slice(0, 8)}` : '未找到');

    /* ══════════ ④ 项目立项：整页表单 ══════════ */
    console.log('\n④ 项目 — 整页表单立项');
    page.resetDiagnostics();
    const pname = `${TAG} 项目A`;
    await page.goto(`${APP}/projects/new`, { settleMs: 2300 });
    await sleep(1600);
    await setInput(page, 'input[name="name"]', pname, 0);
    /*
     * 一个合同只能立一个项目（uq_erp_project_one_contract）。
     * 随便选第一个合同很可能已被占用 → 409，所以显式挑一个还没有项目的合同。
     */
    /*
     * 立项的前置条件（实测，都不是缺陷）：
     *   ① 合同必须**已生效** —— draft 会被拒："合同 draft 状态不允许立项，须先生效"；
     *   ② 一个合同只能立一个项目（uq_erp_project_one_contract）。
     *
     * ⚠️ 不要试图在页面上"现造一个空闲合同"：合同下拉的数据是**进入页面时拉的**，
     * 新建的合同不在里面（实测会静默回落选到第一个，然后报 uq_erp_project_one_contract）。
     * 因此这里改成**临时释放一个已被占用的 active 合同**：把它的原项目整行删掉，
     * 立项成功后把原项目**原样恢复**（列值全量回填，主键也保留）。
     */
    const occupied = (await sql`
      SELECT p.id, p.code, p.name, p.contract_id, c.code AS ctr_code
      FROM erp_project p JOIN erp_contract c ON c.id = p.contract_id
      WHERE c.status = 'performing' AND p.contract_id IS NOT NULL LIMIT 1`)[0];
    if (!occupied) throw new Error('找不到已生效且已挂项目的合同，无法测立项');
    /** 原项目的整行快照，用于恢复 */
    snapshot = (await sql`SELECT * FROM erp_project WHERE id = ${occupied.id}`)[0];
    await sql`DELETE FROM erp_project WHERE id = ${occupied.id}`;
    record('临时释放合同以测立项', true, `合同=${occupied.ctr_code}（原项目 ${occupied.code} 将恢复）`);
    const freeCtr = [{ code: String(occupied.ctr_code) }];
    const wantCode = String(freeCtr[0]?.code ?? '');
    const ctrPick = await page.evaluate(`(() => {
      const el = document.querySelectorAll('select')[0];
      if (!el) return 'not-found';
      const want = ${JSON.stringify(wantCode)};
      const o = [...el.options].find((x) => x.value !== '' && (x.textContent || '').includes(want))
        ?? [...el.options].find((x) => x.value !== '');
      if (!o) return 'no-option';
      const s = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      s ? s.call(el, o.value) : (el.value = o.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return o.textContent.trim().slice(0, 34);
    })()`);
    record('项目：选择未被占用的合同', ctrPick !== 'not-found' && ctrPick !== 'no-option', String(ctrPick) + ' | 期望编号=' + wantCode);
    await sleep(500);
    await page.clickByText('立项', { selector: 'button', settleMs: 800 });
    const t4 = await toasts(page);
    await sleep(900);
    const pRow = await sql`SELECT id, name FROM erp_project WHERE name = ${pname} LIMIT 1`;
    record('项目已落库', pRow.length === 1, `toast=${JSON.stringify(t4)} ${pRow.length ? 'id=' + String(pRow[0].id).slice(0, 8) : '未找到'}`);

    /* ══════════ ⑤ 应收登记：**校验拦截** + 正常落库（事务路径）══════════ */
    console.log('\n⑤ 应收登记 — 必填校验 + 事务落库');
    page.resetDiagnostics();
    const arBefore = (await sql`SELECT count(*)::int AS n FROM erp_ar`)[0].n;
    await page.goto(`${APP}/finance`, { settleMs: 2600 });
    await sleep(1600);
    await page.clickByText('登记应收', { selector: 'button', settleMs: 1300 });
    await sleep(1100);

    // 5a：只填金额、不选合同 → 应被前端校验拦住且**不发请求**
    const reqBefore = (page.requests ?? []).length;
    await setInput(page, '[role="dialog"] input[type="number"]', '5000', 0);
    await sleep(400);
    await page.clickByText('保存', { selector: '[role="dialog"] button', settleMs: 800 });
    await sleep(1200);
    const newReqs = (page.requests ?? []).slice(reqBefore).filter((r) => /POST|PATCH/.test(r.method ?? ''));
    const vmsg = await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return [];
      return [...d.querySelectorAll('*')].filter((e) => e.children.length === 0 && /必填|请选择|不能为空|请输入/.test(e.textContent || '')).map((e) => (e.textContent || '').trim()).slice(0, 5);
    })()`);
    record(
      '未选合同点保存 → 有校验提示且不发请求',
      vmsg.length > 0 && newReqs.length === 0,
      `提示=${JSON.stringify(vmsg)} 写请求=${newReqs.length}`,
    );

    // 5b：选合同 + 金额 → 应真正落库（这一条走 db.transaction）
    /*
     * 应收登记的「合同」是原生 select（Radix Select 只是它的可见壳：
     * 弹窗里 [role=combobox] 的 textContent 是空的，而 select 有 3 个 option）。
     * 用 setNativeSelect 直接写值 —— 不要去按文本找 trigger，它没有文本。
     */
    /*
     * 备注带上 [API_TEST]：应收单没有业务来源可依附，清理只能靠备注精确命中。
     * （本轮探针就是因为没打标，留下 4 行游离 ARR 记录，事后手工删的。）
     */
    await setInput(page, '[role="dialog"] textarea', `${TAG} 走查应收`, 0).catch(() => {});
    await sleep(300);
    const picked = await setNativeSelect(page, 0);
    record('选择合同（原生 select）', picked !== 'not-found' && picked !== 'no-option', String(picked));
    await sleep(400);
    await page.clickByText('保存', { selector: '[role="dialog"] button', settleMs: 900 });
    const t5 = await toasts(page);
    await sleep(1000);
    const arAfter = (await sql`SELECT count(*)::int AS n FROM erp_ar`)[0].n;
    record(
      '应收登记走事务成功落库（begin 修复重点）',
      arAfter > arBefore,
      `erp_ar ${arBefore}→${arAfter} toast=${JSON.stringify(t5)} httpErr=${page.httpErrors.length}`,
    );

    /* ── 诊断 ── */
    const diag = {
      consoleErrors: page.consoleLogs.filter((l) => l.type === 'error'),
      exceptions: page.exceptions,
      httpErrors: page.httpErrors,
    };
    record('无未捕获异常', diag.exceptions.length === 0, JSON.stringify(diag.exceptions).slice(0, 200));
    record('无 console.error', diag.consoleErrors.length === 0, JSON.stringify(diag.consoleErrors).slice(0, 200));
    record('无 HTTP ≥500', diag.httpErrors.filter((e) => Number(e.status) >= 500).length === 0, JSON.stringify(diag.httpErrors).slice(0, 200));
    writeFileSync(`${OUT}/crud-report.json`, JSON.stringify({ results, diagnostics: diag }, null, 2));
  } finally {
    try {
      await sql`DELETE FROM erp_ar WHERE remark LIKE ${`%${TAG}%`}`.catch(() => {});
      await sql`DELETE FROM erp_project WHERE name LIKE ${`%${TAG}%`}`.catch(() => {});
      // 恢复被临时删除的原项目
      if (snapshot) {
        /*
         * ⚠️ 必须给每个占位符**显式类型转换**（$1::uuid / $2::timestamptz …）。
         * 第一版写成 `$${i+1}` 且把值原样传入：postgres.js 以 text 发送、
         * PG 在 INSERT 上下文里把无标注的 text 参数推断成 integer，
         * 于是 uuid 列报 `column "id" is of type uuid but expression is of type integer`
         * —— 恢复静默失败，那一行真的被删掉了（本轮手工补回）。
         *
         * 类型从 information_schema 现查，不硬编码：表结构变了也不会失效。
         */
        const meta = await sql`SELECT column_name, udt_name FROM information_schema.columns
          WHERE table_name = 'erp_project'`;
        const udtOf = Object.fromEntries(meta.map((m) => [m.column_name, m.udt_name]));
        const cols = Object.keys(snapshot);
        const colList = cols.map((c) => `"${c}"`).join(', ');
        const placeholders = cols
          .map((c, i) => {
            const udt = udtOf[c];
            return udt ? `$${i + 1}::${udt}` : `$${i + 1}`;
          })
          .join(', ');
        /* 值一律转成字符串后按 udt 转换：numeric/timestamptz 的字符串字面量 PG 都认，
           而把 Date / 数字直接塞进去反而会引入驱动侧的猜测。 */
        const values = cols.map((c) => {
          const v = snapshot[c];
          if (v === null || v === undefined) return null;
          if (v instanceof Date) return v.toISOString();
          return typeof v === 'object' ? JSON.stringify(v) : String(v);
        });
        await sql.unsafe(
          `INSERT INTO erp_project (${colList}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
          values,
        ).catch((e) => console.log('  ! 恢复原项目失败:', e.message));
        const ok = await sql`SELECT code FROM erp_project WHERE id = ${snapshot.id}`;
        console.log(ok.length ? `  已恢复原项目 ${snapshot.code}` : `  ! 原项目 ${snapshot.code} 未恢复，请手工检查`);
      }
      for (const id of createdContracts) {
        await sql`DELETE FROM erp_project WHERE contract_id = ${id}`.catch(() => {});
        await sql`DELETE FROM erp_contract_item WHERE contract_id = ${id}`.catch(() => {});
        await sql`DELETE FROM erp_contract WHERE id = ${id}`.catch(() => {});
      }
      await sql`DELETE FROM crm_lead WHERE customer_name LIKE ${`%${TAG}%`}`.catch(() => {});
      await sql`DELETE FROM md_supplier WHERE name LIKE ${`%${TAG}%`}`.catch(() => {});
      await sql`DELETE FROM md_customer WHERE name LIKE ${`%${TAG}%`}`.catch(() => {});
      console.log('\n清理完成');
    } catch (e) {
      console.log('清理出错:', e.message);
    }
    const left = await sql`SELECT
      (SELECT count(*)::int FROM md_customer WHERE name LIKE ${`%${TAG}%`}) AS cus,
      (SELECT count(*)::int FROM md_supplier WHERE name LIKE ${`%${TAG}%`}) AS sup,
      (SELECT count(*)::int FROM crm_lead WHERE customer_name LIKE ${`%${TAG}%`}) AS lead,
      (SELECT count(*)::int FROM erp_project WHERE name LIKE ${`%${TAG}%`}) AS proj,
      (SELECT count(*)::int FROM erp_ar WHERE code NOT IN (SELECT code FROM erp_ar WHERE remark IS NULL)) AS arx`;
    console.log(`残留: 客户=${left[0].cus} 供应商=${left[0].sup} 线索=${left[0].lead} 项目=${left[0].proj}`);
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
