// 本地开发：显式加载仓库根 .env（生产由容器/编排注入环境变量，此处加载为空操作）
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import {
  BadRequestException,
  ConsoleLogger,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { appendFile, mkdirSync } from 'fs';
import { join } from 'path';
import { __express as hbsExpressEngine } from 'hbs';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { json, urlencoded, static as expressStatic } from 'express';
import type { Sql } from 'postgres';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { PG_CLIENT } from '@server/platform';
import { bindRateLimitSql } from '@server/common/security/rate-limit';
import { PostgresRateLimitStore } from '@server/common/security/pg-rate-limit.store';
import {
  allowWeakSecrets,
  isProductionRuntime,
} from '@server/common/utils/runtime-env';

/** D7：LOG_DIR 已设置时，在控制台之外追加 JSON Lines 到文件 */
class JsonFileLogger extends ConsoleLogger {
  private readonly filePath: string;

  constructor(logDir: string) {
    super();
    mkdirSync(logDir, { recursive: true });
    this.filePath = join(logDir, 'nest.jsonl');
  }

  private append(level: string, message: unknown, context?: string): void {
    // L2：异步追加，避免高 QPS 下 sync IO 阻塞事件循环
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      level,
      context: context ?? this.context,
      message,
    })}\n`;
    appendFile(this.filePath, line, () => {
      /* 文件写入失败不影响主流程 */
    });
  }

  override log(message: unknown, context?: string): void {
    super.log(message, context);
    this.append('log', message, context);
  }

  override error(message: unknown, stackOrContext?: string, context?: string): void {
    super.error(message, stackOrContext, context);
    this.append('error', { message, stack: stackOrContext }, context);
  }

  override warn(message: unknown, context?: string): void {
    super.warn(message, context);
    this.append('warn', message, context);
  }

  override debug(message: unknown, context?: string): void {
    super.debug(message, context);
    this.append('debug', message, context);
  }

  override verbose(message: unknown, context?: string): void {
    super.verbose(message, context);
    this.append('verbose', message, context);
  }
}

/**
 * 修复 P1-15：生产环境密钥强度/存在性此前完全不校验。
 * JWT_SECRET 若为空或仍是样例值，任何人都能伪造管理员会话；
 * SECRET_ENC_KEY 缺失会让飞书密钥写入直接失败（且失败点分散在业务里，排查成本高）。
 * 这里在启动阶段一次性 fail-fast，避免"带病上线"。
 */
/**
 * 修复 S1：原先仅在 NODE_ENV === 'production' 时才强制密钥强度。
 * 若生产被误配为 'prod'/空值/漏配，弱/空 JWT 密钥会被允许，攻击者可伪造管理员会话。
 *
 * 现改为**统一走 `runtime-env.ts` 的 fail-safe 判定**：
 * 只有显式 `NODE_ENV=development` 才降级，其余（含未设置）一律按生产强制。
 * `ALLOW_WEAK_SECRETS=true` 仅能在显式开发环境生效 —— 它不再是一个能整体关掉
 * 生产密钥校验的开关（原来 `NODE_ENV=prod` + `ALLOW_WEAK_SECRETS=true`
 * 会让 `abortOnError` 与密钥校验一起失效，等于一把钥匙全开）。
 */
function assertProductionSecrets(logger: Logger): void {
  const env = (process.env.NODE_ENV ?? '').trim() || '（未设置）';
  const allowWeak = allowWeakSecrets();
  const enforce = isProductionRuntime();
  const jwt = process.env.JWT_SECRET ?? '';
  const enc = process.env.SECRET_ENC_KEY ?? '';
  const weakJwt = new Set([
    '',
    'change-me',
    'changeme',
    'secret',
    'your-secret',
    'your_secret',
    'dev-secret',
  ]);
  if (enforce) {
    const problems: string[] = [];
    if (jwt.length < 32 || weakJwt.has(jwt.toLowerCase())) {
      problems.push('JWT_SECRET 缺失或强度不足（须 ≥32 字符且非样例值）');
    }
    if (enc.length < 16 || weakJwt.has(enc.toLowerCase())) {
      problems.push('SECRET_ENC_KEY 缺失或强度不足（须 ≥16 字符且非样例值）');
    }
    if (problems.length > 0) {
      logger.error(
        `密钥校验失败（NODE_ENV=${env} 按生产标准执行）：${problems.join('；')}` +
          '。本地开发请显式设置 NODE_ENV=development。'
      );
      throw new Error(`密钥校验失败：${problems.join('；')}`);
    }
    logger.log(`密钥校验通过（NODE_ENV=${env} 按生产标准执行）`);
    return;
  }
  if (jwt.length < 32) {
    logger.warn('JWT_SECRET 强度不足（<32 字符），上线前请更换');
  }
  if (enc.length === 0) {
    logger.warn('未配置 SECRET_ENC_KEY，飞书密钥写入功能不可用');
  }
  if (allowWeak) {
    logger.warn('ALLOW_WEAK_SECRETS=true：已显式允许弱密钥，仅限本地开发，禁止用于任何非开发环境');
  }
}

async function bootstrap() {
  const logDir = process.env.LOG_DIR?.trim();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    abortOnError: isProductionRuntime(),
    bodyParser: false,
    ...(logDir ? { logger: new JsonFileLogger(logDir) } : {}),
  });
  /*
   * 部署在 Nginx / SLB / CDN 之后时，若不设 trust proxy，req.ip 全是网关地址，
   * 全局限速会把所有用户一起封掉；但**直接暴露 3000 时默认信任 1 层**会让任意
   * 客户端用 X-Forwarded-For 伪造 IP，绕过登录限速与审计（P2-10）。
   * 因此默认 0 层，只有显式设置 TRUST_PROXY_HOPS=1（或更多）才信任反代。
   */
  const trustHopsRaw = process.env.TRUST_PROXY_HOPS;
  const hops = trustHopsRaw ? Number(trustHopsRaw) : 0;
  app.set('trust proxy', Number.isFinite(hops) && hops > 0 ? hops : 0);
  // 10MB 文件的 base64 约 14MB，限制略高于该值，避免把合法上传挡在门外
  app.use(json({ limit: '16mb' }));
  app.use(urlencoded({ extended: true, limit: '16mb' }));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", 'https:'],
          frameAncestors: ["'none'"],
        },
      },
    })
  );
  // L1：优先用 PG 共享限速（多实例一致）；失败时回退内存桶
  let rateLimitStore: PostgresRateLimitStore | undefined;
  try {
    const sql = app.get<Sql>(PG_CLIENT);
    bindRateLimitSql(sql);
    rateLimitStore = new PostgresRateLimitStore(sql);
  } catch {
    /* 启动早期若尚未注册 PG_CLIENT，保持进程内桶 */
  }
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: true,
      legacyHeaders: false,
      ...(rateLimitStore ? { store: rateLimitStore } : {}),
    })
  );
  // 修复 P1-9：ValidationPipe 默认只回 "Bad Request Exception"，
  // 前端拿到后无法定位是哪个字段不合法（whitelist+forbidNonWhitelisted 下尤其致命：
  // 多传一个字段就 400，却没有任何提示）。这里把校验错误翻成中文并按字段列出。
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => {
        const messages = errors.flatMap((err) => {
          const constraints = err.constraints ?? {};
          const fieldMessages = Object.values(constraints).map(String);
          if (fieldMessages.length > 0) return fieldMessages.map((m) => `${err.property}: ${m}`);
          const children = err.children ?? [];
          return children.map((c) => `${err.property}.${c.property}: 参数不合法`);
        });
        return new BadRequestException({
          code: 'BAD_REQUEST',
          message: messages.length > 0 ? messages.join('; ') : '请求参数不合法',
          fieldErrors: errors.map((err) => ({
            field: err.property,
            errors: Object.values(err.constraints ?? { unknown: '参数不合法' }).map(String),
          })),
          timestamp: Date.now(),
        });
      },
    })
  );
  app.use(expressStatic(join(process.cwd(), 'dist/client')));
  const logger = new Logger('Bootstrap');

  // M9：显式 CORS 策略，避免「同源隐性可用但不可审计」。
  // 默认不开启跨域（同源部署最安全）；需独立部署前端时以 CORS_ORIGIN 显式声明允许来源。
  // 任何非 Allowed 来源都会被浏览器拦截，且携带 credentials 时不允许 '*'。
  const corsOrigin = process.env.CORS_ORIGIN?.trim();
  if (corsOrigin) {
    const origins = corsOrigin
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    app.enableCors({
      origin: origins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });
    logger.log(`已启用 CORS，允许来源：${origins.join(', ')}`);
  } else {
    logger.log('CORS 未启用（默认仅同源）：跨域部署前端请配置 CORS_ORIGIN');
  }
  assertProductionSecrets(logger);
  const host = process.env.SERVER_HOST || 'localhost';
  const port = Number(process.env.SERVER_PORT || '3000');

  // 注册视图引擎, 渲染 client 目录下的 html 文件
  app.setBaseViewsDir(join(process.cwd(), 'dist/client'));
  app.setViewEngine('html');
  app.engine('html', hbsExpressEngine);

  // D1：优雅退出，给在途请求/事务收尾时间
  app.enableShutdownHooks();
  const shutdown = async (signal: string) => {
    logger.warn(`收到 ${signal}，开始优雅退出…`);
    try {
      await app.close();
      logger.log('服务已关闭');
      process.exit(0);
    } catch (error) {
      logger.error(
        '优雅退出失败',
        error instanceof Error ? error.stack : String(error)
      );
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  // F4-1：未处理 Promise / 未捕获异常兜底（配合 F4X-1，避免限流未 await 打崩进程）
  let uncaughtBurst = 0;
  let uncaughtWindowStart = Date.now();
  process.on('unhandledRejection', (reason) => {
    logger.error(
      '未处理的 Promise 拒绝',
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    );
  });
  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常，准备优雅退出', error.stack ?? error.message);
    const now = Date.now();
    if (now - uncaughtWindowStart > 60_000) {
      uncaughtWindowStart = now;
      uncaughtBurst = 0;
    }
    uncaughtBurst += 1;
    if (uncaughtBurst >= 5) {
      logger.error('60 秒内未捕获异常 ≥5 次，强制退出交由编排重启');
      process.exit(1);
      return;
    }
    void shutdown('uncaughtException');
  });

  logger.log(
    `进程时区 = ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
  );
  await app.listen(port, host);
  logger.log(`Server running on ${host}:${port}`);
  logger.log(`API endpoints ready at http://${host}:${port}/api`);
}

bootstrap();
