/**
 * 前端 UI 结构一致性审计（只读，不改代码）。
 *
 * 目的：把"看起来不统一"变成**可数的清单**，而不是逐个页面凭感觉挑。
 * 依据 `AGENTS.md` 的设计规范与仓库既有实现（`PageShell.tsx` 的 `actions` 插槽）。
 *
 * 检查项：
 *   ① 用 `PageShell` 但**没用它的 `actions` 插槽**（主操作按钮散落在页面正文里）
 *   ② 手写页面标题（`text-2xl font-semibold` 的 h1）而非走 `PageShell`
 *   ③ 页面根容器手写 `p-6`/`gap-6`（应交给 `PageShell`）
 *   ④ `FilterBar` 里有 `<Button>`（筛选区混入主操作）
 *   ⑤ Card 嵌套 Card（规范明确禁止）
 *   ⑥ 裸写十六进制色值（图表须走 `seriesColor`）
 *   ⑦ 用 shadcn `<Table>` 做数据表（应一律 antd `<Table>`）
 *   ⑧ 页面主文件超 500 行（§5.9 拆分门槛；`components/ui/` 豁免、**`.spec.ts` 豁免**）
 *   ⑨ `text-[22px]` 之类偏离规范的标题字号
 *
 * ## 已确认的例外（`EXEMPTIONS`）
 *
 * 审计的价值取决于"每一条都值得看"。若清单里长期挂着若干**已确认不是问题**的条目，
 * 人就会整体忽略这份清单 —— 那比没有审计更糟（与残留审计 §19.6 同一教训）。
 * 所以把**逐个核实过**的例外写进 `EXEMPTIONS`，并在条目里保留理由；
 * 新增例外必须写清理由，不许只写"豁免"两个字。
 *
 * 2026-10-17 修正的两类**误报**（不是豁免，是规则写错）：
 *   · ④ 原先只要 FilterBar 里有 `<Button>` 就报 —— 实测 9 处**全是「导出 Excel」**，
 *     而规范原文就是「筛选 + 只读工具（刷新/导出）」。现只报**写语义**按钮。
 *   · ⑧ 原先把 `pages/` 下的 `.spec.ts` 也算进 500 行 —— 9 处里 **8 处是测试文件**。
 *
 * 用法：npx tsx scripts/audit-ui-consistency.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 已确认的例外。键 = 文件相对路径（`client/src/...`），值 = 该文件被豁免的规则编号与理由。
 *
 * 判定要求：**每条都必须能说清"为什么规范在这里不适用"**，
 * 而不是"暂时没空改"。理由写不出来的，就不是例外，该改。
 */
const EXEMPTIONS = {
  'client/src/components/excel/ExcelImportDialog.tsx': {
    rules: ['⑦'],
    reason:
      'Excel 导入**预览**表不是数据表（无分页/排序/固定列需求，行数受导入文件限制），' +
      '`AGENTS.md` 明文把"Excel 导入预览"列为 shadcn `<Table>` 的允许场景之一。',
  },
  'client/src/pages/costs/TimesheetsTab.tsx': {
    rules: ['⑧'],
    reason:
      '531 行（门槛 500）。§5.9 的收益判据要求"有可抽出的纯逻辑"，' +
      '而该文件已抽走 `timesheet-form.ts`（10 条断言），剩余部分是表格列定义 + 弹窗编排，' +
      '无纯逻辑可再抽；再拆只会把同一屏的状态切碎。详见该文件头注释。',
  },
  'client/src/pages/login/LoginPage.tsx': {
    rules: ['②', '③', '⑨'],
    reason:
      '登录页是**全屏独立页**（无侧边栏、无顶栏、无面包屑），' +
      '不使用 `PageShell` 是刻意的：套上会强制出现页面外壳与该页版式冲突。' +
      '`p-6` 与自定义标题字号是全屏版式的一部分，同属该例外。',
  },
};

const ROOT = 'client/src';
const rows = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(full)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);

/** 页面主文件：pages/<域>/XxxPage.tsx（不含 components/ 下的） */
const isPageFile = (p) =>
  /pages[\\/][^\\/]+[\\/][A-Za-z]+Page\.tsx$/.test(p) && !p.includes(`${'components'}\\`) && !p.includes('components/');

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = relative('.', f).replace(/\\/g, '/');
  const lines = src.split(/\r?\n/).length;
  const isUi = rel.includes('components/ui/');

  /* ① PageShell 但无 actions，而正文里有 Button（疑似主操作散落） */
  const usesPageShell = /<PageShell/.test(src);
  const hasActionsProp = /<PageShell[\s\S]{0,400}?actions=\{/.test(src);
  const bodyButtons = (src.match(/<Button\b/g) ?? []).length;

  /*
   * ⚠️ 这条规则的**误报**很多，实测 7 条命中里只有 4 条是真缺陷。两类合法豁免：
   *
   * a) **详情页的吸顶操作条**：详情页的状态动作是**上下文相关**的（随状态机变化、
   *    可能七八个），塞进 `PageShell.actions` 会挤成一行且位置远离内容。
   *    本仓的既有做法是在正文里放一条 `sticky top-*` 操作条
   *    （`ProjectDetailPage.tsx` 的「返回列表 / 编辑项目 / 状态动作」就是范例）。
   *    判据：出现 `sticky` + `top-` 的操作条 → 豁免。
   *
   * b) **不需要页头主操作**：页面的动作是"卡片内的字段级保存"
   *    （`SettingsPage` 每个 Card 里一个保存按钮）、或只有"导出/清空筛选/重试"
   *    这类工具动作（`AuditPage`）。这些页面本来就没有单一主操作。
   *    判据：`PageShell` 之后（即正文）没有 `<Button` → 豁免。
   */
  const hasStickyActionBar = /sticky[^"']*top-\d+[\s\S]{0,400}?<Button/.test(src);
  const buttonsAfterShell = (() => {
    const i = src.indexOf('<PageShell');
    if (i < 0) return 0;
    return (src.slice(i).match(/<Button\b/g) ?? []).length;
  })();

  /*
   * ① 的**显式豁免名单**。
   *
   * 每一条都必须写明理由 —— 豁免名单是"经过人工判断的结论"，不是"懒得修"。
   *
   * · `audit/AuditPage.tsx`：审计日志是**只读**页。它正文里的三个按钮分别是
   *   「导出 CSV」（对当前筛选结果的只读工具）、「清空筛选」（筛选复位）、
   *   「重试」（错误态按钮，正常渲染路径下不存在）。
   *   **本页没有"改变数据的主动作"**，所以 `actions` 插槽理应留空。
   *   已在浏览器实测确认：页头 actions = `[]`（正确）。
   */
  const ACTION_SLOT_EXEMPT = new Set(['client/src/pages/audit/AuditPage.tsx']);

  if (
    isPageFile(f) &&
    usesPageShell &&
    !hasActionsProp &&
    bodyButtons >= 2 &&
    !hasStickyActionBar &&
    buttonsAfterShell > 0 &&
    !ACTION_SLOT_EXEMPT.has(rel)
  ) {
    rows.push({ file: rel, kind: '① PageShell 无 actions 插槽但正文有 ≥2 个 Button', detail: `Button×${bodyButtons}`, lines });
  }

  /* ② 页面文件里手写 h1 + text-2xl（应走 PageShell 标题） */
  if (isPageFile(f) && !usesPageShell && /text-2xl font-semibold/.test(src)) {
    rows.push({ file: rel, kind: '② 手写页面标题（未走 PageShell）', detail: '', lines });
  }

  /* ③ 页面文件手写 p-6 + gap-6 根容器 */
  if (isPageFile(f) && !usesPageShell && /className="[^"]*\bp-6\b[^"]*"/.test(src)) {
    rows.push({ file: rel, kind: '③ 手写 p-6 根容器（应交给 PageShell）', detail: '', lines });
  }

  /*
   * ④ FilterBar 内混入**写操作** Button。
   *
   * ⚠️ 2026-10-17 修正误报：原先只要 FilterBar 里出现 `<Button>` 就报，
   * 实测报出的 9 处**全部是「导出 Excel」**（另有「刷新」「重置」）。
   * 而规范原文是「FilterBar 承载**筛选 + 只读工具**（刷新/导出）」——
   * 也就是说这些按钮**本来就该在这里**。
   *
   * 一条永远报 9 个误报的规则会被忽略，比没有规则更糟（与残留审计同一个教训）。
   * 现在只报**写语义**的按钮：新建/新增/提交/审批/删除/确认/保存/作废/导入/生成…
   */
  const fb = src.match(/<FilterBar[\s\S]*?<\/FilterBar>/g) ?? [];
  const WRITE_ACTION_RE = /新建|新增|创建|提交|审批|审核|删除|移除|作废|确认|保存|导入|生成|登记|发起|上报|一键|转合同|转项目/;
  const offending = fb
    .flatMap((block) => block.match(/<Button[\s\S]*?<\/Button>/g) ?? [])
    .filter((btn) => WRITE_ACTION_RE.test(btn));
  if (offending.length > 0) {
    const first = (offending[0].replace(/\s+/g, ' ').match(/>([^<>]{1,14})</) ?? [, '?'])[1].trim();
    rows.push({
      file: rel,
      kind: '④ FilterBar 内混入写操作 Button（筛选区应只放筛选 + 只读工具）',
      detail: `${offending.length} 个，首个「${first}」`,
      lines,
    });
  }

  /*
   * ⑤ Card 嵌套 Card（`AGENTS.md`：Card 禁止嵌套 Card）
   *
   * ⚠️ 这里必须做**真正的标签配对**，不能用 `/<Card[\s\S]{0,600}?<Card/`：
   * 那个正则会把「同一层级的连续两张 Card」判成嵌套 —— 详情页极常见
   * （概览卡、明细卡、附件卡一字排开），实测 24 条命中里**24 条全是误报**。
   * 现在用标签栈跟踪深度：只有第二张 Card 落在第一张的**子树**里才算违规。
   * 自闭合 `<Card />` 与 `CardHeader/CardContent/...` 不参与深度计算。
   * 完整的独立校验见 `scripts/audit-card-nesting.mjs`。
   */
  {
    const re = /<\/?Card(?=[\s/>])/g;
    let depth = 0;
    let m2;
    let nested = 0;
    while ((m2 = re.exec(src)) !== null) {
      if (m2[0].startsWith('</')) {
        if (depth > 0) depth -= 1;
      } else {
        const gt = src.indexOf('>', m2.index);
        const selfClosing = gt > 0 && src[gt - 1] === '/';
        if (depth >= 1) nested += 1;
        if (!selfClosing) depth += 1;
      }
    }
    if (nested > 0) {
      rows.push({ file: rel, kind: '⑤ Card 嵌套 Card（规范禁止）', detail: `嵌套 ${nested} 处`, lines });
    }
  }

  /* ⑥ 裸写十六进制色值（排除 ui/ 原子组件与 tokens/theme） */
  if (!isUi && !rel.includes('theme/') && !rel.includes('tokens')) {
    const hex = src.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    // 排除注释里的（粗筛：只看非注释行）
    const codeHex = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')
      .match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    if (codeHex.length > 0 && (rel.includes('pages/') || rel.includes('charts'))) {
      rows.push({ file: rel, kind: '⑥ 裸写十六进制色值', detail: codeHex.slice(0, 4).join(','), lines });
    }
  }

  /* ⑦ 用 shadcn Table 做数据表 */
  if (/from '@\/components\/ui\/table'|from '@client\/src\/components\/ui\/table'/.test(src) && !isUi) {
    rows.push({ file: rel, kind: '⑦ 引用了 shadcn ui/table（数据表应一律 antd）', detail: '', lines });
  }

  /*
   * ⑧ 超 500 行（§5.9 拆分门槛）。
   *
   * ⚠️ 2026-10-17 修正误报：`rel.includes('pages/')` 会把 `pages/` 下的
   * **`.spec.ts`** 也算进来，于是 9 处里有 **8 处是测试文件**
   * （`ar-ap-model.spec.ts` 904 行、`contract-detail-model.spec.ts` 806 行…）。
   * §5.9 的 500 行门槛针对的是**页面/组件主文件** —— 测试文件行数多不是问题，
   * 一条要靠"忽略 8 个 spec"才能看的清单，实际上等于没有清单。
   */
  const isSpec = /\.spec\.tsx?$/.test(rel);
  if (!isUi && !isSpec && lines > 500 && rel.includes('pages/')) {
    rows.push({ file: rel, kind: '⑧ 超过 500 行（§5.9 拆分门槛）', detail: `${lines} 行`, lines });
  }

  /* ⑨ 偏离规范的标题字号 */
  const odd = src.match(/text-\[\d+px\]/g) ?? [];
  if (isPageFile(f) && odd.length > 0) {
    rows.push({ file: rel, kind: '⑨ 非规范字号（text-[Npx]）', detail: [...new Set(odd)].join(','), lines });
  }
}

/* ── 汇总 ── */
/* 套用已确认例外：把豁免掉的规则从条目里去掉；全部命中的条目整条移除 */
const exempted = [];
const remaining = [];
for (const r of rows) {
  const ex = EXEMPTIONS[r.file.replace(/\\/g, '/')];
  const rule = r.kind.slice(0, 1);
  if (ex && ex.rules.includes(rule)) {
    exempted.push({ ...r, reason: ex.reason });
    continue;
  }
  remaining.push(r);
}

const byKind = {};
for (const r of remaining) (byKind[r.kind] ??= []).push(r);

console.log('=== UI 结构一致性审计 ===\n');
for (const [kind, list] of Object.entries(byKind).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${kind}  —— ${list.length} 处`);
  for (const r of list.slice(0, 12)) console.log(`    ${r.file}${r.detail ? '   ' + r.detail : ''}`);
  if (list.length > 12) console.log(`    … 另有 ${list.length - 12} 处`);
  console.log('');
}
console.log(`合计可疑点: ${remaining.length}`);
if (remaining.length === 0) {
  console.log('\n✓ 无待处理项：所有命中都已是**已确认例外**（理由见脚本内 `EXEMPTIONS`）。');
} else {
  console.log('\n注意：②③④⑤⑥⑦ 是启发式匹配（正则），可能有误报；');
  console.log('每一条都要打开文件确认后再改 —— 这份清单用于**定位**，不是用于直接批量替换。');
}

/* 例外单独列出，避免"隐形的绿"：让人能一眼看到豁免了哪些、为什么 */
if (exempted.length > 0) {
  console.log(`\n─ 已确认例外（不计入合计）: ${exempted.length} 条 ─`);
  for (const e of exempted) {
    console.log(`  ${e.kind.slice(0, 1)} ${e.file}${e.detail ? '   ' + e.detail : ''}`);
    console.log(`     理由：${e.reason}`);
  }
}
