import { Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, eq, ne, sum } from 'drizzle-orm';
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
      .where(ne(erpAr.status, 'settled'));
    const today = todayInShanghai();
    let openArAmount = 0;
    let overdueArAmount = 0;
    for (const row of arRows) {
      const open = Number(row.amount) - Number(row.settledAmount ?? 0);
      openArAmount += open;
      if ((row.dueDate ?? '') < today) overdueArAmount += open;
    }
    // T6：回款合计排除作废
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
      .where(ne(erpApBill.status, 'paid'));
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
