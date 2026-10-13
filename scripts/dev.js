/**
 * 跨平台开发启动器（Windows / macOS / Linux 通用）
 *
 * 为什么要重写？
 *   原实现为 `npx concurrently "npm run dev:server" "npm run dev:client"`，
 *   在 Windows 上 concurrently 派生子进程时未走 shell，导致
 *   `'run' 不是内部或外部命令`；且 `NODE_ENV=development xxx` 属于 Unix 语法，
 *   cmd.exe 无法识别。此处改为 Node 原生 spawn，环境变量通过 env 传入。
 *
 * 行为：
 *   1. 预加载仓库根 .env（后端 main.ts 虽有 dotenv，前端/迁移脚本同样需要）
 *   2. 预检 DATABASE_URL / node_modules，缺失时给出可执行的修复提示
 *   3. 并行拉起 nest(start --watch) 与 vite，输出带 [server]/[client] 前缀
 *   4. Ctrl+C 时同时结束两个子进程，避免端口残留占用
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// ---------- 1. 预加载 .env ----------
try {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
} catch {
  // dotenv 缺失不致命：变量可能由外部注入
}

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

function line(color, tag, text) {
  process.stdout.write(`${color}[${tag}]${OFF} ${text}`);
}

// ---------- 2. 预检 ----------
const problems = [];

if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
  problems.push('未安装依赖，请先执行: npm install');
}

if (!process.env.DATABASE_URL) {
  problems.push(
    '缺少 DATABASE_URL：请复制 .env.example 为 .env 并填写，' +
      '或确认 PostgreSQL 已启动（本地默认 127.0.0.1:5433/shengseerp）'
  );
}

if (problems.length > 0) {
  for (const p of problems) line(RED, 'preflight', p + '\n');
  process.exit(1);
}

line(DIM, 'preflight', `DATABASE_URL = ${process.env.DATABASE_URL.replace(/\/\/[^@]*@/, '//***@')}\n`);

// ---------- 3. 拉起子进程 ----------
const isWindows = process.platform === 'win32';

/** Windows 下 npx/npm 是 .cmd 批处理，必须经 shell 执行 */
function launch(name, color, command, args) {
  const child = spawn(command, args, {
    cwd: ROOT,
    shell: isWindows, // Unix 下不使用 shell，保证信号可直达子进程
    env: { ...process.env, NODE_ENV: 'development', FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pipe = (stream) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const p of parts) line(color, name, p + '\n');
    });
    stream.on('end', () => {
      if (buf) line(color, name, buf + '\n');
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on('exit', (code, signal) => {
    if (signal) return; // 被我们主动 kill
    line(color, name, `进程退出，code=${code}\n`);
    shutdown(code ?? 1);
  });

  child.on('error', (err) => {
    line(RED, name, `启动失败: ${err.message}\n`);
  });

  return child;
}

const children = [];

children.push(
  launch('server', CYAN, isWindows ? 'npx.cmd' : 'npx', ['nest', 'start', '--watch'])
);
children.push(
  launch('client', GREEN, isWindows ? 'npx.cmd' : 'npx', ['vite', '--config', 'vite.config.ts'])
);

line(
  YELLOW,
  'dev',
  `后端 http://127.0.0.1:${process.env.SERVER_PORT || 3000}/api   前端 http://127.0.0.1:5173/   (Ctrl+C 停止)\n`
);

// ---------- 4. 优雅退出 ----------
let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
