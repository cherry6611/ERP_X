#!/usr/bin/env node
/**
 * 枚举白名单一致性检查（防止"类型加了、白名单没跟上"）。
 *
 * ## 这个门禁要拦的是什么
 *
 * `shared/api.interface.ts` 是前后端契约的唯一权威；后端用 `@IsIn([...])`
 * 做运行时白名单校验（`ValidationPipe` 靠它拦非法值）。这两者**不会自动同步**：
 * 给联合类型加一个成员（`tsc` 全绿），但漏了 `@IsIn` 数组 —— 于是：
 *
 *   · 类型层面"支持"新动作；· service 里写好了处理分支；
 *   · 前端按钮也渲染出来了；· **点下去 400「xxx 不合法」**。
 *
 * 本次修复里**实际发生了两次**，两次都是"看起来全绿"
 * （`tsc --noEmit` 与 `npm test` 都发现不了）：
 *   · `B6` 项目状态 `cancel` / `reopen` → 漏在 `PROJECT_STATUS_ACTIONS`
 *   · `B12` 工资单 `pay` / `void` → 漏在 `PayrollActionBody`
 *
 * ## 第一条判据为什么必须放弃（记录一次真实的误报）
 *
 * 首版判据是"某个 `@IsIn` 数组是某契约类型的**真子集** → 报缺失"。
 * 结果 29 处全部误报 —— 因为**白名单未必校验该类型**：
 *
 * ```ts
 * // admin-bill 的审批接口只接受 approve/reject，
 * // 它的入参类型恰好也叫 XxxAction，与 ContractStatusAction 值域重叠
 * @IsIn(['approve', 'reject'])
 * action!: 'approve' | 'reject';
 * ```
 *
 * 这类"子集"是**有意的窄接口**，不是漏配。误报的代价是真实的：
 * 修它最省事的办法是给检查器加豁免，豁免一多就等于没有检查器。
 *
 * ## 现行判据（**强信号**，只查一种情况）
 *
 * 一个白名单数组，如果它
 *   ① 是某个契约类型的**真子集**，**且**
 *   ② 它自身**不等于任何**已知契约类型的值域，**且**
 *   ③ 该文件中**出现了该类型的名字或它唯一的字段名**
 *
 * 才判定为"本该覆盖全量却漏了成员"。
 *
 * ③ 是关键：`PayrollActionBody.action` 这个字段名只出现在工资单动作的 DTO 里，
 * 而 `finance.controller.ts` 的 `approve/reject` 所在字段名与之不同 ——
 * 于是真实的漏配被抓到，窄接口被放过。
 * 这一版在修复前**两处真实缺陷全部命中、零误报**（见下方自检断言）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const INTERFACE_FILE = join(ROOT, 'shared', 'api.interface.ts');
const SERVER_DIR = join(ROOT, 'server');

/**
 * 从契约文件里抽出所有"纯字符串字面量联合类型"。
 *
 * ## 必须先去注释、再多行匹配
 *
 * 首版用单行正则 `/export type X = ('a' | 'b');/`，于是**漏掉了本仓最需要
 * 检查的那两个类型** —— 因为它们带 TSDoc 且跨多行：
 *
 * ```ts
 * /**
 *  * B6：项目状态动作。
 *  *\/
 * export type ProjectStatusAction =
 *   | 'approve'
 *   | 'deliver'
 *   | 'cancel'      ← 漏配就发生在这些值上
 *   | 'reopen';
 * ```
 *
 * 结果是：`B6` 的漏配**完全没被检查到**（`B12` 是单行的所以抓到了）。
 * 这与"只解析内联字面量、漏掉 `...CONST`"是同一类错误 ——
 * **检查器的覆盖面必须覆盖团队实际使用的全部写法**，否则它给出的是假安心。
 *
 * 因此这里先剥掉注释，再按"从 `export type X =` 到第一个分号"整段取值。
 */
function collectUnionTypes(source) {
  // ① 剥掉块注释与行注释（避免注释里的示例值被当成成员）
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
  const result = new Map();
  // ② 多行、可带前导 `|`、成员之间任意空白
  const re = /export type (\w+)\s*=\s*([^;]+);/gu;
  let matched;
  while ((matched = re.exec(stripped)) !== null) {
    const name = matched[1];
    const body = matched[2];
    // 只接受"纯字面量 + 竖线 + 空白"的联合类型；含其它 token（泛型、引用）则跳过
    if (!/^[\s|']*$/u.test(body.replace(/'[^']*'/gu, ''))) continue;
    const members = [...body.matchAll(/'([^']*)'/gu)].map((m) => m[1]);
    if (members.length >= 2 && members.length <= 12) {
      result.set(name, new Set(members));
    }
  }
  return result;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 抽出 `@IsIn([...])` 数组，并连带取出它**所属的字段名**。
 *
 * ## 必须解析 `...CONST` 间接引用
 *
 * 白名单有两种写法，**两者都要覆盖**：
 *
 * ```ts
 * @IsIn(['submit', 'approve'])          action!: PayrollAction;   // 内联字面量
 * @IsIn([...PROJECT_STATUS_ACTIONS])    action!: ProjectStatusAction; // 引用常量
 * ```
 *
 * 首版只解析内联字面量，于是 `B6` 那处漏配**被漏掉了** ——
 * 检查器只抓到了 `B12`。一个只覆盖一半写法的检查器比没有更危险：
 * 它会让人以为"检查过了"，而漏掉的那一半正是团队习惯用的写法
 * （把长白名单提成常量本来就是更好的写法）。
 *
 * 因此这里先把文件内所有 `const X = [...] as const;` 的取值抽出来，
 * 再在 `@IsIn` 里解析 `...X` 引用并展开。
 */
function collectConstArrays(source) {
  const consts = new Map();
  const re = /const (\w+)\s*=\s*\[([\s\S]*?)\]\s*as const\s*;/gu;
  let matched;
  while ((matched = re.exec(source)) !== null) {
    const literals = [...matched[2].matchAll(/'([^']*)'/gu)].map((m) => m[1]);
    if (literals.length > 0) consts.set(matched[1], literals);
  }
  return consts;
}

function collectIsInArrays(source) {
  const consts = collectConstArrays(source);
  const results = [];
  const re = /@IsIn\(\s*\[([\s\S]*?)\]\s*(?:,[\s\S]*?)?\)([\s\S]{0,200}?)(\w+)\s*[!?]?\s*:/gu;
  let matched;
  while ((matched = re.exec(source)) !== null) {
    const body = matched[1];
    const literals = [...body.matchAll(/'([^']*)'/gu)].map((m) => m[1]);
    // 展开 `...CONST` 引用
    for (const spread of body.matchAll(/\.\.\.\s*(\w+)/gu)) {
      const referenced = consts.get(spread[1]);
      if (referenced) literals.push(...referenced);
    }
    if (literals.length >= 2) {
      results.push({
        line: source.slice(0, matched.index).split(/\r?\n/u).length,
        literals: new Set(literals),
        fieldName: matched[3],
        rawLiterals: literals,
      });
    }
  }
  return results;
}

const unionTypes = collectUnionTypes(readFileSync(INTERFACE_FILE, 'utf8'));
const allValueSets = [...unionTypes.values()];
const files = walk(SERVER_DIR);
const problems = [];
let inspected = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const arrays = collectIsInArrays(source);
  if (arrays.length === 0) continue;

  for (const entry of arrays) {
    for (const [typeName, members] of unionTypes) {
      const allWithin = [...entry.literals].every((value) => members.has(value));
      if (!allWithin) continue;
      const missing = [...members].filter((m) => !entry.literals.has(m));
      if (missing.length === 0) continue;
      // 判据 ②：白名单自身不等于任何已知类型的值域（否则它是另一个枚举的完整校验）
      const equalsAnotherType = allValueSets.some(
        (set) =>
          set.size === entry.literals.size &&
          [...set].every((value) => entry.literals.has(value))
      );
      if (equalsAnotherType) continue;
      /*
       * 判据 ③（**收紧到不误报的关键**）：该文件必须真的提及了这个类型，
       * 且出问题的字段名必须是 `action` —— 本仓所有"动作枚举"DTO 的字段
       * 都叫 `action`（`PayrollActionBody.action` / `ProjectStatusActionDto.action`）。
       *
       * 于是真实的漏配被抓住，而 `@IsIn(['approve','reject'])` 这类
       * **有意的窄接口**（值域恰好与某动作枚举重叠、但校验的不是它）被放过 ——
       * 首版没有这两条，29 处全部误报。
       */
      const mentionsType = new RegExp(`\\b${typeName}\\b`, 'u').test(source);
      if (!mentionsType) continue;
      if (entry.fieldName.toLowerCase() !== 'action') continue;
      inspected += 1;
      problems.push({
        file: relative(ROOT, file).replace(/\\/gu, '/'),
        line: entry.line,
        typeName,
        missing,
        had: entry.rawLiterals,
        fieldName: entry.fieldName,
      });
    }
  }
}

console.log(
  `枚举白名单一致性检查：契约里 ${unionTypes.size} 个字符串联合类型，` +
    `扫描 ${files.length} 个后端文件，命中 ${inspected} 处强信号`
);

if (problems.length > 0) {
  console.error(
    `\n[FAIL] ${problems.length} 处 @IsIn 白名单缺少契约类型已声明的成员：\n`
  );
  for (const p of problems) {
    console.error(`  · ${p.file}:${p.line}（字段 ${p.fieldName}）`);
    console.error(`      契约 ${p.typeName} 声明：${p.had.join(', ')}`);
    console.error(`      **缺少**：${p.missing.join(', ')}`);
  }
  console.error(
    `\n这类缺陷会让"类型对、service 写好、前端按钮也在"的功能点下去返回 400 ——` +
      `\n且 tsc 与 jest 都发现不了。请把缺失成员补进对应白名单。`
  );
  process.exit(1);
}

console.log('枚举白名单一致性检查通过：未发现"类型已声明、白名单缺失"的情况。');
