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
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  crmQuotation,
  crmQuotationItem,
  erpContract,
  mdCustomer,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { NotificationsService } from '@server/modules/notifications/notifications.service';
import type {
  Contract,
  CreateQuotationDto,
  Quotation,
  QuotationItem,
  QuotationItemInput,
  QuotationStatus,
  UpdateQuotationDto,
} from '@shared/api.interface';

const QUOTATION_STATUS_FLOW: Record<QuotationStatus, QuotationStatus[]> = {
  draft: ['pending_approval', 'void'],
  pending_approval: ['approved', 'draft'],
  approved: ['converted', 'void'],
  converted: [],
  void: [],
};

type QuotationRow = typeof crmQuotation.$inferSelect;
type ItemRow = typeof crmQuotationItem.$inferSelect;

@Injectable()
export class QuotationService {
  private readonly logger = new Logger(QuotationService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly notificationsService: NotificationsService
  ) {}

  private lineAmount(item: {
    quantity: number;
    unitPrice: number;
    discountPct: number;
  }): number {
    return item.quantity * item.unitPrice * (1 - item.discountPct / 100);
  }

  private computeTotals(
    items: QuotationItemInput[],
    discountPct: number
  ): { totalAmount: number; estimatedCost: number } {
    let gross = 0;
    let cost = 0;
    for (const item of items) {
      gross += this.lineAmount({
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountPct: item.discountPct ?? 0,
      });
      cost += item.quantity * (item.estUnitCost ?? 0);
    }
    return {
      totalAmount: Math.round(gross * (1 - discountPct / 100) * 100) / 100,
      estimatedCost: Math.round(cost * 100) / 100,
    };
  }

  private toQuotation(
    row: QuotationRow,
    items: ItemRow[],
    customerName: string
  ): Quotation {
    const totalAmount = Number(row.totalAmount ?? 0);
    const estimatedCost = Number(row.estimatedCost ?? 0);
    const marginPct =
      totalAmount > 0
        ? Math.round(((totalAmount - estimatedCost) / totalAmount) * 10000) / 100
        : 0;
    return {
      id: row.id,
      code: row.code,
      customerId: row.customerId,
      customerName,
      opportunityId: row.opportunityId,
      title: row.title,
      quoteDate: row.quoteDate,
      validUntil: row.validUntil,
      status: (row.status ?? 'draft') as QuotationStatus,
      discountPct: Number(row.discountPct ?? 0),
      totalAmount,
      estimatedCost,
      marginPct,
      remark: row.remark,
      items: items.map((item) => ({
        id: item.id,
        quotationId: item.quotationId,
        seq: item.seq,
        itemName: item.itemName,
        unit: item.unit,
        quantity: Number(item.quantity ?? 0),
        unitPrice: Number(item.unitPrice ?? 0),
        discountPct: Number(item.discountPct ?? 0),
        estUnitCost: Number(item.estUnitCost ?? 0),
        lineAmount:
          Math.round(
            this.lineAmount({
              quantity: Number(item.quantity ?? 0),
              unitPrice: Number(item.unitPrice ?? 0),
              discountPct: Number(item.discountPct ?? 0),
            }) * 100
          ) / 100,
        remark: item.remark,
      })),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async loadCustomerName(customerId: string): Promise<string> {
    const customers = await this.db
      .select({ name: mdCustomer.name })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, customerId));
    return customers[0]?.name ?? '';
  }

  private async loadItems(quotationId: string): Promise<ItemRow[]> {
    return this.db
      .select()
      .from(crmQuotationItem)
      .where(eq(crmQuotationItem.quotationId, quotationId));
  }

  private async getOrThrow(id: string): Promise<QuotationRow> {
    const rows = await this.db
      .select()
      .from(crmQuotation)
      .where(eq(crmQuotation.id, id));
    if (rows.length === 0) throw new NotFoundException('报价单不存在');
    return rows[0];
  }

  private async getDetail(row: QuotationRow): Promise<Quotation> {
    const [customerName, items] = await Promise.all([
      this.loadCustomerName(row.customerId),
      this.loadItems(row.id),
    ]);
    return this.toQuotation(row, items, customerName);
  }

  async list(params: {
    customerId?: string;
    opportunityId?: string;
    status?: string;
  }): Promise<Quotation[]> {
    const conditions = [];
    if (params.customerId) {
      conditions.push(eq(crmQuotation.customerId, params.customerId));
    }
    if (params.opportunityId) {
      conditions.push(eq(crmQuotation.opportunityId, params.opportunityId));
    }
    if (params.status) {
      conditions.push(eq(crmQuotation.status, params.status));
    }
    const rows = await this.db
      .select({ quotation: crmQuotation, customerName: mdCustomer.name })
      .from(crmQuotation)
      .leftJoin(mdCustomer, eq(crmQuotation.customerId, mdCustomer.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(crmQuotation.createdAt));
    const ids = rows.map((row) => row.quotation.id);
    const items: ItemRow[] =
      ids.length > 0
        ? await this.db
            .select()
            .from(crmQuotationItem)
            .where(inArray(crmQuotationItem.quotationId, ids))
        : [];
    const byQuotation = new Map<string, ItemRow[]>();
    for (const item of items) {
      byQuotation.set(item.quotationId, [
        ...(byQuotation.get(item.quotationId) ?? []),
        item,
      ]);
    }
    return rows.map((row) =>
      this.toQuotation(
        row.quotation,
        byQuotation.get(row.quotation.id) ?? [],
        row.customerName ?? ''
      )
    );
  }

  async create(dto: CreateQuotationDto): Promise<Quotation> {
    if (dto.items.length === 0) {
      throw new BadRequestException('报价明细行至少 1 条');
    }
    const customer = await this.db
      .select({ id: mdCustomer.id, name: mdCustomer.name })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, dto.customerId));
    if (customer.length === 0) throw new NotFoundException('客户不存在');
    const { totalAmount, estimatedCost } = this.computeTotals(
      dto.items,
      dto.discountPct ?? 0
    );
    const code = await generateBizCode(
      this.db,
      crmQuotation,
      crmQuotation.code,
      'QUO'
    );
    const row = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(crmQuotation)
        .values({
          code,
          customerId: dto.customerId,
          opportunityId: dto.opportunityId ?? null,
          title: dto.title,
          quoteDate: dto.quoteDate ?? null,
          validUntil: dto.validUntil ?? null,
          status: 'draft',
          discountPct: String(dto.discountPct ?? 0),
          totalAmount: String(totalAmount),
          estimatedCost: String(estimatedCost),
          remark: dto.remark ?? null,
        })
        .returning();
      const head = inserted[0];
      await tx.insert(crmQuotationItem).values(
        dto.items.map((item, index) => ({
          quotationId: head.id,
          seq: index + 1,
          itemName: item.itemName,
          unit: item.unit ?? '人天',
          quantity: String(item.quantity),
          unitPrice: String(item.unitPrice),
          discountPct: String(item.discountPct ?? 0),
          estUnitCost: String(item.estUnitCost ?? 0),
          remark: item.remark ?? null,
        }))
      );
      return head;
    });
    return this.getDetail(row);
  }

  async detail(id: string): Promise<Quotation> {
    const row = await this.getOrThrow(id);
    return this.getDetail(row);
  }

  async update(id: string, dto: UpdateQuotationDto): Promise<Quotation> {
    const existing = await this.getOrThrow(id);
    if ((existing.status ?? 'draft') !== 'draft') {
      throw new BadRequestException('仅草稿状态的报价单可编辑');
    }
    if (dto.items !== undefined && dto.items.length === 0) {
      throw new BadRequestException('报价明细行至少 1 条');
    }
    const items = dto.items ?? [];
    const discountPct =
      dto.discountPct !== undefined ? dto.discountPct : Number(existing.discountPct ?? 0);
    const totals =
      dto.items !== undefined ? this.computeTotals(items, discountPct) : null;
    await this.db.transaction(async (tx) => {
      const patch: Partial<typeof crmQuotation.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (dto.title !== undefined) patch.title = dto.title;
      if (dto.opportunityId !== undefined) {
        patch.opportunityId = dto.opportunityId || null;
      }
      if (dto.quoteDate !== undefined) patch.quoteDate = dto.quoteDate || null;
      if (dto.validUntil !== undefined) patch.validUntil = dto.validUntil || null;
      if (dto.discountPct !== undefined) patch.discountPct = String(dto.discountPct);
      if (dto.remark !== undefined) patch.remark = dto.remark;
      if (totals) {
        patch.totalAmount = String(totals.totalAmount);
        patch.estimatedCost = String(totals.estimatedCost);
      }
      await tx.update(crmQuotation).set(patch).where(eq(crmQuotation.id, id));
      if (dto.items !== undefined) {
        await tx
          .delete(crmQuotationItem)
          .where(eq(crmQuotationItem.quotationId, id));
        await tx.insert(crmQuotationItem).values(
          items.map((item, index) => ({
            quotationId: id,
            seq: index + 1,
            itemName: item.itemName,
            unit: item.unit ?? '人天',
            quantity: String(item.quantity),
            unitPrice: String(item.unitPrice),
            discountPct: String(item.discountPct ?? 0),
            estUnitCost: String(item.estUnitCost ?? 0),
            remark: item.remark ?? null,
          }))
        );
      }
    });
    return this.detail(id);
  }

  private async transition(
    id: string,
    target: QuotationStatus
  ): Promise<Quotation> {
    const existing = await this.getOrThrow(id);
    const current = (existing.status ?? 'draft') as QuotationStatus;
    const allowed = QUOTATION_STATUS_FLOW[current];
    if (!allowed.includes(target)) {
      throw new BadRequestException(
        `报价单状态不允许从 ${current} 流转为 ${target}`
      );
    }
    await this.db
      .update(crmQuotation)
      .set({ status: target, updatedAt: new Date() })
      .where(eq(crmQuotation.id, id));
    return this.detail(id);
  }

  async submit(id: string): Promise<Quotation> {
    const result = await this.transition(id, 'pending_approval');
    const notification = await this.notificationsService.sendApprovalNotification(
      {
        bizType: 'quotation',
        bizCode: result.code,
        title: `新报价单待审批：${result.code}`,
        content: [
          `客户：${result.customerName}`,
          `标题：${result.title}`,
          `报价总额：${result.totalAmount} 元`,
          `预估成本：${result.estimatedCost} 元`,
          `毛利率：${result.marginPct}%`,
        ].join('\n'),
      },
      { kind: 'system' }
    );
    if (!notification.sent) {
      this.logger.warn(
        `报价审批通知未发送 reason=${notification.reason} quotation=${result.code}`
      );
    }
    return result;
  }

  async approve(id: string): Promise<Quotation> {
    return this.transition(id, 'approved');
  }

  async reject(id: string): Promise<Quotation> {
    return this.transition(id, 'draft');
  }

  async void(id: string): Promise<Quotation> {
    return this.transition(id, 'void');
  }

  /** 审批通过后一键生成合同草稿，报价金额与客户自动带入 */
  async convert(id: string): Promise<Contract> {
    const existing = await this.getOrThrow(id);
    if ((existing.status ?? 'draft') !== 'approved') {
      throw new BadRequestException('仅已生效的报价单可转合同');
    }
    const draftName = `${existing.title}（合同草稿）`;
    const duplicate = await this.db
      .select({ id: erpContract.id })
      .from(erpContract)
      .where(eq(erpContract.name, draftName));
    if (duplicate.length > 0) {
      throw new BadRequestException('该报价已生成合同草稿，请勿重复转换');
    }
    const code = await generateBizCode(
      this.db,
      erpContract,
      erpContract.code,
      'CTR'
    );
    const contractId = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(erpContract)
        .values({
          code,
          name: draftName,
          customerId: existing.customerId,
          billingModel: 'project',
          amount: String(Number(existing.totalAmount ?? 0)),
          taxRate: '6',
          status: 'draft',
        })
        .returning({ id: erpContract.id });
      await tx
        .update(crmQuotation)
        .set({
          status: 'converted',
          contractId: inserted[0].id,
          updatedAt: new Date(),
        })
        .where(eq(crmQuotation.id, id));
      return inserted[0].id;
    });
    const rows = await this.db
      .select()
      .from(erpContract)
      .where(eq(erpContract.id, contractId));
    const row = rows[0];
    const customerName = await this.loadCustomerName(row.customerId ?? '');
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      customerId: row.customerId ?? '',
      customerName,
      billingModel: (row.billingModel ?? 'project') as Contract['billingModel'],
      amount: Number(row.amount ?? 0),
      taxRate: Number(row.taxRate ?? 0),
      status: (row.status ?? 'draft') as Contract['status'],
      signDate: row.signDate,
      startDate: row.startDate,
      endDate: row.endDate,
      owner: row.owner,
      paymentTerms: row.paymentTerms,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
