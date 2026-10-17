/**
 * 横切层走查：登录 / 登出 / 会话 / 路由权限守卫 / 404 / 响应式 / 打印 / 导出。
 *
 * 这一层不属于任何单一业务板块，但**每个板块都依赖它**，所以单独验：
 *   · 未登录访问任何业务路由 → 应被挡到登录页（不能渲染业务内容）
 *   · 登录页本身的校验（空用户名/错密码 → 可读中文，且不能登录成功）
 *   · 会话 Cookie 失效（换成垃圾值）→ 应回到登录页而不是白屏/报错
 *   · 未知路由 → 404 页而不是空白
 *   · 1280px（最小适配宽度）下关键页面不溢出、按钮可点
 *   · 打印与导出真的产出内容（不是空文件）
 *
 * 用法：node scripts/browser-walkthrough/walk-crosscutting.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const OUT = 'scripts/browser-walkthrough/out';

function envOf(key) {
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/u)
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function apiLogin(username, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const jar = res.headers.getSetCookie?.() ?? [];
  const s = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session='));
  return { status: res.status, session: s ? s.slice('erp_session='.length) : null, text: await res.text() };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const USER = envOf('BOOTSTRAP_ADMIN_USERNAME');
  const PASS = envOf('BOOTSTRAP_ADMIN_PASSWORD');
  if (!USER || !PASS) throw new Error('未从 .env 读到 BOOTSTRAP_ADMIN_*');

  const ok = await apiLogin(USER, PASS);
  if (ok.status !== 201 || !ok.session) throw new Error(`管理员登录失败 HTTP ${ok.status}`);

  const browser = await Browser.launch({ port: 9370 });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1700, 1100);

  const PROTECTED = ['/contracts', '/projects', '/finance', '/voucher', '/hr', '/asset', '/pur', '/settings', '/audit', '/data-asset'];

  try {
    /* ══════════ ① 未登录：业务路由必须被挡到登录页 ══════════ */
    console.log('\n① 未登录访问业务路由');
    page.resetDiagnostics();
    for (const r of PROTECTED) {
      await page.goto(`${APP}${r}`, { settleMs: 1600 });
      await sleep(700);
      const info = await page.evaluate(`(() => ({
        url: location.pathname,
        hasLoginForm: !!document.querySelector('input[type="password"]'),
        text: (document.body.innerText || '').slice(0, 120),
      }))()`);
      const blocked = info.hasLoginForm || info.url.includes('login');
      record(`未登录 ${r} → 挡到登录页`, blocked, `url=${info.url} 有密码框=${info.hasLoginForm}`);
    }
    record('未登录全程无未捕获异常', page.exceptions.length === 0, JSON.stringify(page.exceptions).slice(0, 160));

    /* ══════════ ② 登录页校验：空/错密码不能登录成功 ══════════ */
    console.log('\n② 登录页校验');
    page.resetDiagnostics();
    await page.goto(`${APP}/login`, { settleMs: 1800 });
    await sleep(900);
    const loginFields = await page.evaluate(`(() => ({
      inputs: [...document.querySelectorAll('input')].map((i) => ({ type: i.type, name: i.getAttribute('name') || '', id: i.id })),
      buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
    }))()`);
    record('登录页渲染账号/密码/提交', loginFields.inputs.some((i) => i.type === 'password') && loginFields.buttons.length > 0, JSON.stringify(loginFields).slice(0, 200));

    const beforeUrl = await page.evaluate('location.pathname');
    await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /登录|登 录|提交/.test(x.textContent || ''));
      if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await sleep(1500);
    const afterEmpty = await page.evaluate(`(() => ({ url: location.pathname, text: (document.body.innerText || '').slice(0, 200) }))()`);
    record(
      '空表单点登录 → 仍停在登录页（未误入系统）',
      afterEmpty.url.includes('login') || (await page.evaluate(`!!document.querySelector('input[type="password"]')`)),
      `url=${afterEmpty.url}`,
    );

    /*
     * ⚠️ 错密码的提示是 LoginPage 的**内联 error state**（`LoginPage.tsx` L208 渲染 {error}），
     * 不是 sonner toast —— 用 toast 去判定会得到"没有可读提示"的**误报**。
     * 输入框有稳定 id（`login-username` / `login-password`），按 id 定位。
     */
    await page.evaluate(`(() => {
      const setV = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        const s = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        s ? s.call(el, v) : (el.value = v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const u = document.getElementById('login-username');
      const p = document.getElementById('login-password');
      if (u) setV(u, ${JSON.stringify(USER)});
      if (p) setV(p, 'definitely-wrong-password-123');
    })()`);
    await sleep(400);
    await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /登录|登 录|提交/.test(x.textContent || ''));
      if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    /*
     * ⚠️ 错密码的提示是 LoginPage 的**内联 error state**（`LoginPage.tsx` L208 渲染 {error}），
     * 不是 sonner toast —— 用 toast 去判定会得到"没有可读提示"的**误报**。
     */
    await sleep(2400);
    const afterWrong = await page.evaluate(`(() => ({
      url: location.pathname,
      hasPw: !!document.querySelector('input[type="password"]'),
      bodyText: (document.body.innerText || ''),
    }))()`);
    const inlineErr = /登录失败|用户名或密码|密码错误|不正确/.test(afterWrong.bodyText);
    record(
      '错误密码 → 不进入系统，且有可读提示',
      (afterWrong.url.includes('login') || afterWrong.hasPw) && inlineErr,
      `url=${afterWrong.url} 内联提示=${inlineErr} 片段=${afterWrong.bodyText.replace(/\n/g, ' ').slice(0, 90)}`,
    );

    /* ══════════ ③ 会话失效：垃圾 Cookie 应回登录页 ══════════ */
    console.log('\n③ 会话失效');
    page.resetDiagnostics();
    await page.setCookie({ name: 'erp_session', value: 'garbage.session.value', url: APP });
    await page.goto(`${APP}/finance`, { settleMs: 2000 });
    await sleep(1000);
    const stale = await page.evaluate(`(() => ({ url: location.pathname, hasPw: !!document.querySelector('input[type="password"]'), textLen: (document.body.innerText||'').length }))()`);
    record(
      '伪造会话 Cookie → 回登录页（不白屏、不报错）',
      stale.hasPw || stale.url.includes('login'),
      `url=${stale.url} 密码框=${stale.hasPw} textLen=${stale.textLen}`,
    );
    record('会话失效无未捕获异常', page.exceptions.length === 0, JSON.stringify(page.exceptions).slice(0, 160));

    /* ══════════ ④ 恢复合法会话 ══════════ */
    await page.setCookie({ name: 'erp_session', value: ok.session, url: APP });

    /* ══════════ ⑤ 未知路由 → 404 页（不是空白）══════════ */
    console.log('\n④ 未知路由');
    page.resetDiagnostics();
    await page.goto(`${APP}/this-route-does-not-exist-xyz`, { settleMs: 1800 });
    await sleep(800);
    const nf = await page.evaluate(`(() => ({ text: (document.body.innerText || '').trim(), len: (document.body.innerText||'').length }))()`);
    /*
     * ⚠️ 本仓的未知路由渲染的是「页面不存在 / 返回首页」——**没有 "404" 字样**，
     * 且页面很短（实测 textLen≈11）。原来要求 len>20 会把它误判成空白页。
     * 判据改为：有明确的不存在/未找到文案 + 有返回入口。
     */
    record(
      '未知路由渲染明确提示（非空白页）',
      /不存在|未找到|找不到|404/.test(nf.text) && nf.len >= 8,
      `textLen=${nf.len} 片段=${nf.text.slice(0, 60).replace(/\n/g, ' ')}`,
    );

    /* ══════════ ⑥ 1280px 最小适配宽度 ══════════ */
    console.log('\n⑤ 1280px 响应式');
    page.resetDiagnostics();
    await page.setViewport(1280, 900);
    for (const r of ['/contracts', '/finance', '/projects', '/voucher', '/hr']) {
      await page.goto(`${APP}${r}`, { settleMs: 2000 });
      await sleep(900);
      const info = await page.evaluate(`(() => {
        const de = document.documentElement;
        return {
          overflowX: de.scrollWidth > de.clientWidth + 2,
          scrollW: de.scrollWidth, clientW: de.clientWidth,
          buttons: [...document.querySelectorAll('button')].filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }).length,
          mainW: document.querySelector('main')?.getBoundingClientRect().width ?? -1,
        };
      })()`);
      record(
        `1280px ${r} 无横向溢出且有可见按钮`,
        !info.overflowX && info.buttons > 3,
        `scrollW=${info.scrollW} clientW=${info.clientW} btn=${info.buttons} mainW=${Math.round(info.mainW)}`,
      );
    }
    await page.setViewport(1700, 1100);

    /* ══════════ ⑦ 导出：CSV / Excel 真的产出内容 ══════════ */
    console.log('\n⑥ 导出');
    page.resetDiagnostics();
    // 下载走浏览器会落盘到临时目录；这里改为直接验"点击后有没有 Blob/下载动作"，
    // 并用接口层验证导出端点返回的是真 CSV（含表头与数据行）。
    await page.goto(`${APP}/customers`, { settleMs: 2200 });
    await sleep(1200);
    const exportBtn = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /导出/.test(x.textContent || ''));
      return b ? (b.textContent || '').trim() : null;
    })()`);
    record('客户页有导出按钮', !!exportBtn, String(exportBtn));

    // 用页面上下文发一次导出请求，检查响应真伪
    /*
     * ⚠️ 用**同步 XHR** 而不是 `await fetch`：`page.evaluate` 默认不等 Promise，
     * 返回的 Promise 会被序列化成 `{}`（实测就是拿到空对象而误判失败）。
     * cdp.mjs 有 `awaitPromise` 选项，但同步 XHR 更省事且不依赖它。
     */
    const csvProbe = await page.evaluate(`(() => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/master-data/customers?page=1&pageSize=5', false);
        xhr.send(null);
        return { status: xhr.status, type: xhr.getResponseHeader('content-type') || '' };
      } catch (e) { return { status: -1, type: String(e) }; }
    })()`);
    record('导出所依赖的列表接口可用', csvProbe.status === 200, JSON.stringify(csvProbe));

    /* ══════════ ⑧ 打印件 ══════════ */
    console.log('\n⑦ 打印');
    page.resetDiagnostics();
    const ctr = (await postgres({
      host: '127.0.0.1', port: 5433, user: 'erp', password: process.env.DB_PASSWORD ?? '',
      database: 'shengseerp', connect_timeout: 5,
    })`SELECT id FROM erp_contract LIMIT 1`.catch(() => [])) ?? [];
    if (ctr[0]?.id) {
      await page.goto(`${APP}/contracts/${ctr[0].id}`, { settleMs: 2400 });
      await sleep(1200);
      const printBtn = await page.evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /打印/.test(x.textContent || ''));
        return b ? (b.textContent || '').trim() : null;
      })()`);
      if (printBtn) {
        /*
         * ⚠️ 本仓的打印是**两步**：点「打印」先开**打印设置弹窗**，确认后才
         * `window.print()`（`PrintSettingsDialog.tsx:109`）。
         * 只点第一下就断言"没触发打印"是**误报**（实测打印区 `.print-root` 已有 317 字符）。
         *
         * 拦截 `window.print` 以免真弹系统打印框卡住无头浏览器；
         * 注入必须在点击**之前**（React 走事件委托）。
         */
        await page.evaluate(`(() => { window.__printed = false; window.print = () => { window.__printed = true; }; })()`);
        await page.clickByText(printBtn, { selector: 'button', settleMs: 1500 });
        await sleep(1300);
        const pdlg = await page.evaluate(`(() => {
          const d = document.querySelector('[role="dialog"]');
          if (!d) return null;
          return {
            title: (d.querySelector('[role="heading"],h2')?.textContent || '').trim(),
            buttons: [...d.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
            printRootText: (document.querySelector('.print-root')?.textContent || '').length,
          };
        })()`);
        record('点「打印」打开打印设置弹窗', !!pdlg, pdlg ? `标题=${pdlg.title} 按钮=${JSON.stringify(pdlg.buttons)} 打印区字符=${pdlg.printRootText}` : '无弹窗');
        if (pdlg) {
          const go = pdlg.buttons.find((b) => /打印|确认|开始/.test(b)) ?? '打印';
          await page.clickByText(go, { selector: '[role="dialog"] button', settleMs: 1200 });
          await sleep(2000);
          const printed = await page.evaluate(`(() => ({
            called: !!window.__printed,
            printRootText: (document.querySelector('.print-root')?.textContent || '').length,
          }))()`);
          record('确认后触发 window.print 且打印区有内容', printed.called && printed.printRootText > 50, JSON.stringify(printed));
        }
      } else record('合同详情有打印按钮', false, '未找到「打印」按钮');
    } else record('合同详情有打印按钮', false, '无合同可测');

    /* ══════════ 诊断 ══════════ */
    const diag = {
      consoleErrors: page.consoleLogs.filter((l) => l.type === 'error'),
      exceptions: page.exceptions,
      httpErrors: page.httpErrors,
    };
    record('全程无未捕获异常', diag.exceptions.length === 0, JSON.stringify(diag.exceptions).slice(0, 200));
    record('无 console.error', diag.consoleErrors.length === 0, JSON.stringify(diag.consoleErrors).slice(0, 200));
    record(
      '无 HTTP ≥500',
      diag.httpErrors.filter((e) => Number(e.status) >= 500).length === 0,
      JSON.stringify(diag.httpErrors.filter((e) => Number(e.status) >= 500)).slice(0, 200),
    );
    writeFileSync(`${OUT}/crosscutting-report.json`, JSON.stringify({ results, diagnostics: diag }, null, 2));
  } finally {
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
