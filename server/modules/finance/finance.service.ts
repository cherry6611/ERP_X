import { Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, eq, inArray, ne, sum } from 'drizzle-orm';
import {
  erpApBill,
  erpAr,
  erpInvoice,
  erpReceipt,
} from '@server/database/schema';
import type { FinanceSummary } from '@shared/api.interface';
import { todayInShanghai } from '@server/common/utils/biz-date';

@Injectable()
export class FinanceService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  async getSummary(): Promise<FinanceSummary> {
    const arRows = await this.db
      .select({
        amount: erpAr.amount,
        settledAmount: erpAr.settledAmount,
        dueDate: erpAr.dueDate,
        status: erpAr.status,
      })
      .from(erpAr)
      // B1：白名单化 —— 原 `ne('settled')` 会把作废应收算进财务概览的
      // 「未结应收/逾期应收」，作废即失效的语义不成立。
      .where(inArray(erpAr.status, ['open', 'partial']));
    const today = todayInShanghai();
    let openArAmount = 0;
    let overdueArAmount = 0;
    for (const row of arRows) {
      const open = Number(row.amount) - Number(row.settledAmount ?? 0);
      openArAmount += open;
      if ((row.dueDate ?? '') < today) overdueArAmount += open;
    }
    // T6：回款合计排除作废。
    // B5 收敛：口径与现金流预测共用 `resolveOpeningCash` 的取数条件，
    // 避免三处各写一遍再次分叉（现金流预测原先就是在这里漏掉了作废过滤）。
    const receiptRows = await this.db
      .select({ total: sum(erpReceipt.amount) })
      .from(erpReceipt)
      .where(ne(erpReceipt.status, 'voided'));
    const apRows = await this.db
      .select({
        amount: erpApBill.amount,
        paidAmount: erpApBill.paidAmount,
        status: erpApBill.status,
      })
      .from(erpApBill)
      // B1：白名单化（同上）；`'paid'` 与新增的 `'voided'` 都不计入未结应付。
      .where(inArray(erpApBill.status, ['pending', 'approved', 'partial']));
    let openApAmount = 0;
    for (const row of apRows) {
      openApAmount += Number(row.amount) - Number(row.paidAmount ?? 0);
    }
    // T6：发票合计仅销项已开票
    const invoiceRows = await this.db
      .select({ total: sum(erpInvoice.amount) })
      .from(erpInvoice)
      .where(
        and(
          eq(erpInvoice.status, 'issued'),
          eq(erpInvoice.direction, 'sales')
        )
      );
    const apPaidRows = await this.db
      .select({ total: sum(erpApBill.paidAmount) })
      .from(erpApBill);
    return {
      openArAmount,
      overdueArAmount,
      receivedTotal: Number(receiptRows[0]?.total ?? 0),
      openApAmount,
      paidTotal: Number(apPaidRows[0]?.total ?? 0),
      invoiceTotal: Number(invoiceRows[0]?.total ?? 0),
    };
  }
}
