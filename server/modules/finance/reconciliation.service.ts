import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, ne, sql, sum } from 'drizzle-orm';
import type { ReconRowItem } from '@shared/api.interface';
import { round2 } from '@server/common/utils/number';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import {
  erpApBill,
  erpAr,
  erpArWriteoff,
  erpContract,
  erpInvoice,
  erpProjectRevenue,
  erpReceipt,
  finVoucher,
  finVoucherLine,
  mdCustomer,
  mdSupplier,
} from '@server/database/schema';

/** 勾稽明细行：契约以 shared 为唯一权威（ReconRowItem） */
export type ReconRow = ReconRowItem;


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

  /**
   * P1-1：应收未开票。
   *
   * 既有 `listSalesAr` 只看「发票→应收」方向（发票未关联应收），
   * 会让“已登记应收但一张发票都没开”的缺口（ARR0001-0003 这类）静默漏报。
   * 本方法补上反向口径：应收已确认、未作废发票累计为 0 的行。
   */
  async listArWithoutInvoice(): Promise<ReconRow[]> {
    const ars = await this.db
      .select({
        ar: erpAr,
        customerName: mdCustomer.name,
        contractName: erpContract.name,
      })
      .from(erpAr)
      .leftJoin(mdCustomer, eq(erpAr.customerId, mdCustomer.id))
      .leftJoin(erpContract, eq(erpAr.contractId, erpContract.id))
      .orderBy(desc(erpAr.createdAt))
      .limit(500);

    const rows: ReconRow[] = [];
    for (const row of ars) {
      const invoicedRows = await this.db
        .select({ total: sum(erpInvoice.amount) })
        .from(erpInvoice)
        .where(
          and(
            eq(erpInvoice.arId, row.ar.id),
            ne(erpInvoice.status, 'voided'),
          ),
        );
      const invoiced = Number(invoicedRows[0]?.total ?? 0);
      if (invoiced > 0.01) continue;
      const amount = Number(row.ar.amount ?? 0);
      rows.push({
        id: row.ar.id,
        code: row.ar.code,
        counterpartName:
          row.customerName ?? row.contractName ?? '',
        amount,
        linkedAmount: invoiced,
        openAmount: round2(amount - invoiced),
        status: row.ar.status ?? 'open',
        linkId: null,
        linkCode: null,
        flag: 'unlinked',
      });
    }
    return rows;
  }

  /**
   * P0-4 / P1-1：总账收入 vs 收入台账 差异检测。
   *
   * 总账口径：已过账凭证中 6001/6051 的贷方净发生额；
   * 台账口径：erp_project_revenue 中 status=recognized 的确认金额。
   * 两者应相等；不等说明存在“确认收入未入账”或“入账未确认”的双通道缺口。
   */
  async revenueVariance(period: string): Promise<{
    period: string;
    ledgerRevenue: number;
    bookRevenue: number;
    difference: number;
    passed: boolean;
  }> {
    // 总账收入：6001 主营业务收入 + 6051 其他业务收入（贷方 − 借方）
    const ledgerRows = await this.db
      .select({
        debit: sql<string>`coalesce(sum(${finVoucherLine.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${finVoucherLine.credit}), 0)`,
      })
      .from(finVoucherLine)
      .innerJoin(finVoucher, eq(finVoucherLine.voucherId, finVoucher.id))
      .where(
        and(
          eq(finVoucher.period, period),
          // 自动凭证生成后是 draft；只统计 posted 会让每次勾稽都显示差额。
          inArray(finVoucher.status, ['posted', 'draft']),
          sql`(${finVoucherLine.accountCode} like '6001%' or ${finVoucherLine.accountCode} like '6051%')`,
        ),
      );
    const ledgerRevenue = round2(
      Number(ledgerRows[0]?.credit ?? 0) - Number(ledgerRows[0]?.debit ?? 0),
    );

    // 收入台账：已确认收入合计（期间为 YYYY-MM），按合同税率反算不含税，
    // 与总账 6001/6051（不含税）同口径；否则含税台账永远比总账多一个税额。
    const bookRows = await this.db
      .select({
        total: sql<string>`coalesce(sum(
          case
            when coalesce(${erpContract.taxRate}, 0) <= 0 then ${erpProjectRevenue.amount}
            else ${erpProjectRevenue.amount} * 100 / (100 + ${erpContract.taxRate})
          end
        ), 0)`,
      })
      .from(erpProjectRevenue)
      .leftJoin(erpContract, eq(erpProjectRevenue.contractId, erpContract.id))
      .where(
        and(
          eq(erpProjectRevenue.period, period),
          eq(erpProjectRevenue.status, 'recognized'),
        ),
      );
    const bookRevenue = round2(Number(bookRows[0]?.total ?? 0));

    const difference = round2(ledgerRevenue - bookRevenue);
    return {
      period,
      ledgerRevenue,
      bookRevenue,
      difference,
      passed: Math.abs(difference) < 0.01,
    };
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
    arWithoutInvoice: number;
  }> {
    const [p, s, r, a] = await Promise.all([
      this.listPurchaseAp(),
      this.listSalesAr(),
      this.listReceiptWriteoff(),
      this.listArWithoutInvoice(),
    ]);
    return {
      purchaseUnlinked: p.filter((x) => x.flag === 'unlinked').length,
      salesUnlinked: s.filter((x) => x.flag === 'unlinked').length,
      receiptUnlinked: r.filter((x) => x.flag === 'unlinked').length,
      voidedRisk: [...p, ...s, ...r].filter((x) => x.flag === 'voided_risk').length,
      arWithoutInvoice: a.length,
    };
  }
}
