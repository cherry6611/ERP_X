const { spawnSync } = require('child_process');

function run(script) {
  const result = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(require('node:path').resolve(__dirname, 'build-server.js'));
run(require('node:path').resolve(__dirname, 'build-client.js'));
