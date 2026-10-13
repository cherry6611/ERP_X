/**
 * Cross-platform NODE_ENV runner.
 * Usage: node ./scripts/env-run.mjs <NODE_ENV> -- <cmd> [args...]
 */
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === 0 || sep === argv.length - 1) {
  console.error('用法: node ./scripts/env-run.mjs <NODE_ENV> -- <cmd> [args...]');
  process.exit(1);
}
const nodeEnv = argv[0];
const [cmd, ...args] = argv.slice(sep + 1);
const child = spawn(cmd, args, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NODE_ENV: nodeEnv },
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
