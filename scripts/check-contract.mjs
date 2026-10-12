import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'client', 'src', 'api');
const failures = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
    const source = readFileSync(full, 'utf8');
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/^\s*(export\s+)?interface\s+/.test(line)) {
        failures.push(`${full}:${index + 1} ${line.trim()}`);
      }
    });
  }
}

walk(root);
if (failures.length > 0) {
  console.error('client/src/api 不允许本地声明 interface，请放到 shared/api.interface.ts：');
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log('契约检查通过');
