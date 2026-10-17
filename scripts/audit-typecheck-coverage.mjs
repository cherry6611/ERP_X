/**
 * 门禁覆盖审计：**有没有哪些源码文件不被任何 tsconfig 检查到**？
 *
 * ## 为什么需要这个
 *
 * 2026-10-17 实测：`type:check:server` 用的 `tsconfig.node.json` 的 `exclude`
 * 含 spec 通配，而 jest 用的 `tsconfig.test.json` 才含 spec ——
 * 于是 **108 个 spec 文件从来没有被任何门禁类型检查过**：
 * 在 spec 里写一个未定义标识符，`npm run type:check` 退出码是 **0**。
 *
 * 那次的教训是"某个 glob 被悄悄排除掉了"。但**手写 glob 清单总会漏**，
 * 所以这里不靠人记，而是**用 tsc 自己的文件解析结果**去算：
 * 对每个 tsconfig 跑 `--listFilesOnly`，把结果并起来，
 * 再看 `server/` 与 `shared/` 下的源码里有谁**不在并集里**。
 *
 * ## 判据
 *
 * 之所以敢断言"必须被某个 tsconfig 覆盖"：本仓的 `type:check` 是四路
 * （server / client / scripts / specs），任何**源码**都应当落在其中一路。
 * 落到并集之外的，就是"编译器与 CI 都看不见"的文件 —— 那类文件坏了没人知道。
 *
 * 用法：npx tsx scripts/audit-typecheck-coverage.mjs
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const CONFIGS = [
  'tsconfig.node.json', // type:check:server
  'tsconfig.app.json', // type:check:client
  'tsconfig.scripts.json', // type:check:scripts
  'tsconfig.spec-server.json', // type:check:specs（本轮新增）
];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(p, out);
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 用 tsc 自己解析该 config 覆盖的文件清单。
 *
 * ⚠️ 两个踩过的坑：
 *
 * ① **不要用 `npx`**：Windows 上 `npx.cmd` + `shell:false` 会 `EINVAL`；
 *    而 `shell:true` 会触发 Node 的 DEP0190 警告（args 只是拼接、未转义）。
 *    直接调用**仓库内的** `node_modules/typescript/bin/tsc`（经由 `process.execPath`），
 *    零 shell、零 warning、且用的是本仓锁定的那个 TS 版本。
 *
 * ② **解析失败必须算失败**：我第一版在解析失败时 `return []`，
 *    于是"0 个文件被覆盖"与"真的有 0 个未覆盖文件"长得一模一样 ——
 *    脚本照样打印 "✓ 每个源码文件都覆盖到了"，**是假通过**。
 *    现在把失败记进 `failures`，由 main 统一判失败。
 */
const failures = [];

function filesOf(config) {
  const tscBin = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    const out = execFileSync(
      process.execPath,
      [tscBin, '--noEmit', '--project', config, '--listFilesOnly'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    /* --listFilesOnly 会把每个文件打成一行绝对路径 */
    const files = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('error') && (l.endsWith('.ts') || l.endsWith('.tsx')));
    if (files.length === 0) failures.push(`${config} 解析出 0 个文件（不该发生）`);
    return files;
  } catch (e) {
    const msg = String(e.message).split('\n')[0];
    failures.push(`${config} 解析失败：${msg}`);
    console.log(`  ⚠️ ${config} 解析失败：${msg}`);
    return [];
  }
}

const covered = new Set();
console.log('  tsconfig 覆盖情况：');
for (const cfg of CONFIGS) {
  const files = filesOf(cfg);
  for (const f of files) covered.add(f.replace(/\\/g, '/').toLowerCase());
  console.log(`    ${cfg.padEnd(28)} ${String(files.length).padStart(5)} 个文件`);
}

/* 只看"源码"：server/ 与 shared/
 * 显式排除 server/mcp/ui（tsconfig.node.json 有意排除它，且它由自己的构建负责） */
const sourceFiles = [...walk(join(ROOT, 'server')), ...walk(join(ROOT, 'shared'))]
  .map((f) => f.replace(/\\/g, '/'))
  .filter((f) => !f.includes('/node_modules/') && !f.includes('/dist/'))
  .filter((f) => !f.includes('/server/mcp/ui/'));

const uncovered = sourceFiles.filter((f) => !covered.has(f.toLowerCase()));

console.log(`\n  server + shared 源码：${sourceFiles.length} 个`);
console.log(`  其中**不被任何 tsconfig 覆盖**：${uncovered.length} 个\n`);

/* 解析失败一律判失败：否则"没解析出来"会伪装成"全部覆盖到了" */
if (failures.length > 0) {
  console.error(`  ✗ ${failures.length} 个 tsconfig 未能解析，本次结果**不可信**：`);
  for (const f of failures) console.error(`    · ${f}`);
  process.exitCode = 1;
} else if (uncovered.length === 0) {
  console.log('  ✓ 每个源码文件都落在某一路 type:check 的覆盖范围内');
} else {
  for (const f of uncovered) console.log(`    · ${relative(ROOT, f).replace(/\\/g, '/')}`);
  console.log(
    '\n  这些文件编译器看不见 —— 里面有类型错误也不会被任何门禁发现。\n' +
      '  修法：把它们纳入某个 tsconfig 的 include（或确认它们确实无需类型检查并在此登记豁免）。',
  );
  process.exitCode = 1;
}
