import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { compAuditLog } from '@server/database/schema';
import { redactValue } from './audit-redact';

const ACTION_MAP: Record<string, string> = {
  POST: 'create',
  PATCH: 'update',
  PUT: 'update',
  DELETE: 'delete',
};

const logger = new Logger('AuditInterceptor');

/** 全局写操作审计：POST/PATCH/PUT/DELETE 成功后追加写入审计日志（只追加，不更新） */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{
      method: string;
      originalUrl: string;
      body: Record<string, unknown>;
      userContext?: { userId?: string };
    }>();
    const action = ACTION_MAP[request.method];
    if (!action) return next.handle();
    const path = request.originalUrl.split('?')[0] ?? '';
    const segments = path.split('/').filter(Boolean);
    const apiIndex = segments.indexOf('api');
    const objectType =
      apiIndex >= 0 ? (segments[apiIndex + 1] ?? 'unknown') : 'unknown';
    return next.handle().pipe(
      tap((response: unknown) => {
        const resp = response as
          | { id?: string; code?: string; status?: string }
          | undefined;
        const body = request.body as
          | { code?: string; id?: string }
          | undefined;
        const detail = JSON.stringify({
          method: request.method,
          path,
          body: redactValue(request.body),
        });
        void this.db
          .insert(compAuditLog)
          .values({
            actor: request.userContext?.userId ?? 'anonymous',
            action,
            objectType,
            objectId: resp?.id ?? body?.id ?? null,
            objectCode: resp?.code ?? body?.code ?? null,
            statusBefore: null,
            statusAfter: resp?.status ?? null,
            detail,
          })
          .catch((error: unknown) => {
            logger.error('审计日志写入失败', error as Error);
          });
      })
    );
  }
}
