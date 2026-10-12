const { spawnSync } = require('child_process');

function run(script) {
  const result = spawnSync('npm', ['run', script], {
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('eslint');
run('stylelint');
