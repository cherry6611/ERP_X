#!/usr/bin/env node
/**
 * 标签字典一致性检查：**契约里的状态值必须在对应的展示标签表里有键**。
 *
 * ## 这个门禁要拦的是什么
 *
 * 本仓的展示文案走 `utils/biz-labels.ts` 的 `withDictionaryFallback('dict', {…})`：
 * 字典优先、硬编码兜底其次。于是每新增一个状态值，就有**三处**需要同步：
 *
 * ```
 *   ① shared/api.interface.ts   的契约联合类型（值域）
 *   ② client/src/utils/biz-labels.ts 的兜底表（键）
 *   ③ server 的 sys_dict 种子迁移（可编辑的文案）
 * ```
 *
 * 三者不会自动同步，而**漏了 ② 的后果是可见的功能缺陷**：
 *
 * · `StatusBadge` 是 `labels[status] ?? status` —— 漏键就显示**英文码**；
 * · 更严重的是**筛选下拉**：`ArTab.tsx:330` 的
 *   `Object.entries(AR_STATUS_LABELS).map(…)` 直接用**标签表的键**渲染选项，
 *   所以漏键意味着使用者**连"筛出该状态"都做不到**（下拉里没有那一项）。
 *
 * ## 本仓实际发生过（不是假想）
 *
 * B1 给应收/应付加了作废路径，服务端写 `status='voided'`、契约也含 `'voided'`，
 * 但 `AR_STATUS_LABELS` / `AP_STATUS_LABELS` 都没跟上 → 作废单据显示英文码
 * 且无法筛选。同批还发现：
 *   · `ap_status` 连 `'approved'` 都缺；
 *   · `ASSET_DISPOSAL_STATUS_LABELS` 的键**整套都是错的**
 *     （写的是 `draft/submitted/approved/completed/void` —— 那是审批流的键，
 *     契约里一个都没有）；
 *   · `NOTE_STATUS_LABELS` 缺 `received/held/dishonored` 且多了三个契约外的键。
 * 后两张表之所以长期没暴露，是因为它们**全仓 0 处引用**（组件各自带了本地表）。
 *
 * ## 判据
 *
 * 对每个 `export type XxxStatus = '…' | '…'` 找到同名标签表
 * （`XXX_STATUS_LABELS` 或 `XXX_LABELS`，由类型名推导），要求：
 *   1. 契约的每个值都能在表里找到键（**缺失即失败** —— 这是显示缺陷）；
 *   2. 表里没有契约之外的多余键（**多余即失败** —— 说明表与契约已脱节，
 *      正是 `ASSET_DISPOSAL` / `NOTE` 那两张表的情形）。
 *
 * ## 豁免
 *
 * 有些状态**有意不进标签表**（例如纯内部流转态、或不该出现在筛选下拉里的值）。
 * 这类必须在下面的 `ALLOWLIST` 里逐条登记**理由**；未登记就失败。
 * ⚠️ 不要为了让它变绿而豁免 —— 这与 `check-enum-whitelist.mjs` 的
 * 同一原则：豁免一多，门禁就等于不存在。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const API = join(ROOT, 'shared', 'api.interface.ts');
const LABELS = join(ROOT, 'client', 'src', 'utils', 'biz-labels.ts');

/**
 * 有意不进标签表的键，格式 `'<标签表名>.<键>'` → 理由。
 *
 * 当前为空：全部状态类型都已有完整且对齐的标签表。
 * 新增豁免时必须写清"为什么这个状态不该出现在界面上/筛选里"。
 */
const ALLOWLIST = new Map([]);

/* ── ① 读契约：收集所有 *Status 联合类型 ─────────────────────────────────── */

const apiSrc = readFileSync(API, 'utf8');
/** @type {Map<string, string[]>} */
const contracts = new Map();
for (const m of apiSrc.matchAll(/export type (\w*Status) =([^;]+);/gu)) {
  const values = [...m[2].matchAll(/'([^']+)'/gu)].map((x) => x[1]);
  if (values.length > 0) contracts.set(m[1], values);
}

/* ── ② 读标签表：解析 withDictionaryFallback('dict', { … }) ──────────────── */

const labelSrc = readFileSync(LABELS, 'utf8');
/** @type {Map<string, {dict: string, keys: string[]}>} */
const labelMaps = new Map();
const MAP_RE =
  /export const (\w+_LABELS)\s*(?::[^=]+)?=\s*\n?\s*withDictionaryFallback\(\s*\n?\s*'([^']+)'\s*,\s*\{([\s\S]*?)\n\s*\}/gu;
for (const m of labelSrc.matchAll(MAP_RE)) {
  const keys = [...m[3].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gmu)].map((x) => x[1]);
  labelMaps.set(m[1], { dict: m[2], keys });
}

/* ── ③ 比对 ─────────────────────────────────────────────────────────────── */

/** `ArStatus` → 候选表名 `AR_STATUS_LABELS` / `AR_LABELS` */
function candidateNames(typeName) {
  const snake = typeName
    .replace(/Status$/u, '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toUpperCase();
  return [`${snake}_STATUS_LABELS`, `${snake}_LABELS`];
}

const problems = [];
let checked = 0;
for (const [typeName, values] of contracts) {
  const found = candidateNames(typeName).filter((n) => labelMaps.has(n));
  if (found.length === 0) continue; // 没有对应标签表 → 本门禁不管（可能是纯内部枚举）
  for (const mapName of found) {
    checked += 1;
    const { keys } = labelMaps.get(mapName);
    const missing = values.filter(
      (v) => !keys.includes(v) && !ALLOWLIST.has(`${mapName}.${v}`),
    );
    const extra = keys.filter(
      (k) => !values.includes(k) && !ALLOWLIST.has(`${mapName}.${k}`),
    );
    if (missing.length > 0) {
      problems.push({ mapName, typeName, kind: 'missing', items: missing });
    }
    if (extra.length > 0) {
      problems.push({ mapName, typeName, kind: 'extra', items: extra });
    }
  }
}

console.log(
  `标签字典一致性检查：契约里 ${contracts.size} 个状态类型、` +
    `标签表 ${labelMaps.size} 张，实际比对 ${checked} 对，` +
    `命中问题 ${problems.length} 处`,
);

if (problems.length > 0) {
  console.error('\n[FAIL] 契约状态与展示标签表不一致：\n');
  for (const p of problems) {
    const what =
      p.kind === 'missing'
        ? '标签表缺少契约已声明的状态（界面会显示英文码，且筛选下拉里没有该项）'
        : '标签表存在契约之外的多余键（表与契约已脱节）';
    console.error(`  · ${p.mapName}  vs  契约 ${p.typeName}`);
    console.error(`      ${what}`);
    console.error(`      涉及：${p.items.join(', ')}\n`);
  }
  console.error(
    '请同步三处（缺任何一处都会留下可见缺陷）：\n' +
      '  ① shared/api.interface.ts 的契约联合类型\n' +
      '  ② client/src/utils/biz-labels.ts 的 withDictionaryFallback 兜底表\n' +
      '  ③ server/database/migrations/ 里该 dict_type 的 sys_dict 种子\n' +
      '\n为什么 ② 不能漏：`StatusBadge` 是 `labels[status] ?? status`，漏键显示英文码；\n' +
      '而 ArTab / ApTab 的**筛选下拉**是 `Object.entries(标签表)` 渲染的，\n' +
      '漏键意味着使用者连"筛出该状态"都做不到。\n' +
      '\n若某个状态**有意**不进标签表，请在 scripts/check-label-dict.mjs 的\n' +
      'ALLOWLIST 里登记理由 —— 不要为了让门禁变绿而豁免。',
  );
  process.exit(1);
}

console.log(
  '标签字典一致性检查通过：每个状态类型的每个值都有对应标签键，且无多余键。',
);
