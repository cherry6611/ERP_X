const fs = require('fs');
const path = require('path');

const roots = ['server', 'client', 'shared'];
const replacements = [
  ['@lark-apaas/fullstack-nestjs-core', '@server/platform'],
  ['@lark-apaas/client-toolkit/antd-table', 'antd'],
  ['@lark-apaas/client-toolkit/utils/getAxiosForBackend', '@client/src/platform/request'],
  ['@lark-apaas/client-toolkit/hooks/useCurrentUserProfile', '@client/src/platform/auth'],
  ['@lark-apaas/client-toolkit/components/UniversalLink', '@client/src/platform/UniversalLink'],
  ['@lark-apaas/client-toolkit/components/NotFoundRender', '@client/src/platform/AppContainer'],
  ['@lark-apaas/client-toolkit/components/ErrorRender', '@client/src/platform/AppContainer'],
  ['@lark-apaas/client-toolkit/components/AppContainer', '@client/src/platform/AppContainer'],
  ['@lark-apaas/client-toolkit/tools/services', '@client/src/platform/services'],
  ['@lark-apaas/client-toolkit/tools/storage', '@client/src/platform/storage'],
  ['@lark-apaas/client-toolkit/utils/getEnv', '@client/src/platform/env'],
  ['@lark-apaas/client-toolkit/dataloom', '@client/src/platform/storage'],
  ['@lark-apaas/client-toolkit/logger', '@client/src/platform/logger'],
  ['@lark-apaas/client-toolkit/auth', '@client/src/platform/auth'],
];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === 'dist') continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(full);
  }
  return out;
}

let changed = 0;
for (const root of roots) {
  for (const file of walk(root)) {
    let text = fs.readFileSync(file, 'utf8');
    const next = replacements.reduce((acc, [from, to]) => acc.split(from).join(to), text);
    if (next !== text) {
      fs.writeFileSync(file, next);
      changed += 1;
    }
  }
}
console.log(`rewrote ${changed} files`);
