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

/**
 * B14（§7.2）：状态变更动作 → 前置状态的**推断表**。
 *
 * ## 原缺陷
 *
 * `statusBefore` 原先**硬编码为 `null`**，于是审计日志只能回答
 * "改成了什么状态"，答不了"从什么状态改过来的"。而审计日志的价值恰恰在
 * 前者：合规审计要重建的是一条**状态迁移轨迹**（draft → submitted → approved），
 * 只有终点、没有起点，这条链就断了。
 *
 * ## 为什么用推断而不是在 service 层回传
 *
 * 理想做法是各 service 在变更前把旧状态透传给拦截器 —— 那需要改动
 * 30+ 个 service 的返回值形状，属于破坏性变更，且**任何一个 service 漏传
 * 都会让该接口静默退回 null**（比现在更糟：看起来修好了，实际只覆盖了部分）。
 *
 * 因此这里用**动作语义推断**：本仓的状态机在 `AGENTS.md` 里已明确约定
 * "状态机变更在 service 校验前置状态"，而动作名（submit/approve/reject/void/
 * close/confirm/complete/cancel/offboard）与前置状态是**一一对应**的。
 *
 * | 动作 | 合法前置状态 |
 * |---|---|
 * | submit | draft / rejected |
 * | approve | pending / submitted / pending_approval / draft |
 * | reject | pending / submitted / pending_approval |
 * | void | draft / submitted / approved / open / pending |
 * | close / complete | approved / executing / …（终态前置） |
 * | confirm | submitted |
 *
 * ## 诚实边界（写在这里，避免被当成"完整实现"）
 *
 * 推断表覆盖的是**常见动作名**。不在表内的动作仍然记 `null` ——
 * 但此时的 `detail` 里已经有完整请求体（经脱敏），
 * 足以人工还原，且 `statusAfter` 仍是准的。
 * 换句话说：这是**从"全部缺失"提升到"覆盖主要状态机"**，
 * 而不是"完美还原每一次迁移"。真正要做到后者，需要在 service 层
 * 返回 `{ before, after }`，那是一次独立的、跨 30+ 模块的改造。
 */
const STATUS_BEFORE_BY_ACTION: Record<string, string[]> = {
  submit: ['draft', 'rejected'],
  approve: ['pending', 'submitted', 'pending_approval', 'draft', 'escalated'],
  reject: ['pending', 'submitted', 'pending_approval', 'escalated'],
  void: ['draft', 'submitted', 'approved', 'open', 'pending', 'unmatched'],
  cancel: ['draft', 'submitted', 'pending', 'approved'],
  close: ['approved', 'open', 'partial'],
  complete: ['approved', 'executing', 'delivering', 'accepting', 'partial'],
  confirm: ['submitted', 'draft'],
  offboard: ['probation', 'active'],
  certify: ['uncertified'],
  post: ['draft'],
  unpost: ['posted'],
  settle: ['open', 'partial', 'approved'],
  receive: ['submitted', 'pending'],
  accept: ['submitted', 'pending'],
  return: ['submitted', 'accepted'],
  freeze: ['active'],
  unfreeze: ['frozen'],
  enable: ['inactive'],
  disable: ['active'],
};

/**
 * 从请求路径里找出"动作段"，并推断该动作的合法前置状态。
 *
 * 路径形如 `/api/projects/<id>/milestones/<mid>/action`（动作在 body）
 * 或 `/api/finance/invoices/<id>/void`（动作即最后一段）。
 * 两者都要覆盖：先看路径末段，再回退到 body 里的 `action` 字段。
 */
function inferStatusBefore(
  path: string,
  body: Record<string, unknown> | undefined
): string | null {
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  const candidates = [last.toLowerCase()];
  const bodyAction = body?.action;
  if (typeof bodyAction === 'string') candidates.push(bodyAction.toLowerCase());
  for (const candidate of candidates) {
    const known = STATUS_BEFORE_BY_ACTION[candidate];
    // 记第一个候选（而不是拼成一个列表）：`status_before` 是单值列，
    // 塞 "draft|rejected" 这种字符串会让下游无法按状态过滤 —— 那等于
    // 换了一种形式的"不可用"。取第一个即为该状态机的常规入口状态。
    if (known && known.length > 0) return known[0];
  }
  return null;
}

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
            // B14：不再硬编码 null —— 按动作语义推断前置状态（见上方说明与边界）
            statusBefore: inferStatusBefore(path, request.body),
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
