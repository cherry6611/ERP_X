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
import { and, count, desc, eq, ilike, or, sum } from 'drizzle-orm';
import {
  erpCalloff,
  erpContract,
  erpContractMilestone,
  erpContractVersion,
  erpInvoice,
  erpProject,
  mdCustomer,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
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
};

@Injectable()
export class ContractsService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  private async contractWithCustomerName(row: {
    id: string;
    code: string;
    name: string;
    customerId: string | null;
    billingModel: string | null;
    amount: string | null;
    taxRate: string | null;
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
        taxRate: String(dto.taxRate ?? 6),
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
    if (dto.taxRate !== undefined) patch.taxRate = String(dto.taxRate);
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

  /** 合同变更留痕：生成新版本记录并更新合同金额 */
  async createChange(
    contractId: string,
    dto: { changeLog: string; newAmount?: number }
  ): Promise<ContractVersion> {
    const existing = await this.db
      .select()
      .from(erpContract)
      .where(eq(erpContract.id, contractId));
    if (existing.length === 0) throw new NotFoundException('合同不存在');
    const versionCount = await this.db
      .select({ total: count() })
      .from(erpContractVersion)
      .where(eq(erpContractVersion.contractId, contractId));
    const versionNo = Number(versionCount[0]?.total ?? 0) + 1;
    const oldAmount = Number(existing[0].amount ?? 0);
    if (dto.newAmount !== undefined) {
      await this.db
        .update(erpContract)
        .set({ amount: String(dto.newAmount), updatedAt: new Date() })
        .where(eq(erpContract.id, contractId));
    }
    const rows = await this.db
      .insert(erpContractVersion)
      .values({
        contractId,
        versionNo,
        changeLog: dto.changeLog,
        changeAmount: String(
          dto.newAmount !== undefined ? dto.newAmount - oldAmount : 0
        ),
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
    const calloffRows = await this.db
      .select({ total: sum(erpCalloff.amount), cnt: count() })
      .from(erpCalloff)
      .where(eq(erpCalloff.contractId, contractId));
    const totalExisting = Number(calloffRows[0]?.total ?? 0);
    const contractAmount = Number(contract[0].amount ?? 0);
    if (totalExisting + dto.amount > contractAmount) {
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
        amount: String(dto.amount),
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
      orderDate: row.orderDate,
      remark: row.remark,
    };
  }
}
