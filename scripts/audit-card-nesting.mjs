/**
 * 逐个确认"疑似 Card 嵌套 Card"（规范明确禁止）。
 *
 * ## 为什么需要单独确认
 *
 * `audit-ui-consistency.mjs` 的 ⑤ 是正则启发式：
 *   `/<Card[\s\S]{0,600}?<Card/`
 * 它会把**同一层级的连续两张 Card**（详情页极常见：概览卡、明细卡、附件卡一字排开）
 * 判成嵌套 —— 实测 24 条命中里绝大多数是这种误报。
 *
 * 本脚本做的是**真正的配对分析**：用标签栈跟踪 `<Card` / `</Card>` 的嵌套深度，
 * 只有当深度 ≥ 2 时（即第二张 Card 出现在第一张的**子树**里）才算真嵌套。
 * 自闭合的 `<Card />` 与 `CardHeader/CardContent` 等子组件不计入深度。
 *
 * 用法：npx tsx scripts/audit-card-nesting.mjs
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

/** 只匹配真正的 Card 容器标签，不匹配 CardHeader/CardContent/... */
const OPEN = /<Card(?=[\s/>])(?![A-Za-z])/g;
const CLOSE = /<\/Card(?=[\s>])/g;

const results = [];

for (const f of walk('client/src')) {
  const rel = relative('.', f).replace(/\\/g, '/');
  if (rel.includes('components/ui/')) continue; // shadcn 原语：Card 本体在那里
  const src = readFileSync(f, 'utf8');

  /* 逐字符扫，维护深度；记录每次"在深度≥1 时又开一张 Card"的位置 */
  const events = [];
  const re = /<\/?Card(?=[\s/>])/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    events.push({ index: m.index, close: m[0].startsWith('</') });
  }

  let depth = 0;
  const violations = [];
  for (const e of events) {
    if (!e.close) {
      /* 自闭合 `<Card ... />` 不增加深度 */
      const nl = src.indexOf('>', e.index);
      const selfClosing = nl > 0 && src[nl - 1] === '/';
      if (depth >= 1) {
        const line = src.slice(0, e.index).split('\n').length;
        violations.push({ line, depth });
      }
      if (!selfClosing) depth += 1;
    } else {
      if (depth > 0) depth -= 1;
    }
  }

  if (violations.length) results.push({ file: rel, violations });
}

console.log(`=== 真·Card 嵌套 Card：${results.length} 个文件 ===\n`);
if (results.length === 0) {
  console.log('（无 —— 之前审计里那 24 条全是"连续同级 Card"的正则误报）');
} else {
  for (const r of results) {
    console.log(`${r.file}  (${r.violations.length} 处)`);
    for (const v of r.violations) console.log(`   L${v.line}  嵌套深度 ${v.depth + 1}`);
  }
  console.log('\n修法：内层改成不带 Card 外框的分区（SectionTitle + 内容），或把内层提为同级 Card。');
}
