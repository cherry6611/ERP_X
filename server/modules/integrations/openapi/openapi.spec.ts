/**
 * C-12 OpenAPI 契约一致性测试。
 *
 * 目的：路由元数据（routes.catalog.ts）是手写声明，必须与真实 controller / DTO 对齐，
 * 否则文档会骗人。这里做三项机器校验：
 *  1) catalog 中的每条路由都能在 controller 源码里找到对应的 `@Method('path')` 装饰器；
 *     反向也要求 controller 里的每条路由都被 catalog 覆盖（无漏登记）；
 *  2) catalog 的 requestBody.schemaName 对应的属性集合，与 DTO 类上
 *     class-validator 装饰器覆盖的属性集合完全一致（多一个少一个都失败）；
 *  3) 生成结果可重复（两次生成逐字节一致）且键已排序。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES_CATALOG } from './routes.catalog';
import { buildOpenApiDocument, serializeOpenApiDocument } from './openapi.builder';

const SERVER_ROOT = join(__dirname, '..', '..', '..');

function readServerFile(relative: string): string {
  return readFileSync(join(SERVER_ROOT, relative), 'utf8');
}

/**
 * 归一化路径，便于与 catalog 比对：
 *  - Nest 的 `:id` → OpenAPI 的 `{id}`
 *  - 统一补前导 `/`（@Controller('api/x') 不带斜杠）
 */
function normalizePath(path: string): string {
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

interface DiscoveredRoute {
  method: string;
  path: string;
}

/** 从 controller 源码中提取路由（装饰器 + 方法名声明在同一行或相邻行） */
function discoverRoutes(source: string, controllerPrefix: string): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const pattern = /@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const method = match[1].toLowerCase();
    const sub = match[2] ?? '';
    const path =
      sub === ''
        ? controllerPrefix
        : sub.startsWith('/')
          ? sub
          : `${controllerPrefix}/${sub}`;
    routes.push({ method, path });
  }
  return routes;
}

function controllerPrefixOf(source: string): string {
  const match = /@Controller\(\s*'([^']*)'\s*\)/.exec(source);
  if (!match) throw new Error('未找到 @Controller 前缀');
  return match[1];
}

/** 提取 DTO 类中被 class-validator 装饰器覆盖的属性名 */
function decoratedProperties(source: string, className: string): Set<string> {
  const classStart = source.indexOf(`class ${className}`);
  if (classStart < 0) throw new Error(`未找到 DTO 类：${className}`);
  // 类体到下一个顶层 class/export 声明为止
  const rest = source.slice(classStart);
  const nextClass = rest.slice(1).search(/\n(export )?class /);
  const body = nextClass >= 0 ? rest.slice(0, nextClass + 1) : rest;
  const properties = new Set<string>();
  const pattern = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)[!?]?\s*:/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    properties.add(match[1]);
  }
  return properties;
}

const CONTROLLERS: Array<{ file: string; prefixHint: string }> = [
  { file: 'modules/integrations/bank/bank.controller.ts', prefixHint: 'api/finance' },
  { file: 'modules/integrations/exports/exports.controller.ts', prefixHint: 'api/exports' },
  { file: 'modules/integrations/tasks/tasks.controller.ts', prefixHint: 'api/tasks' },
  { file: 'modules/integrations/openapi/openapi.controller.ts', prefixHint: 'api/openapi' },
];

describe('C-12 catalog 与 controller 路由一致性', () => {
  const discovered: DiscoveredRoute[] = [];
  for (const controller of CONTROLLERS) {
    const source = readServerFile(controller.file);
    const prefix = controllerPrefixOf(source);
    expect(prefix).toBe(controller.prefixHint);
    discovered.push(...discoverRoutes(source, prefix));
  }

  it('controller 中每条路由都在 catalog 中登记（无漏登记）', () => {
    const catalogKeys = new Set(
      ROUTES_CATALOG.routes.map((route) => `${route.method} ${route.path}`)
    );
    const missing = discovered
      .map((route) => `${route.method} ${normalizePath(route.path)}`)
      .filter((key) => !catalogKeys.has(key));
    expect(missing).toEqual([]);
  });

  it('catalog 中每条路由都能在 controller 里找到（无幽灵文档）', () => {
    const discoveredKeys = new Set(
      discovered.map((route) => `${route.method} ${normalizePath(route.path)}`)
    );
    const ghosts = ROUTES_CATALOG.routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((key) => !discoveredKeys.has(key));
    expect(ghosts).toEqual([]);
  });

  it('operationId 唯一（OpenAPI 规范要求）', () => {
    const ids = ROUTES_CATALOG.routes.map((route) => route.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('路径参数在 parameters 中都有声明', () => {
    for (const route of ROUTES_CATALOG.routes) {
      const placeholders = [...route.path.matchAll(/\{([^}]+)\}/g)].map(
        (match) => match[1]
      );
      const declared = (route.parameters ?? [])
        .filter((parameter) => parameter.in === 'path')
        .map((parameter) => parameter.name);
      expect(declared.sort()).toEqual(placeholders.sort());
    }
  });
});

describe('C-12 catalog 与 DTO 一致性', () => {
  const DTO_SOURCES: Record<string, string> = {
    CreateBankAccountDto: 'modules/integrations/bank/bank.controller.ts',
    UpdateBankAccountDto: 'modules/integrations/bank/bank.controller.ts',
    ImportBankStatementDto: 'modules/integrations/bank/bank.controller.ts',
    AutoMatchBankStatementDto: 'modules/integrations/bank/bank.controller.ts',
    ManualMatchBankStatementDto: 'modules/integrations/bank/bank.controller.ts',
    UnmatchBankStatementDto: 'modules/integrations/bank/bank.controller.ts',
    SaveBankImportMappingDto: 'modules/integrations/bank/bank.controller.ts',
    CreateExportTaskDto: 'modules/integrations/exports/exports.controller.ts',
  };

  it('requestBody 引用的 DTO 都有对应 schema 与源码类', () => {
    for (const route of ROUTES_CATALOG.routes) {
      if (!route.requestBody) continue;
      const name = route.requestBody.schemaName;
      expect(ROUTES_CATALOG.schemas[name]).toBeDefined();
      expect(DTO_SOURCES[name]).toBeDefined();
    }
  });

  it('schema 属性集合与 DTO 装饰器属性集合完全一致', () => {
    const cache = new Map<string, string>();
    for (const [name, file] of Object.entries(DTO_SOURCES)) {
      const source = cache.get(file) ?? readServerFile(file);
      cache.set(file, source);
      const decorated = [...decoratedProperties(source, name)].sort();
      const schema = ROUTES_CATALOG.schemas[name];
      const declared = Object.keys(schema.properties ?? {}).sort();
      expect({ dto: name, properties: declared }).toEqual({
        dto: name,
        properties: decorated,
      });
    }
  });

  it('金额字段标注 2 位小数（@IsNumber({ maxDecimalPlaces: 2 }) 对应 multipleOf 0.01）', () => {
    const account = ROUTES_CATALOG.schemas.CreateBankAccountDto;
    expect(account.properties?.openingBalance).toMatchObject({
      type: 'number',
      multipleOf: 0.01,
    });
  });

  it('期间字段带 YYYY-MM 正则', () => {
    const reconciliation = ROUTES_CATALOG.routes.find(
      (route) => route.operationId === 'getBankReconciliation'
    );
    const period = reconciliation?.parameters?.find((item) => item.name === 'period');
    expect(period?.schema.pattern).toBe('^\\d{4}-(0[1-9]|1[0-2])$');
    expect(period?.required).toBe(true);
  });

  it('UUID 参数标注 format=uuid', () => {
    const detail = ROUTES_CATALOG.routes.find(
      (route) => route.operationId === 'getBankStatement'
    );
    const id = detail?.parameters?.find((item) => item.name === 'id');
    expect(id?.schema).toMatchObject({ type: 'string', format: 'uuid' });
  });
});

describe('C-12 生成结果稳定性', () => {
  it('两次生成逐字节一致（可重复执行）', () => {
    expect(serializeOpenApiDocument(ROUTES_CATALOG)).toBe(
      serializeOpenApiDocument(ROUTES_CATALOG)
    );
  });

  it('顶层与 paths 键已排序', () => {
    const document = buildOpenApiDocument(ROUTES_CATALOG);
    const keys = Object.keys(document);
    expect(keys).toEqual([...keys].sort());
    const paths = Object.keys(document.paths as Record<string, unknown>);
    expect(paths).toEqual([...paths].sort());
    const schemas = Object.keys(
      (document.components as { schemas: Record<string, unknown> }).schemas
    );
    expect(schemas).toEqual([...schemas].sort());
  });

  it('覆盖本批次全部新增接口（路径清单快照）', () => {
    const document = buildOpenApiDocument(ROUTES_CATALOG);
    expect(Object.keys(document.paths as Record<string, unknown>).sort()).toEqual([
      '/api/exports',
      '/api/exports/{id}',
      '/api/exports/{id}/download',
      '/api/finance/bank-accounts',
      '/api/finance/bank-accounts/{id}',
      '/api/finance/bank-import-mappings',
      '/api/finance/bank-reconciliation',
      '/api/finance/bank-statements',
      '/api/finance/bank-statements/auto-match',
      '/api/finance/bank-statements/import',
      '/api/finance/bank-statements/match-stat',
      '/api/finance/bank-statements/unmatched',
      '/api/finance/bank-statements/{id}',
      '/api/finance/bank-statements/{id}/ignore',
      '/api/finance/bank-statements/{id}/match',
      '/api/finance/bank-statements/{id}/unmatch',
      '/api/openapi/json',
      '/api/tasks/my',
      '/api/tasks/summary',
    ]);
  });

  it('每个操作都标注了鉴权摘要与 4xx 说明', () => {
    const document = buildOpenApiDocument(ROUTES_CATALOG);
    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
    for (const [path, entry] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(entry)) {
        expect({ path, method, auth: operation['x-auth'] }).toEqual({
          path,
          method,
          auth: expect.stringContaining('@NeedLogin'),
        });
        const responses = operation.responses as Record<string, unknown>;
        expect(Object.keys(responses)).toContain('4XX');
      }
    }
  });
});
