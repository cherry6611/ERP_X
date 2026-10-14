/**
 * C-12 开放接口（OpenAPI 3.0）：文档构建器。
 *
 * 设计要点：
 *  1) 本文件是**纯函数**：不依赖 NestJS 容器、不依赖数据库，脚本与运行时共用同一实现，
 *     因此 `node scripts/gen-openapi.mjs` 与运行中的服务产出的文档结构完全一致。
 *  2) 所有对象键递归排序后输出，保证脚本可重复执行、diff 稳定。
 *  3) 路由清单来自 `routes.catalog.ts`（显式登记，便于与 DTO 做一致性测试）。
 */

/** JSON Schema 子集（与 class-validator 装饰器一一对应） */
export interface OpenApiSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  format?: string;
  description?: string;
  enum?: string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  /** decimal 精度（与 @IsNumber({ maxDecimalPlaces }) 对应） */
  multipleOf?: number;
  default?: string | number | boolean;
  nullable?: boolean;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  additionalProperties?: boolean | OpenApiSchema;
}

export interface CatalogParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description?: string;
  schema: OpenApiSchema;
}

export interface CatalogRoute {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  /** 权限注解摘要（NeedLogin / CanCapability / CanRole），用于文档可读性 */
  auth: string;
  parameters?: CatalogParameter[];
  /** 请求体：schemaName 指向 components.schemas 中的键名 */
  requestBody?: {
    schemaName: string;
    required: boolean;
    contentType: 'application/json' | 'multipart/form-data';
  };
  /** 响应：'200' / '202'，schemaName 可为空（返回数组时用 arrayOf） */
  responses: Array<{
    status: string;
    description: string;
    schemaName?: string;
    arrayOf?: string;
  }>;
}

export interface RoutesCatalog {
  title: string;
  version: string;
  description: string;
  /** components.schemas：键名为模型名 */
  schemas: Record<string, OpenApiSchema>;
  routes: CatalogRoute[];
}

type Json = Record<string, unknown>;

/** 递归按键名排序，保证输出稳定（可重复执行、可 diff） */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeysDeep(item));
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = sortKeysDeep(source[key]);
  }
  return sorted;
}

function schemaRef(name: string): Json {
  return { $ref: `#/components/schemas/${name}` };
}

function toParameter(parameter: CatalogParameter): Json {
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.required,
    ...(parameter.description ? { description: parameter.description } : {}),
    schema: parameter.schema as unknown as Json,
  };
}

function toRequestBody(route: CatalogRoute): Json | undefined {
  if (!route.requestBody) return undefined;
  return {
    required: route.requestBody.required,
    content: {
      [route.requestBody.contentType]: {
        schema: schemaRef(route.requestBody.schemaName),
      },
    },
  };
}

function toResponses(route: CatalogRoute): Json {
  const responses: Json = {};
  for (const response of route.responses) {
    const schema = response.schemaName
      ? response.arrayOf
        ? { type: 'array', items: schemaRef(response.schemaName) }
        : schemaRef(response.schemaName)
      : response.arrayOf
        ? { type: 'array', items: schemaRef(response.arrayOf) }
        : undefined;
    responses[response.status] = {
      description: response.description,
      ...(schema ? { content: { 'application/json': { schema } } } : {}),
    };
  }
  if (!responses['4XX'] && !responses['default']) {
    responses['4XX'] = { description: '业务校验失败（错误结构见 exception.filter 的 error 包装）' };
  }
  return responses;
}

/** 生成 OpenAPI 3.0 文档（未排序；调用 buildOpenApiDocument 得到稳定输出） */
export function buildOpenApiDocumentUnstable(catalog: RoutesCatalog): Json {
  const paths: Json = {};
  const tags = new Set<string>();
  for (const route of catalog.routes) {
    for (const tag of route.tags) tags.add(tag);
    const pathEntry = (paths[route.path] as Json | undefined) ?? {};
    pathEntry[route.method] = {
      operationId: route.operationId,
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      tags: [...route.tags].sort(),
      'x-auth': route.auth,
      ...(route.parameters && route.parameters.length > 0
        ? { parameters: route.parameters.map((item) => toParameter(item)) }
        : {}),
      ...(route.requestBody ? { requestBody: toRequestBody(route) } : {}),
      responses: toResponses(route),
    };
    paths[route.path] = pathEntry;
  }

  const schemas: Json = {};
  for (const [name, schema] of Object.entries(catalog.schemas)) {
    schemas[name] = schema as unknown as Json;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: catalog.title,
      version: catalog.version,
      description: catalog.description,
    },
    tags: [...tags].sort().map((name) => ({ name })),
    servers: [{ url: '/', description: '当前服务（同源）' }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'erp_session',
          description: '登录会话 Cookie（由 /api/auth/login 下发）',
        },
      },
    },
    security: [{ sessionCookie: [] }],
  };
}

/** 稳定输出：递归键排序 */
export function buildOpenApiDocument(catalog: RoutesCatalog): Json {
  return sortKeysDeep(buildOpenApiDocumentUnstable(catalog)) as Json;
}

/** 序列化为 JSON 文本（2 空格缩进 + 末尾换行，便于 diff 与 CI 校验） */
export function serializeOpenApiDocument(catalog: RoutesCatalog): string {
  return `${JSON.stringify(buildOpenApiDocument(catalog), null, 2)}\n`;
}
