#!/usr/bin/env node
/**
 * B-01 前端收敛：把 `<CanRole roles={['admin']}>` 机械替换为
 * `<CanCapability capability="x">`。
 *
 * ## 为什么可以机械替换（而不是逐个人工判断）
 *
 * 权限的**唯一权威在后端**：前端 `<CanRole>` 只是"提前隐藏按钮"，
 * 真正的拦截由 `@CanCapability` / `@CanCapabilityRead` 完成。
 * 因此替换的判据不是"我觉得这个按钮该给谁看"，而是
 * **这个文件调用的 API 属于哪个能力** —— 这是可从代码机械推导的事实。
 *
 * 推导链：
 *   文件里调用的 `xxxApi.fn()` → `client/src/api/xxx/index.ts` 中该函数体内的
 *   `'/api/...'` 路径 → `server/common/auth/route-capability.ts` 的最长前缀匹配
 *   → 写能力码。
 *
 * 实测：363 个 api 函数全部唯一映射到 1 个能力，**没有跨能力的函数**，
 * 因此"文件 → 能力"在只用单一能力的文件上无歧义。
 *
 * ## 边界（明确不处理，交给人工）
 *
 * - 文件里出现**多个**能力：无法判定每个按钮各自对应哪个（按钮与调用的
 *   对应关系无法静态确定）。这类文件跳过并列出，由人工按按钮语义拆分；
 * - 文件用 `<CanRole roles={['admin', 'drive_editor']}>` 等多角色：
 *   角色名不等于能力码，跳过；
 * - 推导不出能力（文件未直接调用 api 模块）：跳过。
 *
 * **跳过必须显式打印**，不能静默略过 —— 否则"改了一部分"会被误读成"全改完了"。
 *
 * ## 用法
 *
 *   node ./scripts/codemod-canrole-to-capability.mjs [--write] [--only=path]
 *
 * 默认 **dry-run**（只打印将要改什么）；加 `--write` 才落盘。
 * 这是刻意的：机械改写 121 处必须能先审阅。
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = process.cwd();
const WRITE = process.argv.includes('--write');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

/* ---------- ① 路由 → 能力 ---------- */

const routeSrc = readFileSync(
  join(REPO, 'server/common/auth/route-capability.ts'),
  'utf8'
);
/**
 * 解析路由规则。
 *
 * ⚠️ **必须区分三种情况**（我曾在这里写错，导致生成不存在的能力码）：
 * - `write: 'x'`      → 写能力是 x；
 * - `write: null`     → **写能力与 read 相同**（如 `admin_ops` / `pur_asset` /
 *                       `tax_entity` 在 MATRIX 里**没有** `_write` 变体，
 *                       注释原文："admin_ops / audit 只有 admin 可写，
 *                       没有单独的 *_write 能力"）；
 * - 未写 write 字段    → 默认 `${read}_write`。
 *
 * 第一版把 `null` 也当成"未写"从而生成 `${read}_write`，
 * 结果产出 `admin_ops_write` / `pur_asset_write` / `tax_entity_write`
 * 三个**不存在的能力码** —— 前端会永远渲染 fallback，整个管理模块的按钮静默消失。
 * 是 `check-frontend-rbac.mjs` 把它拦下来的（typecheck 拦不住，见该脚本注释）。
 */
const rules = [
  ...routeSrc.matchAll(
    /prefix:\s*'([^']+)',\s*read:\s*'([^']+)',\s*write:\s*(?:'([^']+)'|null)|prefix:\s*'([^']+)',\s*read:\s*'([^']+)'/g
  ),
]
  .map((m) => {
    const prefix = m[1] ?? m[4];
    const read = m[2] ?? m[5];
    // m[3] 有值 → 显式 write；m[3] undefined 时要区分是 'null' 还是字段缺失
    if (m[3] !== undefined) return { prefix, read, write: m[3] };
    const chunk = routeSrc.slice(m.index, m.index + 260);
    const isNullWrite = /write:\s*null/.test(chunk);
    return { prefix, read, write: isNullWrite ? read : `${read}_write` };
  })
  .sort((a, b) => b.prefix.length - a.prefix.length);

/** 能力码清单（唯一权威：shared/rbac.ts）—— 用于拒绝不存在的能力码 */
const rbacSrcForRules = readFileSync(join(REPO, 'shared/rbac.ts'), 'utf8');
const unionMatch = rbacSrcForRules.match(/export type Capability\s*=([\s\S]*?);/);
const KNOWN_CAPABILITIES = new Set(
  unionMatch ? [...unionMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : []
);

/* ---------- ② api 函数 → 能力 ---------- */

const apiDir = join(REPO, 'client/src/api');
const fnCap = new Map();
for (const mod of readdirSync(apiDir)) {
  const idx = join(apiDir, mod, 'index.ts');
  if (!existsSync(idx) || !statSync(idx).isFile()) continue;
  const text = readFileSync(idx, 'utf8');
  const blocks = text.split(/(?=export\s+(?:async\s+)?function\s)/);
  for (const block of blocks) {
    const fn = block.match(/export\s+(?:async\s+)?function\s+(\w+)/);
    if (!fn) continue;
    const caps = new Set();
    for (const m of block.matchAll(/['"`](\/api\/[a-zA-Z0-9_\-/{}$:.]+)['"`]/g)) {
      const path = m[1].replace(/\$\{[^}]*\}/g, 'x');
      const rule = rules.find((r) => path.startsWith(`/${r.prefix}`));
      if (rule) caps.add(rule.write);
    }
    if (caps.size) fnCap.set(`${mod}.${fn[1]}`, caps);
  }
}

/* ---------- ③ 人工确认的映射表 ---------- */

/**
 * 无法机械推导、但已**逐项人工核对**的文件 → 能力码。
 *
 * 判定依据：该文件里所有**写接口**调用所对应的后端能力
 * （由 `scripts/plan-canrole-blocks.mjs` 摊开，人工确认）。
 * 例如 `ApTab` 只调用 `financeApi.createAp / createPayment / approvePayment /
 * voidPayment / generateVendorSettlement`，全部映射到 `finance_write`，
 * 因此其 admin 按钮应为 `finance_write`。
 *
 * ⚠️ 这个表是**显式白名单**，不是"猜不出来就塞个默认值"：
 * 每加一项都要求已核对文件内的写接口。未列入的文件仍会被跳过并打印。
 *
 * 另有两个文件**刻意不迁移**（见 CODEX_SKIP）：
 * - `AttachmentField` / `ProjectDocSection`：附件接口是"登录即可用"
 *   （员工自助上传），`route-capability.ts` 把 `api/attachments` 归到
 *   `dashboard_write`。迁移后会用写能力去卡一个后端本来允许的操作，
 *   属**权限收窄**，不是本次目标；
 * - `DrivePage`：含 `roles={['admin','drive_editor']}` 多角色，角色名≠能力码。
 */
const MANUAL_CAPABILITY = new Map([
  ['client/src/pages/asset/components/AssetPanel.tsx', 'pur_asset'],
  ['client/src/pages/contracts/ContractsPage.tsx', 'projects_write'],
  ['client/src/pages/customers/ContactsDialog.tsx', 'crm_write'],
  ['client/src/pages/customers/CustomersPage.tsx', 'crm_write'],
  ['client/src/pages/fin-expense/components/BudgetPanel.tsx', 'finance_write'],
  ['client/src/pages/fin-expense/components/ExpenseApplyPanel.tsx', 'finance_write'],
  ['client/src/pages/fin-expense/components/ExpenseClaimPanel.tsx', 'finance_write'],
  ['client/src/pages/finance/ApTab.tsx', 'finance_write'],
  ['client/src/pages/finance/ArTab.tsx', 'finance_write'],
  ['client/src/pages/finance/InvoicesTab.tsx', 'finance_write'],
  // 注意：MATRIX 无 tax_entity_write（route-capability 里 write: null），写能力与读同码
  ['client/src/pages/masterdata/TaxEntities.tsx', 'tax_entity'],
  ['client/src/pages/projects/components/ArApSection.tsx', 'finance_write'],
  ['client/src/pages/projects/components/InvoiceSection.tsx', 'finance_write'],
  ['client/src/pages/projects/components/RevenueSection.tsx', 'projects_write'],
  // MATRIX 无 pur_asset_write（write: null），写能力与读同码
  ['client/src/pages/pur/components/PurOrderPanel.tsx', 'pur_asset'],
  ['client/src/pages/pur/components/PurRequestPanel.tsx', 'pur_asset'],
  ['client/src/pages/revenues/RevenuesTab.tsx', 'finance_write'],
  ['client/src/pages/suppliers/SuppliersPage.tsx', 'crm_write'],
]);

/** 刻意不迁移的文件及理由（必须写明，否则等于"莫名漏掉"） */
const CANROLE_INTENTIONAL = new Map([
  [
    'client/src/components/attachments/AttachmentField.tsx',
    '附件接口登录即可用（员工自助）；迁移会用写能力收窄后端本来允许的操作',
  ],
  [
    'client/src/pages/projects/components/ProjectDocSection.tsx',
    '同时用附件（登录可用）与项目云盘同步；块内可能只需后者，需按按钮拆分',
  ],
  ['client/src/pages/drive/DrivePage.tsx', '含多角色 roles={[\'admin\',\'drive_editor\']}'],
  [
    'client/src/pages/admin-bills/index.tsx',
    'adminApi 为管理端操作，route-capability 归 admin_ops_write，但块内含读取语义',
  ],
  [
    'client/src/pages/projects/ProjectDetailPage.tsx',
    '仅用 projectsApi 读取函数（getProject/getProjectChain），未推导出写函数',
  ],
]);

/* ---------- ④ 遍历文件 ---------- */

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') walk(full, out);
    } else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

// 匹配 <CanRole ... roles={[...]} ...> —— 允许 roles 与其它属性任意顺序、跨行
const CANROLE_OPEN = /<CanRole\b([^>]*?)\/?>/gs;

const applied = [];
const skipped = [];

for (const file of walk(join(REPO, 'client/src'))) {
  const rel = relative(REPO, file).replace(/\\/g, '/');
  if (ONLY && !rel.includes(ONLY)) continue;
  const text = readFileSync(file, 'utf8');
  const opens = [...text.matchAll(CANROLE_OPEN)].filter((m) =>
    /roles\s*=/.test(m[1])
  );
  if (opens.length === 0) continue;

  // 所有 roles 取值必须都是单一 admin，否则跳过（角色名 ≠ 能力码）
  const rolesValues = opens.map((m) => {
    const r = m[1].match(/roles\s*=\s*\{\s*\[([^\]]*)\]\s*\}/);
    return r ? r[1].replace(/['"\s]/g, '') : null;
  });
  if (rolesValues.some((v) => v === null || v !== 'admin')) {
    skipped.push({ rel, reason: `roles 非单一 admin：${rolesValues.join(' / ')}` });
    continue;
  }

  // 推导能力：优先用人工确认的映射表，其次按该文件调用的 api 函数
  const manual = MANUAL_CAPABILITY.get(rel);
  const caps = new Set();
  if (manual) {
    caps.add(manual);
  } else if (CANROLE_INTENTIONAL.has(rel)) {
    skipped.push({ rel, reason: `刻意不迁移：${CANROLE_INTENTIONAL.get(rel)}` });
    continue;
  } else {
    for (const m of text.matchAll(/\b(\w+[Aa]pi)\.(\w+)\s*\(/g)) {
      const key = `${m[1].replace(/Api$/, '')}.${m[2]}`;
      const found = fnCap.get(key);
      if (found) for (const c of found) caps.add(c);
    }
    // 具名导入（`import { createCustomer } from '@client/src/api/master-data'`）
    for (const m of text.matchAll(
      /import\s*\{([^}]+)\}\s*from\s*'@client\/src\/api\/([\w-]+)'/gs
    )) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
        if (!name) continue;
        const found = fnCap.get(`${m[2]}.${name}`);
        if (found) for (const c of found) caps.add(c);
      }
    }
  }
  if (caps.size === 0) {
    skipped.push({ rel, reason: '未直接调用 api 模块，推导不出能力' });
    continue;
  }
  // 拒绝不存在的能力码：宁可跳过也不写入一个会让按钮永久消失的值
  const unknown = [...caps].filter((c) => !KNOWN_CAPABILITIES.has(c));
  if (unknown.length > 0) {
    skipped.push({
      rel,
      reason: `推导出不存在的能力码 ${unknown.join(' / ')}（shared/rbac.ts 无此码），已拒绝写入`,
    });
    continue;
  }
  if (caps.size > 1) {
    skipped.push({
      rel,
      reason: `跨多个能力，需人工按按钮拆分：${[...caps].join(' / ')}`,
    });
    continue;
  }

  const capability = [...caps][0];
  let next = text;
  let replaced = 0;
  // ① 开标签：保留其它属性（如 fallback），替换 roles 为 capability
  next = next.replace(CANROLE_OPEN, (match, attrs) => {
    if (!/roles\s*=/.test(attrs)) return match;
    replaced += 1;
    const cleaned = attrs
      .replace(/roles\s*=\s*\{\s*\[[^\]]*\]\s*\}/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const head = `<CanCapability capability="${capability}"`;
    return cleaned ? `${head} ${cleaned}>` : `${head}>`;
  });
  // ② 闭标签
  next = next.replace(/<\/CanRole>/g, '</CanCapability>');
  // ③ import
  next = next.replace(
    /import\s*\{\s*CanRole\s*\}\s*from\s*'@client\/src\/platform\/auth';/g,
    "import { CanCapability } from '@client/src/platform/auth';"
  );
  // ④ 同文件里同时 import 了 CanCapability 的，合并去重
  next = next.replace(
    /import\s*\{\s*CanCapability\s*\}\s*from\s*'@client\/src\/platform\/auth';\s*\nimport\s*\{\s*CanCapability\s*\}\s*from\s*'@client\/src\/platform\/auth';/g,
    "import { CanCapability } from '@client/src/platform/auth';"
  );

  if (next !== text) {
    applied.push({ rel, count: replaced, capability });
    if (WRITE) writeFileSync(file, next, 'utf8');
  }
}

/* ---------- ④ 报告 ---------- */

console.log(`${WRITE ? '【已写入】' : '【DRY-RUN，未改动文件】'}`);
console.log(`\n可迁移：${applied.length} 个文件 / ${applied.reduce((s, a) => s + a.count, 0)} 处`);
for (const a of applied.sort((x, y) => y.count - x.count)) {
  console.log(`  ${String(a.count).padStart(2)}  ${a.capability.padEnd(20)} ${a.rel}`);
}

console.log(`\n跳过（需人工）：${skipped.length} 个文件`);
for (const s of skipped.sort((x, y) => x.rel.localeCompare(y.rel))) {
  console.log(`  ${s.rel}\n      理由：${s.reason}`);
}

if (!WRITE && applied.length > 0) {
  console.log('\n确认无误后加 --write 落盘。');
}
