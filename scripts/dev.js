const { spawnSync } = require('child_process');

const result = spawnSync(
  'npx',
  [
    'concurrently',
    '-n',
    'server,client',
    '-c',
    'blue,green',
    'npm run dev:server',
    'npm run dev:client',
  ],
  { stdio: 'inherit', shell: true }
);
process.exit(result.status ?? 1);
