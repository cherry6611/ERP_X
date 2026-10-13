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
import { and, count, desc, eq, ilike, or, sql, sum } from 'drizzle-orm';
import {
  erpCalloff,
  erpContract,
  erpContractItem,
  erpContractMilestone,
  erpContractVersion,
  erpProjectMilestone,
  erpInvoice,
  erpProject,
  mdCustomer,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { TaxEntityService } from '@server/modules/tax/tax-entity.service';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { splitTax } from '@shared/tax';
import type {
  BillableSummary,
  Calloff,
  Contract,
  ContractDetail,
  ContractMilestone,
  ContractStatus,
  ContractStatusAction,
  ContractVersion,
  CreateCalloffDto,
  CreateContractDto,
  CreateMilestoneDto,
  PagedResult,
  UpdateContractDto,
} from '@shared/api.interface';

const STATUS_FLOW: Record<ContractStatusAction, { from: ContractStatus[]; to: ContractStatus }> = {
  submit: { from: ['draft'], to: 'approving' },
  approve: { from: ['approving'], to: 'active' },
  reject: { from: ['approving'], to: 'draft' },
  start: { from: ['active'], to: 'performing' },
  complete: { from: ['performing'], to: 'completed' },
  close: { from: ['completed'], to: 'closed' },
  terminate: { from: ['active', 'performing'], to: 'terminated' },
};

const FROZEN_STATUSES = ['closed', 'terminated'];

@Injectable()
export class ContractsService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly taxResolver: TaxResolverService,
    private readonly taxEntities: TaxEntityService
  ) {}

  private async contractWithCustomerName(row: {
    id: string;
    code: string;
    name: string;
    customerId: string | null;
    billingModel: string | null;
    amount: string | null;
    taxRate: string | null;
    netAmount?: string | null;
    taxAmount?: string | null;
    taxEntityId?: string | null;
    rateSource?: string | null;
    status: string | null;
    signDate: string | null;
    startDate: string | null;
    endDate: string | null;
    owner: string | null;
    paymentTerms: string | null;
    remark: string | null;
    createdAt: Date;
  }, customerName: string): Promise<Contract> {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      customerId: row.customerId ?? '',
      customerName,
      billingModel: (row.billingModel ?? 'project') as Contract['billingModel'],
      amount: Number(row.amount ?? 0),
      taxRate: Number(row.taxRate ?? 0),
      netAmount: Number(row.netAmount ?? 0),
      taxAmount: Number(row.taxAmount ?? 0),
      taxEntityId: row.taxEntityId ?? null,
      rateSource: row.rateSource ?? null,
      status: (row.status ?? 'draft') as ContractStatus,
      signDate: row.signDate,
      startDate: row.startDate,
      endDate: row.endDate,
      owner: row.owner,
      paymentTerms: row.paymentTerms,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listContracts(
    status?: string,
    keyword?: string,
    customerId?: string,
    page = 1,
    pageSize = 20
  ): Promise<PagedResult<Contract>> {
    const conditions = [];
    if (status) conditions.push(eq(erpContract.status, status));
    if (customerId) conditions.push(eq(erpContract.customerId, customerId));
    if (keyword && keyword.trim() !== '') {
      const kw = `%${keyword}%`;
      conditions.push(
        or(ilike(erpContract.name, kw), ilike(erpContract.code, kw))!
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const totalRows = await this.db
      .select({ total: count() })
      .from(erpContract)
      .where(where);
    const rows = await this.db
      .select({ contract: erpContract, customerName: mdCustomer.name })
      .from(erpContract)
      .leftJoin(mdCustomer, eq(erpContract.customerId, mdCustomer.id))
      .where(where)
      .orderBy(desc(erpContract.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const items = await Promise.all(
      rows.map((row) =>
        this.contractWithCustomerName(row.contract, row.customerName ?? '')
      )
    );
    return {
      items,
      total: totalRows[0]?.total ?? 0,
      page,
      pageSize,
    };
  }

  async getBillable(contractId: string): Promise<BillableSummary> {
    const contracts = await this.db
      .select()
      .from(erpContract)
      .where(eq(erpContract.id, contractId));
    if (contracts.length === 0) throw new NotFoundException('合同不存在');
    const contractAmount = Number(contracts[0].amount ?? 0);
    const invoicedRows = await this.db
      .select({ total: sum(erpInvoice.amount) })
      .from(erpInvoice)
      .where(
        and(
          eq(erpInvoice.contractId, contractId),
          eq(erpInvoice.status, 'issued')
        )
      );
    const calloffRows = await this.db
      .select({ total: sum(erpCalloff.amount) })
      .from(erpCalloff)
      .where(eq(erpCalloff.contractId, contractId));
    const invoicedAmount = Number(invoicedRows[0]?.total ?? 0);
    return {
      contractAmount,
      invoicedAmount,
      billableAmount: contractAmount - invoicedAmount,
      calloffTotal: Number(calloffRows[0]?.total ?? 0),
    };
  }

  async getContract(id: string): Promise<ContractDetail> {
    const rows = await this.db
      .select({ contract: erpContract, customerName: mdCustomer.name })
      .from(erpContract)
      .leftJoin(mdCustomer, eq(erpContract.customerId, mdCustomer.id))
      .where(eq(erpContract.id, id));
    if (rows.length === 0) throw new NotFoundException('合同不存在');
    const base = await this.contractWithCustomerName(
      rows[0].contract,
      rows[0].customerName ?? ''
    );
    const milestoneRows = await this.db
      .select()
      .from(erpContractMilestone)
      .where(eq(erpContractMilestone.contractId, id))
      .orderBy(erpContractMilestone.dueDate);
    const calloffRows = await this.db
      .select({ calloff: erpCalloff, projectName: erpProject.name })
      .from(erpCalloff)
      .leftJoin(erpProject, eq(erpCalloff.projectId, erpProject.id))
      .where(eq(erpCalloff.contractId, id))
      .orderBy(erpCalloff.seq);
    const versionRows = await this.db
      .select()
      .from(erpContractVersion)
      .where(eq(erpContractVersion.contractId, id))
      .orderBy(desc(erpContractVersion.versionNo));
    const milestones: ContractMilestone[] = milestoneRows.map((row) => ({
      id: row.id,
      contractId: row.contractId ?? '',
      name: row.name,
      amount: Number(row.amount ?? 0),
      dueCondition: row.dueCondition,
      dueDate: row.dueDate,
      status: (row.status ?? 'pending') as ContractMilestone['status'],
      actualDate: row.actualDate,
      remark: row.remark,
    }));
    const calloffs: Calloff[] = calloffRows.map((row) => ({
      id: row.calloff.id,
      code: row.calloff.code,
      contractId: row.calloff.contractId ?? '',
      seq: row.calloff.seq ?? 1,
      projectId: row.calloff.projectId,
      projectName: row.projectName,
      amount: Number(row.calloff.amount ?? 0),
      quantity:
        row.calloff.quantity != null ? Number(row.calloff.quantity) : null,
      unitPrice:
        row.calloff.unitPrice != null ? Number(row.calloff.unitPrice) : null,
      orderDate: row.calloff.orderDate,
      remark: row.calloff.remark,
    }));
    const versions: ContractVersion[] = versionRows.map((row) => ({
      id: row.id,
      contractId: row.contractId ?? '',
      versionNo: row.versionNo ?? 1,
      changeLog: row.changeLog ?? '',
      changeAmount: Number(row.changeAmount ?? 0),
      createdAt: row.createdAt.toISOString(),
    }));
    return {
      ...base,
      milestones,
      calloffs,
      versions,
      billable: await this.getBillable(id),
    };
  }

  async createContract(dto: CreateContractDto): Promise<ContractDetail> {
    const customer = await this.db
      .select({ id: mdCustomer.id, name: mdCustomer.name })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, dto.customerId));
    if (customer.length === 0) throw new NotFoundException('客户不存在');
    const validModels = ['project', 'quantity', 'subscription', 'framework'];
    if (!validModels.includes(dto.billingModel)) {
      throw new BadRequestException('非法的计费模型');
    }
    const resolved = await this.taxResolver.resolve({
      explicit: dto.taxRate,
      customerId: dto.customerId,
      taxEntityId: dto.taxEntityId,
      side: 'output',
    });
    const split = splitTax(dto.amount, resolved.rate);
    const code = await generateBizCode(
      this.db,
      erpContract,
      erpContract.code,
      'CTR'
    );
    const rows = await this.db
      .insert(erpContract)
      .values({
        code,
        name: dto.name,
        customerId: dto.customerId,
        billingModel: dto.billingModel,
        amount: String(dto.amount),
        taxRate: String(resolved.rate),
        taxEntityId: resolved.taxEntityId,
        netAmount: String(split.net),
        taxAmount: String(split.tax),
        rateSource: resolved.source,
        status: 'draft',
        signDate: dto.signDate,
        startDate: dto.startDate,
        endDate: dto.endDate,
        owner: dto.owner,
        paymentTerms: dto.paymentTerms,
        remark: dto.remark,
      })
      .returning();
    const contractId = rows[0].id;
    if (dto.milestones && dto.milestones.length > 0) {
      await this.db.insert(erpContractMilestone).values(
        dto.milestones.map((m: CreateMilestoneDto) => ({
          contractId,
          name: m.name,
          amount: String(m.amount),
          dueCondition: m.dueCondition,
          dueDate: m.dueDate,
          status: 'pending',
          remark: m.remark,
        }))
      );
    }
    return this.getContract(contractId);
  }

  async updateContract(id: string, dto: UpdateContractDto): Promise<Contract> {
    const existing = await this.db
      .select()
      .from(erpContract)
      .where(eq(erpContract.id, id));
    if (existing.length === 0) throw new NotFoundException('合同不存在');
    const status = existing[0].status ?? 'draft';
    if (FROZEN_STATUSES.includes(status)) {
      const frozen = ['name', 'taxRate', 'owner', 'startDate', 'endDate', 'remark'] as const;
      if (frozen.some((field) => dto[field] !== undefined)) {
        throw new BadRequestException('已关闭或已终止的合同不能修改名称、税率、负责人、日期和备注');
      }
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.amount !== undefined) {
      if ((existing[0].status ?? 'draft') !== 'draft') {
        throw new BadRequestException(
          '合同已生效，金额变更须走合同变更流程'
        );
      }
      patch.amount = String(dto.amount);
    }
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.taxRate !== undefined || dto.amount !== undefined || dto.taxEntityId !== undefined) {
      const amount = dto.amount ?? Number(existing[0].amount ?? 0);
      // 修复 P1-11：此处原为 `dto.taxRate ?? Number(existing[0].taxRate ?? 6)`，
      // 合同未填税率时会把 6 当成"显式税率"塞进解析器，导致 rateSource 永远是 explicit，
      // 客户/纳税主体的默认税率永远不会被继承。改为空值时传 null，交解析器按优先级推导。
      const existingRate =
        existing[0].taxRate != null ? Number(existing[0].taxRate) : null;
      const resolved = await this.taxResolver.resolve({
        explicit: dto.taxRate ?? existingRate,
        customerId: existing[0].customerId,
        taxEntityId: dto.taxEntityId ?? existing[0].taxEntityId,
        side: 'output',
      });
      const split = splitTax(amount, resolved.rate);
      patch.taxRate = String(resolved.rate);
      patch.netAmount = String(split.net);
      patch.taxAmount = String(split.tax);
      patch.taxEntityId = resolved.taxEntityId;
      patch.rateSource = resolved.source;
    }
    if (dto.owner !== undefined) patch.owner = dto.owner;
    if (dto.paymentTerms !== undefined) patch.paymentTerms = dto.paymentTerms;
    if (dto.startDate !== undefined) patch.startDate = dto.startDate;
    if (dto.endDate !== undefined) patch.endDate = dto.endDate;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    const rows = await this.db
      .update(erpContract)
      .set(patch)
      .where(eq(erpContract.id, id))
      .returning();
    const row = rows[0];
    const customer = await this.db
      .select({ name: mdCustomer.name })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, row.customerId ?? ''));
    return this.contractWithCustomerName(row, customer[0]?.name ?? '');
  }

  async changeStatus(id: string, action: ContractStatusAction): Promise<Contract> {
    const flow = STATUS_FLOW[action];
    if (!flow) throw new BadRequestException('非法的状态操作');
    const existing = await this.db
      .select()
      .from(erpContract)
      .where(eq(erpContract.id, id));
    if (existing.length === 0) throw new NotFoundException('合同不存在');
    const current = (existing[0].status ?? 'draft') as ContractStatus;
    if (!flow.from.includes(current)) {
      throw new BadRequestException(
        `合同状态 ${current} 不允许执行 ${action}`
      );
    }
    if (action === 'submit' || action === 'approve') {
      await this.taxEntities.assertReadyForPosting();
      if (!existing[0].taxEntityId) {
        throw new BadRequestException('请先选择纳税主体');
      }
      await this.assertItemSum(id, Number(existing[0].amount ?? 0));
    }
    if (action === 'approve') {
      const requiredFields = ['name', 'customerId', 'amount'] as const;
      for (const field of requiredFields) {
        if (!existing[0][field]) {
          throw new BadRequestException('合同要素不完整，不可生效');
        }
      }
    }
    const rows = await this.db
      .update(erpContract)
      .set({ status: flow.to, updatedAt: new Date() })
      .where(eq(erpContract.id, id))
      .returning();
    const row = rows[0];
    if (action === 'approve') {
      try {
        await this.maybeAutoCreateProject(row);
      } catch (error) {
        await this.db
          .update(erpContract)
          .set({ status: current, updatedAt: new Date() })
          .where(eq(erpContract.id, id));
        throw error;
      }
    }
    const customer = await this.db
      .select({ name: mdCustomer.name })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, row.customerId ?? ''));
    return this.contractWithCustomerName(row, customer[0]?.name ?? '');
  }

  async addMilestone(
    contractId: string,
    dto: CreateMilestoneDto
  ): Promise<ContractMilestone> {
    const contract = await this.db
      .select({ id: erpContract.id })
      .from(erpContract)
      .where(eq(erpContract.id, contractId));
    if (contract.length === 0) throw new NotFoundException('合同不存在');
    const rows = await this.db
      .insert(erpContractMilestone)
      .values({
        contractId,
        name: dto.name,
        amount: String(dto.amount),
        dueCondition: dto.dueCondition,
        dueDate: dto.dueDate,
        status: 'pending',
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];
    return {
      id: row.id,
      contractId: row.contractId ?? '',
      name: row.name,
      amount: Number(row.amount ?? 0),
      dueCondition: row.dueCondition,
      dueDate: row.dueDate,
      status: (row.status ?? 'pending') as ContractMilestone['status'],
      actualDate: row.actualDate,
      remark: row.remark,
    };
  }

  async updateMilestone(
    milestoneId: string,
    dto: { status?: 'reached'; actualDate?: string; name?: string; amount?: number }
  ): Promise<ContractMilestone> {
    const existing = await this.db
      .select()
      .from(erpContractMilestone)
      .where(eq(erpContractMilestone.id, milestoneId));
    if (existing.length === 0) throw new NotFoundException('里程碑不存在');
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.status === 'reached') {
      patch.status = 'reached';
      patch.actualDate = dto.actualDate ?? new Date().toISOString().slice(0, 10);
    }
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.amount !== undefined) patch.amount = String(dto.amount);
    const rows = await this.db
      .update(erpContractMilestone)
      .set(patch)
      .where(eq(erpContractMilestone.id, milestoneId))
      .returning();
    const row = rows[0];
    return {
      id: row.id,
      contractId: row.contractId ?? '',
      name: row.name,
      amount: Number(row.amount ?? 0),
      dueCondition: row.dueCondition,
      dueDate: row.dueDate,
      status: (row.status ?? 'pending') as ContractMilestone['status'],
      actualDate: row.actualDate,
      remark: row.remark,
    };
  }

  /** 合同变更：同一事务内复制当前明细、更新金额并回写项目预算 */
  async createChange(
    contractId: string,
    dto: { changeLog: string; newAmount?: number }
  ): Promise<ContractVersion> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(erpContract)
        .where(eq(erpContract.id, contractId))
        .for('update');
      if (existing.length === 0) throw new NotFoundException('合同不存在');
      const status = existing[0].status ?? 'draft';
      if (status !== 'active' && status !== 'performing') {
        throw new BadRequestException('只有生效或履行中的合同可以变更');
      }
      const versionRows = await tx
        .select({ versionNo: erpContractVersion.versionNo })
        .from(erpContractVersion)
        .where(eq(erpContractVersion.contractId, contractId));
      const versionNo =
        versionRows.reduce((max, row) => Math.max(max, row.versionNo ?? 0), 0) +
        1;
      const currentItems = await tx
        .select()
        .from(erpContractItem)
        .where(
          and(
            eq(erpContractItem.contractId, contractId),
            eq(erpContractItem.isCurrent, 1)
          )
        );
      const oldAmount = Number(existing[0].amount ?? 0);
      const nextAmount = dto.newAmount ?? oldAmount;
      const itemSum = currentItems.reduce(
        (sumAmount, item) => sumAmount + Number(item.amount ?? 0),
        0
      );
      // T-05：变更金额与明细不一致时按比例缩放新版明细，避免生效后无法改明细的死锁
      const scale =
        currentItems.length > 0 && itemSum > 0.009
          ? nextAmount / itemSum
          : 1;
      if (currentItems.length > 0) {
        await tx
          .update(erpContractItem)
          .set({ isCurrent: 0, updatedAt: new Date() })
          .where(
            and(
              eq(erpContractItem.contractId, contractId),
              eq(erpContractItem.isCurrent, 1)
            )
          );
        const scaled = currentItems.map((item, index) => {
          let amount = Number((Number(item.amount ?? 0) * scale).toFixed(2));
          if (index === currentItems.length - 1) {
            const prior = currentItems
              .slice(0, -1)
              .reduce(
                (s, row) =>
                  s + Number((Number(row.amount ?? 0) * scale).toFixed(2)),
                0
              );
            amount = Number((nextAmount - prior).toFixed(2));
          }
          const rate = Number(item.taxRate ?? 0);
          const split = splitTax(amount, rate);
          const qty = Number(item.quantity ?? 1) || 1;
          const unitPrice = Number((amount / qty).toFixed(4));
          return {
            contractId,
            versionNo,
            isCurrent: 1 as const,
            seq: item.seq,
            itemName: item.itemName,
            unit: item.unit,
            quantity: item.quantity,
            unitPrice: String(unitPrice),
            discountPct: item.discountPct,
            taxRate: item.taxRate,
            amount: String(amount),
            netAmount: String(split.net),
            taxAmount: String(split.tax),
            estUnitCost: item.estUnitCost,
            sourceType: 'change' as const,
            sourceItemId: item.id,
          };
        });
        await tx.insert(erpContractItem).values(scaled);
      }
      const rate = Number(existing[0].taxRate ?? 0);
      const split = splitTax(nextAmount, rate);
      await tx
        .update(erpContract)
        .set({
          amount: String(nextAmount),
          netAmount: String(split.net),
          taxAmount: String(split.tax),
          updatedAt: new Date(),
        })
        .where(eq(erpContract.id, contractId));
      await tx
        .update(erpProject)
        .set({ budget: String(split.net), updatedAt: new Date() })
        .where(eq(erpProject.contractId, contractId));
      const rows = await tx
        .insert(erpContractVersion)
        .values({
          contractId,
          versionNo,
          changeLog: dto.changeLog,
          changeAmount: String(nextAmount - oldAmount),
        })
        .returning();
      const row = rows[0];
      return {
        id: row.id,
        contractId: row.contractId ?? '',
        versionNo: row.versionNo ?? 1,
        changeLog: row.changeLog ?? '',
        changeAmount: Number(row.changeAmount ?? 0),
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  /** 框架合同下单：累计不得超过框架上限 */
  async createCalloff(
    contractId: string,
    dto: CreateCalloffDto
  ): Promise<Calloff> {
    const contract = await this.db
      .select()
      .from(erpContract)
      .where(eq(erpContract.id, contractId));
    if (contract.length === 0) throw new NotFoundException('合同不存在');
    if (contract[0].billingModel !== 'framework') {
      throw new BadRequestException('仅框架合同允许下单');
    }
    const contractStatus = contract[0].status ?? 'draft';
    if (contractStatus !== 'active' && contractStatus !== 'performing') {
      throw new BadRequestException('合同当前状态不能下单');
    }
    const orderedAmount =
      dto.quantity != null && dto.unitPrice != null
        ? Math.round(dto.quantity * dto.unitPrice * 100) / 100
        : dto.amount;
    const calloffRows = await this.db
      .select({ total: sum(erpCalloff.amount), cnt: count() })
      .from(erpCalloff)
      .where(eq(erpCalloff.contractId, contractId));
    const totalExisting = Number(calloffRows[0]?.total ?? 0);
    const contractAmount = Number(contract[0].amount ?? 0);
    if (totalExisting + orderedAmount > contractAmount) {
      throw new BadRequestException(
        `累计下单金额将超过框架上限 ${contractAmount}`
      );
    }
    const code = await generateBizCode(
      this.db,
      erpCalloff,
      erpCalloff.code,
      'CAL'
    );
    const rows = await this.db
      .insert(erpCalloff)
      .values({
        code,
        contractId,
        seq: Number(calloffRows[0]?.cnt ?? 0) + 1,
        projectId: dto.projectId,
        amount: String(orderedAmount),
        quantity: dto.quantity != null ? String(dto.quantity) : null,
        unitPrice: dto.unitPrice != null ? String(dto.unitPrice) : null,
        orderDate: dto.orderDate,
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
      contractId: row.contractId ?? '',
      seq: row.seq ?? 1,
      projectId: row.projectId,
      projectName,
      amount: Number(row.amount ?? 0),
      quantity: row.quantity != null ? Number(row.quantity) : null,
      unitPrice: row.unitPrice != null ? Number(row.unitPrice) : null,
      orderDate: row.orderDate,
      remark: row.remark,
    };
  }

  private async assertItemSum(contractId: string, header: number): Promise<void> {
    const rows = await this.db
      .select({ total: sum(erpContractItem.amount), cnt: count() })
      .from(erpContractItem)
      .where(
        and(
          eq(erpContractItem.contractId, contractId),
          eq(erpContractItem.isCurrent, 1)
        )
      );
    // 修复 T-04：0 条明细不能再放行，否则会出现「合同金额 100 万、明细为空」的生效合同，
    // 收入确认/开票/结算全部失去依据。金额同为 0 的空合同允许无明细。
    if (Number(rows[0]?.cnt ?? 0) === 0) {
      if (Math.abs(header) > 0.01) {
        throw new BadRequestException(
          '合同至少需要一条明细才能提交/生效，请先在「合同明细」中添加明细行'
        );
      }
      return;
    }
    const total = Number(rows[0]?.total ?? 0);
    if (Math.abs(total - header) > 0.01) {
      throw new BadRequestException(
        `合同明细合计 ${total} 与合同金额 ${header} 相差超过 0.01`
      );
    }
  }

  /** 默认关闭。设置 AUTO_CREATE_PROJECT=1 后，合同生效时按不含税金额立项。 */
  private async maybeAutoCreateProject(
    contract: typeof erpContract.$inferSelect
  ): Promise<void> {
    if (process.env.AUTO_CREATE_PROJECT !== '1') return;
    const existing = await this.db
      .select({ id: erpProject.id })
      .from(erpProject)
      .where(eq(erpProject.contractId, contract.id))
      .limit(1);
    if (existing.length > 0) return;
    const milestones = await this.db
      .select()
      .from(erpContractMilestone)
      .where(eq(erpContractMilestone.contractId, contract.id));
    if (milestones.length > 0) {
      const milestoneSum = milestones.reduce(
        (total, row) => total + Number(row.amount ?? 0),
        0
      );
      if (Math.abs(milestoneSum - Number(contract.amount ?? 0)) > 0.01) {
        throw new BadRequestException('合同里程碑金额合计与合同金额不一致');
      }
    }
    const costRows = await this.db
      .select({
        total: sql<string>`coalesce(sum(${erpContractItem.estUnitCost} * ${erpContractItem.quantity}), 0)`,
      })
      .from(erpContractItem)
      .where(
        and(
          eq(erpContractItem.contractId, contract.id),
          eq(erpContractItem.isCurrent, 1)
        )
      );
    const code = await generateBizCode(this.db, erpProject, erpProject.code, 'PRJ');
    const inserted = await this.db
      .insert(erpProject)
      .values({
        code,
        name: contract.name,
        contractId: contract.id,
        budget: String(contract.netAmount ?? contract.amount ?? 0),
        estimatedTotalCost: String(Number(costRows[0]?.total ?? 0)),
        startDate: contract.startDate,
        endDate: contract.endDate,
        progress: 0,
        status: 'initiating',
      })
      .returning({ id: erpProject.id });
    if (milestones.length > 0) {
      await this.db.insert(erpProjectMilestone).values(
        milestones.map((row) => ({
          projectId: inserted[0].id,
          name: row.name,
          planDate: row.dueDate,
          status: 'pending',
          contractMilestoneId: row.id,
          remark: row.remark,
        }))
      );
    }
  }
}
