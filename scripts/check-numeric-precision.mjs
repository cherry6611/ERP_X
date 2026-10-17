#!/usr/bin/env node
/**
 * §6.4 numeric 精度门禁：**所有 numeric 列必须声明 precision/scale**。
 *
 * ## 这个门禁要拦的是什么
 *
 * PostgreSQL 的裸 `numeric`（无 precision/scale）等价于"最多 131072 位整数、
 * 16383 位小数"。看起来"最宽松 = 最安全"，实际是三个问题：
 *
 * ① **库层完全失去约束**。全仓用 `round2` 统一保留 2 位，但那是**应用层**约定：
 *    任何绕过 service 的写入（修数脚本、导入、手工 SQL）都能落 3 位小数，
 *    而凭证借贷差 1 厘、应收与回款差 1 厘，**对账时表现为"永远差一点点"**，
 *    是最难定位的一类账务问题。
 *
 * ② **语义不可见**。看 schema 分不清"这是金额（2 位）"还是"这是单价（6 位）"
 *    还是"这是百分数（2 位）"。后人加字段时会照抄邻列的档位 —— 抄错就静默截断。
 *
 * ③ **一刀切会静默毁数据**。实测：`0.0015::numeric(18,2)` = **0.00**。
 *    数据服务的单价常按"元/千次调用"计价，若把单价列也砍成 (18,2)，
 *    成本分摊会**整体归零**且不报错 —— 最坏的一类缺陷。
 *
 * ## 为什么是静态检查而不是连库检查
 *
 * 连库检查需要数据库可达（CI 里没有），而这条约束的**唯一权威**是
 * `server/database/schema.ts`（`db:generate` 从它重建基线）。
 * 直接扫 schema 源码，零依赖、毫秒级、CI 里必然能跑。
 *
 * 库侧另有一道防线的：迁移 `fix09` 末尾有"基表不得残留无精度 numeric 列"的
 * 断言 —— 但那只在跑迁移时生效。本门禁补的是**改 schema 的当下**。
 *
 * ## 误报防线
 *
 * 只认同文件内 `X: numeric("col")` 这种**没有第二个参数**的写法；
 * `numeric("col", { precision, scale })` 视为合规。
 * 不解析 `customType` 或别名封装 —— 本仓没有这类用法，
 * 真有的话应该在 AGENTS.md 里显式登记，而不是让检查器猜。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCHEMA = join(ROOT, 'server', 'database', 'schema.ts');

const source = readFileSync(SCHEMA, 'utf8');
const lines = source.split(/\r?\n/);

/** 当前所在的 pgTable（用于给出"表.列"这种可定位的报错） */
let currentTable = '(未知表)';
const offenders = [];
let numericTotal = 0;

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const tableMatch = /export const \w+ = pgTable\("([a-z_0-9]+)"/.exec(line);
  if (tableMatch) {
    currentTable = tableMatch[1];
    continue;
  }
  // 统计所有 numeric( 出现，用于报告"已声明比例"
  for (const _ of line.matchAll(/numeric\(/g)) numericTotal += 1;

  /*
   * 无精度写法：`字段: numeric("列名")` —— 右括号紧跟引号，没有第二参数。
   * 带精度写法是 `numeric("列名", { precision: .., scale: .. })`，不会匹配。
   */
  const bare = /(\w+):\s*numeric\("([a-z_0-9]+)"\)/.exec(line);
  if (bare) {
    offenders.push({
      table: currentTable,
      column: bare[2],
      tsName: bare[1],
      line: i + 1,
      text: line.trim(),
    });
  }
}

console.log(
  `numeric 精度门禁：schema.ts 共 ${numericTotal} 个 numeric 列，` +
    `无精度 ${offenders.length} 个`,
);

if (offenders.length > 0) {
  console.error(
    `\n[FAIL] ${offenders.length} 个 numeric 列未声明 precision/scale（§6.4）：\n`,
  );
  for (const o of offenders.slice(0, 40)) {
    console.error(`  · schema.ts:${o.line}  ${o.table}.${o.column}`);
    console.error(`      ${o.text}`);
  }
  if (offenders.length > 40) {
    console.error(`  …… 另有 ${offenders.length - 40} 个，已省略`);
  }
  console.error(
    `\n请按列的业务语义选档位（不要一律 (18,2)）：\n` +
      `  · 金额（人民币最小单位是分）      → numeric(18, 2)\n` +
      `  · 单价 / 费率（可能小到 0.0015）  → numeric(18, 6)\n` +
      `  · 数量 / 工时 / 面积（可能有 0.5）→ numeric(18, 6)\n` +
      `  · 百分数（税率 13.00 / 折扣 12.5）→ numeric(6, 2)\n` +
      `  · 评分 / 比例（0~1，需 4 位）     → numeric(8, 4)\n` +
      `\n⚠️ 单价与计量**不能**用 (18,2)：实测 0.0015 会被存成 0.00，\n` +
      `   成本分摊整体归零且不报错。详细论证见迁移 fix09 的文件头。`,
  );
  process.exit(1);
}

console.log(
  'numeric 精度门禁通过：所有 numeric 列均声明了 precision/scale。',
);

/* ══════════════════════════════════════════════════════════════════════════
 * 第二道：禁止在源码里内联「自行取整到 2 位」的写法
 *
 * ## 为什么加这一道
 *
 * `shared/number.ts` 在文件头明令：**不要再写 `Math.round(x * 100) / 100`**，
 * 并给出了理由 —— `Math.round` 是「向 +∞ 取整」而不是会计要求的「远离零取整」，
 * 于是**同一笔金额在计提与红冲两个方向上取整不一致**，
 * 「原凭证 + 红冲凭证」合计差 1 分，且不会抛错。
 *
 * 实测（本门禁加入前）：
 *   · `Math.round(-0.125 * 100) / 100 = -0.12`，`round2(-0.125) = -0.13`
 *   · `x + (-x)`：内联写法 **+0.01 不平**；`round2` 恒为 0 ✓
 *
 * 全仓曾有 9 份互不一致的 `round2`，统一迁移后**仍有 5 处遗漏**
 * （`hr-pay.service.ts` 2 处、`projects.service.ts`、`pur.service.ts`、
 * `quotation-file-text.ts`）—— 全部落在**账务闸门/凭证金额**上，
 * 而原来的 `check:numeric-precision` 只看 SQL schema，**扫不到**。
 * 这道扫描就是为了让同类遗漏不再发生。
 *
 * ## 误报防线（重要）
 *
 * 本仓的注释里**大量引用**这个被禁的写法（`number.ts`、`payroll-engine.ts`、
 * `return.service.ts`、`vat-surcharge.ts` 都在注释里解释"原先这里自带一份 …"）。
 * 因此必须**先剥注释再扫**，否则门禁会被自己的文档打爆（实测会报 9 处，
 * 其中 8 处是注释）。
 *
 * 测试文件（`*.spec.ts`）与 `server/test/` 豁免：那里的内联取整是**断言的辅助计算**，
 * 不参与生产金额。
 * ══════════════════════════════════════════════════════════════════════════ */
{
  const { readdirSync, statSync } = await import('node:fs');
  const { relative } = await import('node:path');

  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  };

  /** 剥掉块注释与整行注释，保持行号不变 */
  const stripsComments = (src) => {
    const out = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split(/\r?\n/)
      .map((line) => (/^\s*(\/\/|\*)/.test(line) ? ' '.repeat(line.length) : line))
      .join('\n');
    return out;
  };

  /*
   * ⚠️ 正则不能用 `[^()]*` 去跳过中间部分 —— 那样**恰好漏掉真实代码**。
   * 实测（我第一版就写错了，靠"故意植入一处违规看门禁会不会拦"才发现）：
   *   · `Math.round(product * 100) / 100`            → 命中（无内层括号，属少数情况）
   *   · `Math.round((gross - netAmount) * 100) / 100` → **漏掉**（有内层括号，属多数情况）
   * 真实违规几乎都带内层括号（在算差值/占比），所以第一版的漏报率接近 100%。
   * 改用 `[\s\S]*?` 非贪婪跨到 `* 100)`，且**逐行扫描**，不会跨行误伤。
   */
  const PATTERN = /Math\.round\([\s\S]*?\*\s*100\s*\)\s*\/\s*100/;
  const hits = [];
  for (const f of walk(join(ROOT, 'server'))) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    if (/\.spec\.ts$/.test(rel) || rel.startsWith('server/test/')) continue;
    const code = stripsComments(readFileSync(f, 'utf8'));
    code.split(/\r?\n/).forEach((line, i) => {
      if (PATTERN.test(line)) {
        hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 80)}`);
      }
    });
  }

  console.log(
    `\n取整口径门禁：server 非测试源码里内联 Math.round(x*100)/100 —— ${hits.length} 处`,
  );
  if (hits.length > 0) {
    console.error(
      `\n[FAIL] ${hits.length} 处内联取整（应统一用 shared/number 的 round2）：\n`,
    );
    for (const h of hits) console.error(`  · ${h}`);
    console.error(
      `\n为什么必须改：Math.round 是「向 +∞ 取整」，不是会计要求的「远离零取整」。\n` +
        `  实测 Math.round(-0.125*100)/100 = -0.12，而 round2(-0.125) = -0.13；\n` +
        `  于是同一笔金额在**计提与红冲**两个方向取整不一致，\n` +
        `  「原凭证 + 红冲凭证」合计差 1 分 —— 且不会抛错。\n` +
        `\n改法：import { round2 } from '@server/common/utils/number'（或 '@shared/number'），\n` +
        `  把 Math.round(x * 100) / 100 换成 round2(x)。`,
    );
    process.exit(1);
  }
  console.log('取整口径门禁通过：未发现内联 Math.round(x*100)/100。');
}
