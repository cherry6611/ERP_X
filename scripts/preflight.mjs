/**
 * 上线前预检（pre-flight）：把所有**可机械验证**的上线条件跑一遍，给出 GO / NO-GO。
 *
 * ## 为什么需要它
 *
 * 上线前要确认的事分散在十几个脚本与文档里：环境变量齐不齐、迁移账本与文件一不一致、
 * 生产密钥护栏是否生效、报表自查是否自洽、库里有没测试残留、UI 结构有没有回退、
 * 构建是否比源码新……**没人会逐条记得跑**。
 *
 * 手工清单的失效方式是"漏跑一项而自己不知道"。所以这里把凡是能自动判定的都自动判定，
 * 剩下的（备份演练、反代配置、真实密钥注入）明确列成**人工步骤**，不假装检查过。
 *
 * ## 判定口径
 *
 * 每项输出 `BLOCKER / WARN / PASS`：
 *   · **BLOCKER** —— 只要有一条不通过就 NO-GO（退出码 1）；
 *   · **WARN** —— 需要人工确认但不一定阻断；
 *   · **PASS** —— 自动检查通过。
 *
 * ⚠️ 本脚本**不修改**任何数据（只读 + 起子进程跑既有校验脚本），可以安全地在生产前置机上跑。
 *
 * 用法：
 *   npx tsx scripts/preflight.mjs                 # 连默认开发库/端口
 *   WT_API=http://api:3000 npx tsx scripts/preflight.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const ROOT = process.cwd();
const API = process.env.WT_API ?? 'http://127.0.0.1:3000';

const rows = [];
const add = (level, name, detail) => {
  rows.push({ level, name, detail });
  const tag = level === 'BLOCKER' ? '✗ BLOCKER' : level === 'WARN' ? '! WARN   ' : '✓ PASS   ';
  console.log(`  ${tag}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** 跑一个 node 脚本，返回 {ok, out}（不抛） */
function runNode(script, args = [], timeout = 600_000) {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function readEnvFile(path) {
  if (!existsSync(path)) return null;
  const map = new Map();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m) map.set(m[1], line);
  }
  return map;
}

/* ────────── 1. 环境变量：.env.example 是否覆盖服务端实际读取的键 ────────── */
function checkEnvKeys() {
  const example = readEnvFile(join(ROOT, '.env.example'));
  if (!example) {
    add('BLOCKER', '环境变量清单', '.env.example 不存在');
    return;
  }
  /* 扫描服务端源码里 process.env.XXX 的读取点 */
  const keys = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (name === 'node_modules' || name === 'dist' || name === 'mcp') continue;
        walk(p);
      } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) keys.add(m[1]);
      }
    }
  };
  walk(join(ROOT, 'server'));
  const missing = [...keys].filter((k) => !example.has(k)).sort();
  if (missing.length === 0) {
    add('PASS', '环境变量清单', `.env.example 覆盖服务端读取的 ${keys.size} 个键`);
  } else {
    add('BLOCKER', '环境变量清单', `.env.example 缺 ${missing.length} 键：${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}`);
  }
}

/* ────────── 2. 迁移账本 vs 文件 ────────── */
async function checkMigrations(sql) {
  const dir = join(ROOT, 'server', 'database', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let applied = [];
  try {
    applied = (await sql`SELECT id FROM schema_migrations ORDER BY id`).map((r) => r.id);
  } catch (e) {
    add('BLOCKER', '迁移账本', `读 schema_migrations 失败：${String(e.message).split('\n')[0]}`);
    return;
  }
  const fileSet = new Set(files);
  const appliedSet = new Set(applied);
  const notApplied = files.filter((f) => !appliedSet.has(f));
  const noFile = applied.filter((a) => !fileSet.has(a));

  if (notApplied.length === 0 && noFile.length === 0) {
    add('PASS', '迁移账本', `${files.length} 条文件与账本完全一致`);
  } else {
    if (notApplied.length) {
      add('BLOCKER', '迁移账本', `有 ${notApplied.length} 条文件未应用：${notApplied.slice(0, 5).join(', ')}`);
    }
    if (noFile.length) {
      add('BLOCKER', '迁移账本', `有 ${noFile.length} 条账本记录找不到文件（runner 会拒绝执行）：${noFile.slice(0, 5).join(', ')}`);
    }
  }
}

/* ────────── 3. migrate:dryrun（pglite 全链） ────────── */
function checkDryrun() {
  /*
   * 直接调 node 脚本而不是 `npm run`：后者需要 `shell: true`（Windows 的 npm 是 .cmd），
   * 而 Node 会因此打 DEP0190 警告（"args 只是拼接、未转义"）。
   * 直连脚本既没有警告，也不依赖 shell 解析。
   */
  const out = runNode(join(ROOT, 'scripts', 'migrate-dryrun.mjs'), [], 900_000);
  const line = out.out.split(/\r?\n/).find((l) => l.includes('SUMMARY')) ?? '';
  if (out.ok) {
    add('PASS', '迁移链 dryrun', line.trim().slice(0, 100));
  } else {
    add(
      'BLOCKER',
      '迁移链 dryrun',
      out.out.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ').slice(0, 160),
    );
  }
}

/* ────────── 4. 构建新鲜度：dist 是否比源码新 ────────── */
function checkBuildFreshness() {
  const distMain = join(ROOT, 'dist', 'server', 'main.js');
  if (!existsSync(distMain)) {
    add('BLOCKER', '构建新鲜度', 'dist/server/main.js 不存在，请先 npm run build');
    return;
  }
  const distTime = statSync(distMain).mtimeMs;
  let newest = 0;
  let newestFile = '';
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (name === 'node_modules' || name === 'dist') continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.spec.ts')) {
        if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = p.replace(ROOT + '\\', '').replace(ROOT + '/', ''); }
      }
    }
  };
  walk(join(ROOT, 'server'));
  walk(join(ROOT, 'shared'));
  if (newest > distTime) {
    add('BLOCKER', '构建新鲜度', `源码比 dist 新：${newestFile}（需重新 npm run build）`);
  } else {
    add('PASS', '构建新鲜度', 'dist 不早于任何 server/shared 源码');
  }
}

/* ────────── 5. 服务健康 ────────── */
async function checkHealth() {
  try {
    const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(5000) });
    add(r.ok ? 'PASS' : 'BLOCKER', '服务健康检查', `${API}/api/health → ${r.status}`);
  } catch (e) {
    add('BLOCKER', '服务健康检查', `${API} 不可达：${String(e.message).split('\n')[0]}`);
  }
}

/* ────────── 6. 报表自查自洽（端到端） ────────── */
function checkReportChecks() {
  const r = runNode(join(ROOT, 'scripts', 'verify-report-checks.mjs'));
  const line = r.out.split(/\r?\n/).find((l) => l.startsWith('结果:')) ?? '';
  add(r.ok ? 'PASS' : 'BLOCKER', '报表自查自洽', line.trim() || (r.ok ? 'ok' : '见输出'));
}

/* ────────── 7. 测试数据残留（孤儿关联） ────────── */
function checkResidue() {
  const r = runNode(join(ROOT, 'scripts', 'audit-test-residue.mjs'));
  const orphans = r.out.split(/\r?\n/).filter((l) => l.includes('⚠️')).slice(0, 3);
  if (r.ok) {
    add('PASS', '测试数据残留', '业务表无测试数据、无孤儿关联');
  } else {
    add('BLOCKER', '测试数据残留', orphans.join(' | ').slice(0, 160) || '见输出');
  }
}

/* ────────── 8. UI 结构一致性（审计 0 待处理） ────────── */
function checkUiConsistency() {
  const r = runNode(join(ROOT, 'scripts', 'audit-ui-consistency.mjs'));
  const m = r.out.match(/合计可疑点:\s*(\d+)/);
  const n = m ? Number(m[1]) : -1;
  if (r.ok && n === 0) add('PASS', 'UI 结构一致性', '审计 0 项待处理（例外均附理由）');
  else add('BLOCKER', 'UI 结构一致性', `仍有 ${n} 项待处理`);
}

/* ────────── 9. 类型覆盖：每个源码文件都落在某路 type:check ────────── */
function checkTypecheckCoverage() {
  const r = runNode(join(ROOT, 'scripts', 'audit-typecheck-coverage.mjs'), [], 900_000);
  const m = r.out.match(/不被任何 tsconfig 覆盖\*\*：(\d+)/);
  const n = m ? Number(m[1]) : -1;
  if (r.ok && n === 0) add('PASS', '类型检查覆盖', '0 个源码文件落在四路 type:check 之外');
  else add('BLOCKER', '类型检查覆盖', n >= 0 ? `${n} 个文件未被任何 tsconfig 检查` : '脚本失败');
}

/* ────────── 10. 生产密钥护栏（真实启动 5 条） ────────── */
function checkSecretGuard() {
  const r = runNode(join(ROOT, 'scripts', 'verify-prod-secrets-guard.mjs'), [], 600_000);
  const line = r.out.split(/\r?\n/).find((l) => l.startsWith('结果:')) ?? '';
  add(r.ok ? 'PASS' : 'BLOCKER', '生产密钥护栏', line.trim() || (r.ok ? 'ok' : '见输出'));
}

/* ────────── 人工步骤（不假装检查过） ────────── */
function humanSteps() {
  add('WARN', '【人工】生产密钥注入', 'JWT_SECRET ≥32 字符、SECRET_ENC_KEY ≥16，且**不得**用 .env 样例值');
  add('WARN', '【人工】数据库备份演练', 'pg_dump 全库 + 恢复演练（见 docs/RUNBOOK.md），记录文件名与校验和');
  add('WARN', '【人工】反代与 trust proxy', 'Nginx 后需设 TRUST_PROXY_HOPS，否则全局限速会把全体用户一起封');
  add('WARN', '【人工】飞书回调地址', 'FEISHU_REDIRECT_URI 须与 APP_BASE_URL / 浏览器三者一致，且与飞书开放平台逐字符相同');
  add('WARN', '【人工】主数据录入', '迁移不种子部门/客户/供应商，需管理员在设置页录入');
  add('WARN', '【人工】生产数据量下的验证', '本预检在开发库上跑；生产量级的报表性能、并发核销、批量导入需另验');
}

async function main() {
  console.log('=== 上线前预检（只读，不改数据）===\n');
  console.log(`  目标 API: ${API}\n`);

  checkEnvKeys();
  checkBuildFreshness();
  checkDryrun();

  const url = readFileSync(join(ROOT, '.env'), 'utf8')
    .split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='))?.slice(13).trim();
  const sql = postgres(url, { max: 1, idle_timeout: 10, connect_timeout: 10 });
  try {
    await checkMigrations(sql);
  } finally {
    await sql.end({ timeout: 3 }).catch(() => {});
  }

  await checkHealth();
  checkReportChecks();
  checkResidue();
  checkUiConsistency();
  checkTypecheckCoverage();
  checkSecretGuard();
  humanSteps();

  const blockers = rows.filter((r) => r.level === 'BLOCKER');
  const warns = rows.filter((r) => r.level === 'WARN');
  console.log('\n────────────────────────────────────────');
  console.log(`  自动检查通过: ${rows.filter((r) => r.level === 'PASS').length}`);
  console.log(`  阻断项: ${blockers.length}`);
  console.log(`  人工步骤: ${warns.length}`);
  if (blockers.length > 0) {
    console.log('\n  **NO-GO**：以下阻断项必须先解决');
    for (const b of blockers) console.log(`    · ${b.name} — ${b.detail}`);
    process.exitCode = 1;
  } else {
    console.log('\n  **自动检查全部通过（GO on automation）**');
    console.log('  ⚠️ 但上线仍需完成上面 ' + warns.length + ' 项人工步骤 —— 本脚本不替你验证它们。');
  }
}

void main().catch((e) => { console.error('预检失败:', e.message); process.exitCode = 1; });
