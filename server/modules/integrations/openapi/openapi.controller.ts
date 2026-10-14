import { Controller, Get } from '@nestjs/common';
import { NeedLogin } from '@server/platform';
import { CanCapability } from '@server/modules/integrations/integration-authz';
import { ROUTES_CATALOG } from './routes.catalog';
import { buildOpenApiDocument } from './openapi.builder';

/**
 * C-12 在线契约：返回本批次新增接口的 OpenAPI 3.0 文档。
 * 需登录 + audit 能力（当前矩阵仅 admin 为 rw），避免把接口清单裸暴露。
 * Swagger UI 由 SWAGGER_ENABLED=true 控制挂载（见 swagger-ui.module.ts）。
 */
@NeedLogin()
@Controller('api/openapi')
export class OpenApiController {
  @CanCapability('audit')
  @Get('json')
  getDocument(): Record<string, unknown> {
    return buildOpenApiDocument(ROUTES_CATALOG);
  }
}
