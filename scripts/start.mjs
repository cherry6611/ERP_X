/**
 * 生产模式启动器（跨平台）
 * 用法：npm run start
 *
 * 原脚本 `NODE_ENV=production node dist/server/main.js` 为 Unix 语法，
 * Windows cmd 下会报 “'NODE_ENV' 不是内部或外部命令”。此处改为 Node 注入环境变量。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 预加载 .env
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.join(ROOT, '.env') });
} catch {
  /* 变量可能由编排层注入，忽略 */
}

const entry = path.join(ROOT, 'dist', 'server', 'main.js');
if (!fs.existsSync(entry)) {
  console.error(`[start] 未找到构建产物: ${entry}\n请先执行: npm run build:server`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('[start] 缺少 DATABASE_URL，请检查 .env 或运行环境注入');
  process.exit(1);
}

const child = spawn(process.execPath, [entry], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
});

child.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGINT', () => child.kill('SIGTERM'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
