#!/usr/bin/env node
/**
 * 可选字段守卫门禁：`?:` 声明的字段必须带 `@IsOptional()`（或等价守卫）。
 *
 * ## 为什么需要它
 *
 * `server/main.ts:193` 的 `ValidationPipe` **没有开** `skipMissingProperties`，
 * 于是 class-validator 会拿 `undefined` 去过每一个校验器。因此：
 *
 * ```ts
 * @IsString()                       // ← 少了 @IsOptional()
 * @IsIn(['active', 'offline'])
 * status?: 'active' | 'offline';    // 声明可选…
 * ```
 *
 * 请求体里**不带 `status`** 的 PATCH 会被拒：
 * `400 status: status must be one of the following values: …`。
 * 即「**声明可选、实际必填**」—— 任何不传该字段的请求都会失败。
 *
 * ## 真实事故（本仓已发生）
 *
 * `UpdateDatasetDto.status` 就缺了 `@IsOptional()`，而前端编辑数据集的 payload
 * **从来不传 `status`**（状态流转走 `POST datasets/:id/actions/:action`）。
 * 后果：**「编辑数据集」保存 100% 失败**，且使用者只看到一句
 * `status must be one of the following values`，完全看不出是"没传可选字段"。
 *
 * ## 为什么非要有门禁
 *
 * 这类缺陷**两道既有防线都看不见**：
 * - `tsc` 看不见：`?:` 是类型层的事，装饰器是运行时元数据，互不校验；
 * - 单测看不见：除非恰好像 `data-asset.dto.spec.ts` 那样用**真实 class-validator**
 *   跑一遍网关，否则纯逻辑单测完全不碰装饰器。
 *
 * 所以它只能靠"扫源码"兜住 —— 与 `check:label-a11y` / `check:label-dict` 同一思路。
 *
 * ## 判据（只看紧邻的连续装饰器块）
 *
 * 从字段行往上收集连续的 `@...` 行（允许中间夹注释行），遇到第一个
 * **非装饰器、非注释、非空**的行就停。块里只要出现下面任一个即放行：
 * - `@IsOptional()` —— 让 `undefined`/`null` 短路放行（本仓主用写法）
 * - `@ValidateIf(...)` —— 显式条件校验（常与 `@IsOptional()` 连用排除 `null`）
 * - `@IsDefined()` —— 语义相反（必填），不属于本规则
 * - `@Allow()` —— class-validator 的"跳过校验"标记
 *
 * **没有任何装饰器的字段不报** —— 它不接受校验，也就不存在"可选被当必填"。
 *
 * ## 已知不报（诚实标注）
 *
 * - **不校验 DTO 之外的类型**（interface / type）—— 它们不会被 `ValidationPipe` 处理；
 * - **不判断"该字段是否真的可选"** —— 只判断"声明了 `?:` 就必须有守卫"；
 *   若某字段本应必填却写成 `?:`，本门禁不会发现（那是设计问题，不是本规则）；
 * - **不做控制流分析** —— 例如 `@ValidateIf(() => false)` 这种恒假条件，
 *   本门禁视为"有守卫"（技术上门禁被绕过，但那已经在滥用装饰器）；
 * - 只扫 `server/modules` 与 `server/common` 下的 `*.dto.ts` / `*.controller.ts`。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCAN_ROOTS = ['server/modules', 'server/common'];
const FILE_RE = /\.(dto|controller)\.ts$/u;

/** 出现任一即视为"该字段有守卫" */
const GUARDS = ['@IsOptional(', '@ValidateIf(', '@IsDefined(', '@Allow('];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (FILE_RE.test(full)) out.push(full);
  }
  return out;
}

/** 收集字段行上方紧邻的连续装饰器块 */
function decoratorBlockAbove(lines, fieldIdx) {
  const decorators = [];
  let j = fieldIdx - 1;
  let inBlockComment = false;
  while (j >= 0) {
    const t = lines[j].trim();
    if (t === '') break;
    if (t.startsWith('*/')) inBlockComment = true;
    if (inBlockComment || t.startsWith('/*')) {
      if (t.startsWith('/*')) inBlockComment = false;
      j -= 1;
      continue;
    }
    if (t.startsWith('//')) {
      j -= 1;
      continue;
    }
    if (t.startsWith('@')) {
      decorators.push(t);
      j -= 1;
      continue;
    }
    break;
  }
  return decorators.reverse();
}

const findings = [];
for (const root of SCAN_ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u);
    for (let i = 0; i < lines.length; i += 1) {
      // 形如 `  fieldName?: Type;`
      const m = lines[i].match(/^\s{2}([A-Za-z_]\w*)\?:\s*[^;=]+;\s*$/u);
      if (!m) continue;
      const decorators = decoratorBlockAbove(lines, i);
      if (decorators.length === 0) continue; // 无装饰器 → 不归本规则管
      const guarded = decorators.some((d) => GUARDS.some((g) => d.includes(g)));
      if (!guarded) {
        findings.push({
          file: relative(ROOT, file).replace(/\\/gu, '/'),
          line: i + 1,
          field: m[1],
          decorators,
        });
      }
    }
  }
}

if (findings.length === 0) {
  console.log(
    '可选字段守卫门禁通过：所有 `?:` 字段都带了 @IsOptional()/@ValidateIf() 守卫。',
  );
  process.exit(0);
}

console.error(`\n[FAIL] 有 ${findings.length} 个「声明可选、实际必填」的字段：\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.field}`);
  console.error(`      装饰器块: ${f.decorators.join(' ')}`);
}
console.error(
  '\n为什么这是缺陷：`server/main.ts` 的 ValidationPipe 没有开 `skipMissingProperties`，\n' +
    'class-validator 会拿 `undefined` 去过校验器 —— 于是**不传该字段的请求一律 400**。\n' +
    '使用者看到的是「xxx must be a string / must be one of …」，\n' +
    '完全看不出根因是"少写了一个 @IsOptional()"。\n' +
    '\n真实事故：`UpdateDatasetDto.status` 缺守卫 → 前端编辑数据集从不传 `status`\n' +
    '→ **保存 100% 失败**。而 tsc 与单测都看不见这个缺陷。\n' +
    '\n修法：在装饰器块最上方补 `@IsOptional()`。\n' +
    '若该字段**本应必填**，那就把 `?:` 改成 `!:` 并去掉 `@IsOptional()` ——\n' +
    '但此时前端必须保证传值，否则就会开始 400。\n' +
    '可空（允许显式传 null 清除）的字段用本仓既有写法：\n' +
    '  @IsOptional()\n' +
    '  @ValidateIf((_, v) => v !== null)\n' +
    '  @IsUUID()\n' +
    '  contractId?: string | null;',
);
process.exit(1);
