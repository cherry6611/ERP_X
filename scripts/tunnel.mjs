/**
 * 飞书事件回调本地联调隧道
 *
 * 飞书开放平台的「事件订阅」需要一个**公网可访问**的 HTTPS 地址，
 * 而本地后端在 127.0.0.1:3000。本脚本用 Cloudflare Quick Tunnel
 * （cloudflared，无需账号）把它映射成 https://xxx.trycloudflare.com。
 *
 * 用法：
 *   node scripts/tunnel.mjs            # 默认转发 127.0.0.1:3000
 *   node scripts/tunnel.mjs --port 3001
 *
 * 启动后把输出的 https://xxx.trycloudflare.com 填到
 *   飞书开放平台 → 事件订阅 → 请求地址：`https://xxx.trycloudflare.com/api/feishu-event`
 *
 * ⚠️ Quick Tunnel 每次启动都会换域名，重启后需要回开放平台更新地址。
 *    生产环境请改用「命名隧道」或固定域名（ngrok 付费版 / cpolar 固定二级域名 / frp）。
 */
import { spawn, spawnSync } from 'node:child_process';

const argPort = process.argv.indexOf('--port');
const port = argPort > -1 ? process.argv[argPort + 1] : process.env.SERVER_PORT || '3000';

/** 定位 cloudflared：优先 PATH，其次常见安装路径 */
function findCloudflared() {
  const candidates = [
    'cloudflared',
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    'C:\\ProgramData\\chocolatey\\bin\\cloudflared.exe',
  ];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8', shell: true });
      if (r.status === 0 || (r.stdout || '').includes('cloudflared')) return c;
    } catch {
      /* continue */
    }
  }
  return null;
}

const bin = findCloudflared();

if (!bin) {
  console.error(
    '[tunnel] 未找到 cloudflared。\n' +
      '  安装方式：\n' +
      '    winget install --id Cloudflare.cloudflared\n' +
      '  或  https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/\n' +
      '  也可以用同类工具：ngrok http 3000 / cpolar http 3000'
  );
  process.exit(1);
}

console.log(`[tunnel] 转发 http://127.0.0.1:${port}  →  公网 HTTPS`);
console.log('[tunnel] 按 Ctrl+C 停止\n');

const child = spawn(
  bin,
  ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
  { stdio: ['ignore', 'pipe', 'pipe'], shell: true }
);

let printed = false;
const handle = (chunk) => {
  const text = chunk.toString();
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !printed) {
    printed = true;
    console.log('\n=========================================================');
    console.log('  公网地址：' + m[0]);
    console.log('  飞书事件订阅地址：' + m[0] + '/api/feishu-event');
    console.log('  飞书 OAuth 重定向：' + m[0] + '/api/auth/feishu/callback');
    console.log('=========================================================\n');
  }
  process.stdout.write(text);
};
child.stdout.on('data', handle);
child.stderr.on('data', handle);

child.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGINT', () => child.kill('SIGTERM'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
