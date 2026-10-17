#!/usr/bin/env node
/**
 * 前端产物体积棘轮（审计 §5.10 / P2-10）。
 *
 * ## 为什么需要它
 *
 * 审计指出「**无 bundle 体积基线**」：`manualChunks` 未为
 * `lucide-react`（4.01 MB 源码 / 120 文件引用）、`echarts-for-react`、
 * `zod`、`dayjs` 等划分，因此**体积回归无法被发现**。
 *
 * 本仓已经吃过一次体积的亏（F10：`exceljs` 909 KB 被三个高频列表页静态引入，
 * 打开"客户列表"就要下载整个 Excel 引擎）。那次是靠人工审计抓出来的 ——
 * 而"某次改动 import 了一个大包"这种事，typecheck、lint、1067 个单测
 * **一个都看不见**。体积是唯一能拦住它的信号。
 *
 * ## 设计：棘轮（ratchet），不是阈值
 *
 * 不写"总积必须 < X MB"这种绝对阈值 —— 那种阈值要么松到没用，要么在
 * 正常加功能时天天误报，最后被人调高到没用。这里用**棘轮**：
 *
 *   · 首次运行（无基线）→ 写入 `docs/bundle-baseline.json` 并通过；
 *   · 之后每次 → 与基线逐 chunk 比较，**变大超过容差即失败**；
 *   · 变小 → 自动收紧基线（把基线改成更小的值），使改进被固化，
 *     而不是"降下去又涨回来"。
 *
 * 容差按"体积 + 百分比"取较大者，避免几百字节的正常波动造成噪音：
 *   · 每 chunk 允许 `max(2 KB, 基线的 2%)`；
 *   · 总允许 `max(50 KB, 基线的 2%)`。
 *
 * ## 已知不覆盖（诚实标注）
 *
 * · **不检查"为什么变大"** —— 它只报警，定位仍需人工（或用
 *   `rollup-plugin-visualizer` 出一张 treemap；本门禁不引入该依赖）。
 * · **不检查运行时性能**（首屏 TTI、内存）—— 只测字节数。
 * · **不检查 CSS 之外的静态资源**（图片/字体）—— 只看 `dist/client/assets/*.js`。
 * · **chunk 命名带 hash**，因此按 **文件名去掉 hash** 归并：同名 chunk 的
 *   多个历史 hash 视为同一个逻辑 chunk。若某次改动导致 chunk 被拆分/合并，
 *   会表现为"旧 chunk 消失 + 新 chunk 出现"，此时脚本会提示需要人工确认，
 *   而不是静默通过。
 *
 * ## 用法
 *
 * ```bash
 * npm run build          # 必须先构建
 * node scripts/check-bundle-size.mjs
 * ```
 *
 * 体积确实该涨时，**明确地**更新基线（而不是删掉门禁）：
 * ```bash
 * node scripts/check-bundle-size.mjs --update
 * ```
 * 该命令会把新的体积写回基线，并在控制台打印出 diff 供提交时审阅。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const ASSETS = join(ROOT, 'dist', 'client', 'assets');
const BASELINE = join(ROOT, 'docs', 'bundle-baseline.json');
const UPDATE = process.argv.includes('--update');

/** 每 chunk 的容差：字节或百分比取较大者 */
const CHUNK_ABS_TOLERANCE = 2 * 1024;
const CHUNK_PCT_TOLERANCE = 0.02;
/** 总体的容差 */
const TOTAL_ABS_TOLERANCE = 50 * 1024;
const TOTAL_PCT_TOLERANCE = 0.02;

if (!existsSync(ASSETS)) {
  console.error(
    `[FAIL] 未找到构建产物目录：${relative(ROOT, ASSETS)}\n` +
      '请先运行 `npm run build`，再运行本门禁。',
  );
  process.exit(1);
}

/**
 * 读取产物并按"逻辑 chunk 名"归并。
 *
 * Vite 产物形如 `index-PQ0zuSJv.js` / `antd-CBe2hxTC.js`；
 * hash 是 8 位 base64url 风格字符。去掉它之后同名归并，
 * 使"同一次改动导致的 hash 变化"不被误判为体积变化。
 */
function logicalName(fileName) {
  return fileName.replace(/-[A-Za-z0-9_-]{8}\.js$/u, '.js');
}

const sizes = new Map();
let total = 0;
for (const entry of readdirSync(ASSETS)) {
  if (!entry.endsWith('.js')) continue;
  const full = join(ASSETS, entry);
  if (!statSync(full).isFile()) continue;
  const key = logicalName(entry);
  const bytes = statSync(full).size;
  /*
   * total 必须按**实际文件**求和：26 个 `index-<hash>.js` 去掉 hash 后
   * 同名归并成一个 key，只取 max 会把 4,429 KB 的真实产物误报成 3,826 KB
   * （P2-27）。逐 chunk 仍按逻辑名比较，避免 hash 变化造成噪音。
   */
  total += bytes;
  // 同名归并时取最大值（正常只有一个，防御性写法）
  sizes.set(key, Math.max(sizes.get(key) ?? 0, bytes));
}
const current = {
  totalBytes: total,
  chunks: Object.fromEntries([...sizes.entries()].sort((a, b) => b[1] - a[1])),
};

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/** 首次运行：写基线 */
if (!existsSync(BASELINE) || UPDATE) {
  const previous = existsSync(BASELINE)
    ? JSON.parse(readFileSync(BASELINE, 'utf8'))
    : null;
  writeFileSync(
    BASELINE,
    `${JSON.stringify(current, null, 2)}\n`,
    'utf8',
  );
  console.log(
    previous
      ? `体积极线已更新（--update）：总计 ${kb(previous.totalBytes)} → ${kb(total)}`
      : `体积极线已建立：总计 ${kb(total)}，共 ${sizes.size} 个 chunk`,
  );
  if (previous) {
    for (const [name, bytes] of Object.entries(current.chunks)) {
      const before = previous.chunks[name] ?? 0;
      const delta = bytes - before;
      if (Math.abs(delta) > CHUNK_ABS_TOLERANCE) {
        console.log(`  ${delta > 0 ? '+' : ''}${kb(delta).replace(' KB', '')} KB  ${name}`);
      }
    }
    for (const name of Object.keys(previous.chunks)) {
      if (!(name in current.chunks)) console.log(`  (消失)  ${name}`);
    }
  }
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const problems = [];

/** ① 逐 chunk 比较 */
for (const [name, bytes] of Object.entries(current.chunks)) {
  const before = baseline.chunks[name];
  if (before === undefined) {
    // 新 chunk：只有大到值得注意才提示（小 chunk 是拆分产物，正常）
    if (bytes > 100 * 1024) {
      problems.push({
        kind: 'new-large-chunk',
        name,
        detail: `新增了 ${kb(bytes)} 的 chunk（基线中没有）`,
      });
    }
    continue;
  }
  const delta = bytes - before;
  const allowance = Math.max(
    CHUNK_ABS_TOLERANCE,
    before * CHUNK_PCT_TOLERANCE,
  );
  if (delta > allowance) {
    problems.push({
      kind: 'chunk-grown',
      name,
      detail: `${kb(before)} → ${kb(bytes)}（+${kb(delta)}，超出容差 ${kb(allowance)}）`,
    });
  }
}

/** ② 总体比较 */
const totalDelta = total - baseline.totalBytes;
const totalAllowance = Math.max(
  TOTAL_ABS_TOLERANCE,
  baseline.totalBytes * TOTAL_PCT_TOLERANCE,
);
if (totalDelta > totalAllowance) {
  problems.push({
    kind: 'total-grown',
    name: '(总计)',
    detail: `${kb(baseline.totalBytes)} → ${kb(total)}（+${kb(totalDelta)}，超出容差 ${kb(totalAllowance)}）`,
  });
}

/**
 * ③ 棘轮收紧：有 chunk 变小就固化下来。
 *
 * 只收紧**变小**的部分（`totalBytes` 取新值），使改进不被回吐；
 * 但**不**在失败时写盘 —— 失败要人来决定。
 */
if (problems.length === 0) {
  if (total < baseline.totalBytes) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    console.log(
      `棘轮收紧：总计 ${kb(baseline.totalBytes)} → ${kb(total)}（下降 ${kb(baseline.totalBytes - total)}，已写入基线）`,
    );
  }
  console.log(
    `产物体积棘轮通过：总计 ${kb(total)}，共 ${sizes.size} 个 chunk` +
      `（基线 ${kb(baseline.totalBytes)}）`,
  );
  process.exit(0);
}

console.error(`\n[FAIL] 前端产物体积回归（${problems.length} 处）：\n`);
for (const p of problems) {
  console.error(`  · ${p.name}`);
  console.error(`      ${p.detail}`);
}
console.error(
  '\n为什么这个门禁存在：typecheck、lint 与单元测试**都看不见体积**。\n' +
    '本仓已经吃过一次亏（F10：exceljs 909 KB 被三个高频列表页静态引入，\n' +
    '打开"客户列表"就要下载整个 Excel 引擎），那次全靠人工审计才抓到。\n' +
    '\n处理方式（按优先级）：\n' +
    '  ① 该依赖是否只在某个交互后才需要？→ 改**动态 import**\n' +
    '     （范例：`components/excel/excel-utils.ts` 把 exceljs 改成函数内 `await import`）；\n' +
    '  ② 是否本该懒加载的整页/整组件被静态引入了？→ 检查是否漏了 `lazy()`；\n' +
    '  ③ 确实是合理的体积增长 → 用 `node scripts/check-bundle-size.mjs --update`\n' +
    '     **明确地**更新基线（会在控制台打印逐 chunk diff 供审阅），\n' +
    '     而**不是**删除本门禁或调大容差。\n' +
    '\n定位工具：`npx vite-bundle-visualizer`（本仓不预装该依赖）可出一张 treemap。',
);
process.exit(1);
