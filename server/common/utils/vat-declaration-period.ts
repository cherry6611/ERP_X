import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { finVatDeclaration } from '@server/database/schema';
import { unwrapRows } from './rows';

/**
 * 已确认增值税申报底稿的期间查询（跨模块共用，故放 `common/utils`）。
 *
 * ## 为什么需要它
 *
 * 有两处判断都必须知道"哪些期间已经申报过了"，而两处都不能依赖
 * `finance-reports` 模块（`finance` 模块导入它会形成循环依赖）：
 *
 *   1. **P0-C 跨月作废闸门**（`finance/invoice.service.ts`）：已申报期间的销项
 *      发票不得作废，必须改走红字发票流程 —— 否则底稿按 `status='issued'` 取数，
 *      已申报的销项税额会被**静默抹掉**（违反国税发〔2006〕156 号第二十条与
 *      国家税务总局公告 2016 年第 47 号）。
 *   2. **P0-B 留抵结转**（`finance-reports/vat-declaration.service.ts`）：
 *      上期已确认底稿的 `closing_credit` 是下期留抵的权威来源。
 *      该处按"指定主体"取数，本文件的 `isVatPeriodDeclared` 按"任一体"取数，
 *      两者语义不同、各有用途，**不是重复实现**。
 *
 * 放在 `common/utils` 是仓库既有约定：跨模块共享的**无状态**数据库工具
 * （如 `period-guard.ts`）都放这里，避免模块间互相 import service。
 */

/**
 * 该期间是否已被**任一**主体确认申报。
 *
 * 之所以不按主体过滤：发票作废是"票面动作"，而底稿按主体分户出具。
 * 只要有任何一户已就该期间完成申报，该期间的销项发票就已进入申报口径，
 * 作废它就会让已申报数据与台账脱节，因此一律拦截、改走红字发票。
 * （按主体过滤会留下口子：票面金额只挂在开票主体上，
 *  "另一主体的票在期间内被作废"本身就是数据错误。）
 */
export async function isVatPeriodDeclared(
  db: PostgresJsDatabase,
  period: string
): Promise<boolean> {
  if (!/^\d{4}-\d{2}$/.test(period)) return false;
  const rows = await db
    .select({ period: finVatDeclaration.period })
    .from(finVatDeclaration)
    .where(
      and(
        eq(finVatDeclaration.status, 'confirmed'),
        eq(finVatDeclaration.period, period)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** 任一已确认底稿中"最新的"期间；无则 null */
export async function latestDeclaredVatPeriod(
  db: PostgresJsDatabase
): Promise<string | null> {
  const rows = await db.execute(sql`
    SELECT max(period) AS period FROM fin_vat_declaration WHERE status = 'confirmed'
  `);
  return unwrapRows<{ period: string | null }>(rows)[0]?.period ?? null;
}

/**
 * 批量查询"已申报期间"集合，供列表页一次性标注（避免 N+1）。
 * 保持与 `isVatPeriodDeclared` 同一条件，两条路径不得分叉。
 */
export async function declaredVatPeriodSet(
  db: PostgresJsDatabase,
  periods: string[]
): Promise<Set<string>> {
  const unique = Array.from(
    new Set(periods.filter((p) => /^\d{4}-\d{2}$/.test(p)))
  );
  if (unique.length === 0) return new Set();
  const condition = and(
    eq(finVatDeclaration.status, 'confirmed'),
    inArray(finVatDeclaration.period, unique)
  ) as SQL;
  const rows = await db
    .select({ period: finVatDeclaration.period })
    .from(finVatDeclaration)
    .where(condition);
  return new Set(rows.map((row) => row.period));
}

