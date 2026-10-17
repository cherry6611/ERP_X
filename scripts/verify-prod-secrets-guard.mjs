/**
 * 生产启动护栏的**行为复验**（`server/main.ts` 的 `assertProductionSecrets`）。
 *
 * ## 为什么必须在真实进程上验，而不是只读代码
 *
 * 这三条是**上线安全边界**，任何一条失效都不会在功能测试里暴露：
 *
 * | # | 断言 | 失效后果 |
 * |---|---|---|
 * | ① | 弱密钥 + `NODE_ENV=production` → **拒绝启动**（退出码非 0） | 任何人可伪造管理员会话 |
 * | ② | 弱密钥 + `ALLOW_WEAK_SECRETS=true` + `NODE_ENV=production` → **仍然拒绝** | 一个环境变量把全部门打开 |
 * | ③ | **不设** `NODE_ENV` + 弱密钥 → **仍然拒绝**（fail-safe） | 最常见的误配变成"无护栏" |
 *
 * ②③ 两条特别容易在重构中被"顺手放宽"（例如把 `enforce` 写成
 * `NODE_ENV==='production'`，于是不设就跳过校验），所以用真实启动来钉住。
 *
 * ④ 反向断言：给足强度的密钥 + production → **能过护栏**（否则护栏过严、
 * 生产根本起不来，也是故障）。
 *
 * 用法：node scripts/verify-prod-secrets-guard.mjs
 */
import { spawn } from 'node:child_process';

const CWD = process.cwd();
const SERVER = 'dist/server/main.js';
const STRONG_JWT = 'a'.repeat(48);
const STRONG_ENC = 'b'.repeat(24);

const results = [];
const rec = (n, pass, d) => {
  results.push({ n, pass, d });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
};

/**
 * 启动服务并收集输出。
 *
 * ## 为什么必须用**独立端口 + 健康轮询**，而不是"进程还活着"就算通过
 *
 * 我第一版把"到点还在运行"当作"护栏通过"。这个判据**不可靠**：
 * 端口被占用时进程也会一直活着（或挣扎一阵），于是"没通过护栏"会伪装成"通过"。
 * 所以现在：
 *   · 给每次启动分配一个**独立端口**（`SERVER_PORT`），避免与常驻服务/彼此冲突；
 *   · 判定"护栏通过"的依据是 **`GET /api/health` 返回 200**（真的在服务），
 *     而不是"进程没退出"；
 *   · 判定"被护栏拒绝"的依据是**进程已退出且输出含密钥校验失败**。
 */
async function pollHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function runServer(env, port, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: CWD,
      env: { ...process.env, SERVER_PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });

    const finish = (kind, code, healthy) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve({ kind, code, out, err, healthy });
    };

    child.on('exit', (code) => finish('exited', code, false));
    /* 轮询健康：起来了就立刻收工（healthy=true），否则等到超时 */
    void (async () => {
      const ok = await pollHealth(port, timeoutMs);
      finish(ok ? 'healthy' : 'timeout', null, ok);
    })();
  });
}

const secretFailure = (r) => /密钥校验失败/.test(r.err) || /密钥校验失败/.test(r.out);

async function main() {
  console.log('  目标：dist/server/main.js\n');

  /* ① 弱密钥 + production → 拒绝 */
  const r1 = await runServer({ NODE_ENV: 'production', JWT_SECRET: 'weak', SECRET_ENC_KEY: 'weak' }, 3151);
  rec(
    '① 弱密钥 + NODE_ENV=production → 拒绝启动（非 0 退出）',
    r1.kind === 'exited' && r1.code !== 0 && secretFailure(r1),
    `kind=${r1.kind} code=${r1.code}`,
  );

  /* ② ALLOW_WEAK_SECRETS 在生产**无效** */
  const r2 = await runServer({
    NODE_ENV: 'production',
    ALLOW_WEAK_SECRETS: 'true',
    JWT_SECRET: 'weak',
    SECRET_ENC_KEY: 'weak',
  }, 3152);
  rec(
    '② ⚠️ ALLOW_WEAK_SECRETS=true 在生产仍被拒（一个环境变量打不开门）',
    r2.kind === 'exited' && r2.code !== 0 && secretFailure(r2),
    `kind=${r2.kind} code=${r2.code}`,
  );

  /* ③ 不设 NODE_ENV → fail-safe 按生产处理 */
  const r3 = await runServer({ NODE_ENV: '', JWT_SECRET: 'weak', SECRET_ENC_KEY: 'weak' }, 3153);
  rec(
    '③ ⚠️ 不设 NODE_ENV + 弱密钥 → 仍被拒（fail-safe，最常见的误配）',
    r3.kind === 'exited' && r3.code !== 0 && secretFailure(r3),
    `kind=${r3.kind} code=${r3.code}`,
  );

  /* ④ 反向：强密钥 + production → 能过护栏（进程持续运行） */
  const r4 = await runServer(
    { NODE_ENV: 'production', JWT_SECRET: STRONG_JWT, SECRET_ENC_KEY: STRONG_ENC },
    3154,
    20000,
  );
  const passedGuard = r4.healthy === true;
  rec(
    '④ 强密钥 + production → 通过护栏（不因过严而启动不了）',
    passedGuard,
    `kind=${r4.kind} code=${r4.code}`,
  );

  /* ⑤ 开发环境 + ALLOW_WEAK_SECRETS=true → 允许（本地联调路径不能被误封） */
  const r5 = await runServer(
    { NODE_ENV: 'development', ALLOW_WEAK_SECRETS: 'true', JWT_SECRET: 'weak', SECRET_ENC_KEY: 'weak' },
    3155,
    20000,
  );
  rec(
    '⑤ development + ALLOW_WEAK_SECRETS=true → 允许且真的在服务（本地联调路径未被误封）',
    r5.healthy === true && !secretFailure(r5),
    `kind=${r5.kind} code=${r5.code}`,
  );

  const bad = results.filter((r) => !r.pass);
  console.log(`\n结果: ${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    for (const b of bad) console.log(`  - ${b.n}  ${b.d ?? ''}`);
    console.log('\n  提示：被拒时的关键输出片段——');
    console.log('   ', (r1.err.split('\n').find((l) => /密钥校验失败/.test(l)) ?? '(无)').trim().slice(0, 160));
    process.exitCode = 1;
  }
}
void main().catch((e) => { console.error(e.message); process.exitCode = 1; });
