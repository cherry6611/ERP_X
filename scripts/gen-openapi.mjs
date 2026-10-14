/* eslint-disable no-console */
/**
 * C-12 OpenAPI 生成脚本。
 *
 * 输入：server/modules/integrations/openapi/routes.catalog.ts 中显式登记的路由元数据
 *      （纯数据，不依赖 NestJS 容器 / 数据库）。
 * 输出：docs/openapi.json（递归键排序，可重复执行、diff 稳定）。
 *
 * 注意：本脚本只覆盖**批次二新增**的接口。全量 318 条路由需要给既有 DTO 补 @ApiProperty
 * （需求书 B-23），不在本次范围；脚本采用「读自维护路由元数据」而非扫描 Nest 容器，
 * 因此不需要把 IntegrationsModule 挂进 app.module.ts 也能生成。
 *
 * 用法：node scripts/gen-openapi.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

async function loadGenerator() {
  const candidates = [
    join(ROOT, 'dist', 'server', 'modules', 'integrations', 'openapi', 'openapi-generate.js'),
    join(ROOT, 'dist', 'modules', 'integrations', 'openapi', 'openapi-generate.js'),
    // 快速通道：只编译批次二模块到 .openapi-build/（无需全量 nest build）
    join(ROOT, '.openapi-build', 'server', 'modules', 'integrations', 'openapi', 'openapi-generate.js'),
  ];
  for (const candidate of candidates) {
    try {
      return await import(pathToFileURL(candidate).href);
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  console.error(
    '[gen:openapi] 未找到编译产物 openapi-generate.js。\n' +
      '  请先执行 npm run build:server（nest build 输出到 dist/server/），\n' +
      '  或执行 npm run gen:openapi:build（只编译批次二模块，速度快）。'
  );
  process.exit(1);
}

const { generateOpenApiDocument, ROUTES_CATALOG } = await loadGenerator();
const document = generateOpenApiDocument();
const text = `${JSON.stringify(document, null, 2)}\n`;
const outFile = join(ROOT, 'docs', 'openapi.json');
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, text, 'utf8');

const operationCount = Object.values(document.paths ?? {}).reduce(
  (total, entry) => total + Object.keys(entry).length,
  0
);
const pathCount = Object.keys(document.paths ?? {}).length;
console.log(
  `[gen:openapi] 已生成 ${outFile}\n` +
    `[gen:openapi] openapi=${document.openapi} 模块=${ROUTES_CATALOG.title} ` +
    `路径=${pathCount} 操作=${operationCount} schema=${Object.keys(document.components?.schemas ?? {}).length}`
);
