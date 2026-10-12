import { spawnSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}
const file = process.env.BACKUP_FILE || `backup-${new Date().toISOString().slice(0, 10)}.sql`;
const result = spawnSync('pg_dump', ['--dbname', url, '--file', file], { stdio: 'inherit' });
process.exit(result.status ?? 1);
