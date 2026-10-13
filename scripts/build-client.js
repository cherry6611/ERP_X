/** 跨平台前端构建（避免 NODE_ENV= 前缀在 cmd 下不可用） */
const { spawnSync } = require('node:child_process');

const isWin = process.platform === 'win32';
const r = spawnSync(isWin ? 'npx.cmd' : 'npx', ['vite', 'build', '--config', 'vite.config.ts'], {
  stdio: 'inherit',
  shell: isWin,
  env: { ...process.env, NODE_ENV: 'production' },
});
process.exit(r.status ?? 1);
