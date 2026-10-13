/**
 * 数据库备份：优先本机 pg_dump；若未安装则回退 docker compose exec postgres。
 * 输出文件由 BACKUP_FILE 指定，默认 backup-YYYY-MM-DD.sql。
 */
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}
const file =
  process.env.BACKUP_FILE ||
  `backup-${new Date().toISOString().slice(0, 10)}.sql`;

const dump = spawnSync('pg_dump', ['--dbname', url, '--file', file], {
  stdio: 'inherit',
});

if (!dump.error || dump.error.code !== 'ENOENT') {
  process.exit(dump.status ?? 1);
}

console.warn('本机未找到 pg_dump，尝试 docker compose exec postgres …');
const user = process.env.POSTGRES_USER || 'erp';
const db = process.env.POSTGRES_DB || 'shengseerp';
const docker = spawnSync(
  'docker',
  ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-U', user, db],
  { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }
);

if (docker.error) {
  console.error(
    docker.error.code === 'ENOENT'
      ? '本机也未找到 docker，无法备份'
      : docker.error.message
  );
  process.exit(1);
}
if (docker.status !== 0) {
  const errText = docker.stderr?.toString?.() || 'docker pg_dump 失败';
  console.error(errText);
  process.exit(docker.status ?? 1);
}

writeFileSync(file, docker.stdout);
console.log(`已写入 ${file}`);
process.exit(0);
