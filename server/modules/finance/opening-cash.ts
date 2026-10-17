import { inArray, ne, sum } from 'drizzle-orm';
import type { PostgresJsDatabase } from '@server/platform';
import { erpPayment, erpReceipt } from '@server/database/schema';
import { round2 } from '@server/common/utils/number';

/**
 * 期初现金（= 累计已确认回款 − 累计已批准/已付付款）。
 *
 * ## 为什么必须抽成单一函数
 *
 * 这个口径原先在三处**各写了一遍**，且三份写法并不一致：
 *   - `finance.service.ts` 与 `bi-metrics.service.ts` 都排除了作废回款
 *     （`ne(erpReceipt.status, 'voided')`）；
 *   - `cash-flow.service.ts` 的 13 周现金流预测**没有这个条件**，
 *     直接把作废回款算成已收。
 *
 * 后果不是"数字略偏"，而是**方向性错误**：3 月录入 200 万回款、4 月作废后，
 * 现金流预测的期初现金仍多 200 万 → 13 周累计曲线整体高估 → 财务据此判断
 * "现金充裕、不用催款" → 直接造成备付金缺口。而另外两张报表是对的，
 * 所以人对不上账时也无从判断谁错。
 *
 * 一处遗漏的根因是"同一口径有多份实现"。因此这里收敛为唯一入口，
 * 三个调用方共用；新增任何"现金余额"口径一律走本函数，不要再写第四遍。
 */
export async function resolveOpeningCash(
  db: PostgresJsDatabase
): Promise<number> {
  const receiptRows = await db
    .select({ total: sum(erpReceipt.amount) })
    .from(erpReceipt)
    .where(ne(erpReceipt.status, 'voided'));
  const paymentRows = await db
    .select({ total: sum(erpPayment.amount) })
    .from(erpPayment)
    .where(inArray(erpPayment.status, ['approved', 'paid']));
  return round2(
    Number(receiptRows[0]?.total ?? 0) - Number(paymentRows[0]?.total ?? 0)
  );
}
