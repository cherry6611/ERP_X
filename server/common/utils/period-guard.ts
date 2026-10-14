import { BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { finPeriodClose } from '@server/database/schema';

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
}
