import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const files = [
  'server/database/migrations/0000_baseline.sql',
  'server/database/migrations/2026-10-13-security.sql',
  'server/database/migrations/2026-10-13-feishu-deep.sql',
];
for (const file of files) {
  await db.exec(readFileSync(file, 'utf8'));
}
const tables = await db.query(
  "select count(*)::int as count from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
);
console.log('tables', tables.rows[0]?.count);
await db.close();
