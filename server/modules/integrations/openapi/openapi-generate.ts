/**
 * C-12 OpenAPI 生成入口。
 *
 * 单独成文件的原因：`scripts/gen-openapi.mjs` 与运行时 `/api/openapi/json`
 * 必须使用**同一实现**，避免"脚本产出的文档"与"在线文档"漂移。
 * 本文件只做编排，不含被 @Decorator / NestJS 依赖污染的代码。
 */

import { ROUTES_CATALOG } from './routes.catalog';
import {
  buildOpenApiDocument,
  serializeOpenApiDocument,
  type RoutesCatalog,
} from './openapi.builder';

export { ROUTES_CATALOG };

/** 生成 OpenAPI 3.0 文档（递归键排序，稳定可 diff） */
export function generateOpenApiDocument(
  catalog: RoutesCatalog = ROUTES_CATALOG
): Record<string, unknown> {
  return buildOpenApiDocument(catalog);
}

/** 生成 JSON 文本（末尾带换行，便于 CI diff） */
export function generateOpenApiJson(catalog: RoutesCatalog = ROUTES_CATALOG): string {
  return serializeOpenApiDocument(catalog);
}
