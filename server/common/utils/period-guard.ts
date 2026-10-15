import { BadRequestException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { finPeriodClose, finYearEndClose } from '@server/database/schema';
import { unwrapRows } from './rows';

/** D-27：业务写入统一校验期间未结账（与凭证侧口径一致） */
export async function assertPeriodOpen(
  db: PostgresJsDatabase,
  periodOrDate: string,
  action: string,
): Promise<void> {
  const period = periodOrDate.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new BadRequestException(`期间格式无效：${periodOrDate}`);
  }
  const closedRows = await db
    .select({ period: finPeriodClose.period })
    .from(finPeriodClose)
    .where(eq(finPeriodClose.period, period))
    .limit(1);
  if (closedRows.length > 0) {
    throw new BadRequestException(`期间 ${period} 已结账，禁止${action}`);
  }
  // P2-2：禁止「补记到已结账期间之前」。
  //
  // 跳期结账（例如 11 月未结就直接结 12 月）本身不是错误，真正破坏报表的是它留下的
  // 缺口：12 月已按当时数据结账并出了报表，之后仍能往 11 月写入凭证 —— 11 月的期末余额
  // 变了，12 月的期初/本期数却已经冻结，两份报表从此互相矛盾。
  //
  // 因此这里守住真正的不变量：**任何早于「最新已结账期间」的写入都必须先反结账**。
  // 这样既不必强迫用户按顺序结账（很多账套会跳着结），又保证缺口不能被补记。
  const latestRows = await db.execute(sql`
    SELECT max(period) AS period FROM fin_period_close
    WHERE period ~ '^[0-9]{4}-[0-9]{2}$'
  `);
  const latestClosed = unwrapRows<{ period: string | null }>(latestRows)[0]?.period ?? null;
  if (latestClosed && period < latestClosed) {
    throw new BadRequestException(
      `期间 ${period} 早于已结账期间 ${latestClosed}，禁止${action}；` +
        `如需调整请先反结账 ${latestClosed} 及其后续已结账期间`
    );
  }
}

/**
 * P0-3：会计年度已年结后的「年度只读」闸门。
 *
 * 月结（`fin_period_close`）与年结（`fin_year_end_close`）是**两张表、两套语义**：
 * 只做月结拦截时，只要某月未月结，用户仍能在已出年结报表的年度里新增/过账凭证，
 * 「年结即只读」的承诺不成立。这里与 `assertPeriodOpen` 并列，供凭证新增/过账/作废
 * 与自动凭证钩子共同调用（放在 `common` 层，避免 VoucherModule ↔ FinanceReportsModule
 * 循环依赖）。
 */
export async function assertFiscalYearOpen(
  db: PostgresJsDatabase,
  periodOrDate: string,
): Promise<void> {
  const period = periodOrDate.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) return;
  const fiscalYear = Number(period.slice(0, 4));
  const rows = await db
    .select({ id: finYearEndClose.id })
    .from(finYearEndClose)
    .where(
      and(
        eq(finYearEndClose.fiscalYear, fiscalYear),
        eq(finYearEndClose.status, 'closed'),
      ),
    )
    .limit(1);
  if (rows.length > 0) {
    throw new BadRequestException(
      `会计年度 ${fiscalYear} 已年结，期间 ${period} 只读；如需调整请先反年结`,
    );
  }
}

