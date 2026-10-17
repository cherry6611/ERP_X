#!/usr/bin/env node
/**
 * 业务时区门禁：客户端**不得**用浏览器本地时区解释"此刻"。
 *
 * ## 这个门禁要拦的是什么
 *
 * 服务端的期间闸门（`assertPeriodOpen` / `assertFiscalYearOpen`）与全部报表口径
 * 都按 `Asia/Shanghai`。客户端若用本地时区算"今天 / 本月 / 本年"，跨时区用户
 * 会在时间窗口内与服务端落在不同期间。
 *
 * 本仓**实际发生过三次**（都在 F8 拆分时发现）：
 *
 * | 位置 | 写法 | 后果 |
 * |---|---|---|
 * | `ApTab.tsx` | `new Date(y, m - i, 1)` | 上海已 11-01 而本地还是 10-31 → **当前月不在下拉选项里**，无法做本月外协结算 |
 * | `AttendancePanel.tsx` | `new Date().getFullYear()` → `initLeaveBalances(year)` | 元旦前后传错年份 → 给**已过去的年份**建年假余额，正确年份仍为空 → 员工请假报「余额记录不存在」，且脏行需人工清理 |
 * | `FullBudgetPanel.tsx` | `new Date().getFullYear()` | 预算页默认年份查不到数据 |
 *
 * 共同点：**只在跨时区 + 特定时刻出现**（元旦/月初/月末），一年只发生一两次，
 * 人工测试几乎不可能覆盖 —— 这类缺陷必须靠静态门禁拦。
 *
 * ## 判据（只拦危险的，放行正确的）
 *
 * **拦**：`new Date().getXxx()` / `Date.now()` 参与**生成业务日期**——
 * 即在"此刻"上取年月日。
 *
 * **放行**（有意，且这三处已被人工确认正确）：
 *
 * ```ts
 * // 用户从日期选择器**选**的某一天 → 本地日历日才是正确语义。
 * // 若改成上海时区，纽约用户选 10-16 会被存成 10-17（日历日位移）。
 * const toLocalDate = (date: Date): string => {
 *   const y = date.getFullYear();   // ← 参数是用户选的 Date，不是"此刻"
 *   ...
 * };
 * ```
 *
 * 判据是**数据来源**而不是写法：`date.getFullYear()`（有参数）看的是"用户选的那天"，
 * `new Date().getFullYear()`（无参数）看的是"现在"。
 * 后者必须走 `utils/format.ts` 的 `todayIso` / `currentPeriod` / `currentBizYear`
 * / `recentPeriods`（它们统一用 `Intl` 指定 `Asia/Shanghai`）。
 *
 * ## 已知不覆盖（诚实标注，避免被当成"全查过了"）
 *
 * · `const now = new Date()` 之后再 `now.getFullYear()` —— 变量式写法本门禁抓不到。
 *   本仓当前没有这种写法；若将来出现，应扩展本检查器而不是靠人记。
 * · `dayjs()` / `moment()` 无参调用取当下 —— 同上，当前未出现。
 * · `Intl.DateTimeFormat` 未指定 `timeZone` —— 那会走本地时区，但写法与
 *   `todayIso` 高度相似，改动时更容易被 review 发现。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const CLIENT_SRC = join(ROOT, 'client', 'src');

/**
 * 危险写法：在**此刻**上取本地年月日。
 *
 * 刻意用精确的字面量模式而不是"任何 `.getFullYear()`" ——
 * 后者会把 `toLocalDate(date)` 这类**正确**用法一起报掉，
 * 而误报会让人开始给检查器加豁免，最终等于没有检查器。
 */
const DANGEROUS = [
  {
    re: /new\s+Date\(\)\s*\.\s*get(FullYear|Month|Date|Day|Hours)\s*\(/u,
    why: '在"此刻"上取浏览器本地时间的字段',
  },
  {
    re: /Date\.now\(\)\s*[-+]\s*[\d_]/u,
    why: '对 Date.now() 做数值算术得到业务日期（本地时区毫秒）',
  },
];

/** 允许出现的地方：统一时区口径的实现本身 */
const ALLOWED_FILES = new Set([
  // 这里就是"统一时区口径"的实现处，`new Date()` 是它的输入
  'client/src/utils/format.ts',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(CLIENT_SRC);
const problems = [];
for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/gu, '/');
  if (ALLOWED_FILES.has(rel)) continue;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // 跳过注释行（说明文字里出现这些写法是正常的）
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    for (const { re, why } of DANGEROUS) {
      if (re.test(line)) {
        problems.push({ file: rel, line: i + 1, text: trimmed, why });
      }
    }
  }
}

console.log(
  `业务时区门禁：扫描 ${files.length} 个客户端文件，` +
    `命中"本地时区取此刻"${problems.length} 处`,
);

if (problems.length > 0) {
  console.error(
    `\n[FAIL] ${problems.length} 处用浏览器本地时区解释"此刻"（服务端口径是 Asia/Shanghai）：\n`,
  );
  for (const p of problems) {
    console.error(`  · ${p.file}:${p.line}  （${p.why}）`);
    console.error(`      ${p.text}`);
  }
  console.error(
    `\n请改用 \`@client/src/utils/format\` 的统一时区口径：\n` +
      `  · 今天      → todayIso()\n` +
      `  · 本月      → currentPeriod()\n` +
      `  · 本年      → currentBizYear()\n` +
      `  · 近 N 个月 → recentPeriods(n)\n` +
      `\n为什么必须这样：服务端期间闸门（assertPeriodOpen / assertFiscalYearOpen）\n` +
      `与全部报表口径都按 Asia/Shanghai，客户端用本地时区会在元旦/月初/月末的\n` +
      `时间窗内落在不同期间 —— 表现为"当前月份不在下拉选项里"或\n` +
      `"年假余额建到了错的年份"。这类缺陷一年只出现一两次，人工测试覆盖不到。\n` +
      `\n⚠️ **不要**把 \`toLocalDate(date: Date)\` 这类"把用户选的某一天格式化为\n` +
      `日历日"的写法改掉 —— 那种场景本地时区才是对的（换成上海时区会让\n` +
      `纽约用户选的 10-16 存成 10-17）。本检查器已按"有无参数"区分两者。`,
  );
  process.exit(1);
}

console.log('业务时区门禁通过：未见用本地时区取"此刻"的写法。');
