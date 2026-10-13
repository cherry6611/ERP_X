import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const files = [
  'server/database/migrations/0000_baseline.sql',
  'server/database/migrations/2026-10-13-security.sql',
  'server/database/migrations/2026-10-13-feishu-deep.sql',
  'server/database/migrations/2026-10-13-tax-final.sql',
];
for (const file of files) {
  console.log('apply', file);
  await db.exec(readFileSync(file, 'utf8'));
}
const tables = await db.query(`
  select count(*)::int as count
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
`);
const accounts = await db.query(
  `select code from fin_account where code in ('1001','1122','2202','2221','6001','6401') order by code`
);
const entities = await db.query(`select count(*)::int as count from md_tax_entity`);
console.log('tables', tables.rows[0]?.count);
console.log('accounts', accounts.rows.map((row) => row.code).join(','));
console.log('tax_entities', entities.rows[0]?.count);
await db.close();
