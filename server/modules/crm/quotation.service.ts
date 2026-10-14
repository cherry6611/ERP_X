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
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import {
  crmOpportunity,
  crmQuotation,
  crmQuotationItem,
  erpContract,
  erpContractItem,
  mdCustomer,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { splitTax } from '@shared/tax';
import { NotificationsService } from '@server/modules/notifications/notifications.service';
import { todayInShanghai } from '@server/common/utils/biz-date';
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
    private readonly notificationsService: NotificationsService,
    private readonly taxResolver: TaxResolverService
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
  ): { totalAmount: number; estimatedCost: number; grossAmount: number } {
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
    const headerFactor = 1 - discountPct / 100;
    return {
      grossAmount: Math.round(gross * 100) / 100,
      totalAmount: Math.round(gross * headerFactor * 100) / 100,
      estimatedCost: Math.round(cost * 100) / 100,
    };
  }

  /** 转合同明细行金额：行折扣后再乘整单折扣，与 computeTotals 同口径 */
  private convertLineAmount(
    item: { quantity: number; unitPrice: number; discountPct: number },
    headerDiscountPct: number,
  ): number {
    const line = this.lineAmount(item);
    return Math.round(line * (1 - headerDiscountPct / 100) * 100) / 100;
  }

  private toQuotation(
    row: QuotationRow,
    items: ItemRow[],
    customerName: string,
    extra?: {
      opportunityTitle?: string | null;
      isWon?: boolean;
    },
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
      opportunityTitle: extra?.opportunityTitle ?? null,
      roundNo: row.roundNo ?? null,
      title: row.title,
      quoteDate: row.quoteDate,
      validUntil: row.validUntil,
      status: (row.status ?? 'draft') as QuotationStatus,
      discountPct: Number(row.discountPct ?? 0),
      totalAmount,
      estimatedCost,
      marginPct,
      remark: row.remark,
      contractId: row.contractId ?? null,
      isWon: extra?.isWon ?? false,
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
    const [customerName, items, opp] = await Promise.all([
      this.loadCustomerName(row.customerId),
      this.loadItems(row.id),
      row.opportunityId
        ? this.db
            .select({
              title: crmOpportunity.title,
              wonQuotationId: crmOpportunity.wonQuotationId,
            })
            .from(crmOpportunity)
            .where(eq(crmOpportunity.id, row.opportunityId))
            .limit(1)
        : Promise.resolve([]),
    ]);
    return this.toQuotation(row, items, customerName, {
      opportunityTitle: opp[0]?.title ?? null,
      isWon: opp[0]?.wonQuotationId === row.id,
    });
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
      .select({
        quotation: crmQuotation,
        customerName: mdCustomer.name,
        opportunityTitle: crmOpportunity.title,
        wonQuotationId: crmOpportunity.wonQuotationId,
      })
      .from(crmQuotation)
      .leftJoin(mdCustomer, eq(crmQuotation.customerId, mdCustomer.id))
      .leftJoin(
        crmOpportunity,
        eq(crmQuotation.opportunityId, crmOpportunity.id),
      )
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
        row.customerName ?? '',
        {
          opportunityTitle: row.opportunityTitle ?? null,
          isWon: row.wonQuotationId === row.quotation.id,
        },
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
    let roundNo: number | null = null;
    if (dto.opportunityId) {
      const opp = await this.db
        .select({ id: crmOpportunity.id })
        .from(crmOpportunity)
        .where(eq(crmOpportunity.id, dto.opportunityId))
        .limit(1);
      if (opp.length === 0) throw new NotFoundException('商机不存在');
      const maxRows = await this.db
        .select({ m: max(crmQuotation.roundNo) })
        .from(crmQuotation)
        .where(eq(crmQuotation.opportunityId, dto.opportunityId));
      roundNo = Number(maxRows[0]?.m ?? 0) + 1;
    }
    const row = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(crmQuotation)
        .values({
          code,
          customerId: dto.customerId,
          opportunityId: dto.opportunityId ?? null,
          roundNo,
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
    if (dto.opportunityId) {
      const oppRows = await this.db
        .select({ stage: crmOpportunity.stage })
        .from(crmOpportunity)
        .where(eq(crmOpportunity.id, dto.opportunityId))
        .limit(1);
      const stage = oppRows[0]?.stage ?? 'new';
      if (stage === 'new' || stage === 'following') {
        await this.db
          .update(crmOpportunity)
          .set({ stage: 'quoting', updatedAt: new Date() })
          .where(eq(crmOpportunity.id, dto.opportunityId));
      }
    }
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
    const discountPct =
      dto.discountPct !== undefined ? dto.discountPct : Number(existing.discountPct ?? 0);
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

      // F10：明细或整单折扣变更时按同口径重算并落库，杜绝脏合计
      let itemInputs: QuotationItemInput[];
      if (dto.items !== undefined) {
        itemInputs = dto.items;
      } else if (dto.discountPct !== undefined) {
        const existingItems = await tx
          .select()
          .from(crmQuotationItem)
          .where(eq(crmQuotationItem.quotationId, id))
          .orderBy(crmQuotationItem.seq);
        itemInputs = existingItems.map((item) => ({
          itemName: item.itemName ?? '',
          unit: item.unit ?? '人天',
          quantity: Number(item.quantity ?? 0),
          unitPrice: Number(item.unitPrice ?? 0),
          discountPct: Number(item.discountPct ?? 0),
          estUnitCost: Number(item.estUnitCost ?? 0),
          remark: item.remark ?? undefined,
        }));
      } else {
        itemInputs = [];
      }
      if (dto.items !== undefined || dto.discountPct !== undefined) {
        const totals = this.computeTotals(itemInputs, discountPct);
        patch.totalAmount = String(totals.totalAmount);
        patch.estimatedCost = String(totals.estimatedCost);
      }
      await tx.update(crmQuotation).set(patch).where(eq(crmQuotation.id, id));
      if (dto.items !== undefined) {
        await tx
          .delete(crmQuotationItem)
          .where(eq(crmQuotationItem.quotationId, id));
        await tx.insert(crmQuotationItem).values(
          itemInputs.map((item, index) => ({
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
    if (existing.contractId) {
      throw new BadRequestException('该报价已生成合同，请勿重复转换');
    }
    if (existing.validUntil && existing.validUntil < todayInShanghai()) {
      throw new BadRequestException('报价已超过有效期，不能转合同');
    }
    const items = await this.db
      .select()
      .from(crmQuotationItem)
      .where(eq(crmQuotationItem.quotationId, id))
      .orderBy(crmQuotationItem.seq);
    const resolved = await this.taxResolver.resolve({
      explicit: existing.taxRate != null ? Number(existing.taxRate) : null,
      customerId: existing.customerId,
      side: 'output',
    });
    const amount = Number(existing.totalAmount ?? 0);
    const split = splitTax(amount, resolved.rate);
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
          name: existing.title,
          customerId: existing.customerId,
          billingModel: 'project',
          amount: String(amount),
          taxRate: String(resolved.rate),
          taxEntityId: resolved.taxEntityId,
          netAmount: String(split.net),
          taxAmount: String(split.tax),
          rateSource: resolved.source,
          status: 'draft',
        })
        .returning({ id: erpContract.id });
      const headerDiscountPct = Number(existing.discountPct ?? 0);
      let itemSum = 0;
      if (items.length > 0) {
        await tx.insert(erpContractItem).values(
          items.map((item) => {
            const line = this.convertLineAmount(
              {
                quantity: Number(item.quantity ?? 0),
                unitPrice: Number(item.unitPrice ?? 0),
                discountPct: Number(item.discountPct ?? 0),
              },
              headerDiscountPct,
            );
            itemSum += line;
            const lineSplit = splitTax(line, resolved.rate);
            return {
              contractId: inserted[0].id,
              versionNo: 1,
              isCurrent: 1,
              seq: item.seq,
              itemName: item.itemName,
              unit: item.unit,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              discountPct: item.discountPct,
              taxRate: String(resolved.rate),
              amount: String(line),
              netAmount: String(lineSplit.net),
              taxAmount: String(lineSplit.tax),
              estUnitCost: item.estUnitCost,
              sourceType: 'quotation',
              sourceItemId: item.id,
            };
          })
        );
        itemSum = Math.round(itemSum * 100) / 100;
        if (Math.abs(itemSum - amount) > 0.01) {
          throw new BadRequestException(
            `报价明细合计 ${itemSum} 与报价总额 ${amount} 不一致，已回滚`
          );
        }
      }
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
