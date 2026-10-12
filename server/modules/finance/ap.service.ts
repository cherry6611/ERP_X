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
import { and, desc, eq, sum } from 'drizzle-orm';
import {
  erpApBill,
  erpApWriteoff,
  erpPayment,
  erpProject,
  mdSupplier,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import type {
  ApItem,
  ApStatus,
  ApWriteoffDto,
  CreateApDto,
  CreatePaymentDto,
  PaymentItem,
  PaymentStatus,
} from '@shared/api.interface';

@Injectable()
export class ApService {
  private readonly logger = new Logger(ApService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService
  ) {}

  async listAps(supplierId?: string, status?: string): Promise<ApItem[]> {
    const conditions = [];
    if (supplierId) conditions.push(eq(erpApBill.supplierId, supplierId));
    if (status) conditions.push(eq(erpApBill.status, status));
    const rows = await this.db
      .select({
        ap: erpApBill,
        supplierName: mdSupplier.name,
        projectName: erpProject.name,
      })
      .from(erpApBill)
      .leftJoin(mdSupplier, eq(erpApBill.supplierId, mdSupplier.id))
      .leftJoin(erpProject, eq(erpApBill.projectId, erpProject.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(erpApBill.createdAt));
    return rows.map((row) => ({
      id: row.ap.id,
      code: row.ap.code,
      supplierId: row.ap.supplierId ?? '',
      supplierName: row.supplierName ?? '',
      projectId: row.ap.projectId,
      projectName: row.projectName,
      amount: Number(row.ap.amount ?? 0),
      paidAmount: Number(row.ap.paidAmount ?? 0),
      dueDate: row.ap.dueDate,
      status: (row.ap.status ?? 'pending') as ApStatus,
      source: row.ap.source ?? 'manual',
      sourceRef: row.ap.sourceRef,
      remark: row.ap.remark,
      createdAt: row.ap.createdAt.toISOString(),
    }));
  }

  async createAp(dto: CreateApDto): Promise<ApItem> {
    const supplier = await this.db
      .select({ id: mdSupplier.id, name: mdSupplier.name })
      .from(mdSupplier)
      .where(eq(mdSupplier.id, dto.supplierId));
    if (supplier.length === 0) throw new NotFoundException('供应商不存在');
    const code = await generateBizCode(
      this.db,
      erpApBill,
      erpApBill.code,
      'APB'
    );
    const rows = await this.db
      .insert(erpApBill)
      .values({
        code,
        supplierId: dto.supplierId,
        projectId: dto.projectId,
        amount: String(dto.amount),
        paidAmount: '0',
        dueDate: dto.dueDate,
        status: 'pending',
        source: dto.source ?? 'manual',
        sourceRef: dto.sourceRef,
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];
    let projectName: string | null = null;
    if (row.projectId) {
      const project = await this.db
        .select({ name: erpProject.name })
        .from(erpProject)
        .where(eq(erpProject.id, row.projectId));
      projectName = project[0]?.name ?? null;
    }
    return {
      id: row.id,
      code: row.code,
      supplierId: row.supplierId ?? '',
      supplierName: supplier[0].name,
      projectId: row.projectId,
      projectName,
      amount: Number(row.amount ?? 0),
      paidAmount: Number(row.paidAmount ?? 0),
      dueDate: row.dueDate,
      status: (row.status ?? 'pending') as ApStatus,
      source: row.source ?? 'manual',
      sourceRef: row.sourceRef,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listPayments(apId?: string): Promise<PaymentItem[]> {
    const rows = await this.db
      .select({
        payment: erpPayment,
        apCode: erpApBill.code,
        supplierName: mdSupplier.name,
      })
      .from(erpPayment)
      .leftJoin(erpApBill, eq(erpPayment.apId, erpApBill.id))
      .leftJoin(mdSupplier, eq(erpPayment.supplierId, mdSupplier.id))
      .where(apId ? eq(erpPayment.apId, apId) : undefined)
      .orderBy(desc(erpPayment.createdAt));
    return rows.map((row) => ({
      id: row.payment.id,
      code: row.payment.code,
      apId: row.payment.apId ?? '',
      apCode: row.apCode,
      supplierId: row.payment.supplierId ?? '',
      supplierName: row.supplierName ?? '',
      amount: Number(row.payment.amount ?? 0),
      payDate: row.payment.payDate,
      method: row.payment.method ?? 'bank',
      status: (row.payment.status ?? 'pending') as PaymentStatus,
      approver: row.payment.approver,
      remark: row.payment.remark,
      createdAt: row.payment.createdAt.toISOString(),
    }));
  }

  /** 付款登记（草稿），审批通过后才能核销 */
  async createPayment(dto: CreatePaymentDto): Promise<PaymentItem> {
    const apRows = await this.db
      .select()
      .from(erpApBill)
      .where(eq(erpApBill.id, dto.apId));
    if (apRows.length === 0) throw new NotFoundException('应付记录不存在');
    const ap = apRows[0];
    const remaining = Number(ap.amount) - Number(ap.paidAmount ?? 0);
    if (dto.amount > remaining) {
      throw new BadRequestException(`付款金额超过应付未付余额 ${remaining}`);
    }
    const code = await generateBizCode(
      this.db,
      erpPayment,
      erpPayment.code,
      'PAY'
    );
    const rows = await this.db
      .insert(erpPayment)
      .values({
        code,
        apId: dto.apId,
        supplierId: ap.supplierId,
        amount: String(dto.amount),
        payDate: dto.payDate,
        method: dto.method ?? 'bank',
        status: 'pending',
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];
    const supplier = await this.db
      .select({ name: mdSupplier.name })
      .from(mdSupplier)
      .where(eq(mdSupplier.id, row.supplierId ?? ''));
    return {
      id: row.id,
      code: row.code,
      apId: row.apId ?? '',
      apCode: ap.code,
      supplierId: row.supplierId ?? '',
      supplierName: supplier[0]?.name ?? '',
      amount: Number(row.amount ?? 0),
      payDate: row.payDate,
      method: row.method ?? 'bank',
      status: (row.status ?? 'pending') as PaymentStatus,
      approver: row.approver,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 付款审批：approve 置为已批准，reject 驳回 */
  async approvePayment(
    id: string,
    action: 'approve' | 'reject',
    approver: string
  ): Promise<PaymentItem> {
    const rows0 = await this.db
      .select()
      .from(erpPayment)
      .where(eq(erpPayment.id, id));
    if (rows0.length === 0) throw new NotFoundException('付款记录不存在');
    if ((rows0[0].status ?? 'pending') !== 'pending') {
      throw new BadRequestException('该付款已审批');
    }
    const rows = await this.db
      .update(erpPayment)
      .set({
        status: action === 'approve' ? 'approved' : 'rejected',
        approver,
        updatedAt: new Date(),
      })
      .where(eq(erpPayment.id, id))
      .returning();
    const row = rows[0];

    /* 付款审批通过 → 生成凭证草稿：借 应付账款(2202) / 贷 银行存款(1001) */
    if (action === 'approve') {
      const payAmount = Number(row.amount ?? 0);
      const voucherStatus = await this.voucherHookService.generateVoucherDraft({
        sourceType: 'payment',
        sourceRef: `payment:${row.code}`,
        voucherDate: row.payDate ?? new Date().toISOString().slice(0, 10),
        summary: `付款审批 ${row.code}`,
        lines: [
          { accountCode: '2202', debit: payAmount },
          { accountCode: '1001', credit: payAmount },
        ],
      });
      if (voucherStatus !== 'created') {
        this.logger.error(
          `付款凭证 voucherStatus=${voucherStatus} payment:${row.code}`
        );
      }
    }

    const ap = await this.db
      .select({ code: erpApBill.code })
      .from(erpApBill)
      .where(eq(erpApBill.id, row.apId ?? ''));
    const supplier = await this.db
      .select({ name: mdSupplier.name })
      .from(mdSupplier)
      .where(eq(mdSupplier.id, row.supplierId ?? ''));
    return {
      id: row.id,
      code: row.code,
      apId: row.apId ?? '',
      apCode: ap[0]?.code ?? null,
      supplierId: row.supplierId ?? '',
      supplierName: supplier[0]?.name ?? '',
      amount: Number(row.amount ?? 0),
      payDate: row.payDate,
      method: row.method ?? 'bank',
      status: (row.status ?? 'pending') as PaymentStatus,
      approver: row.approver,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 付款核销：将已批准的付款核销到应付（支持部分核销）。事务内锁行校验，防并发超核销 */
  async apWriteoff(dto: ApWriteoffDto): Promise<ApItem> {
    if (dto.amount <= 0) {
      throw new BadRequestException('核销金额必须大于 0');
    }
    await this.db.transaction(async (tx) => {
      const apRows = await tx
        .select()
        .from(erpApBill)
        .where(eq(erpApBill.id, dto.apId))
        .for('update');
      if (apRows.length === 0) throw new NotFoundException('应付记录不存在');
      const ap = apRows[0];
      const payRows = await tx
        .select()
        .from(erpPayment)
        .where(eq(erpPayment.id, dto.paymentId))
        .for('update');
      if (payRows.length === 0) throw new NotFoundException('付款记录不存在');
      const payment = payRows[0];
      if (payment.status !== 'approved') {
        throw new BadRequestException('仅已批准的付款可核销');
      }
      if (payment.apId !== dto.apId) {
        throw new BadRequestException('付款与应付不匹配，不可核销');
      }
      const apRemaining = Number(ap.amount) - Number(ap.paidAmount ?? 0);
      if (dto.amount > apRemaining) {
        throw new BadRequestException(`核销金额超过应付未付余额 ${apRemaining}`);
      }
      const usedRows = await tx
        .select({ total: sum(erpApWriteoff.amount) })
        .from(erpApWriteoff)
        .where(eq(erpApWriteoff.paymentId, dto.paymentId));
      const payRemaining =
        Number(payment.amount) - Number(usedRows[0]?.total ?? 0);
      if (dto.amount > payRemaining) {
        throw new BadRequestException(`核销金额超过付款未核销余额 ${payRemaining}`);
      }
      await tx.insert(erpApWriteoff).values({
        apId: dto.apId,
        paymentId: dto.paymentId,
        amount: String(dto.amount),
        writeoffDate: new Date().toISOString().slice(0, 10),
      });
      const newPaid = Number(ap.paidAmount ?? 0) + dto.amount;
      const apStatus =
        newPaid >= Number(ap.amount)
          ? 'paid'
          : newPaid > 0
            ? 'partial'
            : (ap.status ?? 'pending');
      await tx
        .update(erpApBill)
        .set({
          paidAmount: String(newPaid),
          status: apStatus,
          updatedAt: new Date(),
        })
        .where(eq(erpApBill.id, dto.apId));
      const newUsed = Number(usedRows[0]?.total ?? 0) + dto.amount;
      if (newUsed >= Number(payment.amount)) {
        await tx
          .update(erpPayment)
          .set({ status: 'paid', updatedAt: new Date() })
          .where(eq(erpPayment.id, dto.paymentId));
      }
    });
    const updated = await this.db
      .select({
        ap: erpApBill,
        supplierName: mdSupplier.name,
        projectName: erpProject.name,
      })
      .from(erpApBill)
      .leftJoin(mdSupplier, eq(erpApBill.supplierId, mdSupplier.id))
      .leftJoin(erpProject, eq(erpApBill.projectId, erpProject.id))
      .where(eq(erpApBill.id, dto.apId));
    const row = updated[0];
    return {
      id: row.ap.id,
      code: row.ap.code,
      supplierId: row.ap.supplierId ?? '',
      supplierName: row.supplierName ?? '',
      projectId: row.ap.projectId,
      projectName: row.projectName,
      amount: Number(row.ap.amount ?? 0),
      paidAmount: Number(row.ap.paidAmount ?? 0),
      dueDate: row.ap.dueDate,
      status: (row.ap.status ?? 'pending') as ApStatus,
      source: row.ap.source ?? 'manual',
      sourceRef: row.ap.sourceRef,
      remark: row.ap.remark,
      createdAt: row.ap.createdAt.toISOString(),
    };
  }
}
