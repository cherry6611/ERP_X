import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { asc, count, desc, eq, inArray } from 'drizzle-orm';
import {
  crmLead,
  crmOpportunity,
  crmQuotation,
  erpContract,
  mdCustomer,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { splitTax } from '@shared/tax';
import type {
  Contract,
  CreateLeadDto,
  CreateOpportunityDto,
  Lead,
  LeadStatus,
  Opportunity,
  OpportunityDetail,
  OpportunityQuotationSummary,
  OpportunityStage,
  QuotationStatus,
  UpdateLeadDto,
  UpdateOpportunityDto,
} from '@shared/api.interface';

const OPP_STAGE_FLOW: Record<OpportunityStage, OpportunityStage[]> = {
  new: ['following', 'quoting', 'negotiating', 'won', 'lost'],
  following: ['quoting', 'negotiating', 'won', 'lost'],
  quoting: ['negotiating', 'won', 'lost'],
  negotiating: ['won', 'lost'],
  won: [],
  lost: [],
};

const LEAD_FLOW: Record<LeadStatus, LeadStatus[]> = {
  new: ['following'],
  following: ['converted', 'lost', 'new'],
  converted: [],
  lost: [],
};

@Injectable()
export class CrmService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly taxResolver: TaxResolverService
  ) {}

  async listLeads(status?: string): Promise<Lead[]> {
    const rows = await this.db
      .select()
      .from(crmLead)
      .where(status ? eq(crmLead.status, status) : undefined)
      .orderBy(desc(crmLead.createdAt));
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      customerName: row.customerName,
      source: row.source,
      contactName: row.contactName,
      contactPhone: row.contactPhone,
      customerId: row.customerId ?? null,
      convertedOpportunityId: row.convertedOpportunityId ?? null,
      status: (row.status ?? 'new') as LeadStatus,
      owner: row.owner,
      followNote: row.followNote,
      nextDate: row.nextDate,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async createLead(dto: CreateLeadDto): Promise<Lead> {
    const code = await generateBizCode(this.db, crmLead, crmLead.code, 'LEAD');
    const rows = await this.db
      .insert(crmLead)
      .values({
        code,
        customerName: dto.customerName,
        customerId: dto.customerId,
        source: dto.source,
        contactName: dto.contactName,
        contactPhone: dto.contactPhone,
        status: 'new',
        owner: dto.owner,
        nextDate: dto.nextDate,
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];
    return {
      id: row.id,
      code: row.code,
      customerName: row.customerName,
      source: row.source,
      contactName: row.contactName,
      contactPhone: row.contactPhone,
      customerId: row.customerId ?? null,
      convertedOpportunityId: row.convertedOpportunityId ?? null,
      status: (row.status ?? 'new') as LeadStatus,
      owner: row.owner,
      followNote: row.followNote,
      nextDate: row.nextDate,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async updateLead(id: string, dto: UpdateLeadDto): Promise<Lead> {
    const existing = await this.db
      .select()
      .from(crmLead)
      .where(eq(crmLead.id, id));
    if (existing.length === 0) throw new NotFoundException('线索不存在');
    const current = (existing[0].status ?? 'new') as LeadStatus;
    if (dto.status !== undefined) {
      const allowed = LEAD_FLOW[current];
      if (!allowed.includes(dto.status)) {
        throw new BadRequestException(
          `线索状态不允许从 ${current} 流转为 ${dto.status}`
        );
      }
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.customerId !== undefined) patch.customerId = dto.customerId;
    if (dto.followNote !== undefined) patch.followNote = dto.followNote;
    if (dto.nextDate !== undefined) patch.nextDate = dto.nextDate;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    const rows = await this.db
      .update(crmLead)
      .set(patch)
      .where(eq(crmLead.id, id))
      .returning();
    const row = rows[0];
    return {
      id: row.id,
      code: row.code,
      customerName: row.customerName,
      source: row.source,
      contactName: row.contactName,
      contactPhone: row.contactPhone,
      customerId: row.customerId ?? null,
      convertedOpportunityId: row.convertedOpportunityId ?? null,
      status: (row.status ?? 'new') as LeadStatus,
      owner: row.owner,
      followNote: row.followNote,
      nextDate: row.nextDate,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async enrichOpportunities(
    opps: Array<typeof crmOpportunity.$inferSelect>,
    customerNames: Map<string, string>,
  ): Promise<Opportunity[]> {
    if (opps.length === 0) return [];
    const ids = opps.map((o) => o.id);
    const wonIds = opps
      .map((o) => o.wonQuotationId)
      .filter((id): id is string => Boolean(id));

    const quoteCountRows = await this.db
      .select({
        opportunityId: crmQuotation.opportunityId,
        cnt: count(),
      })
      .from(crmQuotation)
      .where(inArray(crmQuotation.opportunityId, ids))
      .groupBy(crmQuotation.opportunityId);
    const countMap = new Map(
      quoteCountRows.map((r) => [r.opportunityId ?? '', Number(r.cnt)]),
    );

    const wonMap = new Map<string, { code: string; title: string }>();
    if (wonIds.length > 0) {
      const wonRows = await this.db
        .select({
          id: crmQuotation.id,
          code: crmQuotation.code,
          title: crmQuotation.title,
        })
        .from(crmQuotation)
        .where(inArray(crmQuotation.id, wonIds));
      for (const w of wonRows) {
        wonMap.set(w.id, { code: w.code, title: w.title });
      }
    }

    return opps.map((row) => {
      const won = row.wonQuotationId
        ? wonMap.get(row.wonQuotationId)
        : undefined;
      return {
        id: row.id,
        code: row.code,
        customerId: row.customerId ?? '',
        customerName: customerNames.get(row.customerId ?? '') ?? '',
        title: row.title,
        stage: (row.stage ?? 'new') as OpportunityStage,
        amount: Number(row.amount ?? 0),
        winRate: row.winRate ?? 0,
        owner: row.owner,
        expectedDate: row.expectedDate,
        remark: row.remark,
        wonQuotationId: row.wonQuotationId ?? null,
        wonQuotationCode: won?.code ?? null,
        wonQuotationTitle: won?.title ?? null,
        contractId: row.contractId ?? null,
        quotationCount: countMap.get(row.id) ?? 0,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  private async toOpportunity(
    row: typeof crmOpportunity.$inferSelect,
    customerName?: string,
  ): Promise<Opportunity> {
    const name =
      customerName ??
      (
        await this.db
          .select({ name: mdCustomer.name })
          .from(mdCustomer)
          .where(eq(mdCustomer.id, row.customerId ?? ''))
          .limit(1)
      )[0]?.name ??
      '';
    const [enriched] = await this.enrichOpportunities(
      [row],
      new Map([[row.customerId ?? '', name]]),
    );
    return enriched;
  }

  async listOpportunities(stage?: string): Promise<Opportunity[]> {
    const rows = await this.db
      .select({
        opp: crmOpportunity,
        customerName: mdCustomer.name,
      })
      .from(crmOpportunity)
      .leftJoin(mdCustomer, eq(crmOpportunity.customerId, mdCustomer.id))
      .where(stage ? eq(crmOpportunity.stage, stage) : undefined)
      .orderBy(desc(crmOpportunity.createdAt));
    const names = new Map(
      rows.map((r) => [r.opp.customerId ?? '', r.customerName ?? '']),
    );
    return this.enrichOpportunities(
      rows.map((r) => r.opp),
      names,
    );
  }

  async getOpportunity(id: string): Promise<OpportunityDetail> {
    const rows = await this.db
      .select({
        opp: crmOpportunity,
        customerName: mdCustomer.name,
      })
      .from(crmOpportunity)
      .leftJoin(mdCustomer, eq(crmOpportunity.customerId, mdCustomer.id))
      .where(eq(crmOpportunity.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('商机不存在');
    const base = await this.toOpportunity(rows[0].opp, rows[0].customerName ?? '');
    const quoteRows = await this.db
      .select()
      .from(crmQuotation)
      .where(eq(crmQuotation.opportunityId, id))
      .orderBy(asc(crmQuotation.roundNo), asc(crmQuotation.createdAt));
    const quotations: OpportunityQuotationSummary[] = quoteRows.map((q) => {
      const totalAmount = Number(q.totalAmount ?? 0);
      const estimatedCost = Number(q.estimatedCost ?? 0);
      const marginPct =
        totalAmount > 0
          ? Math.round(((totalAmount - estimatedCost) / totalAmount) * 10000) / 100
          : 0;
      return {
        id: q.id,
        code: q.code,
        roundNo: q.roundNo ?? null,
        title: q.title,
        quoteDate: q.quoteDate,
        validUntil: q.validUntil,
        status: (q.status ?? 'draft') as QuotationStatus,
        totalAmount,
        estimatedCost,
        marginPct,
        remark: q.remark,
        isWon: base.wonQuotationId === q.id,
        createdAt: q.createdAt.toISOString(),
      };
    });
    return { ...base, quotations };
  }

  async createOpportunity(dto: CreateOpportunityDto): Promise<Opportunity> {
    const customer = await this.db
      .select({ id: mdCustomer.id, name: mdCustomer.name })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, dto.customerId));
    if (customer.length === 0) throw new NotFoundException('客户不存在');
    const code = await generateBizCode(
      this.db,
      crmOpportunity,
      crmOpportunity.code,
      'OPP'
    );
    const rows = await this.db
      .insert(crmOpportunity)
      .values({
        code,
        customerId: dto.customerId,
        title: dto.title,
        stage: 'new',
        amount: String(dto.amount ?? 0),
        winRate: dto.winRate ?? 0,
        owner: dto.owner,
        expectedDate: dto.expectedDate,
        remark: dto.remark,
      })
      .returning();
    return this.toOpportunity(rows[0], customer[0].name);
  }

  async updateOpportunity(
    id: string,
    dto: UpdateOpportunityDto
  ): Promise<Opportunity> {
    const existing = await this.db
      .select()
      .from(crmOpportunity)
      .where(eq(crmOpportunity.id, id));
    if (existing.length === 0) throw new NotFoundException('商机不存在');
    const current = (existing[0].stage ?? 'new') as OpportunityStage;
    if (dto.stage !== undefined && dto.stage !== current) {
      const allowed = OPP_STAGE_FLOW[current];
      if (!allowed.includes(dto.stage)) {
        throw new BadRequestException(
          `商机阶段不允许从 ${current} 流转为 ${dto.stage}`
        );
      }
    }

    if (dto.wonQuotationId !== undefined && dto.wonQuotationId !== null) {
      const quotes = await this.db
        .select()
        .from(crmQuotation)
        .where(eq(crmQuotation.id, dto.wonQuotationId))
        .limit(1);
      if (quotes.length === 0) throw new NotFoundException('报价单不存在');
      if (quotes[0].opportunityId !== id) {
        throw new BadRequestException('只能选定本商机下的报价单为最终成交');
      }
      if (quotes[0].status === 'void') {
        throw new BadRequestException('已作废的报价单不能设为最终成交');
      }
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.stage !== undefined) {
      patch.stage = dto.stage;
      if (dto.stage === 'won') patch.winRate = 100;
      if (dto.stage === 'lost') patch.winRate = 0;
    }
    if (dto.amount !== undefined) patch.amount = String(dto.amount);
    if (dto.winRate !== undefined) patch.winRate = dto.winRate;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    if (dto.owner !== undefined) patch.owner = dto.owner;
    if (dto.expectedDate !== undefined) patch.expectedDate = dto.expectedDate || null;
    if (dto.wonQuotationId !== undefined) {
      patch.wonQuotationId = dto.wonQuotationId;
      if (dto.wonQuotationId) {
        const won = await this.db
          .select({ totalAmount: crmQuotation.totalAmount })
          .from(crmQuotation)
          .where(eq(crmQuotation.id, dto.wonQuotationId))
          .limit(1);
        if (won[0] && dto.amount === undefined) {
          patch.amount = String(won[0].totalAmount ?? 0);
        }
      }
    }
    const rows = await this.db
      .update(crmOpportunity)
      .set(patch)
      .where(eq(crmOpportunity.id, id))
      .returning();
    return this.toOpportunity(rows[0]);
  }

  /** 线索转为商机。必须已经关联客户。 */
  async convertLead(id: string): Promise<Opportunity> {
    const rows = await this.db
      .select()
      .from(crmLead)
      .where(eq(crmLead.id, id));
    if (rows.length === 0) throw new NotFoundException('线索不存在');
    const lead = rows[0];
    if (lead.convertedOpportunityId) {
      throw new BadRequestException('该线索已转为商机');
    }
    if (!lead.customerId) {
      throw new BadRequestException('线索未关联客户，不能转换');
    }
    const code = await generateBizCode(
      this.db,
      crmOpportunity,
      crmOpportunity.code,
      'OPP'
    );
    const created = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(crmOpportunity)
        .values({
          code,
          customerId: lead.customerId,
          title: lead.customerName,
          stage: 'new',
          amount: '0',
          winRate: 0,
          owner: lead.owner,
          remark: lead.remark,
        })
        .returning();
      await tx
        .update(crmLead)
        .set({
          status: 'converted',
          convertedOpportunityId: inserted[0].id,
          updatedAt: new Date(),
        })
        .where(eq(crmLead.id, id));
      return inserted[0];
    });
    return this.toOpportunity(created);
  }

  /** 已赢单商机生成合同草稿。同一商机只保留一份合同。优先使用最终成交报价金额。 */
  async convertToContract(opportunityId: string): Promise<Contract> {
    const existing = await this.db
      .select()
      .from(crmOpportunity)
      .where(eq(crmOpportunity.id, opportunityId));
    if (existing.length === 0) throw new NotFoundException('商机不存在');
    const opp = existing[0];
    if ((opp.stage ?? 'new') !== 'won') {
      throw new BadRequestException('只有已赢单的商机可以转合同');
    }
    if (opp.contractId) {
      throw new BadRequestException('该商机已生成合同，请勿重复转换');
    }
    if (!opp.customerId) {
      throw new BadRequestException('商机未关联客户，不能转合同');
    }
    let amount = Number(opp.amount ?? 0);
    if (opp.wonQuotationId) {
      const won = await this.db
        .select({ totalAmount: crmQuotation.totalAmount })
        .from(crmQuotation)
        .where(eq(crmQuotation.id, opp.wonQuotationId))
        .limit(1);
      if (won[0]) amount = Number(won[0].totalAmount ?? amount);
    }
    const resolved = await this.taxResolver.resolve({
      explicit: opp.taxRate != null ? Number(opp.taxRate) : null,
      customerId: opp.customerId,
      side: 'output',
    });
    const split = splitTax(amount, resolved.rate);
    const code = await generateBizCode(
      this.db,
      erpContract,
      erpContract.code,
      'CTR'
    );
    const rows = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(erpContract)
        .values({
          code,
          name: opp.title,
          customerId: opp.customerId,
          billingModel: 'project',
          amount: String(amount),
          taxRate: String(resolved.rate),
          taxEntityId: resolved.taxEntityId,
          netAmount: String(split.net),
          taxAmount: String(split.tax),
          rateSource: resolved.source,
          status: 'draft',
        })
        .returning();
      await tx
        .update(crmOpportunity)
        .set({ contractId: inserted[0].id, updatedAt: new Date() })
        .where(eq(crmOpportunity.id, opportunityId));
      return inserted;
    });
    const row = rows[0];
    const customer = await this.db
      .select({ name: mdCustomer.name })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, row.customerId ?? ''));
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      customerId: row.customerId ?? '',
      customerName: customer[0]?.name ?? '',
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
