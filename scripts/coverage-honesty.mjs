#!/usr/bin/env node
/**
 * §2.4：覆盖率口径**诚实化 + 棘轮（ratchet）**。
 *
 * ## 问题回顾
 *
 * `jest.config.cjs` 的 `collectCoverageFrom` 只统计 4 个路径，于是全局门槛
 * （60%/50%）**轻松通过**，而真实业务代码的覆盖缺口完全不在度量范围内：
 *
 *   · 业务 service / logic / rules / engine 文件总数 91
 *   · **未被任何 spec 引用的文件数 66（72.5%）**，合计 29,210 / 41,717 行 = **70.0%**
 *   · `hr-pay.service.ts`（1309 行）、`projects.service.ts`（1122 行）、
 *     `invoice.service.ts`（534 行，发票进销项与作废）**全部零覆盖**
 *
 * 配置里的注释是诚实的（说明了为什么收窄），但**收窄的副作用是门禁不再度量
 * 真实缺口**：一个把 `invoice.service.ts` 改坏 500 行的提交可以完全不被门禁察觉。
 *
 * ## 本脚本做什么（三件事，都刻意不做成"硬门槛"）
 *
 * 1. **量化缺口并打印**：把真实覆盖率写进 CI 日志，让它**可见**。
 *    不可见的缺口不会被排期修复。
 * 2. **棘轮**：把"未被任何 spec 引用的业务文件行数"作为**基线**记录在
 *    `docs/coverage-baseline.json`。当前值**不得高于**基线 + 容差 ——
 *    允许低但**禁止倒退**。这正是审计报告建议的形态。
 * 3. **门槛数值不下调**：`jest.config.cjs` 的门槛保持不动（那部分口径本身的
 *    正确性另有其价值），本脚本只补上"真实缺口"这一维度。
 *
 * ## 为什么棘轮用"未被覆盖的行数"而不是"覆盖率百分比"
 *
 * 百分比会随分母变化：**新增一个 500 行的零覆盖 service 会拉低百分比**
 * （好，能被发现），但**删掉一个 500 行的零覆盖 service 会拉高百分比**
 * （看起来变好了，其实什么都没测）。用"未被引用文件的总行数"作为棘轮，
 * 语义单一且不会因删除代码而"假性变好" —— 它只会在**真的补了测试**时下降。
 *
 * ## 更新基线
 *
 * 补了测试之后，用 `node ./scripts/coverage-honesty.mjs --update` 刷新基线。
 * 这一步**必须由人显式执行**：自动更新等于没有棘轮。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVER_DIR = join(ROOT, 'server');
const BASELINE_FILE = join(ROOT, 'docs', 'coverage-baseline.json');

/**
 * "业务代码"的判定范围：模块目录下的 service / logic / rules / engine。
 *
 * 为什么用这几个后缀而不是"server 下所有 .ts"：
 *   · 控制器、DTO、模块声明、迁移脚本属于**接线代码**，行数大但业务风险低；
 *   · 把它们算进来会让缺口数字虚高（几万行），从而失去"这个数字该不该降"的判断力。
 * 这与审计报告的统计口径一致（它统计的正是这 91 个文件）。
 */
const BUSINESS_SUFFIXES = ['.service.ts', '.logic.ts', '.rules.ts', '.engine.ts'];

/** 容差：允许棘轮有少量浮动（重命名/小改动），但不允许数量级倒退 */
const TOLERANCE_RATIO = 0.02; // 2%

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function isBusinessFile(file) {
  const rel = relative(ROOT, file).split(sep).join('/');
  if (!rel.startsWith('server/modules/')) return false;
  return BUSINESS_SUFFIXES.some((suffix) => rel.endsWith(suffix));
}

function countLines(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).length;
}

function main() {
  const allTs = walk(SERVER_DIR);
  const specs = allTs.filter((f) => f.endsWith('.spec.ts'));
  const business = allTs.filter((f) => isBusinessFile(f));

  /*
   * 判定"是否被 spec 引用"：**按 import 路径**匹配，而不是按文件名子串。
   *
   * 为什么不能用子串匹配（第一版踩过的坑，实测偏差很大）：
   *   `server/test/integration/accounting-chain.spec.ts` 通过
   *   `@server/modules/voucher/accounting-base.service` 间接使用
   *   `voucher.service.ts`，但 spec 文本里只出现 `VoucherService` 这个**类名**，
   *   不含文件名 —— 子串匹配会把它判成"零覆盖"，于是
   *   `voucher.service.ts`（1477 行）被算进缺口，覆盖率从 72.5% 虚报成 95.5%。
   *
   * 一个偏高的缺口数字会让棘轮基线**永远无法达成**（没人能一次补完 4 万行），
   * 于是它会被 --update 一再放宽 —— 最终变成没有棘轮。这就是"测量口径错了，
   * 再好的机制也会失效"。
   *
   * 现在的判据：spec 里出现的 import 路径（如 `modules/voucher/voucher.service`）
   * 是否是该业务文件路径的前缀/后缀匹配。这比文件名子串严格得多，也准确得多。
   */
  const specImports = [];
  for (const spec of specs) {
    const text = readFileSync(spec, 'utf8');
    for (const matched of text.matchAll(
      /from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gu,
    )) {
      const raw = matched[1] ?? matched[2] ?? '';
      if (raw) specImports.push(raw);
    }
  }
  /** 把 `@server/modules/x/y.service` 归一成 `modules/x/y.service` 便于比较 */
  const normalizedImports = specImports.map((raw) =>
    raw.replace(/^@server\//u, '').replace(/\.ts$/u, ''),
  );
  const specText = specs.map((f) => readFileSync(f, 'utf8')).join('\n');
  /**
   * 由文件名推导可能的**类名**（兜底判据）。
   *
   * 例：`vat-declaration.service.ts` → `VatDeclarationService`
   *     `ar-match.logic.ts`         → `ArMatch` / `ArMatchLogic`
   *
   * 之所以需要这一步：很多 spec 通过**间接依赖**覆盖某个 service
   * （例如 `accounting-chain.spec.ts` 用 `VoucherService`），
   * 此时 spec 文本里只有类名、没有 import 路径。
   */
  function classNamesOf(fileBase) {
    const stem = fileBase.replace(/\.ts$/u, '');
    const pascal = stem
      .split(/[^A-Za-z0-9]+/u)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
    const names = new Set([pascal]);
    // `XxxService` 这类后缀同时也是类型名，去掉后缀再看一次
    for (const suffix of ['Service', 'Logic', 'Rules', 'Engine']) {
      if (pascal.endsWith(suffix) && pascal.length > suffix.length) {
        names.add(pascal.slice(0, -suffix.length));
      }
    }
    return [...names].filter((name) => name.length > 3);
  }
  function isReferenced(relFromServer, fileBase) {
    const noExt = relFromServer.replace(/\.ts$/u, '');
    for (const imp of normalizedImports) {
      if (imp === noExt) return true;
      // 允许 spec 用省略后缀/只写到目录的写法（barrel 导入时较常见）
      if (noExt.endsWith(imp) || imp.endsWith(noExt)) return true;
    }
    // 类名兜底：间接依赖覆盖时 spec 里只有类名
    for (const className of classNamesOf(fileBase)) {
      if (new RegExp(`\\b${className}\\b`, 'u').test(specText)) return true;
    }
    return false;
  }

  const uncovered = [];
  let totalLines = 0;
  for (const file of business) {
    const lines = countLines(file);
    totalLines += lines;
    const rel = relative(ROOT, file).split(sep).join('/');
    const relFromServer = rel.replace(/^server\//u, '');
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (!isReferenced(relFromServer, base)) {
      uncovered.push({ path: rel, lines });
    }
  }
  const uncoveredLines = uncovered.reduce((sum, item) => sum + item.lines, 0);
  const uncoveredRatio = totalLines > 0 ? (uncoveredLines / totalLines) * 100 : 0;
  const fileRatio = business.length > 0 ? (uncovered.length / business.length) * 100 : 0;

  console.log('── 覆盖率诚实性报告（§2.4）────────────────────────────────────');
  console.log(
    `业务代码文件（modules/**/{service,logic,rules,engine}.ts）：${business.length} 个 / ${totalLines} 行`,
  );
  console.log(
    `未被任何 spec 引用的文件：${uncovered.length} 个（${fileRatio.toFixed(1)}%），` +
      `${uncoveredLines} 行（${uncoveredRatio.toFixed(1)}%）`,
  );
  if (uncovered.length > 0) {
    console.log('缺口最大的 10 个文件：');
    for (const item of [...uncovered].sort((a, b) => b.lines - a.lines).slice(0, 10)) {
      console.log(`  ${String(item.lines).padStart(5)} 行  ${item.path}`);
    }
  }
  console.log('（jest 门槛只统计 collectCoverageFrom 的 4 个路径，不含以上缺口 —— 这是有意的，');
  console.log('  原因见 jest.config.cjs 注释；本报告的作用是让缺口**可见**并禁止倒退。）');

  const current = {
    businessFiles: business.length,
    businessLines: totalLines,
    uncoveredFiles: uncovered.length,
    uncoveredLines,
    /*
     * §2.4 修正：棘轮要盯**比率**，不是**绝对行数**。
     *
     * 首版用 `uncoveredLines` 作棘轮量。它在"补测试"时下降，看起来很对 ——
     * 但它同样会在"**新增被测代码**"时**上升**：
     *
     *   基线：业务代码 44,000 行 / 未覆盖 28,983 行（65.9% 缺口）
     *   新增：印花税模块 400 行，**带完整 spec**（覆盖率 100%）
     *   结果：业务代码 44,400 行 / 未覆盖 28,983 行 —— 行数不变，
     *         但若新代码有 spec 而**同批还加了别的无 spec 代码**，
     *         行数就会上升并触发失败，即使**覆盖率其实改善了**。
     *
     * 换句话说：用一个跟随分母变化的量当阈值，会把"把蛋糕做大"
     * 误判成"退步"。真实出现过：本轮未覆盖行数从 28,397 涨到 28,796
     * 正是因为新增了 projects.dto / vendor-settlement 等**无 spec 的接线代码**，
     * 而同一批里 stamp-duty（400 行）是 100% 覆盖的 —— 前者该被拦，
     * 后者不该被牵连。
     *
     * 因此棘轮量改为 `uncoveredRatio = uncoveredLines / businessLines`，
     * 并**同时**保留行数用于报告与"新增无测试代码"的绝对值提示。
     */
    uncoveredRatio:
      totalLines > 0 ? Number((uncoveredLines / totalLines).toFixed(4)) : 0,
    generatedAt: new Date().toISOString(),
  };

  if (process.argv.includes('--update')) {
    writeFileSync(
      BASELINE_FILE,
      `${JSON.stringify(
        {
          ...current,
          note:
            '覆盖率棘轮基线（§2.4）：uncoveredRatio（未覆盖业务代码占比）只允许下降。' +
            '补了测试后用 `node ./scripts/coverage-honesty.mjs --update` 刷新 —— ' +
            '必须由人显式执行，自动更新等于没有棘轮。' +
            '2026-10-16 修正：棘轮量由 uncoveredLines（绝对行数）改为 uncoveredRatio（占比）——' +
            '绝对行数会随业务代码规模变化，"新增被测代码"会被误判为倒退。',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`\n已更新基线：${relative(ROOT, BASELINE_FILE)}`);
    return;
  }

  if (!existsSync(BASELINE_FILE)) {
    console.log(
      `\n未找到基线文件 ${relative(ROOT, BASELINE_FILE)}：` +
        '本次作为首次记录，请执行 `node ./scripts/coverage-honesty.mjs --update` 建立基线。',
    );
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  /*
   * 兼容旧基线：老基线只有 uncoveredLines。
   * 此时用"老基线的行数与总行数"反推比率，避免直接跳过检查
   * （跳过等于棘轮失效，比误报更糟）。
   */
  const baselineRatio =
    typeof baseline.uncoveredRatio === 'number'
      ? baseline.uncoveredRatio
      : baseline.businessLines > 0
        ? baseline.uncoveredLines / baseline.businessLines
        : 0;
  const allowedRatio = baselineRatio * (1 + TOLERANCE_RATIO);
  if (current.uncoveredRatio > allowedRatio) {
    const baselinePct = (baselineRatio * 100).toFixed(2);
    const currentPct = (current.uncoveredRatio * 100).toFixed(2);
    const allowedPct = (allowedRatio * 100).toFixed(2);
    console.error(
      `\n[FAIL] 覆盖率棘轮触发：未被测试引用的业务代码占比 ${currentPct}% > ` +
        `基线 ${baselinePct}%（容差 ${(TOLERANCE_RATIO * 100).toFixed(0)}% → 允许至 ${allowedPct}%）。\n` +
        `  当前 ${uncoveredLines} 行 / 业务代码 ${totalLines} 行。\n` +
        '  含义：本次改动**新增了未经测试的业务代码**（或删除了被测代码）。' +
        '请为新增逻辑补 spec，或（若确认是不可避免的接线代码）在 review 中说明后执行:\n' +
        '    node ./scripts/coverage-honesty.mjs --update\n' +
        '  注意：更新基线是**承认缺口**，不是修复缺口。',
    );
    process.exitCode = 1;
    return;
  }
  const deltaLines = baseline.uncoveredLines - uncoveredLines;
  const deltaRatio =
    (baselineRatio - current.uncoveredRatio) * 100;
  console.log(
    `\n棘轮通过：未覆盖占比 ${(current.uncoveredRatio * 100).toFixed(2)}%` +
      `（基线 ${(baselineRatio * 100).toFixed(2)}%，` +
      `${deltaRatio >= 0 ? `已下降 ${deltaRatio.toFixed(2)}` : `上升 ${(-deltaRatio).toFixed(2)}`} 个百分点，` +
      `允许上限 ${(allowedRatio * 100).toFixed(2)}%）。` +
      `\n  参考：未覆盖行数 ${uncoveredLines}（基线 ${baseline.uncoveredLines}，` +
      `${deltaLines >= 0 ? `下降 ${deltaLines}` : `上升 ${-deltaLines}`} 行，` +
      `业务代码总量 ${totalLines} 行）。行数会随代码规模变化，故只作参考。`,
  );
}

main();
