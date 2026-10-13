import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, desc, eq, sql, sum } from 'drizzle-orm';
import {
  erpAr,
  erpContract,
  erpInvoice,
  erpProject,
  erpProjectRevenue,
  mdCustomer,
  mdSupplier,
  mdTaxEntity,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { TaxEntityService } from '@server/modules/tax/tax-entity.service';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { splitTax } from '@shared/tax';
import { inputIssueLines, inputVoidLines } from '@server/common/tax/posting';
import type {
  CreateInvoiceDto,
  InvoiceDirection,
  InvoiceItem,
  InvoiceStatus,
  InvoiceType,
  UpdateInvoiceDto,
} from '@shared/api.interface';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InvoiceLockRow {
  id: string;
  status: string | null;
  contract_id: string | null;
  amount: string | null;
  tax_rate: string | null;
  code: string | null;
  invoice_no: string | null;
  direction: string | null;
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService,
    private readonly taxEntities: TaxEntityService,
    private readonly taxResolver: TaxResolverService
  ) {}

  async listInvoices(
    contractId?: string,
    direction?: string
  ): Promise<InvoiceItem[]> {
    const conditions = [];
    if (contractId) conditions.push(eq(erpInvoice.contractId, contractId));
    if (direction) conditions.push(eq(erpInvoice.direction, direction));
    const rows = await this.db
      .select({
        invoice: erpInvoice,
        contractName: erpContract.name,
        customerName: mdCustomer.name,
        projectName: erpProject.name,
        supplierName: mdSupplier.name,
        arCode: erpAr.code,
      })
      .from(erpInvoice)
      .leftJoin(erpContract, eq(erpInvoice.contractId, erpContract.id))
      .leftJoin(mdCustomer, eq(erpInvoice.customerId, mdCustomer.id))
      .leftJoin(erpProject, eq(erpInvoice.projectId, erpProject.id))
      .leftJoin(mdSupplier, eq(erpInvoice.supplierId, mdSupplier.id))
      .leftJoin(erpAr, eq(erpInvoice.arId, erpAr.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(erpInvoice.createdAt));
    return rows.map((row) => this.toInvoiceItem(row));
  }

  private toInvoiceItem(row: {
    invoice: typeof erpInvoice.$inferSelect;
    contractName: string | null;
    customerName: string | null;
    projectName: string | null;
    supplierName: string | null;
    arCode: string | null;
  }): InvoiceItem {
    return {
      id: row.invoice.id,
      code: row.invoice.code,
      contractId: row.invoice.contractId ?? '',
      contractName: row.contractName ?? '',
      customerId: row.invoice.customerId ?? '',
      customerName: row.customerName ?? '',
      projectId: row.invoice.projectId,
      projectName: row.projectName,
      invoiceNo: row.invoice.invoiceNo,
      invoiceType: (row.invoice.invoiceType ?? 'vat_special') as InvoiceType,
      direction: (row.invoice.direction ?? 'sales') as InvoiceDirection,
      supplierId: row.invoice.supplierId,
      supplierName: row.supplierName,
      arId: row.invoice.arId,
      arCode: row.arCode,
      amount: Number(row.invoice.amount ?? 0),
      taxRate: Number(row.invoice.taxRate ?? 0),
      taxAmount: Number(row.invoice.taxAmount ?? 0),
      invoiceDate: row.invoice.invoiceDate,
      status: (row.invoice.status ?? 'issued') as InvoiceStatus,
      remark: row.invoice.remark,
      createdAt: row.invoice.createdAt.toISOString(),
    };
  }

  private async getInvoiceItem(id: string): Promise<InvoiceItem> {
    const rows = await this.db
      .select({
        invoice: erpInvoice,
        contractName: erpContract.name,
        customerName: mdCustomer.name,
        projectName: erpProject.name,
        supplierName: mdSupplier.name,
        arCode: erpAr.code,
      })
      .from(erpInvoice)
      .leftJoin(erpContract, eq(erpInvoice.contractId, erpContract.id))
      .leftJoin(mdCustomer, eq(erpInvoice.customerId, mdCustomer.id))
      .leftJoin(erpProject, eq(erpInvoice.projectId, erpProject.id))
      .leftJoin(mdSupplier, eq(erpInvoice.supplierId, mdSupplier.id))
      .leftJoin(erpAr, eq(erpInvoice.arId, erpAr.id))
      .where(eq(erpInvoice.id, id));
    if (rows.length === 0) throw new NotFoundException('发票记录不存在');
    return this.toInvoiceItem(rows[0]);
  }

  private async assertArExists(arId: string): Promise<void> {
    if (!UUID_PATTERN.test(arId)) {
      throw new BadRequestException('arId 格式不合法');
    }
    const arRows = await this.db
      .select({ id: erpAr.id })
      .from(erpAr)
      .where(eq(erpAr.id, arId));
    if (arRows.length === 0) throw new NotFoundException('应收记录不存在');
  }

  async createInvoice(dto: CreateInvoiceDto): Promise<InvoiceItem> {
    if (dto.amount <= 0) {
      throw new BadRequestException('开票金额必须大于 0');
    }
    const direction: InvoiceDirection = dto.direction ?? 'sales';
    if (direction === 'purchase') {
      return this.createPurchaseInvoice(dto);
    }
    return this.createSalesInvoice(dto);
  }

  /** 销项开票：金额不得超过合同可开金额，可关联应收。事务内锁合同防并发超额 */
  private async createSalesInvoice(
    dto: CreateInvoiceDto
  ): Promise<InvoiceItem> {
    await this.taxEntities.assertReadyForPosting();
    if (!dto.contractId || !UUID_PATTERN.test(dto.contractId)) {
      throw new BadRequestException('contractId 格式不合法');
    }
    if (dto.arId) await this.assertArExists(dto.arId);
    const code = await generateBizCode(
      this.db,
      erpInvoice,
      erpInvoice.code,
      'INV'
    );
    const rows = await this.db.transaction(async (tx) => {
      const contractRows = await tx
        .select()
        .from(erpContract)
        .where(eq(erpContract.id, dto.contractId!))
        .for('update');
      if (contractRows.length === 0) throw new NotFoundException('合同不存在');
      const contract = contractRows[0];
      const invoicedRows = await tx
        .select({ total: sum(erpInvoice.amount) })
        .from(erpInvoice)
        .where(
          and(
            eq(erpInvoice.contractId, dto.contractId!),
            eq(erpInvoice.status, 'issued')
          )
        );
      const invoiced = Number(invoicedRows[0]?.total ?? 0);
      const contractAmount = Number(contract.amount ?? 0);
      const billable = contractAmount - invoiced;
      if (dto.amount > billable + 0.001) {
        throw new BadRequestException(
          `开票金额超过合同可开金额，当前可开 ${billable}`
        );
      }
      if (dto.arId) {
        const arRows = await tx
          .select()
          .from(erpAr)
          .where(eq(erpAr.id, dto.arId))
          .for('update');
        if (arRows.length === 0) throw new NotFoundException('应收记录不存在');
        const open =
          Number(arRows[0].amount ?? 0) - Number(arRows[0].settledAmount ?? 0);
        if (dto.amount > open + 0.001) {
          throw new BadRequestException(
            `开票金额超过未核销应收余额 ${open}`
          );
        }
      }
      const resolved = await this.taxResolver.resolve({
        explicit: dto.taxRate,
        upstream: Number(contract.taxRate ?? NaN),
        customerId: contract.customerId,
        taxEntityId: contract.taxEntityId,
        side: 'output',
      });
      const taxRate = resolved.rate;
      const split = splitTax(dto.amount, taxRate);
      const seller = resolved.taxEntityId
        ? await tx
            .select()
            .from(mdTaxEntity)
            .where(eq(mdTaxEntity.id, resolved.taxEntityId))
            .limit(1)
        : [];
      const buyer = contract.customerId
        ? await tx
            .select()
            .from(mdCustomer)
            .where(eq(mdCustomer.id, contract.customerId))
            .limit(1)
        : [];
      return tx
        .insert(erpInvoice)
        .values({
          code,
          contractId: dto.contractId,
          customerId: contract.customerId,
          projectId: dto.projectId,
          invoiceNo: dto.invoiceNo || code,
          invoiceType: dto.invoiceType,
          direction: 'sales',
          arId: dto.arId,
          amount: String(dto.amount),
          taxRate: String(taxRate),
          taxAmount: String(split.tax),
          netAmount: String(split.net),
          taxEntityId: resolved.taxEntityId,
          buyerName: buyer[0]?.invoiceTitle || buyer[0]?.name || null,
          buyerUscc:
            buyer[0]?.uscc && buyer[0].uscc.length <= 20 ? buyer[0].uscc : null,
          sellerName: seller[0]?.invoiceTitle || seller[0]?.name || null,
          sellerUscc: seller[0]?.uscc ?? null,
          invoiceDate: dto.invoiceDate ?? new Date().toISOString().slice(0, 10),
          status: 'issued',
          remark: dto.remark,
        })
        .returning();
    });
    const row = rows[0];
    // 方案 A：收入确认为准，销项开票只登记台账，不再生成收入/税凭证
    const item = await this.getInvoiceItem(row.id);
    const recognizedRows = await this.db
      .select({
        total: sql<string>`coalesce(sum(${erpProjectRevenue.amount}), 0)`,
      })
      .from(erpProjectRevenue)
      .where(eq(erpProjectRevenue.contractId, dto.contractId!));
    const recognized = Number(recognizedRows[0]?.total ?? 0);
    const invoicedAfter = await this.db
      .select({
        total: sql<string>`coalesce(sum(${erpInvoice.amount}), 0)`,
      })
      .from(erpInvoice)
      .where(
        and(
          eq(erpInvoice.contractId, dto.contractId!),
          eq(erpInvoice.status, 'issued')
        )
      );
    const invoicedTotal = Number(invoicedAfter[0]?.total ?? 0);
    if (invoicedTotal > recognized + 0.01) {
      item.warning = `开票额（累计 ${invoicedTotal}）超过已确认收入 ${recognized}`;
    }
    return item;
  }

  /** 进项发票登记：不关联合同/客户，可关联供应商 */
  private async createPurchaseInvoice(
    dto: CreateInvoiceDto
  ): Promise<InvoiceItem> {
    if (dto.supplierId) {
      const supplier = await this.db
        .select({ id: mdSupplier.id })
        .from(mdSupplier)
        .where(eq(mdSupplier.id, dto.supplierId));
      if (supplier.length === 0) throw new NotFoundException('供应商不存在');
    }
    await this.taxEntities.assertReadyForPosting();
    const resolved = await this.taxResolver.resolve({
      explicit: dto.taxRate,
      supplierId: dto.supplierId,
      side: 'input',
    });
    const taxRate = resolved.rate;
    const split = splitTax(dto.amount, taxRate);
    const code = await generateBizCode(
      this.db,
      erpInvoice,
      erpInvoice.code,
      'INV'
    );
    const rows = await this.db
      .insert(erpInvoice)
      .values({
        code,
        projectId: dto.projectId,
        invoiceNo: dto.invoiceNo || code,
        invoiceType: dto.invoiceType,
        direction: 'purchase',
        supplierId: dto.supplierId,
        amount: String(dto.amount),
        taxRate: String(taxRate),
        taxAmount: String(split.tax),
        netAmount: String(split.net),
        taxEntityId: resolved.taxEntityId,
        invoiceDate: dto.invoiceDate ?? new Date().toISOString().slice(0, 10),
        status: 'issued',
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];
    await this.voucherHookService.generateVoucherDraft({
      sourceType: 'invoice',
      sourceRef: `invoice:${row.invoiceNo ?? row.code}`,
      voucherDate: row.invoiceDate ?? new Date().toISOString().slice(0, 10),
      summary: `进项发票 ${row.invoiceNo ?? row.code}`,
      lines: inputIssueLines(Number(row.amount ?? 0), taxRate),
    });
    return this.getInvoiceItem(row.id);
  }

  /** 作废发票：锁发票与合同行，作废后对销项生成反向凭证草稿 */
  async voidInvoice(id: string, userId: string): Promise<InvoiceItem> {
    const locked = await this.db.transaction(async (tx) => {
      const rows: unknown = await tx.execute(sql`
        SELECT id, status, contract_id, amount, tax_rate, code, invoice_no, direction
        FROM erp_invoice
        WHERE id = ${id}
        FOR UPDATE
      `);
      const list = Array.isArray(rows)
        ? (rows as InvoiceLockRow[])
        : ((rows as { rows?: InvoiceLockRow[] }).rows ?? []);
      const invoice = list[0];
      if (!invoice) throw new NotFoundException('发票记录不存在');
      if (invoice.status !== 'issued') {
        throw new BadRequestException('仅已开票状态的发票可作废');
      }
      if (invoice.contract_id) {
        await tx.execute(sql`
          SELECT id FROM erp_contract WHERE id = ${invoice.contract_id} FOR UPDATE
        `);
      }
      const updated = await tx
        .update(erpInvoice)
        .set({ status: 'voided', updatedAt: new Date(), updatedBy: userId })
        .where(and(eq(erpInvoice.id, id), eq(erpInvoice.status, 'issued')))
        .returning({ id: erpInvoice.id });
      if (updated.length === 0) {
        throw new BadRequestException('仅已开票状态的发票可作废');
      }
      return invoice;
    });

    // 方案 A：销项作废只改状态；进项仍冲回凭证
    if ((locked.direction ?? 'sales') !== 'sales') {
      const amount = Number(locked.amount ?? 0);
      const rate = Number(locked.tax_rate ?? 0);
      const ref = locked.invoice_no ?? locked.code ?? id;
      const voucherStatus = await this.voucherHookService.generateVoucherDraft({
        sourceType: 'invoice',
        sourceRef: `invoice-void:${ref}`,
        voucherDate: new Date().toISOString().slice(0, 10),
        summary: `进项发票作废冲销 ${ref}`,
        lines: inputVoidLines(amount, rate),
      });
      if (voucherStatus !== 'created') {
        this.logger.error(
          `进项作废凭证 voucherStatus=${voucherStatus} invoice-void:${ref}`
        );
      }
    }
    return this.getInvoiceItem(id);
  }

  async updateInvoice(
    id: string,
    dto: UpdateInvoiceDto,
    userId: string
  ): Promise<InvoiceItem> {
    const patch: Partial<typeof erpInvoice.$inferInsert> = {};
    if (dto.invoiceNo !== undefined) patch.invoiceNo = dto.invoiceNo;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    if (dto.arId !== undefined) {
      if (dto.arId !== null) await this.assertArExists(dto.arId);
      patch.arId = dto.arId;
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }
    patch.updatedAt = new Date();
    patch.updatedBy = userId;
    const updated = await this.db
      .update(erpInvoice)
      .set(patch)
      .where(eq(erpInvoice.id, id))
      .returning({ id: erpInvoice.id });
    if (updated.length === 0) throw new NotFoundException('发票记录不存在');
    return this.getInvoiceItem(id);
  }
}
