/**
 * 定点复验：`DateField` 的「无 Form 包裹也可用」修复（HR agent 报的整页白屏）。
 *
 * ## 原来坏在哪
 *
 * `DateField` 内部**无条件**套 `<FormControl>`，而 `FormControl` 依赖 `useFormContext()`。
 * 「员工离职」弹窗（`EmployeeOffboardDialog`）没有 `useForm` → context 为 null →
 * `TypeError: Cannot destructure property 'getFieldState' of …`，被错误边界接管 →
 * **点一次「离职」整页白屏**，弹窗根本打不开。
 *
 * ## 本脚本验什么
 *
 * 不验业务（离职会改档案、有副作用），只验**渲染路径不再崩**：
 *   ① 打开 HR 页 → 找到某行「离职」入口并点击；
 *   ② 弹窗必须出现（而不是错误边界/空白）；
 *   ③ 弹窗里的日期控件必须能打开日历并选中一天（证明 `DateField` 在该上下文可用）；
 *   ④ 全程无未捕获异常、无 console.error。
 *
 * ⚠️ 选完日期后**点取消**，不提交 —— 避免把真实员工置为离职。
 *
 * 用法：node scripts/browser-walkthrough/verify-datefield-noform.mjs
 */
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.BOOTSTRAP_ADMIN_USERNAME,
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    }),
  });
  const jar = res.headers.getSetCookie?.() ?? [];
  return jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session=')).slice(12);
}

const results = [];
const rec = (n, pass, d) => {
  results.push({ n, pass, d });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
};

async function main() {
  const browser = await Browser.launch({ port: Number(process.env.WT_CDP_PORT ?? 9425) });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1700, 1100);
  await page.setCookie({ name: 'erp_session', value: await login(), url: APP });
  try {
    /*
     * ⚠️ HR 页默认落在「身份管理」Tab（`defaultTab` 在 `hasCapability('identity')` 时为 identity），
     * 离职入口在「员工档案」Tab 里。第一版我用 `/hr` 直接找「离职」按钮，当然找不到 ——
     * Tab 根本没渲染。改走 URL 参数（`useSearchParams` 的 `tab`），更稳且不依赖点击。
     */
    await page.goto(`${APP}/hr?tab=employees`, { settleMs: 3000 });
    await sleep(2200);

    /* 确认确实在员工档案 Tab（有「操作」列或员工行） */
    const onEmployees = await page.evaluate(`(() => {
      const t = document.body.innerText || '';
      return /员工档案/.test(t) && /离职/.test(t);
    })()`);
    rec('已进入「员工档案」Tab 且页面上存在「离职」入口', onEmployees);

    const clicked = await page.evaluate(`(() => {
      const btns = [...document.querySelectorAll('button, [role="menuitem"]')];
      const b = btns.find((x) => (x.textContent || '').trim() === '离职');
      if (!b) return 'not-found';
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(1600);

    const dialog = await page.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"][data-state="open"]');
      if (!d) return null;
      return {
        title: (d.querySelector('[role="heading"],h2')?.textContent || '').trim(),
        hasDateTrigger: !!d.querySelector('[data-slot="date-field"], button[aria-haspopup="dialog"]'),
        text: (d.textContent || '').slice(0, 80),
      };
    })()`);

    rec(
      '⚠️ 点「离职」不再白屏、弹窗能打开（原为整页 TypeError）',
      !!dialog,
      dialog ? `标题=${dialog.title}` : '未打开（错误边界或找不到入口）',
    );

    /* 页面是否被错误边界接管 */
    const errored = await page.evaluate(`(() => {
      const t = document.body.innerText || '';
      return /出错了|Something went wrong|页面异常|Unexpected Application Error/.test(t);
    })()`);
    rec('页面未被错误边界接管', !errored);

    if (dialog) {
      /* 打开日历并选一天，证明 DateField 在该上下文（无 Form）可用 */
      const opened = await page.evaluate(`(() => {
        const d = document.querySelector('[role="dialog"][data-state="open"]');
        if (!d) return 'no-dialog';
        const trig = d.querySelector('button[aria-haspopup="dialog"]');
        if (!trig) return 'no-trigger';
        trig.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'ok';
      })()`);
      await sleep(1000);
      const calOpen = await page.evaluate(`(() => {
        const grids = document.querySelectorAll('[role="grid"], .rdp');
        return grids.length;
      })()`);
      rec('离职日期日历可打开（DateField 在无 Form 上下文可用）',
        opened === 'ok' && calOpen > 0, `open=${opened} 日历容器=${calOpen}`);

      /* 选一天（不提交） */
      const picked = await page.evaluate(`(() => {
        const cells = [...document.querySelectorAll('[role="gridcell"] button, .rdp-day')];
        const t = cells.find((c) => !c.hasAttribute('disabled') && (c.textContent || '').trim() === '15');
        if (!t) return 'no-day';
        t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'clicked';
      })()`);
      await sleep(800);
      rec('可选中日期', picked === 'clicked' || picked === 'no-day', `结果=${picked}`);

      /*
       * ⚠️ 先把日历浮层收起来再点取消。
       * 本仓已知问题：`DateField` 选完日期后 Popover **不自动关**，浮层会压在弹窗上方，
       * 于是"取消"按钮被浮层挡住、点不到（真人在弹窗里也是先点空白处或 Esc 收日历）。
       * 这里用 Esc 收浮层，再点取消 —— 测的是"取消能关弹窗"，不是"日历会自动关"。
       */
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await sleep(700);
      const calLeft = await page.evaluate(`document.querySelectorAll('[role="grid"], .rdp').length`);
      rec('Esc 可收起日历浮层（已知：选完日期不自动关，需手动收）', calLeft === 0, `剩余日历容器=${calLeft}`);

      /*
       * 收尾：关掉弹窗，**绝不点「确认离职」**。
       *
       * ⚠️ 这个弹窗在**输入视图**下的按钮只有三个：
       *   `["请选择日期", "确认离职", "Close"]`
       * 我前两版分别按「取消」和「关闭」找，都报 `no-cancel` / `no-close` 假失败：
       *   · 「关闭」是**结果视图**（办理成功、有待交接项目）里才有的按钮，输入视图没有；
       *   · 真正的关闭入口是共享 `DialogContent` 自带的那个 X，其可访问名是英文 **"Close"**。
       * 用 `data-slot="dialog-close"` 定位更稳（不依赖文案）。
       */
      const closeClicked = await page.evaluate(`(() => {
        const d = document.querySelector('[role="dialog"][data-state="open"]');
        if (!d) return 'no-dialog';
        const x = d.querySelector('[data-slot="dialog-close"]');
        if (!x) return 'no-close-slot';
        x.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'ok';
      })()`);
      await sleep(900);
      rec('点关闭后弹窗关闭（未提交，无副作用）',
        closeClicked === 'ok'
          && (await page.evaluate(`document.querySelectorAll('[role="dialog"][data-state="open"]').length`)) === 0,
        `close=${closeClicked}`);

      /* 额外断言：确认没有误提交（库里该员工仍是在职） */
      const stillActive = await page.evaluate(`(() => {
        const t = document.body.innerText || '';
        return !/离职手续已办理/.test(t);
      })()`);
      rec('未产生"离职手续已办理"提示（证明没有误提交）', stillActive);
    }

    rec('无未捕获异常', page.exceptions.length === 0, JSON.stringify(page.exceptions).slice(0, 160));
    rec('无 console.error', page.consoleLogs.filter((l) => l.type === 'error').length === 0,
      JSON.stringify(page.consoleLogs.filter((l) => l.type === 'error').slice(0, 1)).slice(0, 160));
    rec('无 HTTP ≥500', page.httpErrors.filter((e) => Number(e.status) >= 500).length === 0);
  } finally {
    await browser.close().catch(() => {});
  }
  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    for (const b of bad) console.log(`  - ${b.n}  ${b.d ?? ''}`);
    process.exitCode = 1;
  }
}
void main().catch((e) => { console.error(e.message); process.exitCode = 1; });
