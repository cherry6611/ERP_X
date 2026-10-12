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
  mdCustomer,
  mdSupplier,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
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
  code: string | null;
  invoice_no: string | null;
  direction: string | null;
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService
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
      if (dto.amount > billable) {
        throw new BadRequestException(
          `开票金额超过合同可开金额，当前可开 ${billable}`
        );
      }
      const taxRate = dto.taxRate ?? Number(contract.taxRate ?? 6);
      const taxAmount = Math.round(dto.amount * (taxRate / 100) * 100) / 100;
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
          taxAmount: String(taxAmount),
          invoiceDate: dto.invoiceDate ?? new Date().toISOString().slice(0, 10),
          status: 'issued',
          remark: dto.remark,
        })
        .returning();
    });
    const row = rows[0];

    /* 发票 issued → 生成凭证草稿：借 应收账款(1122) / 贷 主营业务收入(6001) */
    const invoiceAmount = Number(row.amount ?? 0);
    const voucherStatus = await this.voucherHookService.generateVoucherDraft({
      sourceType: 'invoice',
      sourceRef: `invoice:${row.invoiceNo ?? row.code}`,
      voucherDate: row.invoiceDate ?? new Date().toISOString().slice(0, 10),
      summary: `开票确认 ${row.invoiceNo ?? row.code}`,
      lines: [
        { accountCode: '1122', debit: invoiceAmount },
        { accountCode: '6001', credit: invoiceAmount },
      ],
    });
    if (voucherStatus !== 'created') {
      this.logger.error(
        `发票凭证 voucherStatus=${voucherStatus} invoice:${row.invoiceNo ?? row.code}`
      );
    }

    return this.getInvoiceItem(row.id);
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
    const taxRate = dto.taxRate ?? 6;
    const taxAmount = Math.round(dto.amount * (taxRate / 100) * 100) / 100;
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
        taxAmount: String(taxAmount),
        invoiceDate: dto.invoiceDate ?? new Date().toISOString().slice(0, 10),
        status: 'issued',
        remark: dto.remark,
      })
      .returning();
    return this.getInvoiceItem(rows[0].id);
  }

  /** 作废发票：锁发票与合同行，作废后对销项生成反向凭证草稿 */
  async voidInvoice(id: string, userId: string): Promise<InvoiceItem> {
    const locked = await this.db.transaction(async (tx) => {
      const rows: unknown = await tx.execute(sql`
        SELECT id, status, contract_id, amount, code, invoice_no, direction
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

    if ((locked.direction ?? 'sales') === 'sales') {
      const amount = Number(locked.amount ?? 0);
      const ref = locked.invoice_no ?? locked.code ?? id;
      const voucherStatus = await this.voucherHookService.generateVoucherDraft({
        sourceType: 'invoice',
        sourceRef: `invoice-void:${ref}`,
        voucherDate: new Date().toISOString().slice(0, 10),
        summary: `发票作废冲销 ${ref}`,
        lines: [
          { accountCode: '6001', debit: amount },
          { accountCode: '1122', credit: amount },
        ],
      });
      if (voucherStatus !== 'created') {
        this.logger.error(
          `发票作废反向凭证 voucherStatus=${voucherStatus} invoice-void:${ref}`
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
