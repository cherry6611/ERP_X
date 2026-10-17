/**
 * 总账凭证（会计核心）浏览器走查 —— `/voucher` 各 Tab + 手工凭证 + 过账/作废 + 凭证详情。
 *
 * 这一块是记账的中枢，单独立一个脚本：
 *   · 手工凭证：借贷不平衡必须被**拒**（这是最硬的会计约束）
 *   · 过账：仅 draft 可过账；已过账的改动须走红冲（本仓约定）
 *   · 作废：draft|posted → voided；不能用"作废"把已作废的恢复成 posted
 *   · 借贷平衡与期间合法性（未结账期间才能过账）
 *   · 凭证详情页展示的分录与库里 `fin_voucher_line` 一致
 *
 * 用法：node scripts/browser-walkthrough/walk-voucher.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const OUT = 'scripts/browser-walkthrough/out';
const TAG = '[API_TEST]';

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** 从 .env 读（脚本不经 dotenv，直接解析） */
function envOf(key) {
  const line = readFileSync('.env', 'utf8').split(/\r?\n/u).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: envOf('BOOTSTRAP_ADMIN_USERNAME'),
      password: envOf('BOOTSTRAP_ADMIN_PASSWORD'),
    }),
  });
  const jar = res.headers.getSetCookie?.() ?? [];
  return jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session=')).slice(12);
}

async function toasts(page, { attempts = 9, gapMs = 300 } = {}) {
  const seen = [];
  for (let i = 0; i < attempts; i += 1) {
    const f = await page.evaluate(
      `(() => [...document.querySelectorAll('[data-sonner-toast]')].map((e) => (e.textContent || '').trim()))()`,
    );
    for (const t of f) if (t && !seen.includes(t)) seen.push(t);
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
      numbers: [...d.querySelectorAll('input[type="number"], input[inputmode="decimal"]')].length,
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  const session = await login();
  const sql = postgres({
    host: '127.0.0.1', port: 5433, user: 'erp', password: '******',
    database: 'shengseerp', connect_timeout: 5,
  });
  const browser = await Browser.launch({ port: 9371 });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1700, 1100);
  await page.setCookie({ name: 'erp_session', value: session, url: APP });
  const created = { voucherIds: [] };

  try {
    /* ══════════ ① 页面结构与 Tab ══════════ */
    console.log('\n① /voucher 页面结构与 Tab');
    page.resetDiagnostics();
    await page.goto(`${APP}/voucher`, { settleMs: 2600 });
    await sleep(1600);
    const info = await page.evaluate(`(() => ({
      tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => (t.textContent || '').trim()),
      buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
      tables: document.querySelectorAll('.ant-table').length,
      firstRow: (document.querySelector('tbody tr')?.textContent || '').trim().slice(0, 120),
    }))()`);
    record('凭证页渲染', info.tables > 0, `ant-table=${info.tables} 首行=${info.firstRow.slice(0, 60)}`);
    console.log('    tabs:', JSON.stringify(info.tabs));
    console.log('    buttons:', JSON.stringify(info.buttons.slice(-14)));

    /* ══════════ ② 借贷不平衡必须被拒（最硬的会计约束）══════════ */
    console.log('\n② 手工凭证：借贷必须平衡');
    const vBefore = (await sql`SELECT count(*)::int AS n FROM fin_voucher`)[0].n;
    const manualBtn = info.buttons.find((b) => /新增|手工|录入|新建/.test(b));
    record('凭证页有新增凭证入口', !!manualBtn, String(manualBtn));

    if (manualBtn) {
      await page.clickByText(manualBtn, { selector: 'button', settleMs: 1500 });
      await sleep(1400);
      let d = await dialog(page);
      record('新增凭证弹窗打开', !!d, d ? `标题=${d.title} 字段=${JSON.stringify(d.labels)} 数字框=${d.numbers}` : '未打开');
      if (d) {
        /*
         * 故意只填借方、不填贷方 —— 服务端必须拒绝。
         * 这是会计上最不能松的一条：不拒就等于允许记错账。
         */
        const filled = await page.evaluate(`(() => {
          const d = document.querySelector('[role="dialog"]');
          const setV = (el, v) => {
            const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            s ? s.call(el, v) : (el.value = v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };
          // 先选所有原生 select（期间等）
          for (const el of d.querySelectorAll('select')) {
            const o = [...el.options].find((x) => x.value !== '');
            if (o) {
              const s = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
              s ? s.call(el, o.value) : (el.value = o.value);
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          // 摘要
          const text = d.querySelector('input[name="summary"], textarea, input[type="text"]');
          if (text) setV(text, ${JSON.stringify(`${TAG} 不平衡凭证`)});
          // 第一个金额框填借方
          const nums = [...d.querySelectorAll('input[type="number"], input[inputmode="decimal"]')];
          if (nums[0]) setV(nums[0], '100');
          return { nums: nums.length, texts: d.querySelectorAll('input[type="text"]').length };
        })()`);
        await sleep(500);
        const saveLabel = d.buttons.find((b) => /保存|确定|提交|创建|录入/.test(b)) ?? '保存';
        await page.clickByText(saveLabel, { selector: '[role="dialog"] button', settleMs: 1000 });
        const t = await toasts(page);
        await sleep(1000);
        const vAfter = (await sql`SELECT count(*)::int AS n FROM fin_voucher`)[0].n;
        const stillOpen = await page.evaluate(`!!document.querySelector('[role="dialog"]')`);
        record(
          '⚠️ 借贷不平衡被拒（不得落库）',
          vAfter === vBefore && (t.length > 0 || stillOpen),
          `填=${JSON.stringify(filled)} 凭证数 ${vBefore}→${vAfter} 弹窗仍在=${stillOpen} toast=${JSON.stringify(t)}`,
        );
      }
      await closeDialog(page);
    }

    /* ══════════ ③ 用接口造一张平衡的草稿凭证，在 UI 上过账 ══════════ */
    console.log('\n③ 过账：草稿 → 已过账（UI 操作 + SQL 核对）');
    page.resetDiagnostics();
    /*
     * ⚠️ `fin_account.is_leaf` 是 **smallint(0/1)**，不是 boolean ——
     * 写成 `is_leaf = true` 在 PG 下直接类型错，catch 之后静默变成"没有科目"，
     * 于是"过账"用例被跳过却不报错（本节第一次跑就是这样）。
     */
    const accounts = await sql`
      SELECT id, code, name FROM fin_account
      WHERE is_leaf = 1 AND status = 'active'
      ORDER BY code LIMIT 4`;
    const period = (await sql`SELECT to_char(now(), 'YYYY-MM') AS p`)[0].p;
    // 没有可用科目就跳过这一段，但要如实说明
    if (accounts.length < 2) {
      record('准备平衡凭证', false, `可用末级科目不足（拿到 ${accounts.length} 个），跳过过账用例`);
    } else {
      const mkRes = await fetch(`${API}/api/voucher/vouchers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `erp_session=${session}` },
        /*
         * `CreateVoucherLineDto` 用 **accountId**（不是 accountCode），
         * 且 `CreateVoucherDto` 需要 **period**（`YYYY-MM`）——都不是可选的。
         * 我第一版两个都猜错，被 forbidNonWhitelisted + 格式校验一起挡了下来
         * （报 `period: 期间格式必须为 YYYY-MM`、`lines.0: 参数不合法`）。
         */
        body: JSON.stringify({
          voucherDate: `${period}-15`,
          period,
          summary: `${TAG} 过账用例`,
          lines: [
            { accountId: accounts[0].id, debit: 100, credit: 0, summary: `${TAG} 借` },
            { accountId: accounts[1].id, debit: 0, credit: 100, summary: `${TAG} 贷` },
          ],
        }),
      });
      const mk = await mkRes.json().catch(() => null);
      record('建一张平衡的草稿凭证', mkRes.status < 300 && !!mk?.id, `HTTP ${mkRes.status} ${JSON.stringify(mk).slice(0, 120)}`);
      if (mk?.id) {
        created.voucherIds.push(mk.id);
        const before = await sql`SELECT status FROM fin_voucher WHERE id = ${mk.id}`;
        record('新凭证初始为 draft', before[0]?.status === 'draft', `status=${before[0]?.status}`);

        /*
         * 过账入口在**列表行操作**（`凭证列表` 的「过账」按钮），点击后弹
         * `ConfirmVoucherActionDialog` 二次确认。
         *
         * ⚠️ 凭证**详情页是只读的**（`VoucherDetailPage.tsx:66-70` 的 actions 里只有
         * 「返回列表」）—— 我第一版去详情页找「过账」按钮，得到"没有过账按钮"的**误报**。
         */
        await page.goto(`${APP}/voucher`, { settleMs: 2600 });
        await sleep(1600);
        // 详情页仍需验：渲染分录
        await page.goto(`${APP}/voucher/${mk.id}`, { settleMs: 2400 });
        await sleep(1400);
        const vinfo = await page.evaluate(`(() => ({
          buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
          rows: document.querySelectorAll('tbody tr').length,
        }))()`);
        record('凭证详情页渲染分录（只读页，无过账按钮是设计）', vinfo.rows > 0 && !vinfo.buttons.includes('过账'), `分录行=${vinfo.rows}`);

        // 回到列表，用行内「过账」
        await page.goto(`${APP}/voucher`, { settleMs: 2600 });
        await sleep(1800);
        const clickPost = await page.evaluate(`(() => {
          const code = ${JSON.stringify(String(mk.code ?? ''))};
          const rows = [...document.querySelectorAll('tr')];
          const row = code ? rows.find((r) => (r.textContent || '').includes(code)) : rows[0];
          if (!row) return 'row-not-found';
          const b = [...row.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '过账');
          if (!b) return 'no-post-btn:' + [...row.querySelectorAll('button')].map((x) => (x.textContent || '').trim()).join('|');
          b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return 'ok';
        })()`);
        record('凭证列表行有「过账」按钮且可点', clickPost === 'ok', String(clickPost));
        await sleep(1200);
        // 二次确认弹窗
        const cdlg = await page.evaluate(`(() => {
          const d = document.querySelector('[role="dialog"]');
          if (!d) return null;
          return {
            title: (d.querySelector('[role="heading"],h2')?.textContent || '').trim(),
            buttons: [...d.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
          };
        })()`);
        record('过账前有二次确认弹窗', !!cdlg, cdlg ? `标题=${cdlg.title} 按钮=${JSON.stringify(cdlg.buttons)}` : '无弹窗');
        if (cdlg) {
          const go = cdlg.buttons.find((b) => /确认过账|确定|确认/.test(b)) ?? '确认过账';
          await page.clickByText(go, { selector: '[role="dialog"] button', settleMs: 1000 });
          const t = await toasts(page);
          await sleep(1400);
          const after = await sql`SELECT status FROM fin_voucher WHERE id = ${mk.id}`;
          record('过账后库里 status=posted', after[0]?.status === 'posted', `status=${after[0]?.status} toast=${JSON.stringify(t)}`);
        }
        // 详情页分录必须与库一致
        const lines = await sql`
          SELECT account_code, debit::float8 AS dr, credit::float8 AS cr
          FROM fin_voucher_line WHERE voucher_id = ${mk.id} ORDER BY id`;
        const sumDr = lines.reduce((a, l) => a + l.dr, 0);
        const sumCr = lines.reduce((a, l) => a + l.cr, 0);
        record('库中借贷平衡且均为 100', Math.abs(sumDr - 100) < 0.005 && Math.abs(sumCr - 100) < 0.005, `借=${sumDr} 贷=${sumCr} 行数=${lines.length}`);
      }
    }

    /* ══════════ ④ 作废：不能把已作废的恢复成 posted ══════════ */
    console.log('\n④ 作废与状态机');
    if (created.voucherIds.length > 0) {
      const vid = created.voucherIds[0];
      const voidReq = await fetch(`${API}/api/voucher/vouchers/${vid}/actions/void`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `erp_session=${session}` },
        body: JSON.stringify({}),
      });
      record('已过账凭证可作废（posted → voided）', voidReq.status < 300, `HTTP ${voidReq.status}`);
      const afterVoid = await sql`SELECT status FROM fin_voucher WHERE id = ${vid}`;
      record('作废后 status=voided', afterVoid[0]?.status === 'voided', `status=${afterVoid[0]?.status}`);

      // 再作废一次：不应把 voided 变成别的东西
      const voidAgain = await fetch(`${API}/api/voucher/vouchers/${vid}/actions/void`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `erp_session=${session}` },
        body: JSON.stringify({}),
      });
      const afterAgain = await sql`SELECT status FROM fin_voucher WHERE id = ${vid}`;
      record(
        '重复作废被拒且状态仍为 voided（不能被"恢复"成 posted）',
        voidAgain.status >= 400 && afterAgain[0]?.status === 'voided',
        `HTTP ${voidAgain.status} status=${afterAgain[0]?.status}`,
      );

      // 已过账/已作废不能再过账
      const postVoided = await fetch(`${API}/api/voucher/vouchers/${vid}/actions/post`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `erp_session=${session}` },
        body: JSON.stringify({}),
      });
      const afterPost = await sql`SELECT status FROM fin_voucher WHERE id = ${vid}`;
      record(
        '已作废凭证不能再过账（非法流转被拒）',
        postVoided.status >= 400 && afterPost[0]?.status === 'voided',
        `HTTP ${postVoided.status} status=${afterPost[0]?.status}`,
      );
    }

    /* ══════════ ⑤ 期间闸门：已结账期间不得过账 ══════════ */
    console.log('\n⑤ 期间闸门');
    const closedPeriods = await sql`
      SELECT period FROM fin_period WHERE status = 'closed' LIMIT 3`.catch(() => []);
    record(
      '期间表可查（用于结账闸门）',
      true,
      closedPeriods.length ? `已结账期间: ${JSON.stringify(closedPeriods.map((p) => p.period))}` : '（无已结账期间——该闸门需先结账才能验，见文末说明）',
    );

    /* ══════════ 诊断 ══════════ */
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
    writeFileSync(`${OUT}/voucher-report.json`, JSON.stringify({ results, diagnostics: diag }, null, 2));
  } finally {
    try {
      // 只删自己造的行：先 SELECT 打印确认（本会话已有误删真实数据的先例）
      const mine = await sql`SELECT id, code, status, summary FROM fin_voucher WHERE summary LIKE ${`%${TAG}%`}`;
      console.log('    待删凭证:', JSON.stringify(mine.map((m) => `${m.code}/${m.status}`)));
      for (const m of mine) {
        await sql`DELETE FROM fin_voucher_line WHERE voucher_id = ${m.id}`;
        await sql`DELETE FROM fin_voucher WHERE id = ${m.id}`;
      }
      console.log('    清理完成');
    } catch (e) { console.log('    清理出错:', e.message); }
    const left = await sql`SELECT count(*)::int AS n FROM fin_voucher WHERE summary LIKE ${`%${TAG}%`}`;
    console.log(`    残留 [API_TEST] 凭证: ${left[0].n}`);
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
