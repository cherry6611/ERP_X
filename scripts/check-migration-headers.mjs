#!/usr/bin/env node
/**
 * §6.10 (12)：迁移文件头 `-- requires:` 断言（轻量、无依赖）。
 *
 * ## 为什么需要这道门禁
 *
 * 迁移按**文件名排序**执行。新迁移若排在它所依赖的建表迁移**之前**，
 * 会在干净库上直接失败 —— 而这个失败**只在"全新建库"时暴露**：
 *   · 开发者本地库早已有那些表 → 跑 `db:migrate` 一路 OK；
 *   · CI 的 `migrate:dryrun` 是全量执行的，能拦住 —— 但它只在**改了迁移**
 *     的时候才有意义，且报错信息是 SQL 层的 "relation does not exist"，
 *     排查者要从报错反推到"我这条迁移排太前了"，成本高。
 *
 * 本仓已经**真实发生过**这类故障：`2026-10-15-upgrade-batch3z-code-rules-seed.sql`
 * 的文件头自陈「本仓已因种子排在建表前导致全新建库失败」，并因此把文件名
 * 加 `z` 后缀来确保排序靠后。`AGENTS.md` 也明文要求迁移文件头写 `-- requires:`。
 *
 * ## 断言内容（两条，都只做静态检查）
 *
 * 1. **每个迁移文件必须有 `-- requires:` 头**（历史文件已在白名单登记，
 *    白名单只允许"确实无法判断依赖"的基线迁移，且每条要写理由）；
 * 2. `-- requires:` 里出现的**文件名必须真实存在**（防止写了 `-- requires:`
 *    却把文件名拼错 —— 那种头比没有头更糟：它看起来已经被检查过了）。
 *
 * ## 有意不做的事
 *
 * **不校验"排在被依赖文件之后"**。理由：迁移链里大量依赖是隐式的
 * （种子数据依赖多张表、索引依赖列），静态无法可靠判定；
 * 硬做会产出大量假失败，而假失败比漏检查更糟 —— 它会让人开始忽略这道门禁。
 * "排序是否正确"由 `migrate:dryrun` 在真实全新库上证明，那才是权威判据。
 * 本脚本只负责**把缺失的元数据补齐**，让 dryrun 失败时能一眼看出依赖意图。
 *
 * 用法：node ./scripts/check-migration-headers.mjs
 * 退出码：0 = 通过；1 = 存在缺失/拼错的 requires 头
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'server', 'database', 'migrations');

/**
 * 白名单：允许**没有** `-- requires:` 头的迁移，必须逐条写理由。
 *
 * 只有"迁移链起点"才配得上这个豁免 —— 它没有前序依赖可写。
 * 任何新增条目都应当在 review 时被质疑。
 */
const NO_REQUIRES_WHITELIST = Object.freeze({
  '0000_baseline.sql':
    '迁移链起点（由 scripts/emit-baseline.ts 生成，无前序依赖）。' +
    '注意该文件由生成器覆写，因此不能手工加头 —— 加头会在下次 db:generate 时丢失。',
});

/** 旧的、`.sql.disabled` 之类不计入检查 */
function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(
      (name) =>
        name.endsWith('.sql') &&
        !name.includes('SKIP') &&
        !name.includes('.disabled') &&
        !name.endsWith('.sql.disabled'),
    )
    .sort();
}

function readRequires(text) {
  // 只认文件头 40 行内的 `-- requires:`（避免正文里偶然出现同名字样被当成声明）
  const head = text.split(/\r?\n/).slice(0, 40);
  for (const line of head) {
    const matched = /^--\s*requires\s*:\s*(.*)$/iu.exec(line.trim());
    if (matched) {
      return (
        matched[1]
          /*
           * 分隔符必须覆盖**中文顿号 `、`**。
           *
           * 首版只按半角/全角逗号切分，于是
           * `-- requires: A.sql（说明）、B.sql` 会被当成**一个**依赖项，
           * 拼上"（说明）"后自然找不到文件 → 误报"引用了不存在的迁移文件"。
           * 这类假失败很危险：修它最省事的办法是把说明删掉，
           * 而不是修检查器 —— 最终结果是 require 头的说明信息被磨光。
           */
          .split(/[,，、]/u)
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      );
    }
  }
  return null;
}

function main() {
  const files = listMigrations();
  const known = new Set(files);
  const missing = [];
  const dangling = [];
  const whitelisted = [];

  for (const name of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    const requires = readRequires(text);
    if (requires === null) {
      if (Object.prototype.hasOwnProperty.call(NO_REQUIRES_WHITELIST, name)) {
        whitelisted.push(name);
      } else {
        missing.push(name);
      }
      continue;
    }
    if (requires.length === 0) {
      // 写了 `-- requires:` 但后面是空的：与"没写"等价，同样算缺失
      // （作者显然想说点什么但没说完，值得人工看一眼）
      missing.push(`${name}（requires 头为空）`);
      continue;
    }
    for (const dep of requires) {
      // 允许写"（无）"之类的自然语言说明；只对**看起来像文件名**的项做存在性校验
      if (!dep.endsWith('.sql')) continue;
      if (!known.has(dep)) {
        dangling.push(`${name} → ${dep}`);
      }
    }
  }

  console.log(
    `迁移头检查：共 ${files.length} 个迁移，白名单 ${whitelisted.length} 个（均已登记理由）`,
  );

  let failed = false;
  if (missing.length > 0) {
    failed = true;
    console.error(`\n[FAIL] ${missing.length} 个迁移缺少 "-- requires:" 头：`);
    for (const name of missing) console.error(`  · ${name}`);
    console.error(
      '  请在文件头补一行，例如：\n' +
        '    -- requires: 2026-10-15-upgrade-batch1-vat-declaration.sql（本迁移依赖该表/列）\n' +
        '  迁移按文件名排序执行；写清依赖能让 dryrun 失败时可一眼定位，' +
        '而不是从 "relation does not exist" 反推。',
    );
  }

  if (dangling.length > 0) {
    failed = true;
    console.error(`\n[FAIL] ${dangling.length} 处 "-- requires:" 引用了不存在的迁移文件：`);
    for (const item of dangling) console.error(`  · ${item}`);
    console.error(
      '  拼错的文件名比没有 requires 头更糟：它看起来已经被检查过了。请核对文件名。',
    );
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }
  console.log('迁移头检查通过：所有迁移均声明了 requires，且引用文件均存在。');
}

main();
