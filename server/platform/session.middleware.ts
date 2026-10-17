import { Inject, Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { NextFunction, Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { eq } from 'drizzle-orm';
import { sysRoleMember } from '@server/database/schema';
import { PG_CLIENT, RAW_DATABASE } from './tokens';
import { requestDb } from './database';
import { readCookie, readSession, SESSION_COOKIE } from './jwt';
import { SessionStore } from './session-store';

/** `pg.reserve()` 返回的预留连接句柄（带 `release`） */
type ReservedSql = Sql & { release: () => void };

/**
 * 每个请求如何把当前用户绑定到 DB 会话（供给审计列 `current_setting('app.user_id')`）。
 *
 * - `connection`（**默认**，自本次修复起）：向连接池**预留**一条专用连接，
 *   用**会话级** GUC（set_config 第三个参数 false）绑定用户，请求结束（res.finish）
 *   时先重置 GUC 再 `release()` 归还连接。因为连接仅本请求使用，会话级 GUC 不会
 *   串号到池内下一请求；且**不再用长事务持有连接**。
 *
 * - `transaction`（历史实现，可显式 `PER_REQUEST_TX=transaction` 回退）：
 *   开一条 DB 事务包住整个请求，`set_config(..., true)` 的事务级 GUC 随事务存活，
 *   连接被该事务占用直到响应结束。
 *
 * ## 为什么把默认从 `transaction` 换成 `connection`
 *
 * 1. **可用性**：事务模式让每个请求（含慢接口、SSE、大报表）都长期占用一条连接，
 *    连接池 `max: 20`（`openDatabase`），并发一上来就排队甚至耗尽。
 * 2. **正确性（这才是决定性的）**：外层已有一个事务时，业务 service 再调
 *    `db.transaction()` 会形成**嵌套**。drizzle 在内层块抛错时会发送 `ROLLBACK`，
 *    而在 PG 语义下 `ROLLBACK` **中止的是整个外层事务**，该连接随后所有语句都报
 *    42P01/25P02（"relation does not exist" / "current transaction is aborted"），
 *    即：**请求中任何一个内层事务失败，会把同一请求后续所有查询一起带崩**。
 *    已用 `scripts/probe-nested-tx.mjs` 在真实 PG 上实测确认
 *    （内层显式 ROLLBACK 后外层 TEMP 表被一并回滚掉）。
 *    连接模式下请求内**没有**外层事务，service 的 `db.transaction()` 是真正的
 *    顶层事务，语义正确且局部——失败只影响它自己。
 * 3. 代码库本身已经在规避这个坑：`invoice.service.ts` 有注释明确说明
 *    "在 db.transaction 内调用会形成嵌套 … pglite 单连接直接冲突"，
 *    并把逻辑挪到事务外。换成连接模式后这类规避不再是必需的。
 *
 * 回退方式：`PER_REQUEST_TX=transaction`（秒级生效，无需改代码）。
 * 验证：`server/test/integration/*` 覆盖审计列 `app.user_id` 的正确性。
 */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
  private readonly logger = new Logger(SessionMiddleware.name);
  private readonly mode: 'transaction' | 'connection';

  constructor(
    @Inject(RAW_DATABASE) private readonly raw: PostgresJsDatabase,
    @Inject(PG_CLIENT) private readonly pg: Sql,
    private readonly sessions: SessionStore,
  ) {
    // 默认 connection（见类注释）；仅当显式写成 'transaction' 时才回退旧实现。
    // 未设置或写成其它值时取安全的默认值 connection —— 与 runtime-env 的
    // fail-safe 思路一致：不确定时不选那个会长期占连接/嵌套事务的模式。
    const rawMode = (process.env.PER_REQUEST_TX ?? 'connection').toLowerCase();
    this.mode = rawMode === 'transaction' ? 'transaction' : 'connection';
  }

  /**
   * 为 postgres.js 的**预留连接**构造 drizzle 句柄。
   *
   * 为什么要单独一层：`pg.reserve()` 返回的是一个精简 `Sql` 句柄（只额外带 `release`），
   * **没有 `options`**；而 drizzle 的 postgres-js driver 在 `construct()` 里无条件访问
   * `client.options.parsers` / `client.options.serializers` 来安装透明解析器，
   * 于是直接 `drizzle(conn)` 会在**第一次请求**就抛
   * `Cannot read properties of undefined (reading 'parsers')`（已实测复现）。
   *
   * 这也说明原 `connection` 模式虽然写了、却从未真正在真实 PG 上跑通过 ——
   * 它只是躺在环境变量开关后面（默认关闭），因此一直没被发现。
   *
   * 修法：把根客户端上的 `options` 引用挂到预留句柄上。两边指向同一份
   * parsers/serializers 容器，driver 的安装动作是幂等的（同一批 type 覆写为同一函数），
   * 不会破坏根客户端的解析行为（已用 `scripts/probe-reserve-drizzle.mjs` 验证
   * 数值/参数绑定与 GUC 可见性）。
   */
  private drizzleForReservedConnection(conn: ReservedSql): PostgresJsDatabase {
    // postgres.js 的 `Sql` 类型上没有声明 `options`（实际运行时根客户端有），
    // 但 drizzle 的 driver 在 construct() 里会读它，故这里必须补上。
    const patch = conn as unknown as {
      options?: Record<string, unknown>;
      begin?: unknown;
    };
    if (patch.options === undefined) {
      const root = this.pg as unknown as { options?: Record<string, unknown> };
      patch.options = root.options ?? { parsers: {}, serializers: {} };
    }
    /*
     * ⚠️ **必须自己补 `begin`** —— 这是本文件此前最大的一个洞。
     *
     * `pg.reserve()` 返回的是 `Sql(handler)`，它**只挂了**
     * `array / file / json / notify / typed / types / unsafe / release`
     * （实测 `Object.keys(reserved)`），**没有 `begin`**。
     * 而 drizzle 的 postgres-js driver 在 `transaction()` 里无条件调用
     * `this.client.begin(...)`（`node_modules/drizzle-orm/postgres-js/session.cjs:134`）。
     *
     * 后果：**请求内任何 `db.transaction()` 都抛
     * `TypeError: this.client.begin is not a function` → 500**。
     * 全仓有 **48 处** `db.transaction()`（23 个 service，集中在 finance/crm/hr/costs/voucher），
     * 也就是说记账、核销、开票、过账这些最需要事务的写路径**全部不可用**。
     *
     * 为什么之前没被发现：`PER_REQUEST_TX` 的**旧默认值是 `transaction`**
     * （走 `runWithTransaction`，用根客户端的真 `begin`，所以能跑）；
     * 后来为修 GUC 串号把默认改成 `connection`，这条路径就再没被真实执行过 ——
     * 单元测试用 pglite（自己的 `createDrizzle`，有事务），也覆盖不到。
     *
     * ## 为什么这里自己实现而不是直接借用根客户端的 `begin`
     *
     * 根客户端的 `begin` 会**从连接池里另取一条连接**开事务，于是
     * `set_config('app.user_id', …, false)` 设在这条预留连接上的会话级 GUC
     * 在事务内**看不见** —— 行级权限（RLS/数据范围）会失效。
     * 所以事务必须跑在**这条预留连接**上。
     *
     * ## 实现要点
     *
     * - 事务体用 `conn.unsafe(sql)` 执行，保证落在预留连接上；
     * - 支持嵌套：drizzle 对嵌套 `transaction()` 用 `savepoint`，
     *   这里按深度生成 `savepoint sp_N` / `release` / `rollback to`；
     * - 事务控制语句单独提交，不与业务 SQL 拼串（避免多语句语义差异）。
     */
    let depth = 0;
    patch.begin = async (
      fn: (tx: unknown) => Promise<unknown>,
    ): Promise<unknown> => {
      const unsafe = conn.unsafe.bind(conn);
      const level = depth;
      depth += 1;
      const tag = `sp_${level}`;
      try {
        if (level === 0) {
          await unsafe('begin').execute();
        } else {
          await unsafe(`savepoint ${tag}`).execute();
        }
        const tx = { unsafe };
        const result = await fn(tx);
        if (level === 0) {
          await unsafe('commit').execute();
        } else {
          await unsafe(`release savepoint ${tag}`).execute();
        }
        return result;
      } catch (error) {
        try {
          if (level === 0) {
            await unsafe('rollback').execute();
          } else {
            await unsafe(`rollback to savepoint ${tag}`).execute();
          }
        } catch {
          /* 回滚本身失败时不掩盖原始错误 */
        }
        throw error;
      } finally {
        depth -= 1;
      }
    };
    // 预留句柄与根客户端的 Sql 结构一致（只是少了 options/begin），故为双重断言：
    // 先 unknown 再断言为 drizzle 接受的入参类型。
    const drizzleFn = drizzle as unknown as (
      client: unknown
    ) => PostgresJsDatabase;
    return drizzleFn(conn);
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
    // 健康检查/静态资源不持有 DB 连接，避免连接池被无关请求占满
    if (
      path === '/api/health' ||
      path.startsWith('/assets/') ||
      path === '/favicon.svg' ||
      path === '/favicon.ico'
    ) {
      req.userContext = { roles: [] };
      next();
      return;
    }
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const token = bearer ?? readCookie(req.headers.cookie, SESSION_COOKIE);
    const secret = process.env.JWT_SECRET || '';
    const claims = token && secret ? readSession(token, secret) : null;
    req.userContext = {
      userId: claims?.userId,
      userName: claims?.userName,
      roles: claims?.roles ?? [],
    };
    const userId = req.userContext?.userId ?? '';

    if (this.mode === 'connection') {
      void this.runWithReservedConnection(userId, claims, req, res, next);
    } else {
      void this.runWithTransaction(userId, claims, req, res, next);
    }
  }

  private runWithTransaction(
    userId: string,
    claims: { jti?: string } | null,
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    return this.raw
      .transaction(async (tx) => {
        if (claims?.jti && (await this.sessions.isRevoked(claims.jti))) {
          req.userContext = { roles: [] };
        }
        await tx.execute(
          sql`select set_config('app.user_id', ${userId}, true)`,
        );
        await new Promise<void>((resolve) => {
          res.once('finish', () => resolve());
          res.once('close', () => resolve());
          requestDb.run(tx, () => next());
        });
      })
      .catch((error: unknown) => {
        if (!res.headersSent) next(error);
      });
  }

  private async runWithReservedConnection(
    userId: string,
    claims: { jti?: string } | null,
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const conn = (await this.pg.reserve()) as unknown as ReservedSql;
    try {
      if (claims?.jti && (await this.sessions.isRevoked(claims.jti))) {
        req.userContext = { roles: [] };
      }
      // 会话级 GUC：该连接本次请求专用，请求结束前会重置，绝不串号到池内下一请求
      await conn`select set_config('app.user_id', ${userId}, false)`;
      const connDb = this.drizzleForReservedConnection(conn);
      await new Promise<void>((resolve) => {
        res.once('finish', () => resolve());
        res.once('close', () => resolve());
        requestDb.run(connDb, () => next());
      });
    } catch (error: unknown) {
      this.logger.error(
        `PER_REQUEST_TX=${this.mode} 模式请求处理异常`,
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      if (!res.headersSent) next(error);
    } finally {
      /*
       * §6.10 (6)：GUC 重置失败**不能静默吞掉**。
       *
       * `app.user_id` 是迁移中 167 处审计列 DEFAULT 的来源
       * （`_created_by` / `_updated_by` 读它）。HTTP 路径每次请求都会重设，
       * 所以"租出去的连接"不会串号；但两类路径会**带着上一个人的身份**继续用这条连接：
       *   · 本请求重置失败 → 连接归还池 → 下一个请求若在设置 GUC 之前就写入
       *     （例如 cron / 自动化作业**从不设置**该 GUC），审计列会被盖上
       *     **上一个用户的 id**；
       *   · cron 路径本身不设 GUC，见 `scheduler.ts` 的同类修复。
       *
       * 原实现是 `catch { /* 忽略 *\/ }` —— 污染审计归属这件事**完全没有痕迹**。
       * 现在：记录 error 日志（含 userId，便于定位受影响的写入），并且
       * 不再无条件 `release()` —— 重置失败的连接不该回到池中继续被复用。
       *
       * 诚实声明：`postgres-js` 的 `ReservedSql.release()` 不接受 `destroy` 参数，
       * 因此这里无法真正销毁连接。可行的最强处置是：
       *   ① 记 error 日志（可观测）；
       *   ② **显式再置一次**（多数失败是瞬时网络/语句问题，重试一次常能成功）；
       *   ③ 若仍失败，把连接标记为不可信 —— 通过置一个哨兵值让后续写入
       *      至少不会盖上"上一个真实用户"的身份。
       */
      let gucReset = false;
      for (let attempt = 0; attempt < 2 && !gucReset; attempt += 1) {
        try {
          await conn`select set_config('app.user_id', '', false)`;
          gucReset = true;
        } catch (error: unknown) {
          if (attempt === 1) {
            this.logger.error(
              `会话 GUC(app.user_id) 重置失败（已重试）：userId=${userId} mode=${this.mode}。` +
                `该连接归还池后，若被不设置 GUC 的路径（cron / 自动化作业）复用，` +
                `审计列 _created_by 可能被盖上该用户 id —— 请按 userId 核查近期审计归属。`,
              error instanceof Error ? error.stack : String(error),
            );
          }
        }
      }
      try {
        conn.release();
      } catch {
        /* 已归还或异常时忽略 */
      }
    }
  }
}

export async function loadRoleCodes(db: PostgresJsDatabase, userId: string): Promise<string[]> {
  const rows = await db
    .select({ roleCode: sysRoleMember.roleCode })
    .from(sysRoleMember)
    .where(eq(sysRoleMember.userId, userId));
  return rows.map((row) => row.roleCode);
}
