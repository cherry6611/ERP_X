import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, ne, sum } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import {
  erpApBill,
  erpAr,
  erpArWriteoff,
  erpInvoice,
  erpReceipt,
  mdCustomer,
  mdSupplier,
} from '@server/database/schema';

export interface ReconRow {
  id: string;
  code: string;
  counterpartName: string;
  amount: number;
  linkedAmount: number;
  openAmount: number;
  status: string;
  linkId: string | null;
  linkCode: string | null;
  flag: 'ok' | 'unlinked' | 'over' | 'voided_risk';
}

@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /** 进项发票 ↔ 应付 */
  async listPurchaseAp(): Promise<ReconRow[]> {
    const invoices = await this.db
      .select({
        invoice: erpInvoice,
        supplierName: mdSupplier.name,
        apCode: erpApBill.code,
        apAmount: erpApBill.amount,
      })
      .from(erpInvoice)
      .leftJoin(mdSupplier, eq(erpInvoice.supplierId, mdSupplier.id))
      .leftJoin(erpApBill, eq(erpInvoice.apId, erpApBill.id))
      .where(eq(erpInvoice.direction, 'purchase'))
      .orderBy(desc(erpInvoice.createdAt))
      .limit(500);

    const rows: ReconRow[] = [];
    for (const row of invoices) {
      const amount = Number(row.invoice.amount ?? 0);
      const apAmount = row.apAmount != null ? Number(row.apAmount) : 0;
      let linkedAmount = 0;
      if (row.invoice.apId) {
        const sumRows = await this.db
          .select({ total: sum(erpInvoice.amount) })
          .from(erpInvoice)
          .where(
            and(
              eq(erpInvoice.apId, row.invoice.apId),
              eq(erpInvoice.status, 'issued'),
              eq(erpInvoice.direction, 'purchase'),
            ),
          );
        linkedAmount = Number(sumRows[0]?.total ?? 0);
      }
      let flag: ReconRow['flag'] = 'ok';
      if (row.invoice.status === 'voided') flag = 'voided_risk';
      else if (!row.invoice.apId) flag = 'unlinked';
      else if (linkedAmount > apAmount + 0.01) flag = 'over';
      rows.push({
        id: row.invoice.id,
        code: row.invoice.code,
        counterpartName: row.supplierName ?? '',
        amount,
        linkedAmount,
        openAmount: Math.max(0, apAmount - linkedAmount),
        status: row.invoice.status ?? 'issued',
        linkId: row.invoice.apId,
        linkCode: row.apCode ?? null,
        flag,
      });
    }
    return rows;
  }

  /** 销项发票 ↔ 应收 */
  async listSalesAr(): Promise<ReconRow[]> {
    const invoices = await this.db
      .select({
        invoice: erpInvoice,
        customerName: mdCustomer.name,
        arCode: erpAr.code,
        arAmount: erpAr.amount,
      })
      .from(erpInvoice)
      .leftJoin(mdCustomer, eq(erpInvoice.customerId, mdCustomer.id))
      .leftJoin(erpAr, eq(erpInvoice.arId, erpAr.id))
      .where(eq(erpInvoice.direction, 'sales'))
      .orderBy(desc(erpInvoice.createdAt))
      .limit(500);

    return invoices.map((row) => {
      const amount = Number(row.invoice.amount ?? 0);
      const arAmount = row.arAmount != null ? Number(row.arAmount) : 0;
      let flag: ReconRow['flag'] = 'ok';
      if (row.invoice.status === 'voided') flag = 'voided_risk';
      else if (!row.invoice.arId) flag = 'unlinked';
      else if (amount > arAmount + 0.01) flag = 'over';
      return {
        id: row.invoice.id,
        code: row.invoice.code,
        counterpartName: row.customerName ?? '',
        amount,
        linkedAmount: row.invoice.arId ? amount : 0,
        openAmount: row.invoice.arId ? Math.max(0, arAmount - amount) : amount,
        status: row.invoice.status ?? 'issued',
        linkId: row.invoice.arId,
        linkCode: row.arCode ?? null,
        flag,
      };
    });
  }

  /** 回款 ↔ 核销覆盖 */
  async listReceiptWriteoff(): Promise<ReconRow[]> {
    const receipts = await this.db
      .select({
        receipt: erpReceipt,
        customerName: mdCustomer.name,
      })
      .from(erpReceipt)
      .leftJoin(mdCustomer, eq(erpReceipt.customerId, mdCustomer.id))
      .orderBy(desc(erpReceipt.createdAt))
      .limit(500);

    const rows: ReconRow[] = [];
    for (const row of receipts) {
      const amount = Number(row.receipt.amount ?? 0);
      const usedRows = await this.db
        .select({ total: sum(erpArWriteoff.amount) })
        .from(erpArWriteoff)
        .where(eq(erpArWriteoff.receiptId, row.receipt.id));
      const linkedAmount = Number(usedRows[0]?.total ?? 0);
      let flag: ReconRow['flag'] = 'ok';
      if (row.receipt.status === 'voided') {
        flag = linkedAmount > 0.01 ? 'voided_risk' : 'ok';
      } else if (linkedAmount <= 0.01) flag = 'unlinked';
      else if (linkedAmount > amount + 0.01) flag = 'over';
      rows.push({
        id: row.receipt.id,
        code: row.receipt.code,
        counterpartName: row.customerName ?? '',
        amount,
        linkedAmount,
        openAmount: Math.max(0, amount - linkedAmount),
        status: row.receipt.status ?? 'unmatched',
        linkId: null,
        linkCode: null,
        flag,
      });
    }
    return rows;
  }

  async bindPurchaseAp(invoiceId: string, apId: string): Promise<void> {
    // D-11：FOR UPDATE 与额度校验、更新必须在同一事务内，否则锁语句结束即释放
    await this.db.transaction(async (tx) => {
      const inv = await tx
        .select()
        .from(erpInvoice)
        .where(eq(erpInvoice.id, invoiceId))
        .for('update');
      if (inv.length === 0) throw new NotFoundException('发票不存在');
      if ((inv[0].direction ?? '') !== 'purchase') {
        throw new BadRequestException('仅进项发票可勾稽应付');
      }
      if ((inv[0].status ?? '') === 'voided') {
        throw new BadRequestException('作废发票不可勾稽');
      }
      const ap = await tx
        .select()
        .from(erpApBill)
        .where(eq(erpApBill.id, apId))
        .for('update');
      if (ap.length === 0) throw new NotFoundException('应付不存在');
      const invoicedRows = await tx
        .select({ total: sum(erpInvoice.amount) })
        .from(erpInvoice)
        .where(
          and(
            eq(erpInvoice.apId, apId),
            eq(erpInvoice.status, 'issued'),
            ne(erpInvoice.id, invoiceId),
          ),
        );
      const cumulative =
        Number(invoicedRows[0]?.total ?? 0) + Number(inv[0].amount ?? 0);
      if (cumulative > Number(ap[0].amount ?? 0) + 0.001) {
        throw new BadRequestException(
          `勾稽后累计开票 ${cumulative} 超过应付 ${ap[0].amount}`,
        );
      }
      await tx
        .update(erpInvoice)
        .set({ apId, updatedAt: new Date() })
        .where(eq(erpInvoice.id, invoiceId));
    });
  }

  async unbindPurchaseAp(invoiceId: string): Promise<void> {
    const inv = await this.db
      .select()
      .from(erpInvoice)
      .where(eq(erpInvoice.id, invoiceId));
    if (inv.length === 0) throw new NotFoundException('发票不存在');
    await this.db
      .update(erpInvoice)
      .set({ apId: null, updatedAt: new Date() })
      .where(eq(erpInvoice.id, invoiceId));
  }

  async summary(): Promise<{
    purchaseUnlinked: number;
    salesUnlinked: number;
    receiptUnlinked: number;
    voidedRisk: number;
  }> {
    const [p, s, r] = await Promise.all([
      this.listPurchaseAp(),
      this.listSalesAr(),
      this.listReceiptWriteoff(),
    ]);
    return {
      purchaseUnlinked: p.filter((x) => x.flag === 'unlinked').length,
      salesUnlinked: s.filter((x) => x.flag === 'unlinked').length,
      receiptUnlinked: r.filter((x) => x.flag === 'unlinked').length,
      voidedRisk: [...p, ...s, ...r].filter((x) => x.flag === 'voided_risk').length,
    };
  }
}
