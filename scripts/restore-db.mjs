/**
 * 数据库恢复：用 psql 将 BACKUP_FILE 导入到 DATABASE_URL 指向的库。
 * 危险操作——请确认目标库正确，且已备份当前数据。
 */
import { spawnSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}
const file = process.env.BACKUP_FILE;
if (!file) {
  console.error('缺少 BACKUP_FILE（须指定要恢复的 SQL 备份文件路径）');
  process.exit(1);
}

const result = spawnSync('psql', ['--dbname', url, '-f', file], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
