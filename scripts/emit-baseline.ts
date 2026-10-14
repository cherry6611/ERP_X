import { writeFileSync } from 'node:fs';
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../server/database/schema';

const PROFILE_DEFAULT =
  "CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END";

function chunkText(value: unknown): string {
  if (!value || typeof value !== 'object' || !('queryChunks' in value)) return '';
  const chunks = (value as { queryChunks: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk;
      if (chunk && typeof chunk === 'object' && 'value' in chunk) {
        const inner = (chunk as { value: unknown }).value;
        return Array.isArray(inner) ? inner.join('') : String(inner ?? '');
      }
      return '';
    })
    .join('');
}

function columnDefault(column: PgColumn): string | null {
  const raw = (column as { default?: unknown }).default;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'string') return `'${raw.replace(/'/g, "''")}'`;
  const text = chunkText(raw);
  if (!text) {
    if ((column as { hasDefault?: boolean }).hasDefault) return 'gen_random_uuid()';
    return null;
  }
  if (text.includes('current_setting') && !text.includes('END')) return PROFILE_DEFAULT;
  if (text.includes('gen_random_uuid') || text.includes('defaultRandom')) return 'gen_random_uuid()';
  if (text.trim() === 'CURRENT_TIMESTAMP' || text.includes('CURRENT_TIMESTAMP')) return 'CURRENT_TIMESTAMP';
  return text;
}

function columnSql(column: PgColumn): string {
  const typeName = column.getSQLType().replace('timestamptz (3)', 'timestamptz(3)');
  const parts = [`"${column.name}" ${typeName}`];
  if (column.primary) parts.push('PRIMARY KEY');
  if (column.notNull && !column.primary) parts.push('NOT NULL');
  const fallback = columnDefault(column);
  if (fallback) parts.push(`DEFAULT ${fallback}`);
  return parts.join(' ');
}

function isTable(value: unknown): value is PgTable {
  return Boolean(value) && typeof value === 'object' && typeof (value as PgTable).getSQL === 'function';
}

const tables: string[] = [];
const indexes: string[] = [];
const seen = new Set<string>();

for (const value of Object.values(schema)) {
  if (!isTable(value)) continue;
  let config: ReturnType<typeof getTableConfig>;
  try {
    config = getTableConfig(value);
  } catch {
    continue;
  }
  if (seen.has(config.name)) continue;
  seen.add(config.name);
  const columns = config.columns.map((column) => `  ${columnSql(column)}`).join(',\n');
  tables.push(`CREATE TABLE IF NOT EXISTS "${config.name}" (\n${columns}\n);`);
  for (const index of config.indexes) {
    // drizzle 的索引列类型是 `SQL | IndexedColumn`：表达式索引（如部分唯一索引）
    // 没有 `name` 字段，跳过即可（这类索引由 SQL 迁移显式创建，见 AGENTS.md 说明）。
    const cols = index.config.columns
      .map((column) =>
        'name' in column && typeof column.name === 'string'
          ? `"${column.name}"`
          : null
      )
      .filter((name): name is string => name !== null)
      .join(', ');
    if (cols === '') continue;
    const unique = index.config.unique ? 'UNIQUE ' : '';
    indexes.push(`CREATE ${unique}INDEX IF NOT EXISTS "${index.config.name}" ON "${config.name}" (${cols});`);
  }
}

const sql = `-- 独立部署基线。由 scripts/emit-baseline.ts 根据 schema.ts 生成。
CREATE TYPE user_profile AS (user_id varchar, user_name varchar);
CREATE TYPE file_attachment AS (bucket_id varchar, file_path varchar);

${tables.join('\n\n')}

${indexes.join('\n')}

INSERT INTO sys_role (code, name) VALUES
  ('admin', '管理员'),
  ('finance_viewer', '财务查看'),
  ('hr_manager', '人事经理'),
  ('drive_editor', '云盘编辑'),
  ('project_manager', '项目经理')
ON CONFLICT (code) DO NOTHING;
`;

writeFileSync('server/database/migrations/0000_baseline.sql', sql);
console.log(`tables=${seen.size} indexes=${indexes.length}`);
