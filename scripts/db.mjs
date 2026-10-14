/**
 * 本地 PostgreSQL 实例管理（start / stop / restart / status / init）
 *
 * 背景：本机 5432 端口已被另一个 PostgreSQL 占用，本项目改用
 *   数据目录 <repo>/.pgdata，端口 5433，超级用户 erp，库名 shengseerp。
 *   init 密码读取环境变量 POSTGRES_PASSWORD（或 PGPASSWORD），勿把口令写进脚本。
 * 由于未注册为 Windows 服务，重启电脑后需要手动拉起 —— 本脚本就是为此准备的。
 *
 * 用法：
 *   node scripts/db.mjs start | stop | restart | status | init
 *
 * 说明：init 会【初始化一个全新的空集群】。若 .pgdata 已存在则拒绝执行，
 *       避免误删现有数据（如需重建请手工移走目录后再跑）。
 */
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

const CODE_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const REPO_ROOT = resolve(CODE_ROOT, '..');
/** 优先仓库根 .pgdata（实测集群位置），其次 code/.pgdata */
const PGDATA_CANDIDATES = [
  join(REPO_ROOT, '.pgdata'),
  join(CODE_ROOT, '.pgdata'),
];
const PGDATA =
  PGDATA_CANDIDATES.find((p) => existsSync(join(p, 'PG_VERSION'))) ??
  PGDATA_CANDIDATES[0];
const ROOT = CODE_ROOT;
const PORT = process.env.PGPORT_LOCAL || '5433';

/** 定位 pg_ctl：优先 PATH，其次常见安装路径 */
function findBin(name) {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    shell: true,
    encoding: 'utf8',
  });
  const first = (which.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (first && existsSync(first)) return first;

  const candidates = [];
  for (const major of [18, 17, 16, 15, 14]) {
    for (const base of ['C:\\Program Files\\PostgreSQL', 'D:\\Program Files\\PostgreSQL', 'D:\\App\\PostgreSQL']) {
      candidates.push(join(base, String(major), 'bin', `${name}.exe`));
    }
  }
  return candidates.find((p) => existsSync(p)) || null;
}

const pgCtl = findBin('pg_ctl');
const initDb = findBin('initdb');

if (!pgCtl) {
  console.error(
    '[db] 未找到 pg_ctl。请安装 PostgreSQL 17，或把其 bin 目录加入 PATH。\n' +
      '     下载地址: https://www.postgresql.org/download/windows/'
  );
  process.exit(1);
}

// 说明：Windows 上直接 spawnSync 该 exe 会偶发 EBUSY（文件被占用/扫描），
// 统一走 shell 规避。
function run(args, opts = {}) {
  const r = spawnSync(
    `"${pgCtl}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`,
    { stdio: 'inherit', shell: true, ...opts }
  );
  return r.status ?? 1;
}

function runRaw(cmdLine, opts = {}) {
  const r = spawnSync(cmdLine, { encoding: 'utf8', shell: true, ...opts });
  return r;
}

const cmd = process.argv[2] || 'status';

switch (cmd) {
  case 'init': {
    if (existsSync(join(PGDATA, 'PG_VERSION'))) {
      console.error(`[db] 集群已存在: ${PGDATA}\n     如需重建，请先手工移走该目录。`);
      process.exit(1);
    }
    if (!initDb) {
      console.error('[db] 未找到 initdb');
      process.exit(1);
    }
    mkdirSync(PGDATA, { recursive: true });
    // Windows 下 initdb 的 --pwfile 从 stdin 读取不稳定，改为落临时文件
    // M14：密码从环境变量读取，禁止把口令写死在仓库脚本中
    const initPassword = process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD;
    if (!initPassword) {
      console.error(
        '[db] 请设置环境变量 POSTGRES_PASSWORD（或 PGPASSWORD）后再执行 init',
      );
      process.exit(1);
    }
    const pwFile = join(PGDATA, '..', '.pgpw.tmp');
    writeFileSync(pwFile, `${initPassword}\n`);
    const r = spawnSync(
      `"${initDb}" -D "${PGDATA}" -U erp --auth=scram-sha-256 --pwfile "${pwFile}" -E UTF8`,
      { stdio: 'inherit', shell: true }
    );
    try {
      unlinkSync(pwFile);
    } catch {
      /* ignore */
    }
    if (r.status !== 0) process.exit(r.status ?? 1);
    console.log(`[db] 集群已初始化: ${PGDATA} (user=erp, 密码见 .env)`);
    console.log('[db] 接下来执行: node scripts/db.mjs start  →  createdb shengseerp  →  npm run db:migrate');
    break;
  }

  case 'start': {
    if (!existsSync(join(PGDATA, 'PG_VERSION'))) {
      console.error(`[db] 数据目录不存在或未初始化: ${PGDATA}\n     先执行: node scripts/db.mjs init`);
      process.exit(1);
    }
    const code = run(['-D', PGDATA, '-l', join(PGDATA, 'pg.log'), '-o', `-p ${PORT}`, 'start'], {
      encoding: 'utf8',
    });
    if (code === 0) {
      console.log(`[db] 已启动，监听 127.0.0.1:${PORT}，日志: ${join(PGDATA, 'pg.log')}`);
    }
    process.exit(code);
  }

  case 'stop': {
    const code = run(['-D', PGDATA, '-m', 'fast', 'stop']);
    if (code === 0) console.log('[db] 已停止');
    process.exit(code);
  }

  case 'restart': {
    run(['-D', PGDATA, '-m', 'fast', 'stop']);
    const child = spawn(pgCtl, ['-D', PGDATA, '-l', join(PGDATA, 'pg.log'), '-o', `-p ${PORT}`, 'start'], {
      stdio: 'inherit',
    });
    child.on('exit', (c) => process.exit(c ?? 1));
    break;
  }

  case 'status': {
    const r = runRaw(`"${pgCtl}" -D "${PGDATA}" status`);
    console.log(((r.stdout || '') + (r.stderr || '')).trim());
    if (r.status !== 0) {
      console.log(`[db] 未运行。启动命令: node scripts/db.mjs start`);
    }
    process.exit(0);
  }

  default:
    console.error(`未知命令: ${cmd}\n用法: node scripts/db.mjs start | stop | restart | status | init`);
    process.exit(1);
}
