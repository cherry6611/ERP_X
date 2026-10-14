#!/usr/bin/env node
/**
 * B-01 codemod：把 `@CanRole([...])` 机械替换为 `@CanCapability('...')`。
 *
 * 判定规则（与 server/common/auth/route-capability.ts 同一张表）：
 *   - 需要 `@CanRole` 的方法，其 HTTP 动词来自同一方法上的 @Get/@Post/@Patch/@Put/@Delete；
 *   - GET/HEAD → 读能力；其它 → 写能力（缺省为 read + '_write'，若无该能力码则用 read）；
 *   - 兼容既有语义：`@CanRole(['admin','hr_manager'])` 这类"多角色"一律走能力码，
 *     由 MATRIX 决定最终结论；因此本脚本会**丢弃**原角色清单，只保留能力码。
 *
 * 用法：
 *   node scripts/codemod-rbac-capability.mjs            # 预演（打印将改动的行）
 *   node scripts/codemod-rbac-capability.mjs --write    # 实际写入
 *
 * 注意：脚本会重写整个文件，只替换 `@CanRole(...)` 所在的整行，其余行原样保留。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const WRITE = process.argv.includes('--write');

/** 与 server/common/auth/route-capability.ts 保持同源（此处内联，避免加载 TS） */
const ROUTE_RULES = [
  { prefix: 'api/finance', read: 'finance', write: 'finance_write' },
  { prefix: 'api/voucher', read: 'finance', write: 'finance_write' },
  { prefix: 'api/revenues', read: 'finance', write: 'finance_write' },
  { prefix: 'api/fin-expense', read: 'finance', write: 'finance_write' },
  { prefix: 'api/fin-budget', read: 'finance', write: 'finance_write' },
  { prefix: 'api/hr', read: 'hr', write: 'hr_write' },
  { prefix: 'api/projects', read: 'projects', write: 'projects_write' },
  { prefix: 'api/contracts', read: 'crm', write: 'crm_write' },
  { prefix: 'api/crm', read: 'crm', write: 'crm_write' },
  { prefix: 'api/master-data/tax-entities', read: 'tax_entity', write: null },
  { prefix: 'api/master-data', read: 'crm', write: 'crm_write' },
  { prefix: 'api/tax', read: 'tax_entity', write: null },
  { prefix: 'api/costs', read: 'projects', write: 'projects_write' },
  { prefix: 'api/pur', read: 'pur_asset', write: null },
  { prefix: 'api/asset', read: 'pur_asset', write: null },
  { prefix: 'api/admin', read: 'admin_ops', write: null },
  { prefix: 'api/audit', read: 'audit', write: null },
  { prefix: 'api/identity', read: 'identity', write: null },
  { prefix: 'api/drive', read: 'drive', write: 'drive_write' },
  { prefix: 'api/wiki', read: 'drive', write: 'drive_write' },
  { prefix: 'api/settings', read: 'settings_appearance', write: null },
  { prefix: 'api/system', read: 'admin_ops', write: null },
  { prefix: 'api/data-asset', read: 'audit', write: null },
  { prefix: 'api/notifications', read: 'dashboard', write: null },
  { prefix: 'api/semantic', read: 'dashboard', write: null },
  { prefix: 'api/files', read: 'dashboard', write: null },
  { prefix: 'api/attachments', read: 'dashboard', write: null },
  { prefix: 'api/exports', read: 'dashboard', write: null },
  { prefix: 'api/tasks', read: 'dashboard', write: null },
  { prefix: 'api/feishu', read: 'drive', write: 'drive_write' },
  { prefix: 'api/feishu-sync', read: 'drive', write: 'drive_write' },
  { prefix: 'api/auth', read: 'dashboard', write: null },
  { prefix: 'api/health', read: 'dashboard', write: null },
  { prefix: 'api/directory', read: 'dashboard', write: null },
  { prefix: 'api/openapi', read: 'admin_ops', write: null },
  { prefix: 'api', read: 'dashboard', write: null },
];

function resolveRule(controllerPath) {
  const normalized = String(controllerPath ?? '').replace(/^\/+|\/+$/g, '');
  const matches = ROUTE_RULES.filter(
    (rule) => normalized === rule.prefix || normalized.startsWith(`${rule.prefix}/`)
  ).sort((a, b) => b.prefix.length - a.prefix.length);
  return matches[0] ?? { prefix: 'api', read: 'dashboard', write: null };
}

function capabilityFor(controllerPath, method) {
  const rule = resolveRule(controllerPath);
  if (method === 'read') return rule.read;
  return rule.write ?? rule.read;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(full, out);
      continue;
    }
    if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

const files = walk(join(ROOT, 'server', 'modules'));
let changedFiles = 0;
let changedLines = 0;
const report = [];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);
  const controllerMatch = /@Controller\(\s*'([^']*)'/.exec(source);
  const controllerPath = controllerMatch ? controllerMatch[1] : '';
  let touched = false;

  for (let index = 0; index < lines.length; index += 1) {
    if (!/@CanRole\(/.test(lines[index])) continue;
    // 向后找到同一方法上的 HTTP 动词
    let verb = null;
    for (let probe = index + 1; probe < Math.min(index + 12, lines.length); probe += 1) {
      const match = /@(Get|Post|Patch|Put|Delete|Head)\(/.exec(lines[probe]);
      if (match) {
        verb = match[1].toUpperCase();
        break;
      }
    }
    const method =
      verb === 'GET' || verb === 'HEAD'
        ? 'read'
        : verb === null
          ? 'write'
          : 'write';
    const capability = capabilityFor(controllerPath, method);
    const indent = /^(\s*)/.exec(lines[index])[1];
    const original = lines[index].trim();
    const replacement = `${indent}@CanCapability('${capability}')`;
    if (lines[index] === replacement) continue;
    report.push(
      `${relative(ROOT, file)}:${index + 1}  ${original}  →  @CanCapability('${capability}')  [${verb ?? 'NO-VERB'} · ${controllerPath}]`
    );
    lines[index] = replacement;
    touched = true;
    changedLines += 1;
  }

  if (touched) {
    changedFiles += 1;
    if (WRITE) {
      let output = lines.join('\n');
      // 保证 CanCapability 已从 @server/platform 导入
      if (!/CanCapability/.test(output.split('\n').find((l) => l.includes("from '@server/platform'")) ?? '')) {
        output = output.replace(
          /import\s*\{([^}]*)\}\s*from\s*'@server\/platform';/,
          (full, names) => {
            const list = names
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean);
            if (!list.includes('CanCapability')) list.push('CanCapability');
            list.sort((a, b) => a.localeCompare(b));
            return `import { ${list.join(', ')} } from '@server/platform';`;
          }
        );
      }
      // 若已不再使用 CanRole，则从 import 中移除（避免 lint unused）
      if (!/@CanRole\(/.test(output)) {
        output = output.replace(
          /import\s*\{([^}]*)\}\s*from\s*'@server\/platform';/,
          (full, names) => {
            const list = names
              .split(',')
              .map((item) => item.trim())
              .filter((item) => item && item !== 'CanRole');
            if (list.length === 0) return '';
            list.sort((a, b) => a.localeCompare(b));
            return `import { ${list.join(', ')} } from '@server/platform';`;
          }
        );
      }
      writeFileSync(file, output, 'utf8');
    }
  }
}

console.log(report.join('\n'));
console.log(
  `\n${WRITE ? '已写入' : '预演'}：${changedFiles} 个文件 / ${changedLines} 行`
);
if (!WRITE) {
  console.log('加 --write 才会真正修改文件。');
}
