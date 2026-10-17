/**
 * 列出每个页面 `FilterBar` 内的按钮**及其文案**，用于区分
 * 「筛选区工具动作」（刷新/导出，留着合理）与「表单提交/主操作」（该进 PageShell.actions）。
 *
 * 用法：npx tsx scripts/audit-filterbar-actions.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/** 从 <Button …>…</Button> 片段里取可见文字（去标签、去表达式、压缩空白） */
function visibleText(chunk) {
  return chunk
    .replace(/<[^>]+>/g, ' ') // 去掉所有标签（含 svg/图标）
    .replace(/\{[^{}]*\}/g, ' ') // 去掉 {表达式}
    .replace(/\s+/g, ' ')
    .replace(/["'`]/g, '')
    .trim()
    .slice(0, 30);
}

const rows = [];
for (const f of walk('client/src/pages')) {
  const rel = relative('.', f).replace(/\\/g, '/');
  const src = readFileSync(f, 'utf8');
  /* 逐块匹配 <FilterBar>…</FilterBar>（用 indexOf 配对，避免嵌套正则失效） */
  let idx = 0;
  while (true) {
    const a = src.indexOf('<FilterBar>', idx);
    if (a < 0) break;
    const b = src.indexOf('</FilterBar>', a);
    if (b < 0) break;
    const inner = src.slice(a, b);
    idx = b + 1;

    /* 该块内所有顶层 <Button …> … </Button> */
    const btns = [];
    let p = 0;
    while (true) {
      const s = inner.indexOf('<Button', p);
      if (s < 0) break;
      const e = inner.indexOf('</Button>', s);
      if (e < 0) break;
      btns.push(visibleText(inner.slice(s, e + 9)));
      p = e + 9;
    }
    if (btns.length) rows.push({ file: rel, line: src.slice(0, a).split('\n').length, btns });
  }
}

console.log(`=== FilterBar 内含 Button 的页面：${rows.length} 处 ===\n`);
for (const r of rows) {
  console.log(`${r.file}:${r.line}`);
  for (const b of r.btns) console.log(`    [${b || '(无文字，仅图标)'}]`);
}
console.log(`
判据（本仓 AGENTS.md）：
  · 保留在 FilterBar：刷新 / 导出 Excel / 打印 / 同步 —— 它们是"对当前筛选结果的操作"，
    与筛选控件同处一排是常见且合理的企业后台形态；
  · 应移到 PageShell.actions：新建 / 登记 / 提交 / 审批 / 执行 这类**改变数据的主动作**。
`);
