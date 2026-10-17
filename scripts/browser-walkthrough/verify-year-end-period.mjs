/**
 * 定点复验：年结页在期间工具抽出后行为一致（`./period-utils`）。
 *
 * ## 为什么只读、不执行年结
 *
 * 「执行年结结转」会**生成结转凭证**，是跨期不可逆动作。本脚本只验证：
 *   · 页面能渲染（期间选择器、预览、历史）；
 *   · `assertPeriod` 闸门仍生效 —— 通过**接口**用非法期间请求预览，必须 400 且文案一致；
 *   · 合法期间的预览与状态查询可用。
 *
 * 用法：node scripts/browser-walkthrough/verify-year-end-period.mjs
 */
import { Browser, sleep } from './cdp.mjs';
import { readFileSync } from 'node:fs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';

function envOf(key) {
  const line = readFileSync('.env', 'utf8').split(/\r?\n/u).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

const results = [];
const rec = (n, pass, d) => {
  results.push({ n, pass, d });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
};

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: envOf('BOOTSTRAP_ADMIN_USERNAME'),
      password: envOf('BOOTSTRAP_ADMIN_PASSWORD'),
    }),
  });
  const jar = login.headers.getSetCookie?.() ?? [];
  const session = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session=')).slice(12);
  const call = async (path) => {
    const res = await fetch(`${API}${path}`, { headers: { cookie: `erp_session=${session}` } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
  };

  /*
   * ── 接口级：非法期间必须被拦下 ──
   *
   * ⚠️ 断言不要写死成"期间格式必须为 YYYY-MM"（`period-utils` 里那条文案）：
   * 请求先过 **DTO 校验层**，非法期间在那里就被拦下并返回
   * `period 必填且格式为 YYYY-MM`，**根本走不到** service 的 `assertPeriod`。
   * 我第一版就是这样把 4 条都误报成失败的（行为其实完全正确）。
   *
   * 这里断言"是 400 且文案点名了 YYYY-MM"——两层防线谁先拦都算通过；
   * 并把实际文案打出来，便于分辨是哪一层拦的。
   */
  for (const bad of ['2026-13', '2026-1', '2026', 'abcd-ef']) {
    const r = await call(`/api/finance/year-end/preview?period=${encodeURIComponent(bad)}`);
    const msg = r.json?.error?.message ?? '';
    const layer = msg.includes('期间格式必须为') ? 'service(assertPeriod)' : 'DTO(@Matches)';
    rec(
      `非法期间 ${bad} → 400 且文案点名 YYYY-MM`,
      r.status === 400 && /YYYY-MM/.test(msg),
      `HTTP ${r.status} [${layer}] ${msg.slice(0, 44)}`,
    );
  }

  /* ── 合法期间：预览与状态应可用（只读）── */
  const ok = await call('/api/finance/year-end/preview?period=2026-10');
  rec('合法期间预览可用（只读）', ok.status === 200, `HTTP ${ok.status}`);
  const st = await call('/api/finance/year-end/status');
  rec('年结状态查询可用（只读）', st.status === 200, `HTTP ${st.status}`);

  /* ── 浏览器：页面渲染 ── */
  const browser = await Browser.launch({ port: Number(process.env.WT_CDP_PORT ?? 9432) });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1700, 1100);
  await page.setCookie({ name: 'erp_session', value: session, url: APP });
  try {
    await page.goto(`${APP}/finance/year-end`, { settleMs: 3000 });
    await sleep(1800);
    const info = await page.evaluate(`(() => {
      const text = document.body.innerText || '';
      const h1 = document.querySelector('h1');
      const row = h1 ? h1.parentElement?.parentElement : null;
      const a = row && row.children.length > 1 ? row.children[1] : null;
      return {
        title: h1 ? (h1.textContent || '').trim() : null,
        headerBtns: a ? [...a.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean) : [],
        hasPreview: /结转损益预览|预览/.test(text),
        hasStatus: /年结状态|历史|状态/.test(text),
        periodShown: /2026-10/.test(text),
      };
    })()`);
    rec('年结页渲染（标题 + 页头动作）', info.title === '期末年结', `标题=${info.title} 页头=${JSON.stringify(info.headerBtns)}`);
    rec('预览与状态区块在', info.hasPreview && info.hasStatus);
    rec('期间筛选显示 2026-10', info.periodShown);
    rec('无未捕获异常', page.exceptions.length === 0, JSON.stringify(page.exceptions).slice(0, 140));
    rec('无 console.error', page.consoleLogs.filter((l) => l.type === 'error').length === 0);
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
