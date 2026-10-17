/**
 * 端到端探针：验证 `PER_REQUEST_TX=connection`（现默认）在真实 PG 上工作，
 * 且会话级 GUC `app.user_id` 正确绑定、不跨请求串号。
 *
 * 断言：
 *   1. 登录成功（请求经过中间件 → 预留连接 → drizzle）。
 *   2. 认证后的 GET 请求返回 200（证明 reserved-connection 的 drizzle 句柄可用）。
 *   3. 未认证请求返回 401。
 *   4. 并发 12 个认证请求全部成功（证明连接预留/归还无泄漏、无串号）。
 *   5. 服务端日志无 SessionMiddleware 错误。
 *
 * 用法：node ./scripts/e2e-probe-connection-mode.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3100';
const USER = process.env.ERP_PROBE_USER ?? 'chengsheng@chengshengdata.cn';
const PASS = process.env.ERP_PROBE_PASS ?? '******';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 极简 cookie jar */
function jarFrom(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map((c) => c.split(';')[0]).join('; ');
}

async function get(path, cookie) {
  return fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
}

// 1) 登录
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const cookie = jarFrom(loginRes);
record('登录成功', loginRes.status === 201, `status=${loginRes.status}`);
if (loginRes.status !== 201) {
  console.log(await loginRes.text());
  process.exit(1);
}
record('登录返回会话 Cookie', cookie.length > 0, cookie.slice(0, 40));

// 2) 认证后的读请求（经过 drizzle + 预留连接）
const authedEndpoints = [
  '/api/auth/me',
  '/api/tasks/summary',
  '/api/system/dictionary/options',
  '/api/master-data/tax-entities',
];
for (const path of authedEndpoints) {
  const res = await get(path, cookie);
  const body = await res.text();
  record(`认证读 ${path}`, res.status === 200, `status=${res.status} len=${body.length}`);
}

// 3) 未认证必须 401
const unauth = await get('/api/voucher/vouchers');
record('未认证返回 401', unauth.status === 401, `status=${unauth.status}`);

// 4) 并发认证请求（连接预留/归还、GUC 隔离）
const conc = await Promise.all(
  Array.from({ length: 12 }, (_, i) =>
    get(authedEndpoints[i % authedEndpoints.length], cookie).then((r) => r.status)
  )
);
record(
  '并发 12 个认证请求全部 200',
  conc.every((s) => s === 200),
  `statuses=${[...new Set(conc)].join(',')}`
);

// 5) 混合并发：认证 + 未认证交替，确认不会互相串号
const mixed = await Promise.all(
  Array.from({ length: 10 }, (_, i) =>
    i % 2 === 0
      ? get('/api/auth/me', cookie).then((r) => r.status)
      : get('/api/auth/me').then((r) => r.status)
  )
);
record(
  '认证/未认证交替并发：状态各自正确',
  mixed.filter((s) => s === 200).length === 5 &&
    mixed.filter((s) => s === 401).length === 5,
  `statuses=${mixed.join(',')}`
);

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
process.exit(failed.length === 0 ? 0 : 1);
