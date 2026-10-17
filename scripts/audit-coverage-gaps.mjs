/**
 * 覆盖率缺口**结构分析**：对未被 spec 引用的文件，看它里面
 * 有多少是**可抽出的纯逻辑**（有 `export function` / 常量表 / 无 `this.` 的模块级函数）。
 *
 * 目的：把"还剩 20 个文件没测"变成"哪几个文件的**哪几段**值得抽"。
 * 之前的做法（只按行数排序）会把"纯编排的 service"排在前面，
 * 而那些文件抽不出东西 —— 白白花时间。
 *
 * 用法：npx tsx scripts/audit-coverage-gaps.mjs
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';

function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const all = walk('server');
const specText = all.filter((f) => /\.spec\.ts$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');

const rows = [];
for (const f of all) {
  const rel = relative('.', f).replace(/\\/g, '/');
  if (/\.spec\.ts$/.test(rel)) continue;
  const name = basename(f, '.ts');
  if (name === 'index' || name.endsWith('.dto') || name.endsWith('.module')) continue;
  const src = readFileSync(f, 'utf8');
  const lines = src.split('\n').length;
  if (lines < 80) continue;
  const sibling = join(dirname(f), `${name}.spec.ts`);
  if (existsSync(sibling) || specText.includes(`/${name}'`)) continue;

  /*
   * 提取"可测信号"：
   *   · 模块级 export function（不是 class 方法）
   *   · 模块级纯常量表（Record/ReadonlyArray/数组字面量）
   *   · 内联算术/取整/阈值比较（round2 / Math. / >= > 阈值）
   *   · 内联状态机映射（Record<...> 字面量含 '状态' 字面量）
   */
  const exportFns = (src.match(/^export function \w+/gm) ?? []).length;
  const constTables = (src.match(/^(export )?const [A-Z_0-9]+[^=]*=\s*(\{|\[)/gm) ?? []).length;
  const arith = (src.match(/round2\(|Math\.(max|min|round|abs)\(/g) ?? []).length;
  const thresholds = (src.match(/[<>]=?\s*[\d_]+(\.\d+)?\b/g) ?? []).length;
  const transitions = (src.match(/Record<string,\s*Record<string,\s*'/g) ?? []).length;
  const hasClass = /export class \w+/.test(src);
  const thisCalls = (src.match(/this\.\w+\(/g) ?? []).length;

  const score = exportFns * 3 + constTables * 2 + arith + transitions * 3 + Math.min(thresholds, 8) * 0.5;
  rows.push({
    rel, lines, score,
    exportFns, constTables, arith, transitions, hasClass, thisCalls,
  });
}

rows.sort((a, b) => b.score - a.score);
console.log('  未被 spec 引用且 ≥80 行的文件，按"可抽出纯逻辑"的信号量排序：\n');
console.log('   分数  行数  导出函数 常量表 算术 状态机  文件');
for (const r of rows) {
  console.log(
    `  ${String(Math.round(r.score)).padStart(5)}  ${String(r.lines).padStart(5)}  ` +
    `${String(r.exportFns).padStart(6)}  ${String(r.constTables).padStart(5)}  ` +
    `${String(r.arith).padStart(4)}  ${String(r.transitions).padStart(5)}  ${r.rel}`,
  );
}
console.log(
  '\n  说明：分数越高 = 越可能有可直接断言的纯逻辑（导出函数/常量表/状态机映射/取整算术）。\n' +
  '  纯编排类 service（只有 this.xxx() 调用、无算术无阈值）分数会很低 —— 那类抽出收益小。',
);
