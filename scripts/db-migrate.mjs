import { readdirSync, readFileSync } from 'node:fs';
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
await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

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
for (const file of files) {
  const applied = await sql`select id from schema_migrations where id = ${file}`;
  if (applied.length > 0) {
    console.log(`skip ${file}`);
    continue;
  }
  const text = readFileSync(join(dir, file), 'utf8');
  try {
    // 修复 P1-6：单条迁移事务化。多语句 .sql 中途失败会留下半应用的 schema，
    // 且 schema_migrations 未登记 → 下次重跑重复执行已成功的语句。
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (id) values (${file})`;
    });
    console.log(`applied ${file}`);
  } catch (error) {
    console.error(`\n[migrate] 迁移失败：${file}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    console.error('  请修复后重跑；已应用的迁移不会被重复执行。\n');
    await sql.end().catch(() => undefined);
    process.exit(1);
  }
}
await sql.end();
