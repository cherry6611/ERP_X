/**
 * L7 · 数据访问层说明（收敛口径）
 *
 * 本仓统一使用 `postgres`（postgres.js）驱动 + drizzle-orm，**不**引入 node-postgres `pg`。
 *
 * - `DRIZZLE_DATABASE`：请求级代理（SessionMiddleware 注入 RLS 事务）
 * - `RAW_DATABASE`：同连接的 drizzle 实例，用于中间件开启事务本身
 * - `PG_CLIENT`：底层 `Sql`，仅用于 advisory lock / 跨实例限速等必须裸 SQL 的场景
 *
 * 新业务模块必须注入 `DRIZZLE_DATABASE`；禁止再新增第三种客户端。
 */
export const DATABASE_LAYER = 'postgres.js + drizzle-orm' as const;
