#!/usr/bin/env node
/**
 * B-01：RBAC 一致性检查（CI 门）。
 *
 * 检查项：
 *   1. `server/modules/**\/*.controller.ts` 中不得再出现 `@CanRole([...])`
 *      （除白名单：密钥/凭证类接口，需在 ALLOWED_CAN_ROLE 中登记理由）；
 *   2. 所有 `@CanCapability('x')` / `@CanCapabilityRead('x')` 的能力码必须存在于
 *      `shared/rbac.ts` 的 Capability 联合类型中；
 *   3. 写接口（POST/PUT/PATCH/DELETE）不得使用只读装饰器 `CanCapabilityRead`；
 *   4. 控制器文件不得"裸奔"：类上必须有 `@NeedLogin()`（或 `@Public()`）。
 *
 * 退出码：0 = 通过；1 = 有不一致。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 允许保留 @CanRole 的接口（必须登记理由，否则 CI 失败） */
const ALLOWED_CAN_ROLE = new Set([
  // 示例：'server/modules/xxx/xxx.controller.ts#methodName'
]);

const WRITE_VERBS = ['Post', 'Put', 'Patch', 'Delete'];

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

function loadCapabilities() {
  const source = readFileSync(join(ROOT, 'shared', 'rbac.ts'), 'utf8');
  const match = /export type Capability =([\s\S]*?);/.exec(source);
  if (!match) {
    console.error('无法从 shared/rbac.ts 解析 Capability 联合类型');
    process.exit(1);
  }
  const caps = new Set(
    [...match[1].matchAll(/'([a-z_]+)'/g)].map((item) => item[1])
  );
  return caps;
}

const capabilities = loadCapabilities();
const files = walk(join(ROOT, 'server', 'modules'));
const problems = [];

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);

  const classHasNeedLogin = /@NeedLogin\(/.test(source) || /@Public\(/.test(source);
  if (!classHasNeedLogin) {
    problems.push(`${rel}: 控制器类未标注 @NeedLogin() 或 @Public()`);
  }

  lines.forEach((line, index) => {
    const canRole = /@CanRole\(/.exec(line);
    if (canRole) {
      // 允许的写法：@CanRole(['admin']) 在 AuthModule 的 unlock 或已登记白名单
      const key = `${rel}#line${index + 1}`;
      if (!ALLOWED_CAN_ROLE.has(key)) {
        problems.push(
          `${rel}:${index + 1}: 仍在使用 @CanRole(...)：${line.trim()}（请改用 @CanCapability / @CanCapabilityRead，或登记到 ALLOWED_CAN_ROLE）`
        );
      }
    }

    const capMatch = /@CanCapability(?:Read)?\(\s*'([^']+)'\s*\)/.exec(line);
    if (capMatch) {
      const cap = capMatch[1];
      if (!capabilities.has(cap)) {
        problems.push(
          `${rel}:${index + 1}: 能力码 '${cap}' 不在 shared/rbac.ts 的 Capability 联合类型中`
        );
      }
      const isReadDecorator = /@CanCapabilityRead\(/.test(line);
      // 向后找同一方法的 HTTP 动词，写方法不得用只读装饰器
      for (let probe = index + 1; probe < Math.min(index + 12, lines.length); probe += 1) {
        const verbMatch = /@(Get|Post|Put|Patch|Delete)\(/.exec(lines[probe]);
        if (verbMatch) {
          const verb = verbMatch[1];
          if (isReadDecorator && WRITE_VERBS.includes(verb)) {
            problems.push(
              `${rel}:${index + 1}: 写方法 @${verb} 不得使用只读装饰器 @CanCapabilityRead('${cap}')`
            );
          }
          // 只读方法（GET）使用写装饰器是允许的（更严格），但提示信息便于评审
          break;
        }
      }
    }
  });
}

if (problems.length > 0) {
  console.error('RBAC 一致性检查未通过：\n');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(`\n共 ${problems.length} 处问题。`);
  process.exit(1);
}

console.log(
  `RBAC 一致性检查通过：${files.length} 个控制器，能力码 ${capabilities.size} 个。`
);
