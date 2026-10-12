import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const sql = readFileSync('server/database/migrations/0000_baseline.sql', 'utf8');
await db.exec(sql);
const tables = await db.query(
  "select count(*)::int as count from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
);
console.log('tables', tables.rows[0]?.count);
await db.close();
