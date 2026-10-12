import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

const dir = join(process.cwd(), 'server', 'database', 'migrations');
const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
for (const file of files) {
  const applied = await sql`select id from schema_migrations where id = ${file}`;
  if (applied.length > 0) {
    console.log(`skip ${file}`);
    continue;
  }
  const text = readFileSync(join(dir, file), 'utf8');
  await sql.unsafe(text);
  await sql`insert into schema_migrations (id) values (${file})`;
  console.log(`applied ${file}`);
}
await sql.end();
