#!/usr/bin/env node
/**
 * B-14：后端错误文案审计。
 *
 * 需求书 §7.1 API-5 要求"业务校验失败返回 4xx + **可读中文原因**"。
 * 前端 B-14 又把 `getApiErrorMessage` 统一成展示后端消息，
 * 因此后端一旦抛出英文消息，用户看到的就是英文（例如
 * `Request failed with status code 400` 之外的 `Invalid uuid`）。
 *
 * 本脚本扫描所有 `throw new <HttpException>(...)`，找出**消息不含中日韩字符**的调用点：
 *   - 退出码 1：存在需要修成中文的文案（CI 门）；
 *   - 退出码 0：全部文案均可读。
 *
 * 白名单：允许保留英文的场景（例如内部断言、仅日志使用的异常）在此登记，
 * 并且必须写明理由，避免"用白名单把问题藏起来"。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 已确认合理的英文消息（文件路径 + 行号或片段 → 理由） */
const ALLOWED = [
  {
    file: 'server/modules/feishu-collab/event.controller.ts',
    reason: '飞书事件回调的入参校验由飞书侧决定，消息会回传给飞书开放平台而非终端用户',
  },
];

const HTTP_EXCEPTIONS = [
  'BadRequestException',
  'UnauthorizedException',
  'ForbiddenException',
  'NotFoundException',
  'ConflictException',
  'ServiceUnavailableException',
  'UnprocessableEntityException',
  'InternalServerErrorException',
  'HttpException',
];

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      walk(full, out);
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/**
 * 从 `throw new XxxException(` 起，收集到匹配的右括号为止的源码片段，
 * 并取出其中的**字符串字面量**作为候选消息。模板字符串也纳入。
 */
function extractMessages(source, startIndex) {
  let depth = 0;
  let index = startIndex;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  const literals = [];
  let current = '';
  let capturing = false;

  for (; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (!inSingle && !inDouble && !inTemplate && char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (!inSingle && !inDouble && !inTemplate && char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (inSingle) {
      if (char === '\\') {
        current += source[index + 1] ?? '';
        index += 1;
        continue;
      }
      if (char === "'") {
        inSingle = false;
        capturing = false;
        literals.push(current);
        current = '';
        continue;
      }
      current += char;
      continue;
    }
    if (inDouble) {
      if (char === '\\') {
        current += source[index + 1] ?? '';
        index += 1;
        continue;
      }
      if (char === '"') {
        inDouble = false;
        capturing = false;
        literals.push(current);
        current = '';
        continue;
      }
      current += char;
      continue;
    }
    if (inTemplate) {
      if (char === '\\') {
        current += source[index + 1] ?? '';
        index += 1;
        continue;
      }
      if (char === '`') {
        inTemplate = false;
        capturing = false;
        literals.push(current);
        current = '';
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      capturing = true;
      current = '';
      continue;
    }
    if (char === '"') {
      inDouble = true;
      capturing = true;
      current = '';
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      capturing = true;
      current = '';
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth <= 0) break;
    }
  }
  void capturing;
  return literals;
}

const files = walk(join(ROOT, 'server'));
const problems = [];

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const source = readFileSync(file, 'utf8');
  const pattern = new RegExp(`throw\\s+new\\s+(${HTTP_EXCEPTIONS.join('|')})\\s*\\(`, 'g');
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const lineNo = source.slice(0, match.index).split(/\r?\n/).length;
    const allowed = ALLOWED.find((item) => item.file === rel);
    if (allowed) continue;
    const literals = extractMessages(source, match.index + match[0].length - 1);
    if (literals.length === 0) continue;
    // 只要任一字符串字面量含中文就算通过（可能首参是状态码等）
    const hasChinese = literals.some((text) => CJK.test(text));
    if (!hasChinese) {
      problems.push(
        `${rel}:${lineNo} ${match[1]} 的消息不含中文：${JSON.stringify(literals[0]).slice(0, 80)}`
      );
    }
  }
}

if (problems.length > 0) {
  console.error('后端错误文案审计未通过（API-5 / B-14：业务失败必须返回可读中文原因）：\n');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(
    `\n共 ${problems.length} 处。若确属内部断言或回传给第三方的消息，请在脚本 ALLOWED 中登记并写明理由。`
  );
  process.exit(1);
}

console.log(
  `后端错误文案审计通过（扫描 ${files.length} 个文件；白名单 ${ALLOWED.length} 条，均已登记理由）`
);
