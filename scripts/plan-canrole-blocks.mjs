#!/usr/bin/env node
/**
 * B-01 前端收敛的**人工判定辅助工具**：为每个仍在用 `<CanRole>` 的按钮
 * 追溯到它最终调用的写接口，从而给出应使用的能力码。
 *
 * ## 为什么需要两跳追溯
 *
 * 按钮几乎都是"打开弹窗"（`onClick={() => setXxxOpen(true)}`），
 * 真正的写请求在弹窗的提交处理函数里（`const onSubmit = form.handleSubmit(async () => { await xxxApi.create... })`）。
 * 只看按钮那一行必然推导不出能力 —— 第一版工具就是这样全部输出"⚠️ 推导不出"的。
 *
 * 追溯链：
 *   ① 按钮的 `onClick` 里 `setXxxOpen(true)` → 状态名 `xxxOpen`；
 *   ② 全文找 `open={xxxOpen}` 的 `<Dialog>`/弹窗组件；
 *   ③ 在该组件范围内找 `onSubmit` / `handleSubmit` 处理函数；
 *   ④ 从处理函数体里提取 `xxxApi.fn(` 调用 → 映射为能力码。
 *
 * ## 保守原则
 *
 * - 追溯不到就输出 **⚠️ 推导不出**，不猜；
 * - 一个块内出现**多个能力**时全部列出，提示需按按钮拆分 ——
 *   取并集会让低权限用户看到不该看到的按钮（比漏隐藏危险）；
 * - 输出的是**建议**，最终由人工确认后写入代码。
 *
 * 用法：node ./scripts/plan-canrole-blocks.mjs [--file=substring]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = process.cwd();
const FILE_FILTER = process.argv.find((a) => a.startsWith('--file='))?.slice(7);

/* ---------- 路由 → 能力 ---------- */
const routeSrc = readFileSync(
  join(REPO, 'server/common/auth/route-capability.ts'),
  'utf8'
);
const rules = [
  ...routeSrc.matchAll(
    /prefix:\s*'([^']+)',\s*read:\s*'([^']+)'(?:,\s*write:\s*(?:'([^']+)'|null))?/g
  ),
]
  .map((m) => ({ prefix: m[1], read: m[2], write: m[3] ?? `${m[2]}_write` }))
  .sort((a, b) => b.prefix.length - a.prefix.length);

/* ---------- api 函数 → 能力 ---------- */
const fnCap = new Map();
const apiDir = join(REPO, 'client/src/api');
// barrel 的 `export * as xxxApi from './mod-dir'` 用于把别名还原成目录名
const barrel = readFileSync(join(apiDir, 'index.ts'), 'utf8');
const aliasToDir = new Map();
for (const m of barrel.matchAll(/export \* as (\w+) from '\.\/([\w-]+)'/g)) {
  aliasToDir.set(m[1].replace(/Api$/, ''), m[2]);
}

for (const mod of readdirSync(apiDir)) {
  const idx = join(apiDir, mod, 'index.ts');
  if (!existsSync(idx) || !statSync(idx).isFile()) continue;
  const text = readFileSync(idx, 'utf8');
  for (const block of text.split(/(?=export\s+(?:async\s+)?function\s)/)) {
    const fn = block.match(/export\s+(?:async\s+)?function\s+(\w+)/);
    if (!fn) continue;
    const caps = new Set();
    for (const m of block.matchAll(/['"`](\/api\/[a-zA-Z0-9_\-/{}$:.]+)['"`]/g)) {
      const rule = rules.find((r) =>
        m[1].replace(/\$\{[^}]*\}/g, 'x').startsWith(`/${r.prefix}`)
      );
      if (rule) caps.add(rule.write);
    }
    if (caps.size) fnCap.set(`${mod}.${fn[1]}`, caps);
  }
}

/** 把 `financeApi.createAp(` 解析成能力集合 */
function capsOfCall(prefix, fnName) {
  const mod = aliasToDir.get(prefix) ?? prefix;
  return fnCap.get(`${mod}.${fnName}`);
}

/* ---------- 遍历 ---------- */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') walk(full, out);
    } else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

let totalBlocks = 0;
let resolvedBlocks = 0;

for (const file of walk(join(REPO, 'client/src'))) {
  const rel = relative(REPO, file).replace(/\\/g, '/');
  if (FILE_FILTER && !rel.includes(FILE_FILTER)) continue;
  const text = readFileSync(file, 'utf8');
  if (!/<CanRole\b/.test(text)) continue;

  const opens = [...text.matchAll(/<CanRole\b[^>]*>/g)];
  console.log(`\n=== ${rel}（${opens.length} 个块）===`);

  for (const open of opens) {
    const start = open.index;
    const end = text.indexOf('</CanRole>', start);
    const block = end === -1 ? text.slice(start) : text.slice(start, end);
    const line = text.slice(0, start).split('\n').length;
    totalBlocks += 1;

    // ① 按钮文案
    const label = block.match(/>\s*([\u4e00-\u9fa5][^<>{}\n]{1,16})\s*</);
    // ② onClick 里打开的状态
    const setState = [...block.matchAll(/set(\w+)\s*\(\s*true\s*\)/g)].map(
      (m) => m[1]
    );

    const caps = new Set();
    const calls = new Set();

    for (const state of setState) {
      // ③ 找 `open={state}` 附近的弹窗块
      const openIdx = text.indexOf(`open={${state}}`);
      if (openIdx === -1) continue;
      // 弹窗范围：从该 `<Dialog` 起到对应 `</Dialog>`（粗略取 4000 字符）
      const regionStart = Math.max(0, text.lastIndexOf('<Dialog', openIdx));
      const regionEnd = text.indexOf('</Dialog>', openIdx);
      const region =
        regionEnd === -1
          ? text.slice(regionStart, regionStart + 4000)
          : text.slice(regionStart, regionEnd);
      // ④ 区域内的 api 调用
      for (const m of region.matchAll(/\b(\w+Api)\.(\w+)\s*\(/g)) {
        calls.add(`${m[1]}.${m[2]}`);
        const found = capsOfCall(m[1].replace(/Api$/, ''), m[2]);
        if (found) for (const c of found) caps.add(c);
      }
      // ⑤ 区域内若调用本地 handler，再去 handler 定义里找
      for (const m of region.matchAll(/onClick=\{\(\)\s*=>\s*(\w+)\(/g)) {
        const hIdx = text.indexOf(`const ${m[1]} =`);
        if (hIdx === -1) continue;
        const hRegion = text.slice(hIdx, hIdx + 2500);
        for (const c of hRegion.matchAll(/\b(\w+Api)\.(\w+)\s*\(/g)) {
          calls.add(`${c[1]}.${c[2]}`);
          const found = capsOfCall(c[1].replace(/Api$/, ''), c[2]);
          if (found) for (const cap of found) caps.add(cap);
        }
      }
    }

    // 块内直接调用也收进来（有些块不含弹窗）
    for (const m of block.matchAll(/\b(\w+Api)\.(\w+)\s*\(/g)) {
      calls.add(`${m[1]}.${m[2]}`);
      const found = capsOfCall(m[1].replace(/Api$/, ''), m[2]);
      if (found) for (const c of found) caps.add(c);
    }

    const capList = [...caps].sort();
    if (capList.length > 0) resolvedBlocks += 1;
    console.log(
      `  L${line}  [${label ? label[1].trim() : '（无文案）'}]  →  ${
        capList.length === 0
          ? '⚠️ 推导不出'
          : capList.length === 1
            ? `✅ ${capList[0]}`
            : `⚠️ 多能力，需拆分：${capList.join(' / ')}`
      }`
    );
    if (calls.size > 0) {
      console.log(`          调用：${[...calls].slice(0, 6).join(', ')}`);
    }
  }
}

console.log(
  `\n合计 ${totalBlocks} 个块，其中可推导出能力 ${resolvedBlocks} 个，` +
    `需人工 ${totalBlocks - resolvedBlocks} 个`
);
