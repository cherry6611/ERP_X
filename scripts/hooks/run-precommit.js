const { spawnSync } = require('child_process');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npm', ['run', 'type:check:server']);
run('node', ['./scripts/check-need-login.mjs']);
run('node', ['./scripts/check-contract.mjs']);
run('npm', ['test', '--', '--passWithNoTests']);
