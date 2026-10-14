#!/usr/bin/env node
/**
 * B-01 收尾：把**写语义**的 `<CanCapability capability="xxx_write">` 改为
 * `<CanCapabilityWrite capability="xxx_write">`。
 *
 * ## 为什么必须区分读写两种组件
 *
 * `CanCapability` 走 `hasCapability`（矩阵中 `r` 或 `rw` 都通过），
 * `CanCapabilityWrite` 走 `hasWriteCapability`（**必须是 `rw`**）。
 *
 * 后端写接口要求 `rw`，所以前端写按钮必须用后者。用 `CanCapability` 判写按钮，
 * 只读角色会**看到点了必然被拒的按钮**（B-01 验收标准②）。
 *
 * 实测这不是理论风险：`tax_entity` / `pur_asset` 这类"读写同码"的能力
 * （route-capability 中 `write: null`，矩阵里 `finance_viewer` / `project_manager`
 * 有 `r`）在 `hasCapability` 下会对只读角色返回 true —— 共 3 处差异。
 *
 * ## 判定哪些是写语义
 *
 * - 以 `_write` 结尾的能力码（如 `finance_write`）；
 * - 或属于 `WRITE_ONLY_CAPABILITIES`（矩阵中只有 `admin` 有 `rw`、
 *   而又有其他角色持有 `r` 的"读写同码"，即 route-capability 里 `write: null` 的那些）。
 *
 * 其余能力码（`finance` / `crm` / `projects` / `finance` 等纯读语义）
 * **保持 `CanCapability`** —— 对它们用写语义会**过度隐藏**（只读角色本该看得见入口）。
 *
 * ## 用法
 *
 *   node ./scripts/codemod-canwrite.mjs [--write] [--file=substring]
 *
 * 默认 dry-run。
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = process.cwd();
const WRITE = process.argv.includes('--write');
const FILE_FILTER = process.argv.find((a) => a.startsWith('--file='))?.slice(7);

/**
 * "读写同码"的能力：矩阵中只有 admin 拿到 `rw`，但**其他角色有 `r`**，
 * 对应 route-capability.ts 里 `write: null` 的规则（写接口沿用读能力码）。
 *
 * 这些码在 `hasCapability` 下对只读角色为 true，因此写按钮必须用
 * `CanCapabilityWrite` 才不会漏出来。清单与 route-capability.ts 的
 * `write: null` 规则一致。
 */
const WRITE_ONLY_CAPABILITIES = new Set([
  'tax_entity',
  'pur_asset',
  'admin_ops',
  'audit',
  'identity',
  'settings_brand',
  'settings_feishu',
  'settings_appearance',
]);

const isWriteCapability = (cap) =>
  /_write$/.test(cap) || WRITE_ONLY_CAPABILITIES.has(cap);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') walk(full, out);
    } else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const applied = [];
const skipped = [];

for (const file of walk(join(REPO, 'client/src'))) {
  const rel = relative(REPO, file).replace(/\\/g, '/');
  if (FILE_FILTER && !rel.includes(FILE_FILTER)) continue;
  const text = readFileSync(file, 'utf8');
  if (!/<CanCapability\s+capability=/.test(text)) continue;

  let replaced = 0;
  const caps = new Set();
  // 只替换"写语义"的那些开标签；闭标签统一处理（两种组件同名闭合写法一致）
  let next = text.replace(
    /<CanCapability(\s+capability="([^"]+)")/g,
    (match, attrs, cap) => {
      if (!isWriteCapability(cap)) return match;
      replaced += 1;
      caps.add(cap);
      return `<CanCapabilityWrite${attrs}`;
    }
  );
  if (replaced === 0) continue;

  // 闭标签：把与写标签配对的 </CanCapability> 改成 </CanCapabilityWrite>。
  // 由于 JSX 嵌套，不能简单全局替换 —— 用计数法逐段处理。
  next = closeTags(next);

  // 更新 import：可能来自 auth 或 RequireCapability
  next = next.replace(
    /import\s*\{\s*CanCapability\s*\}\s*from\s*'@client\/src\/platform\/auth';/g,
    "import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';"
  );
  next = next.replace(
    /import\s*\{\s*CanCapability,\s*CanCapabilityWrite\s*\}\s*from\s*'@client\/src\/platform\/auth';/g,
    "import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';"
  );
  if (
    /CanCapabilityWrite/.test(next) &&
    !/import\s*\{[^}]*CanCapabilityWrite[^}]*\}\s*from/.test(next)
  ) {
    skipped.push({ rel, reason: '改用了 CanCapabilityWrite 但未能自动补 import，需人工' });
    continue;
  }

  if (next !== text) {
    applied.push({ rel, count: replaced, caps: [...caps] });
    if (WRITE) writeFileSync(file, next, 'utf8');
  }
}

/**
 * 把 `</CanCapability>` 改成与最近未闭合的 `CanCapabilityWrite` 配对的闭合标签。
 *
 * 为什么需要：`<CanCapabilityWrite ...>...</CanCapability>` 在 JSX 里是合法的
 * （React 不要求闭合标签名与开标签一致？—— 不，实际上要求一致）。
 * 因此必须精确配对，不能全局替换 `</CanCapability>`，
 * 否则会把仍在用读语义的块也改掉。
 */
function closeTags(text) {
  const openRe = /<(CanCapability|CanCapabilityWrite)\b[^>]*?(\/?)>/g;
  const stack = [];
  const edits = [];
  let m;
  while ((m = openRe.exec(text)) !== null) {
    if (m[2] === '/') continue; // 自闭合，不压栈
    stack.push({ name: m[1], index: m.index });
  }
  // 再收集全部闭标签，按出现顺序与栈匹配
  const closeRe = /<\/(CanCapability|CanCapabilityWrite)>/g;
  const closes = [];
  while ((m = closeRe.exec(text)) !== null) {
    closes.push({ name: m[1], index: m.index, end: m.index + m[0].length });
  }
  void stack;
  // 用栈做真正的配对：顺序遍历开/闭标签
  const tokens = [];
  const anyRe = /<(CanCapability|CanCapabilityWrite)\b[^>]*?(\/?)>|<\/(CanCapability|CanCapabilityWrite)>/g;
  while ((m = anyRe.exec(text)) !== null) {
    const isClose = Boolean(m[3]);
    if (isClose) {
      const top = stack.pop();
      if (top && top.name === 'CanCapabilityWrite') {
        edits.push({ start: m.index, end: m.index + m[0].length });
      }
    } else if (m[2] !== '/') {
      stack.push({ name: m[1], index: m.index });
    }
  }
  // 从后往前替换，避免位移
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, e.start)}</CanCapabilityWrite>${out.slice(e.end)}`;
  }
  return out;
}

console.log(`${WRITE ? '【已写入】' : '【DRY-RUN，未改动文件】'}`);
console.log(
  `\n改写：${applied.length} 个文件 / ${applied.reduce((s, a) => s + a.count, 0)} 处`
);
for (const a of applied.sort((x, y) => y.count - x.count)) {
  console.log(`  ${String(a.count).padStart(2)}  ${a.caps.join(",").padEnd(30)} ${a.rel}`);
}
if (skipped.length > 0) {
  console.log(`\n跳过（需人工）：${skipped.length}`);
  for (const s of skipped) console.log(`  ${s.rel}\n      理由：${s.reason}`);
}
if (!WRITE && applied.length > 0) console.log('\n确认后加 --write 落盘。');
