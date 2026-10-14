import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'server', 'modules');
const failures = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!name.endsWith('.controller.ts')) continue;
    if (name === 'view.controller.ts') continue;
    const source = readFileSync(full, 'utf8');
    const marks = [...source.matchAll(/export class \w*Controller\b/g)];
    if (marks.length === 0) {
      failures.push(full);
      continue;
    }
    let cursor = 0;
    for (const mark of marks) {
      const block = source.slice(cursor, mark.index);
      cursor = mark.index + mark[0].length;
      // 类级 @NeedLogin() 为默认；纯公开控制器可用类级 @Public()（如 health）
      if (!block.includes('@NeedLogin()') && !block.includes('@Public()')) {
        failures.push(full);
        break;
      }
    }
  }
}

walk(root);
if (failures.length > 0) {
  console.error('这些 controller 缺少类级 @NeedLogin()：');
  for (const file of failures) console.error(`  ${file}`);
  process.exit(1);
}
console.log('类级 @NeedLogin() 检查通过');
