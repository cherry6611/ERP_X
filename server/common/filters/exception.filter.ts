import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { BusinessException } from '../interfaces/exception.interface';
import { HTTP_STATUS_TO_RESPONSE_CODE_MAP, ResponseCode } from '../constants/api_response_code';
import { ApiErrorResponse } from '../interfaces/api_response.interface';

/** SQLSTATE → HTTP 语义映射。生产只回通用中文提示，原始报文仅落日志。 */
const DB_ERROR_MAP: Record<
  string,
  { status: number; code: string; message: string }
> = {
  // 非法类型输入，最常见的是 ID 不是合法 UUID
  '22P02': {
    status: HttpStatus.BAD_REQUEST,
    code: ResponseCode.BAD_REQUEST,
    message: '请求参数格式有误（请检查 ID / 数值字段）',
  },
  // 非空字段缺失
  '23502': {
    status: HttpStatus.BAD_REQUEST,
    code: ResponseCode.BAD_REQUEST,
    message: '必填字段缺失',
  },
  // 外键约束：关联记录不存在，或记录仍被引用不可删除
  '23503': {
    status: HttpStatus.BAD_REQUEST,
    code: ResponseCode.BAD_REQUEST,
    message: '关联记录不存在或仍被引用，无法完成操作',
  },
  // 唯一约束冲突：重复提交
  '23505': {
    status: HttpStatus.CONFLICT,
    code: ResponseCode.CONFLICT,
    message: '记录已存在，请勿重复提交',
  },
  // CHECK 约束（税率档位、纳税主体类型等）
  '23514': {
    status: HttpStatus.BAD_REQUEST,
    code: ResponseCode.BAD_REQUEST,
    message: '数据不满足业务校验规则',
  },
  // 数值超出字段精度
  '22003': {
    status: HttpStatus.BAD_REQUEST,
    code: ResponseCode.BAD_REQUEST,
    message: '数值超出允许范围',
  },
  // 事务串行化失败 / 死锁，客户端可重试
  '40001': {
    status: HttpStatus.CONFLICT,
    code: ResponseCode.CONFLICT,
    message: '并发冲突，请重试',
  },
  '40P01': {
    status: HttpStatus.CONFLICT,
    code: ResponseCode.CONFLICT,
    message: '并发冲突，请重试',
  },
};

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  /** 取请求方法与路径，用于日志定位（拿不到时返回 '-'） */
  private requestPath(ctx: {
    getRequest: <T = unknown>() => T;
  }): string {
    try {
      const req = ctx.getRequest<{ method?: string; originalUrl?: string }>();
      return `${String(req?.method ?? '-')} ${String(req?.originalUrl ?? '-')}`;
    } catch {
      return '-';
    }
  }

  /**
   * 修复 P1-16：Drizzle 会把驱动异常包一层（DrizzleQueryError），
   * 真正的 PostgreSQL 错误码在 cause 链里。原过滤器只检查 exception.code，
   * 因此 22P02（非法 UUID）等错误全部穿透成 500 —— 客户端传错 ID 就报服务器内部错误，
   * 既误导排查也让 5xx 告警失真。这里沿 cause 链找出 SQLSTATE 并映射成正确的 4xx。
   */
  private sqlState(exception: unknown): string | null {
    const SQLSTATE = /^[0-9A-Z]{5}$/u;
    let current: unknown = exception;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      if (typeof current !== 'object') break;
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && SQLSTATE.test(code)) return code;
      current = (current as { cause?: unknown }).cause;
    }
    return null;
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (response.headersSent) {
      return;
    }

    let errorResponse: Omit<ApiErrorResponse, 'httpStatus'>;
    let httpStatus: HttpStatus;
    const isProd = process.env.NODE_ENV === 'production';

    if (exception instanceof BusinessException) {
      httpStatus = exception.httpStatus;
      // 修复 P2-1：业务异常（越权、参数非法、重复提交）此前完全不落日志，
      // 生产上无法观测也无法做暴力尝试告警。
      const ctxPath = this.requestPath(ctx);
      if (httpStatus < 500) {
        this.logger.warn(
          `[${String(httpStatus)}] ${ctxPath} ${String(exception.code)} ${exception.message}`
        );
      } else {
        this.logger.error(
          `[${String(httpStatus)}] ${ctxPath} ${String(exception.code)} ${exception.message}`
        );
      }
      errorResponse = {
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          fieldErrors: exception.fieldErrors,
          timestamp: Date.now(),
        },
      };
    } else if (exception instanceof HttpException) {
      httpStatus = exception.getStatus() as HttpStatus;
      const exceptionResponse = exception.getResponse();
      const ctxPath = this.requestPath(ctx);
      if (httpStatus >= 500) {
        this.logger.error(`[${String(httpStatus)}] ${ctxPath} ${exception.message}`);
      } else {
        this.logger.debug(`[${String(httpStatus)}] ${ctxPath} ${exception.message}`);
      }

      errorResponse = {
        error: {
          code: HTTP_STATUS_TO_RESPONSE_CODE_MAP[httpStatus],
          message:
            typeof exceptionResponse === 'string'
              ? exceptionResponse
              : exception.message,
          // 修复 P2-2：ValidationPipe 的 details 会回显完整 DTO 字段与约束，
          // 生产环境不应暴露内部结构。
          details:
            !isProd && typeof exceptionResponse === 'object'
              ? JSON.stringify(exceptionResponse)
              : undefined,
          timestamp: Date.now(),
        },
      };
    } else {
      const sqlState = this.sqlState(exception);
      const mapped = sqlState ? DB_ERROR_MAP[sqlState] : undefined;
      if (mapped) {
        httpStatus = mapped.status as HttpStatus;
        const detail =
          exception instanceof Error ? exception.message : String(exception);
        // 4xx 是客户端问题，按 warn 记；原始报文只在非生产回显，避免泄漏库表结构
        this.logger.warn(
          `[${String(httpStatus)}] ${this.requestPath(ctx)} SQLSTATE ${sqlState} ${detail}`
        );
        errorResponse = {
          error: {
            code: mapped.code,
            message: mapped.message,
            details: !isProd ? detail : undefined,
            timestamp: Date.now(),
          },
        };
      } else {
        httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
        const message =
          exception instanceof Error ? exception.message : String(exception);
        const stack = exception instanceof Error ? exception.stack : undefined;
        this.logger.error(message, stack);
        errorResponse = {
          error: {
            code: ResponseCode.INTERNAL_ERROR,
            message: '服务器内部错误',
            ...(isProd
              ? {}
              : {
                  stack,
                  cause:
                    exception instanceof Error
                      ? (exception.cause as string | undefined)
                      : undefined,
                }),
            timestamp: Date.now(),
          },
        };
      }
    }

    response.status(httpStatus).json(errorResponse);
  }
}
