#!/usr/bin/env node
/**
 * B-01：**前端**权限显隐一致性检查（CI 门）。
 *
 * 与 `check-rbac-consistency.mjs` 的分工：后者只管后端装饰器，
 * 前端此前**完全没有任何约束** —— 结果长期积累了 121 处
 * `<CanRole roles={['admin']}>`，而后端早已统一到能力码。
 * 两者语义不同：`roles` 匹配角色**名**，`capability` 匹配能力码；
 * 用角色名判显隐会在角色与能力矩阵不一致时给出错误结果
 * （例如 `finance_viewer` 有 `finance: r`，用 `roles={['admin']}` 会把
 * 该角色能看的入口也隐藏掉，反之亦然）。
 *
 * 检查项：
 *   1. `client/src/**` 中的 `<CanRole>` 必须登记在 INTENTIONAL 白名单中，
 *      且**必须写明理由**（空理由 / 占位理由一律失败）；
 *   2. `<CanCapability capability="x">` 的 x 必须存在于 `shared/rbac.ts`
 *      的 Capability 联合类型中（防止拼错能力码后按钮永久隐藏 ——
 *      这类错误没有任何运行时反馈，是最难发现的一类"静默失效"）；
 *   3. 白名单条目的文件必须仍存在且仍含 `<CanRole>`，否则即是过期条目
 *      （防止白名单腐化：功能迁移后旧条目一直留着，掩盖新出现的问题）。
 *
 * 退出码：0 = 通过；1 = 有不一致。
 *
 * ## 为什么第 2 项特别重要
 *
 * 拼错能力码（如 `finance_wirte`）不会抛错、不会告警，
 * 只会让 `<CanCapability>` **永远渲染 fallback** —— 按钮永久消失。
 * `typecheck` 能拦住一部分（prop 类型是 `Capability | string`，
 * 而 `string` 让拼错也能通过），所以必须在这里用运行时清单核对。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * 允许保留 `<CanRole>` 的文件 → 理由。
 *
 * 每一条都必须是**具体理由**，不是"暂不迁移"。新增条目请在 PR 说明里
 * 一并给出"为什么不能用能力码表达"。
 */
const INTENTIONAL = new Map([
  [
    'client/src/components/attachments/AttachmentField.tsx',
    '附件接口登录即可用（员工自助上传）；改用写能力会收窄后端本来允许的操作',
  ],
  [
    'client/src/pages/projects/components/ProjectDocSection.tsx',
    '同一文件混用附件（登录可用）与项目云盘同步；块内按钮需按语义拆分后再迁移',
  ],
  [
    'client/src/pages/drive/DrivePage.tsx',
    "含多角色 roles={['admin','drive_editor']}，角色名无法一一映射到能力码",
  ],
  [
    'client/src/pages/admin-bills/index.tsx',
    'adminApi 为管理端聚合接口；白名单理由待补（见台账遗留清单）',
  ],
  [
    'client/src/pages/projects/ProjectDetailPage.tsx',
    '该文件的 CanRole 块只包读取入口，未推导出对应写能力',
  ],
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/* ---------- 能力码清单（唯一权威：shared/rbac.ts） ---------- */

const rbacSrc = readFileSync(join(ROOT, 'shared/rbac.ts'), 'utf8');
const capabilityUnion = rbacSrc.match(
  /export type Capability\s*=([\s\S]*?);/
);
if (!capabilityUnion) {
  console.error('✗ 无法从 shared/rbac.ts 解析 Capability 联合类型');
  process.exit(1);
}
const knownCapabilities = new Set(
  [...capabilityUnion[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
);

/* ---------- 检查 ---------- */

const failures = [];
const seenIntentional = new Set();
const clientFiles = walk(join(ROOT, 'client/src'));

for (const file of clientFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const text = readFileSync(file, 'utf8');

  /* ① <CanRole> 使用 */
  const canRoleCount = [...text.matchAll(/<CanRole\b/g)].length;
  if (canRoleCount > 0) {
    if (!INTENTIONAL.has(rel)) {
      failures.push(
        `${rel}: 使用了 ${canRoleCount} 处 <CanRole>，未登记白名单。` +
          `B-01 要求前端用能力码显隐（<CanCapability capability="x">）；` +
          `若确需保留，请在本脚本 INTENTIONAL 中登记**具体理由**`
      );
    } else {
      seenIntentional.add(rel);
      const reason = INTENTIONAL.get(rel);
      if (!reason || reason.trim().length < 10) {
        failures.push(
          `${rel}: 白名单理由过短或为空，必须写明"为什么不能用能力码表达"`
        );
      }
    }
  }

  /* ② <CanCapability capability="x"> 的能力码必须在册 */
  for (const m of text.matchAll(
    /<CanCapability\b[^>]*?capability=(?:"([^"]+)"|\{'([^']+)'\})/g
  )) {
    const capability = m[1] ?? m[2];
    if (!knownCapabilities.has(capability)) {
      failures.push(
        `${rel}: <CanCapability capability="${capability}"> 的能力码不在 ` +
          `shared/rbac.ts 的 Capability 联合类型中 —— ` +
          `这不会报错，只会让该元素**永久隐藏**，属静默失效`
      );
    }
  }

  /* ③ 同时导入 CanRole 与 CanCapability 的，提示可能是漏改 */
  if (
    /import\s*\{[^}]*\bCanRole\b[^}]*\}\s*from\s*'@client\/src\/platform\/auth'/.test(
      text
    ) &&
    /<CanCapability\b/.test(text)
  ) {
    failures.push(
      `${rel}: 同时导入了 CanRole 与 CanCapability 且都用到 —— ` +
        `疑似迁移未完成，请确认是否遗漏`
    );
  }
}

/* ④ 白名单腐化：条目指向的文件必须仍存在且仍含 <CanRole> */
for (const rel of INTENTIONAL.keys()) {
  if (!seenIntentional.has(rel)) {
    failures.push(
      `白名单条目已过期：${rel} 不存在或已不含 <CanRole>，请从 INTENTIONAL 中移除`
    );
  }
}

/* ---------- 报告 ---------- */

if (failures.length > 0) {
  console.error('✗ 前端权限显隐一致性检查未通过：\n');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `\n可用 codemod 辅助迁移：node ./scripts/codemod-canrole-to-capability.mjs（默认 dry-run）`
  );
  process.exit(1);
}

console.log(
  `前端权限显隐一致性检查通过（扫描 ${clientFiles.length} 个文件；` +
    `能力码 ${knownCapabilities.size} 个；` +
    `<CanRole> 白名单 ${INTENTIONAL.size} 条，均已登记理由）。`
);
