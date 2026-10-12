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
  erpAr,
  erpArWriteoff,
  erpContract,
  erpProject,
  erpReceipt,
  mdCustomer,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import type {
  AgingBucket,
  ArItem,
  ArStatus,
  ArWriteoffDto,
  CreateArDto,
  CreateReceiptDto,
  ReceiptItem,
  ReceiptStatus,
} from '@shared/api.interface';

const AGING_BUCKETS = [
  { label: '未到期', minDays: -99999, maxDays: 0 },
  { label: '1-30天', minDays: 1, maxDays: 30 },
  { label: '31-60天', minDays: 31, maxDays: 60 },
  { label: '61-90天', minDays: 61, maxDays: 90 },
  { label: '90天以上', minDays: 91, maxDays: 99999 },
];

@Injectable()
export class ArService {
  private readonly logger = new Logger(ArService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService
  ) {}

  private async buildArItem(row: {
    ar: typeof erpAr.$inferSelect;
    contractName: string | null;
    customerName: string | null;
    projectName: string | null;
  }): Promise<ArItem> {
    const today = new Date().toISOString().slice(0, 10);
    const status = (row.ar.status ?? 'open') as ArStatus;
    const open = Number(row.ar.amount) - Number(row.ar.settledAmount ?? 0);
    return {
      id: row.ar.id,
      code: row.ar.code,
      contractId: row.ar.contractId,
      contractName: row.contractName,
      customerId: row.ar.customerId ?? '',
      customerName: row.customerName ?? '',
      projectId: row.ar.projectId,
      projectName: row.projectName,
      amount: Number(row.ar.amount ?? 0),
      settledAmount: Number(row.ar.settledAmount ?? 0),
      dueDate: row.ar.dueDate,
      status,
      source: row.ar.source ?? 'manual',
      overdue: status !== 'settled' && open > 0 && (row.ar.dueDate ?? '') < today,
      ownerUserId: row.ar.ownerUserId ?? null,
      remark: row.ar.remark,
      createdAt: row.ar.createdAt.toISOString(),
    };
  }

  async listArs(customerId?: string, status?: string): Promise<ArItem[]> {
    const conditions = [];
    if (customerId) conditions.push(eq(erpAr.customerId, customerId));
    if (status) conditions.push(eq(erpAr.status, status));
    const rows = await this.db
      .select({
        ar: erpAr,
        contractName: erpContract.name,
        customerName: mdCustomer.name,
        projectName: erpProject.name,
      })
      .from(erpAr)
      .leftJoin(erpContract, eq(erpAr.contractId, erpContract.id))
      .leftJoin(mdCustomer, eq(erpAr.customerId, mdCustomer.id))
      .leftJoin(erpProject, eq(erpAr.projectId, erpProject.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(erpAr.createdAt));
    return Promise.all(rows.map((row) => this.buildArItem(row)));
  }

  /** 应收登记：默认账期取客户档案的账期天数 */
  async createAr(dto: CreateArDto): Promise<ArItem> {
    const contract = await this.db
      .select()
      .from(erpContract)
      .where(eq(erpContract.id, dto.contractId));
    if (contract.length === 0) throw new NotFoundException('合同不存在');
    const customer = await this.db
      .select({ id: mdCustomer.id, name: mdCustomer.name, termsDays: mdCustomer.termsDays })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, contract[0].customerId ?? ''));
    if (customer.length === 0) throw new NotFoundException('客户不存在');
    const code = await generateBizCode(this.db, erpAr, erpAr.code, 'ARR');
    let dueDate = dto.dueDate ?? null;
    if (!dueDate) {
      const terms = customer[0].termsDays ?? 30;
      const d = new Date();
      d.setDate(d.getDate() + terms);
      dueDate = d.toISOString().slice(0, 10);
    }
    const rows = await this.db
      .insert(erpAr)
      .values({
        code,
        contractId: dto.contractId,
        customerId: contract[0].customerId,
        projectId: dto.projectId,
        amount: String(dto.amount),
        settledAmount: '0',
        dueDate,
        status: 'open',
        source: dto.source ?? 'manual',
        remark: dto.remark,
        ownerUserId: dto.ownerUserId ?? null,
      })
      .returning();
    return this.buildArItem({
      ar: rows[0],
      contractName: contract[0].name,
      customerName: customer[0].name,
      projectName: null,
    });
  }

  async listReceipts(customerId?: string): Promise<ReceiptItem[]> {
    const rows = await this.db
      .select({ receipt: erpReceipt, customerName: mdCustomer.name })
      .from(erpReceipt)
      .leftJoin(mdCustomer, eq(erpReceipt.customerId, mdCustomer.id))
      .where(customerId ? eq(erpReceipt.customerId, customerId) : undefined)
      .orderBy(desc(erpReceipt.createdAt));
    return rows.map((row) => ({
      id: row.receipt.id,
      code: row.receipt.code,
      customerId: row.receipt.customerId ?? '',
      customerName: row.customerName ?? '',
      amount: Number(row.receipt.amount ?? 0),
      receiptDate: row.receipt.receiptDate,
      method: row.receipt.method ?? 'bank',
      source: row.receipt.source,
      status: (row.receipt.status ?? 'unmatched') as ReceiptStatus,
      remark: row.receipt.remark,
      createdAt: row.receipt.createdAt.toISOString(),
    }));
  }

  async createReceipt(dto: CreateReceiptDto): Promise<ReceiptItem> {
    const customer = await this.db
      .select({ id: mdCustomer.id, name: mdCustomer.name })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, dto.customerId));
    if (customer.length === 0) throw new NotFoundException('客户不存在');
    const code = await generateBizCode(
      this.db,
      erpReceipt,
      erpReceipt.code,
      'RCV'
    );
    const rows = await this.db
      .insert(erpReceipt)
      .values({
        code,
        customerId: dto.customerId,
        amount: String(dto.amount),
        receiptDate: dto.receiptDate ?? new Date().toISOString().slice(0, 10),
        method: dto.method ?? 'bank',
        source: dto.source,
        status: 'unmatched',
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];

    /* 回款登记成功 → 生成凭证草稿：借 银行存款(1001) / 贷 应收账款(1122) */
    const receiptAmount = Number(row.amount ?? 0);
    const voucherStatus = await this.voucherHookService.generateVoucherDraft({
      sourceType: 'receipt',
      sourceRef: `receipt:${row.code}`,
      voucherDate: row.receiptDate ?? new Date().toISOString().slice(0, 10),
      summary: `回款登记 ${row.code}`,
      lines: [
        { accountCode: '1001', debit: receiptAmount },
        { accountCode: '1122', credit: receiptAmount },
      ],
    });
    if (voucherStatus !== 'created') {
      this.logger.error(
        `回款凭证 voucherStatus=${voucherStatus} receipt:${row.code}`
      );
    }

    return {
      id: row.id,
      code: row.code,
      customerId: row.customerId ?? '',
      customerName: customer[0].name,
      amount: Number(row.amount ?? 0),
      receiptDate: row.receiptDate,
      method: row.method ?? 'bank',
      source: row.source,
      status: (row.status ?? 'unmatched') as ReceiptStatus,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 应收核销（支持部分核销）：一笔回款可拆分核销多笔应收。事务内锁行校验，防并发超核销 */
  async writeoff(dto: ArWriteoffDto): Promise<ArItem> {
    if (dto.amount <= 0) {
      throw new BadRequestException('核销金额必须大于 0');
    }
    await this.db.transaction(async (tx) => {
      const arRows = await tx
        .select()
        .from(erpAr)
        .where(eq(erpAr.id, dto.arId))
        .for('update');
      if (arRows.length === 0) throw new NotFoundException('应收记录不存在');
      const ar = arRows[0];
      const arOpen = Number(ar.amount) - Number(ar.settledAmount ?? 0);
      if (arOpen <= 0) throw new BadRequestException('该应收已全额核销');
      if (dto.amount > arOpen) {
        throw new BadRequestException(`核销金额超过应收未核销余额 ${arOpen}`);
      }
      const receiptRows = await tx
        .select()
        .from(erpReceipt)
        .where(eq(erpReceipt.id, dto.receiptId))
        .for('update');
      if (receiptRows.length === 0) throw new NotFoundException('回款记录不存在');
      const receipt = receiptRows[0];
      if (receipt.customerId !== ar.customerId) {
        throw new BadRequestException('回款客户与应收客户不一致，不可核销');
      }
      const usedRows = await tx
        .select({ total: sum(erpArWriteoff.amount) })
        .from(erpArWriteoff)
        .where(eq(erpArWriteoff.receiptId, dto.receiptId));
      const receiptOpen =
        Number(receipt.amount) - Number(usedRows[0]?.total ?? 0);
      if (dto.amount > receiptOpen) {
        throw new BadRequestException(`核销金额超过回款未核销余额 ${receiptOpen}`);
      }
      await tx.insert(erpArWriteoff).values({
        arId: dto.arId,
        receiptId: dto.receiptId,
        amount: String(dto.amount),
        writeoffDate: new Date().toISOString().slice(0, 10),
      });
      const newSettled = Number(ar.settledAmount ?? 0) + dto.amount;
      await tx
        .update(erpAr)
        .set({
          settledAmount: String(newSettled),
          status: newSettled >= Number(ar.amount) ? 'settled' : 'partial',
          updatedAt: new Date(),
        })
        .where(eq(erpAr.id, dto.arId));
      const newUsed = Number(usedRows[0]?.total ?? 0) + dto.amount;
      await tx
        .update(erpReceipt)
        .set({
          status:
            newUsed >= Number(receipt.amount) ? 'matched' : 'partial',
          updatedAt: new Date(),
        })
        .where(eq(erpReceipt.id, dto.receiptId));
    });
    const updated = await this.db
      .select({
        ar: erpAr,
        contractName: erpContract.name,
        customerName: mdCustomer.name,
        projectName: erpProject.name,
      })
      .from(erpAr)
      .leftJoin(erpContract, eq(erpAr.contractId, erpContract.id))
      .leftJoin(mdCustomer, eq(erpAr.customerId, mdCustomer.id))
      .leftJoin(erpProject, eq(erpAr.projectId, erpProject.id))
      .where(eq(erpAr.id, dto.arId));
    return this.buildArItem(updated[0]);
  }

  /** 账龄分析：按逾期天数分桶统计未结清应收 */
  async listAging(): Promise<AgingBucket[]> {
    const rows = await this.db
      .select({
        amount: erpAr.amount,
        settledAmount: erpAr.settledAmount,
        dueDate: erpAr.dueDate,
        status: erpAr.status,
      })
      .from(erpAr);
    const today = new Date().toISOString().slice(0, 10);
    const buckets: AgingBucket[] = AGING_BUCKETS.map((b) => ({
      label: b.label,
      amount: 0,
      count: 0,
    }));
    for (const row of rows) {
      if (row.status === 'settled') continue;
      const open = Number(row.amount) - Number(row.settledAmount ?? 0);
      if (open <= 0) continue;
      const overdueDays = row.dueDate
        ? Math.floor(
            (new Date(today).getTime() - new Date(row.dueDate).getTime()) /
              86400000
          )
        : 0;
      const idx = AGING_BUCKETS.findIndex(
        (b) => overdueDays >= b.minDays && overdueDays <= b.maxDays
      );
      if (idx >= 0) {
        buckets[idx].amount += open;
        buckets[idx].count += 1;
      }
    }
    return buckets;
  }
}
