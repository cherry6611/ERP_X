/**
 * C-12 Swagger UI 挂载（仅 SWAGGER_ENABLED=true 时生效，且必须登录/内网）。
 *
 * 为什么不裸暴露：
 *  - openapi.json 与 UI 会暴露完整接口清单、参数与权限模型，属敏感信息；
 *  - 因此默认不挂载；启用时必须配置 SWAGGER_USER/SWAGGER_PASSWORD，
 *    且 UI 与 json 都在同一 Basic 认证之下（401 + WWW-Authenticate）。
 *
 * 路由：
 *  - GET /api-docs            → Swagger UI（HTML，spec 指向 /api-docs/openapi.json）
 *  - GET /api-docs/openapi.json → OpenAPI 文档（与 docs/openapi.json 同源同结构）
 *  - GET /api-docs/assets/*   → swagger-ui-dist 静态资源
 */

import { timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Logger, type INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ROUTES_CATALOG } from './routes.catalog';
import { serializeOpenApiDocument } from './openapi.builder';

const SWAGGER_BASE = '/api-docs';

type ExpressHandler = (req: Request, res: Response, next: NextFunction) => void;

/** Express 应用/路由器的变参重载（见 mountSwaggerUi 注释） */
export interface ExpressLikeInstance {
  get(path: string, ...handlers: ExpressHandler[]): unknown;
  use(path: string, ...handlers: ExpressHandler[]): unknown;
}

/** 常量时间比较，避免 Basic 认证凭据被逐字符探测 */
export function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 解析 HTTP Basic 头；格式非法返回 null */
export function parseBasicAuth(header: string | undefined): {
  user: string;
  password: string;
} | null {
  if (!header) return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return {
    user: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

/** 是否允许访问 Swagger UI（启用开关 + 凭据校验，纯函数便于单测） */
export function isSwaggerAuthorized(input: {
  enabled: boolean;
  expectedUser: string;
  expectedPassword: string;
  header: string | undefined;
}): boolean {
  if (!input.enabled) return false;
  // 未配置凭据视为不安全配置，直接拒绝（不裸暴露）
  if (!input.expectedUser || !input.expectedPassword) return false;
  const credentials = parseBasicAuth(input.header);
  if (!credentials) return false;
  return (
    safeCompare(credentials.user, input.expectedUser) &&
    safeCompare(credentials.password, input.expectedPassword)
  );
}

/** Swagger UI 页面（自定义初始化为同源 spec，避免依赖默认 URL） */
export function buildSwaggerHtml(specUrl: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>晟笙 ERP 开放接口</title>
    <link rel="stylesheet" href="${SWAGGER_BASE}/assets/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${SWAGGER_BASE}/assets/swagger-ui-bundle.js"></script>
    <script>
      window.onload = function () {
        window.ui = SwaggerUIBundle({
          url: ${JSON.stringify(specUrl)},
          dom_id: '#swagger-ui',
          deepLinking: true,
          docExpansion: 'none',
          defaultModelsExpandDepth: -1,
          persistAuthorization: false,
        });
      };
    </script>
  </body>
</html>
`;
}

/**
 * 挂载 Swagger UI。未启用时直接返回（不影响服务）。
 * 使用 express 中间件直接挂载，避免引入额外的 NestJS 平台适配层。
 */
export function mountSwaggerUi(app: INestApplication): void {
  const logger = new Logger('SwaggerUi');
  const enabled = process.env.SWAGGER_ENABLED === 'true';
  if (!enabled) {
    logger.log('Swagger UI 未挂载（SWAGGER_ENABLED != true）');
    return;
  }
  const expectedUser = process.env.SWAGGER_USER?.trim() ?? '';
  const expectedPassword = process.env.SWAGGER_PASSWORD ?? '';
  if (!expectedUser || !expectedPassword) {
    logger.error(
      'SWAGGER_ENABLED=true 但未配置 SWAGGER_USER / SWAGGER_PASSWORD，已拒绝挂载（避免裸暴露）'
    );
    return;
  }

  const httpAdapter = app.getHttpAdapter();
  // Express 适配器的 get/use 支持 (path, mw..., handler) 变参形式，
  // 但 NestJS 的 CommonHttpServer 接口只声明了 2 参重载，这里收敛成一个本地类型。
  const instance = httpAdapter.getInstance() as ExpressLikeInstance;

  const guard = (req: Request, res: Response, next: NextFunction): void => {
    const allowed = isSwaggerAuthorized({
      enabled,
      expectedUser,
      expectedPassword,
      header: req.headers.authorization,
    });
    if (!allowed) {
      res.setHeader('WWW-Authenticate', 'Basic realm="ShengSheng ERP API Docs"');
      res.status(401).type('text/plain').send('需要登录后访问接口文档');
      return;
    }
    next();
  };

  const spec = serializeOpenApiDocument(ROUTES_CATALOG);
  const html = buildSwaggerHtml(`${SWAGGER_BASE}/openapi.json`);

  instance.get(
    `${SWAGGER_BASE}/openapi.json`,
    guard,
    (_req: Request, res: Response) => {
      res.type('application/json').send(spec);
    }
  );
  instance.use(
    `${SWAGGER_BASE}/assets`,
    guard,
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const require = createRequire(__filename);
        const dist = dirname(require.resolve('swagger-ui-dist/package.json'));
        const relative = req.path.replace(/^\/+/, '');
        if (relative.includes('..')) {
          res.status(400).type('text/plain').send('非法路径');
          return;
        }
        const content = readFileSync(join(dist, relative));
        res
          .type(relative.endsWith('.css') ? 'text/css' : 'application/javascript')
          .send(content);
      } catch {
        next();
      }
    }
  );
  instance.get(SWAGGER_BASE, guard, (_req: Request, res: Response) => {
    res.type('text/html').send(html);
  });
  instance.get(`${SWAGGER_BASE}/`, guard, (_req: Request, res: Response) => {
    res.type('text/html').send(html);
  });

  logger.warn(
    `Swagger UI 已挂载：${SWAGGER_BASE}（Basic 认证保护，仅内网使用；如需关闭请移除 SWAGGER_ENABLED）`
  );
}
