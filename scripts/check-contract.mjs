import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 契约漂移检查（NFR-M3 / NFR-M4 / API-1 / API-2）。
 *
 * 初衷只有"client/src/api 下不得本地声明 interface"，
 * 但需求书指出它**只扫了 interface**，于是下面三类漂移都能绕过 CI：
 *   ① `type Xxx = {...}`（本地 type 别名）；
 *   ② 内联对象字面量类型（`{ items: Foo[] }` 直接写在函数签名里）；
 *   ③ 后端 `@Body()` 使用 interface / 内联字面量（ValidationPipe 静默失效，实测 20+ 处）。
 *
 * 现在三项一起扫。为便于渐进治理，内联对象字面量只覆盖**明显的**形态
 * （`Promise<{ ... }>` / `: { ... }` 且字段数 ≥ 2），单字段包装不算，
 * 避免把 `Record<string, string>` 之类的工具类型误判。
 */
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const failures = [];
const warnings = [];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
    out.push(full);
  }
  return out;
}

/* ========== ① / ② client/src/api：禁止本地 interface / type / 内联对象类型 ========== */

const CLIENT_ALLOWLIST = new Set([
  // 允许的极少数例外（必须写明理由）
]);

const apiDir = join(ROOT, 'client', 'src', 'api');
for (const file of walk(apiDir)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (CLIENT_ALLOWLIST.has(rel)) continue;
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);

  // 去掉块注释与行注释后判断，避免注释里的示例被误报
  let inBlockComment = false;
  lines.forEach((rawLine, index) => {
    let line = rawLine;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const blockStart = line.indexOf('/*');
    if (blockStart !== -1) {
      const blockEnd = line.indexOf('*/', blockStart + 2);
      if (blockEnd === -1) {
        inBlockComment = true;
        line = line.slice(0, blockStart);
      } else {
        line = line.slice(0, blockStart) + line.slice(blockEnd + 2);
      }
    }
    const lineComment = line.indexOf('//');
    if (lineComment !== -1) line = line.slice(0, lineComment);

    const where = `${rel}:${index + 1}`;
    const trimmed = line.trim();
    if (!trimmed) return;

    if (/^(export\s+)?interface\s+/.test(trimmed)) {
      failures.push(
        `${where} 本地 interface：${trimmed}（API-2：类型必须写入 shared/api.interface.ts）`
      );
      return;
    }
    if (/^(export\s+)?type\s+\w/.test(trimmed)) {
      failures.push(
        `${where} 本地 type：${trimmed}（NFR-M4：check-contract 现已同时扫 type）`
      );
      return;
    }
    // 内联对象**类型**（不是对象字面量值）：`... : { a?: T; b: U }`
    // 判别要点：`{` 之前是类型注解位置（`:` 且再之前不是 `=`/`(`/`,`），
    // 且 `{` 内出现「标识符 + `?` 或 `:`」>= 2 次。
    // 这样可以放过 `params: { page: 1, pageSize: 500 }` 这类**值**字面量。
    const typeAnnotation = /:\s*\{\s*[A-Za-z_$][\w$]*\s*[?:]/.test(line);
    const isValueLiteral =
      /[:=,(]\s*\{\s*[A-Za-z_$][\w$]*\s*:/.test(line) &&
      !/:\s*\{[^}]*[A-Za-z_$][\w$]*\s*\?:/.test(line);
    if (
      typeAnnotation &&
      !isValueLiteral &&
      (line.match(/[A-Za-z_$][\w$]*\s*[?:]/g) ?? []).length >= 2
    ) {
      failures.push(
        `${where} 内联对象类型：${trimmed}（API-2：请提取到 shared/api.interface.ts）`
      );
    }
  });
}

/* ========== ③ server：@Body() 必须是 class DTO（API-1 / NFR-M3） ========== */

/** 把相对 import 路径解析为磁盘文件（尝试 .ts 与 /index.ts） */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(fromFile), spec);
  const candidates = [`${base}.ts`, join(base, 'index.ts')];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* 不存在则继续 */
    }
  }
  return null;
}

/** 定义文件里是否声明了该 class（优先本文件，其次 re-export 的文件） */
function declaresClass(targetFile, className) {
  const pattern = new RegExp(
    `(?:export\\s+)?(?:abstract\\s+)?class\\s+${className}\\b`
  );
  try {
    const text = readFileSync(targetFile, 'utf8');
    if (pattern.test(text)) return true;
    // 可能只是 re-export：`export { Foo } from './foo.dto'`
    for (const m of text.matchAll(/export\s*\{[^}]*\}\s*from\s*'([^']+)'/g)) {
      const nested = resolveImport(targetFile, m[1]);
      if (nested && declaresClass(nested, className)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const serverDir = join(ROOT, 'server', 'modules');
const bodyFailures = [];
for (const file of walk(serverDir)) {
  if (!file.endsWith('.controller.ts')) continue;
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.replace(/\/\/.*$/, '');
    const match = /@Body\(\s*([^)]*)\)\s*(\w+)?/.exec(line);
    if (!match) return;
    const arg = (match[1] ?? '').trim();
    // 合法形态：空（读取整个 body，仍需 DTO 类型）+ 标识符（class DTO）
    if (arg === '' || /^[A-Za-z_$][\w$]*$/.test(arg)) return;
    // 非法形态：`@Body() body: { ... }` 这类内联类型由下一行 `: {` 判定
    if (/^\{/.test(arg) || /^['"]/.test(arg)) {
      bodyFailures.push(`${rel}:${index + 1} ${line.trim()}`);
    }
  });

  // 形态二：@Body() body: { ... }（参数上的内联对象类型）
  const inlineBody = /@Body\(\)\s+\w+\s*:\s*\{/.exec(source);
  if (inlineBody) {
    const lineNo = source.slice(0, inlineBody.index).split(/\r?\n/).length;
    bodyFailures.push(
      `${rel}:${lineNo} @Body() 参数使用内联对象类型（ValidationPipe 会静默失效，请改用 class DTO）`
    );
  }
  // 形态三：@Body() dto: SomeInterface（interface 不是 class，管道同样失效）
  //
  // 关键：必须先收集本文件声明的 **class** 名。
  // `class CreateVoucherDto implements ICreateVoucherDto` 是**合法**的 DTO 写法
  // （API-1 原文就要求"class DTO（implements 契约类型）"），
  // 早期版本把它误判为"使用 interface 类型"，导致 75 处假失败。
  const declaredClasses = new Set();
  for (const m of source.matchAll(/(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g)) {
    declaredClasses.add(m[1]);
  }
  // 本文件 import 的**值**（非 import type）：这些在运行时存在，通常是 class。
  // 记录 `名字 → 定义文件`，以便顺着相对路径去确认它确实是 class（而不是 const/函数）。
  const valueImports = new Map();
  for (const m of source.matchAll(/(?<!import\s)\bimport\s*(?!type\b)\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    for (const name of m[1].split(',')) {
      const clean = name.trim().split(/\s+as\s+/)[0].trim();
      if (clean) valueImports.set(clean, m[2]);
    }
  }
  const interfaceImports = new Set();
  for (const m of source.matchAll(/import\s+type\s*\{([^}]*)\}\s*from/g)) {
    for (const name of m[1].split(',')) {
      const clean = name.trim().split(/\s+as\s+/)[0].trim();
      if (clean) interfaceImports.add(clean);
    }
  }
  lines.forEach((rawLine, index) => {
    const match = /@Body\(\)\s+(\w+)\s*:\s*([A-Za-z_$][\w$]*)/.exec(rawLine);
    if (!match) return;
    const typeName = match[2];
    // 本文件声明的 class → 合法
    if (declaredClasses.has(typeName)) return;
    // 明确来自 `import type` → 一定是 interface/type 别名 → 非法
    if (interfaceImports.has(typeName)) {
      bodyFailures.push(
        `${rel}:${index + 1} @Body() 使用 interface/type 类型 ${typeName}（API-1：必须是 class DTO）`
      );
      return;
    }
    // 其余情况：顺着值导入的相对路径去定义文件里找 `class X`
    if (/^(Request|Response|NextFunction)$/.test(typeName)) return;
    const importSource = valueImports.get(typeName);
    if (importSource) {
      const resolved = resolveImport(file, importSource);
      if (resolved && declaresClass(resolved, typeName)) return;
      warnings.push(
        `${rel}:${index + 1} @Body() 类型 ${typeName} 来自值导入但未在 ${importSource} 中找到 class 定义，请人工复核`
      );
      return;
    }
    warnings.push(
      `${rel}:${index + 1} @Body() 类型 ${typeName} 无法静态确认是否为 class DTO，请人工复核`
    );
  });
}

/* ========== 输出 ========== */

if (failures.length > 0) {
  console.error('契约检查未通过（client/src/api 本地类型声明）：\n');
  for (const line of failures) console.error(`  ✗ ${line}`);
  console.error(`\n共 ${failures.length} 处。类型请放到 shared/api.interface.ts。\n`);
}

if (bodyFailures.length > 0) {
  console.error('契约检查未通过（@Body() 未使用 class DTO）：\n');
  for (const line of bodyFailures) console.error(`  ✗ ${line}`);
  console.error(
    `\n共 ${bodyFailures.length} 处。API-1 要求所有请求体使用 class DTO（implements 契约类型）并有校验装饰器。\n`
  );
}

if (failures.length > 0 || bodyFailures.length > 0) {
  process.exit(1);
}

for (const line of warnings) console.warn(`  ⚠ ${line}`);
console.log(
  `契约检查通过（client/src/api 无本地 interface/type/内联对象类型；所有 @Body() 使用 class DTO）`
);
