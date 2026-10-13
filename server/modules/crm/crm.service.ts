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
import { desc, eq } from 'drizzle-orm';
import {
  crmLead,
  crmOpportunity,
  erpContract,
  mdCustomer,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { splitTax } from '@shared/tax';
import type {
  Contract,
  CreateContractDto,
  CreateLeadDto,
  CreateOpportunityDto,
  Lead,
  LeadStatus,
  Opportunity,
  OpportunityStage,
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
    return rows.map((row) => ({
      id: row.opp.id,
      code: row.opp.code,
      customerId: row.opp.customerId ?? '',
      customerName: row.customerName ?? '',
      title: row.opp.title,
      stage: (row.opp.stage ?? 'new') as OpportunityStage,
      amount: Number(row.opp.amount ?? 0),
      winRate: row.opp.winRate ?? 0,
      owner: row.opp.owner,
      expectedDate: row.opp.expectedDate,
      remark: row.opp.remark,
      createdAt: row.opp.createdAt.toISOString(),
    }));
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
    const row = rows[0];
    return {
      id: row.id,
      code: row.code,
      customerId: row.customerId ?? '',
      customerName: customer[0].name,
      title: row.title,
      stage: (row.stage ?? 'new') as OpportunityStage,
      amount: Number(row.amount ?? 0),
      winRate: row.winRate ?? 0,
      owner: row.owner,
      expectedDate: row.expectedDate,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
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
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.stage !== undefined) {
      patch.stage = dto.stage;
      if (dto.stage === 'won') patch.winRate = 100;
      if (dto.stage === 'lost') patch.winRate = 0;
    }
    if (dto.amount !== undefined) patch.amount = String(dto.amount);
    if (dto.winRate !== undefined) patch.winRate = dto.winRate;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    const rows = await this.db
      .update(crmOpportunity)
      .set(patch)
      .where(eq(crmOpportunity.id, id))
      .returning();
    const row = rows[0];
    const customer = await this.db
      .select({ name: mdCustomer.name })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, row.customerId ?? ''));
    return {
      id: row.id,
      code: row.code,
      customerId: row.customerId ?? '',
      customerName: customer[0]?.name ?? '',
      title: row.title,
      stage: (row.stage ?? 'new') as OpportunityStage,
      amount: Number(row.amount ?? 0),
      winRate: row.winRate ?? 0,
      owner: row.owner,
      expectedDate: row.expectedDate,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
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
    const customer = await this.db
      .select({ name: mdCustomer.name })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, created.customerId ?? ''));
    return {
      id: created.id,
      code: created.code,
      customerId: created.customerId ?? '',
      customerName: customer[0]?.name ?? '',
      title: created.title,
      stage: 'new',
      amount: Number(created.amount ?? 0),
      winRate: created.winRate ?? 0,
      owner: created.owner,
      expectedDate: created.expectedDate,
      remark: created.remark,
      createdAt: created.createdAt.toISOString(),
    };
  }

  /** 已赢单商机生成合同草稿。同一商机只保留一份合同。 */
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
    const resolved = await this.taxResolver.resolve({
      explicit: opp.taxRate != null ? Number(opp.taxRate) : null,
      customerId: opp.customerId,
      side: 'output',
    });
    const amount = Number(opp.amount ?? 0);
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
