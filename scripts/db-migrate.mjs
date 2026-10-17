import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

// 预加载仓库根 .env（Windows 下 `node --env-file` 之外更省事的用法）
try {
  const dotenv = await import('dotenv');
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
  dotenv.config({ path: join(root, '.env') });
} catch {
  /* 变量可能由编排层注入，忽略 */
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL：请复制 .env.example 为 .env 并填写，或确认 PostgreSQL 已启动');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

/*
 * S3（§6.7.2）：迁移账本增加 **checksum** 列并在执行前比对。
 *
 * ## 原缺陷
 *
 * 账本只有 `id text PRIMARY KEY, applied_at timestamptz` —— **只记文件名 + 时间，
 * 无内容校验**；runner 按文件名"已应用即跳过"。而 `package.json` 存在正式脚本
 * `db:generate = tsx ./scripts/emit-baseline.ts`，它整文件重写
 * `0000_baseline.sql`。若该迁移已在生产库应用，重写后文件内容与库中实际 DDL
 * 可以完全不同，而**账本、CI、dryrun 均不报警** ——
 * 迁移链的"权威正文"可被静默改写。
 *
 * ## 修法（三步，都在本文件里）
 *
 * 1. 账本加 `checksum` 列（`ADD COLUMN IF NOT EXISTS`，幂等）；
 * 2. **执行任何迁移之前**先比对：已登记迁移的文件 checksum 与账本不一致，
 *    或账本里有文件却不存在 → **中断且不执行任何迁移**，并给出补救指引；
 * 3. 加列之前登记的历史行 checksum 为 NULL → 首次运行时**回填**为当前文件内容，
 *    并明确提示"这只建立了从现在起的基线"，不假装它验证了历史。
 */
await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
await sql.unsafe(`
  ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text
`);

/** 文件内容校验和（sha256 前 16 位十六进制：足够区分，且便于人工比对） */
function fileChecksum(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// 修复 P1-6：改用脚本自身位置定位迁移目录，不再依赖 process.cwd()，
// 否则从仓库父目录（如 晟笙ERP/）执行会 ENOENT。
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dir = join(ROOT, 'server', 'database', 'migrations');
// L14：忽略含 SKIP / .disabled 的迁移，避免与 drizzle baseline 漂移的半成品被误执行
const files = readdirSync(dir)
  .filter(
    (name) =>
      name.endsWith('.sql') &&
      !name.includes('SKIP') &&
      !name.includes('.disabled') &&
      !name.endsWith('.sql.disabled'),
  )
  .sort();

/* ── 前置比对（在任何迁移执行之前）────────────────────────────────────────── */
const ledger = await sql`select id, checksum from schema_migrations`;
const ledgerById = new Map(ledger.map((row) => [row.id, row.checksum]));

const drifted = [];
for (const id of files) {
  const recorded = ledgerById.get(id);
  if (recorded === null || recorded === undefined) continue;
  const actual = fileChecksum(readFileSync(join(dir, id), 'utf8'));
  if (actual !== recorded) drifted.push({ id, recorded, actual });
}
// 账本有、文件没了 → 全新库无法复现当前结构，同样算漂移
const removed = [...ledgerById.keys()].filter((id) => !files.includes(id));

/*
 * `--repair-ledger`：**只在"孤儿账本行"这一种情况下**允许自动清理。
 *
 * ## 为什么需要这个开关
 *
 * 开发/生产库上真实出现过这种情况：迁移文件被**改名**（例如把
 * `2026-10-15-fix-bs-equity-ytdpl.sql` 规范化为
 * `2026-10-15-upgrade-bs-equity-ytdpl.sql`），两个名字都登记在账本里，
 * 只有新名字有文件。此时：
 *   · 账本多出的孤儿行**不影响任何执行**（runner 只按文件驱动）；
 *   · 但它会让 S3 的漂移检查一直红灯 —— 而"一直红灯的检查"等于没有检查，
 *     运维会习惯性忽略它，真正的漂移就被淹没了。
 *
 * 因此给它一条**显式的、只能删孤儿行**的修复路径。有意做成：
 *   · 只删 `removed`（账本有、文件无的行）；
 *   · **绝不**碰 checksum 不一致的行（那是"内容被改写"，必须人工判断）；
 *   · 必须显式传参，不会在任何自动化流程里被触发。
 */
const repairLedger = process.argv.includes('--repair-ledger');

if (drifted.length > 0 || removed.length > 0) {
  console.error('\n[migrate] ❌ 迁移链内容漂移，已中断（未执行任何迁移）\n');
  for (const item of drifted) {
    console.error(
      `  · ${item.id}\n      账本校验和 ${item.recorded} ≠ 当前文件 ${item.actual}\n` +
        '      含义：该迁移**已在某个库上应用过**，但文件内容之后被改写了。\n' +
        '      若这是有意变更：请新增一条迁移做增量变更，不要改历史迁移（历史迁移必须在\n' +
        '      任何已部署的库上保持字节一致，否则全新库与老库的结构会分叉）。\n' +
        '      若确认库中结构已与当前文件一致：人工核对后执行\n' +
        `        UPDATE schema_migrations SET checksum = '${item.actual}' WHERE id = '${item.id}';\n`,
    );
  }
  for (const id of removed) {
    console.error(
      `  · ${id} 已在账本登记，但文件不存在了。\n` +
        '      含义：全新库无法再复现当前结构。请恢复文件，或新增"反向迁移"并保留历史文件。\n' +
        '      若该行只是"文件被改名"留下的孤儿（新名字也已在账本中）：\n' +
        `        npm run db:migrate -- --repair-ledger    # 将删除 ${removed.length} 条孤儿账本行\n`,
    );
  }
  console.error(
    '\n  常见成因：执行了 `npm run db:generate`（它整文件重写 0000_baseline.sql）、\n' +
      '  或迁移文件被改名。详见 AGENTS.md「迁移顺序」一节。\n',
  );

  const canRepair = repairLedger && drifted.length === 0 && removed.length > 0;
  if (!canRepair) {
    if (repairLedger && drifted.length > 0) {
      console.error(
        '  --repair-ledger 被拒绝：存在**内容漂移**（checksum 不一致）的迁移。\n' +
          '  这一类必须人工核对，脚本不会代你决定。\n',
      );
    }
    await sql.end().catch(() => undefined);
    process.exit(1);
  }

  console.log('[migrate] --repair-ledger：清理孤儿账本行（仅"账本有、文件无"）');
  for (const id of removed) {
    await sql`delete from schema_migrations where id = ${id}`;
    console.log(`  removed ${id}`);
  }
  console.log('[migrate] 孤儿行已清理，继续执行迁移。\n');
}

/* ── 执行未登记的迁移 ────────────────────────────────────────────────────── */
for (const file of files) {
  if (ledgerById.has(file)) {
    console.log(`skip ${file}`);
    continue;
  }
  const text = readFileSync(join(dir, file), 'utf8');
  const checksum = fileChecksum(text);
  try {
    // 修复 P1-6：单条迁移事务化。多语句 .sql 中途失败会留下半应用的 schema，
    // 且 schema_migrations 未登记 → 下次重跑重复执行已成功的语句。
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (id, checksum) values (${file}, ${checksum})`;
    });
    console.log(`applied ${file} (checksum=${checksum})`);
  } catch (error) {
    console.error(`\n[migrate] 迁移失败：${file}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    console.error('  请修复后重跑；已应用的迁移不会被重复执行。\n');
    await sql.end().catch(() => undefined);
    process.exit(1);
  }
}

/* ── 回填历史行校验和（首次运行本版本时发生一次）──────────────────────────── */
const needsBackfill = [...ledgerById.entries()]
  .filter(([id, checksum]) => (checksum === null || checksum === undefined) && files.includes(id))
  .map(([id]) => id);
if (needsBackfill.length > 0) {
  for (const id of needsBackfill) {
    const checksum = fileChecksum(readFileSync(join(dir, id), 'utf8'));
    await sql`update schema_migrations set checksum = ${checksum} where id = ${id}`;
  }
  console.log(
    `\n[migrate] 已为 ${needsBackfill.length} 条历史迁移回填校验和（基线取自当前文件内容）。\n` +
      '  诚实声明：这只建立了"从现在起"的防漂移基线 —— 它**无法证明**这些文件在过去\n' +
      '  与库中实际执行的 DDL 一致。如需确认，请在全新库上跑 `npm run migrate:dryrun`\n' +
      '  并与生产 schema 做 diff。\n',
  );
}

await sql.end();
