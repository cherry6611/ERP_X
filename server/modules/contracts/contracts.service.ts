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
import { and, count, desc, eq, or, sql, sum } from 'drizzle-orm';
import {
  ilikeEscaped,
  likeContains,
} from '@server/common/utils/sql-like';
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
  mdTaxEntity,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { TaxEntityService } from '@server/modules/tax/tax-entity.service';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import {
  DEFAULT_STAMP_DUTY_ITEM,
  STAMP_DUTY_ITEM_LABELS,
  computeStampDuty,
  resolveStampDutyHalved,
} from '@server/common/tax/stamp-duty';
import { stampDutyAccrualLines } from '@server/common/tax/stamp-duty-posting';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { isVatRate, lineAmount, splitTax } from '@shared/tax';
import { todayInShanghai } from '@server/common/utils/biz-date';
import { round2 } from '@server/common/utils/number';
import { checkItemSumConsistency } from './contract-item-consistency';
import { contractUpdateBlockReason } from './contract-update-guard';
/*
 * 税额重算时「旧税率还算不算显式选定」的判据（纯函数，配有规格）。
 * 不这样抽出来就会出现"税率是客户推导的、rate_source 却写着 explicit"的自相矛盾行 ——
 * 详见该模块文件头的三步表格。
 */
import { explicitRateForRecalc } from './contract-tax-recalc';
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

/**
 * 计费模式白名单（`CreateContractDto.billingModel` 的值域）。
 *
 * 原先是 `createContract` 函数体里的局部数组；`updateContract` 本轮也要用同一份判据，
 * 于是提到模块级共用 —— 两处各写一份必然会漂（本项目已多次发生"同一口径两处各写一遍、
 * 其中一处漏了"）。值域与 `shared/api.interface.ts` 的 `BillingModel`、DTO 的
 * `@IsIn(BILLING_MODELS)` 一致。
 */
const VALID_BILLING_MODELS: ReadonlyArray<string> = [
  'project',
  'quantity',
  'subscription',
  'framework',
];

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly taxResolver: TaxResolverService,
    private readonly taxEntities: TaxEntityService,
    /** §4.7(f)：合同生效时计提印花税（原实现完全未实现 —— 全仓零命中） */
    private readonly voucherHookService: VoucherHookService
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
      // S4：转义 `%`/`_` 并显式 `ESCAPE`，避免 `keyword=%` 匹配全表
      const kw = likeContains(keyword);
      if (kw) {
        conditions.push(
          or(ilikeEscaped(erpContract.name, kw), ilikeEscaped(erpContract.code, kw))!
        );
      }
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
    if (!VALID_BILLING_MODELS.includes(dto.billingModel)) {
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
    // 提交/生效要求至少一条明细；新建时按合同金额自动生成一行，避免「有金额无明细」无法推进
    if (dto.amount > 0 && isVatRate(resolved.rate)) {
      const amount = lineAmount(1, dto.amount, 0);
      const itemSplit = splitTax(amount, resolved.rate);
      await this.db.insert(erpContractItem).values({
        contractId,
        versionNo: 1,
        isCurrent: 1,
        seq: 1,
        itemName: dto.name,
        unit: '项',
        quantity: '1',
        unitPrice: String(dto.amount),
        discountPct: '0',
        taxRate: String(resolved.rate),
        amount: String(amount),
        netAmount: String(itemSplit.net),
        taxAmount: String(itemSplit.tax),
        estUnitCost: '0',
        sourceType: 'manual',
        sourceItemId: null,
      });
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
    /*
     * 可改字段判定：**唯一判据**在 `contract-update-guard.ts`（纯函数，配有规格）。
     * 这里只负责把返回的中文文案抛出去 —— 原先散在本函数里的两条内联守卫
     * （冻结状态 / 金额限草稿）已并入该模块，文案与判据逐字未放宽。
     */
    const blocked = contractUpdateBlockReason(status, dto);
    if (blocked !== null) throw new BadRequestException(blocked);
    if (dto.billingModel !== undefined && !VALID_BILLING_MODELS.includes(dto.billingModel)) {
      throw new BadRequestException('非法的计费模型');
    }
    /*
     * 客户存在性：与 createContract 同一句中文文案。
     * `erp_contract.customer_id` 在全仓**没有外键约束**（基线表未建 REFERENCES），
     * 不查库的话一个不存在的 uuid 会被安安静静地写进去，之后合同在列表里就没有客户名。
     */
    if (dto.customerId !== undefined) {
      const customer = await this.db
        .select({ id: mdCustomer.id })
        .from(mdCustomer)
        .where(eq(mdCustomer.id, dto.customerId));
      if (customer.length === 0) throw new NotFoundException('客户不存在');
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.amount !== undefined) {
      patch.amount = String(dto.amount);
    }
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.customerId !== undefined) patch.customerId = dto.customerId;
    if (dto.billingModel !== undefined) patch.billingModel = dto.billingModel;
    if (dto.signDate !== undefined) patch.signDate = dto.signDate;
    if (dto.taxRate !== undefined || dto.amount !== undefined || dto.taxEntityId !== undefined || dto.customerId !== undefined) {
      const amount = dto.amount ?? Number(existing[0].amount ?? 0);
      /*
       * 修复 P1-11：此处原为 `dto.taxRate ?? Number(existing[0].taxRate ?? 6)`，
       * 合同未填税率时会把 6 当成"显式税率"塞进解析器，导致 rateSource 永远是 explicit，
       * 客户/纳税主体的默认税率永远不会被继承。改为空值时传 null，交解析器按优先级推导。
       *
       * ⚠️ 仅"空值 → null"还不够（本轮补齐的另一半）：
       * `existing[0].taxRate` 里存的可能是**上一次由客户推导出来**的税率
       * （`rate_source = counterparty`）。把它当显式税率传进去，
       * 再改客户时新客户的税率就被忽略了 —— 而且 `rate_source` 会被"洗"成 explicit，
       * 从此永远不再跟随客户。判据抽到 `./contract-tax-recalc`（见其文件头表格）。
       */
      const existingRate = explicitRateForRecalc(
        existing[0].taxRate,
        existing[0].rateSource
      );
      /*
       * ⚠️ 换客户必须按**新客户**解析税率：`taxResolver.resolve` 用 `customerId`
       * 取客户默认税率（`counterpartyRate`）与该客户绑定的纳税主体（`resolveEntity`）。
       * 这里原先写的是 `existing[0].customerId`（改客户前唯一可能的取值），
       * 一旦放开 customerId 就会"客户已换、税率仍按旧客户推导"——
       * 客户主体类型不同时（一般纳税人 13% / 小规模 3%）会直接落一个错档税率。
       * `billingModel` 不在 resolve 的入参里，改计费模式不触发重算。
       */
      const effectiveCustomerId = dto.customerId ?? existing[0].customerId;
      const resolved = await this.taxResolver.resolve({
        explicit: dto.taxRate ?? existingRate,
        customerId: effectiveCustomerId,
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
      /*
       * T10：把合同头的税额与不含税额一并传入，让校验覆盖"明细用错税率"。
       *
       * 只传含税金额是原来的做法，它拦不住"含税额相同、税额不同"的构造
       * （如头 113,000@13% vs 明细 113,000@6%）—— 而项目预算取的是
       * `split.net`，于是同一份合同在系统里出现两个净额。
       *
       * 头的税额/不含税额可能为 NULL（历史数据或未回填），此时跳过这两条
       * 校验而不是猜一个值：`splitTax(amount, headerTaxRate)` 依赖税率，
       * 而税率本身也可能为空 —— 猜出来的期望值只会制造假失败。
       */
      await this.assertItemSum(
        id,
        Number(existing[0].amount ?? 0),
        existing[0].taxAmount === null || existing[0].taxAmount === undefined
          ? null
          : Number(existing[0].taxAmount),
        existing[0].netAmount === null || existing[0].netAmount === undefined
          ? null
          : Number(existing[0].netAmount)
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
      /*
       * §4.7(f)：**印花税计提**（原实现完全未实现 —— 全仓零命中）。
       *
       * 合同生效即产生印花税纳税义务（《印花税法》第十五条：书立应税凭证的
       * 单位和个人为纳税人）。数据服务合同属**技术合同**，税率 0.3‰。
       *
       * ## 为什么放在 approve 而不是 submit
       *
       * `submit` 只是提交审批，合同尚未生效、可以驳回；印花税的义务在
       * **书立**时产生，而"书立"在本系统里对应"双方确认生效"，
       * 即 `approve`。放在 submit 会让被驳回的合同留下一条需要红冲的印花税凭证。
       *
       * ## 失败策略：**不阻断生效**
       *
       * 与 `maybeAutoCreateProject` 不同（那个失败会回滚状态），
       * 印花税凭证失败不该让合同无法生效 —— 合同生效是业务事实，
       * 凭证只是账务反映。这里记 error 并由 `comp_voucher_job` 补偿队列兜底
       * （`generateVoucherDraft` 内部已做），底稿的漏提可在对账时发现。
       */
      await this.accrueStampDuty(row);
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
      patch.actualDate = dto.actualDate ?? todayInShanghai();
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
      // D-16：合同变更预算回写按项目精确处理，禁止把同一净额覆盖到全部项目
      const linkedProjects = await tx
        .select({
          id: erpProject.id,
          budget: erpProject.budget,
        })
        .from(erpProject)
        .where(eq(erpProject.contractId, contractId))
        .for('update');
      if (linkedProjects.length === 1) {
        await tx
          .update(erpProject)
          .set({ budget: String(split.net), updatedAt: new Date() })
          .where(eq(erpProject.id, linkedProjects[0].id));
      } else if (linkedProjects.length > 1) {
        const totalBudget = linkedProjects.reduce(
          (s, p) => s + Number(p.budget ?? 0),
          0,
        );
        let allocated = 0;
        for (let i = 0; i < linkedProjects.length; i += 1) {
          const p = linkedProjects[i];
          let share: number;
          if (i === linkedProjects.length - 1) {
            share = Number((split.net - allocated).toFixed(2));
          } else if (totalBudget > 0.009) {
            share = Number(
              ((split.net * Number(p.budget ?? 0)) / totalBudget).toFixed(2),
            );
            allocated += share;
          } else {
            share = Number(
              (split.net / linkedProjects.length).toFixed(2),
            );
            allocated += share;
          }
          await tx
            .update(erpProject)
            .set({ budget: String(share), updatedAt: new Date() })
            .where(eq(erpProject.id, p.id));
        }
      }
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
        ? round2(dto.quantity * dto.unitPrice)
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

  /**
   * T10（§4.6）：明细与合同头的一致性校验 —— **含税额、税额、不含税额三条都要对**。
   *
   * 原实现只比较含税金额合计，于是可以构造"含税额相等但税额差 6,603.77"的合同：
   *
   *   | | 含税额 | 税率 | 不含税 | 税额 |
   *   |---|---|---|---|---|
   *   | 合同头 | 113,000 | 13% | 100,000 | 13,000 |
   *   | 明细行 | 113,000 | 6% | 106,603.77 | **6,396.23** |
   *
   * 后果不是报表不好看：项目预算取 `split.net`（不含税额），
   * 于是**项目预算凭空多出 6,603.77**，而开票/收入确认/申报都按明细的税率走
   * —— 同一份合同在系统里有两个"净额"，且没有任何对账能发现。
   *
   * 容差 0.01：逐行 `splitTax` 与整单 `splitTax` 因整数分取整可能差 1 分，
   * 这是十进制取整的正常结果，不是缺陷。
   */
  private async assertItemSum(
    contractId: string,
    header: number,
    headerTaxAmount?: number | null,
    headerNetAmount?: number | null
  ): Promise<void> {
    const rows = await this.db
      .select({
        total: sum(erpContractItem.amount),
        taxTotal: sum(erpContractItem.taxAmount),
        netTotal: sum(erpContractItem.netAmount),
        cnt: count(),
      })
      .from(erpContractItem)
      .where(
        and(
          eq(erpContractItem.contractId, contractId),
          eq(erpContractItem.isCurrent, 1)
        )
      );
    /*
     * 校验逻辑已抽到 `./contract-item-consistency`（纯函数 + 21 条断言）——
     * 三项校验（含税合计 / 税额 / 不含税）与"容差随行数放大"的推导都在那里，
     * 这里只负责查数、把问题翻译成可读中文异常。
     *
     * 原实现把容差公式 `0.01 * (itemCount + 1)` 写了两遍，且三处比较都用裸
     * `Math.abs(a - b) > tol` —— 实测 `|60.02 − 60|` 的浮点结果是 `0.020000000000003`，
     * 恰好等于容差却被判"超出"。抽出的模块里比较一律过 `round2`。
     */
    const problems = checkItemSumConsistency({
      headerAmount: header,
      headerTaxAmount,
      headerNetAmount,
      itemCount: Number(rows[0]?.cnt ?? 0),
      totalAmount: rows[0]?.total,
      totalTaxAmount: rows[0]?.taxTotal,
      totalNetAmount: rows[0]?.netTotal,
    });
    if (problems.length > 0) {
      throw new BadRequestException(problems[0]);
    }
  }

  /**
   * §4.7(f)：合同生效时计提印花税。
   *
   * ## 口径
   *
   * · **税目**：数据服务公司的主合同是技术合同 → `technology`（0.3‰）。
   *   本仓合同模型没有"合同类型"字段（只有 `billingModel`：project/…），
   *   因此**不猜** —— 统一按技术合同这一主力档位计税，
   *   并在凭证摘要与 notes 里写明税目，便于财务复核后调整。
   *   若将来合同模型引入税目字段，改这里的入参即可。
   * · **计税依据**：优先 `net_amount`（合同已分别列明增值税，
   *   依财政部 税务总局公告 2022 年第 22 号按不含税计税）；
   *   为 null（历史数据未拆税）时退化为含税金额 —— 方向是**多缴**，安全侧。
   * · **减半**：小规模纳税人适用「六税两费」减半（2023 年第 12 号）。
   *
   * ## 幂等
   *
   * `sourceRef = stamp-duty:<合同号>` —— 凭证钩子按 `(sourceType, sourceRef)`
   * 去重，因此重复 approve（反结项后重新生效）不会重复计提。
   *
   * ## 失败不阻断
   *
   * 见调用点注释。这里只记 error 并返回，不向上抛。
   */
  private async accrueStampDuty(
    contract: typeof erpContract.$inferSelect
  ): Promise<void> {
    try {
      if (!contract.taxEntityId) return;
      const entity = await this.db
        .select({ taxpayerType: mdTaxEntity.taxpayerType })
        .from(mdTaxEntity)
        .where(eq(mdTaxEntity.id, contract.taxEntityId))
        .limit(1);
      const result = computeStampDuty({
        amount: Number(contract.amount ?? 0),
        netAmount:
          contract.netAmount === null || contract.netAmount === undefined
            ? null
            : Number(contract.netAmount),
        item: DEFAULT_STAMP_DUTY_ITEM,
        halved: resolveStampDutyHalved(entity[0]?.taxpayerType),
      });
      const lines = stampDutyAccrualLines(result);
      if (lines.length === 0) {
        // 0 元合同 / 不足 1 角：法定不计，不出凭证（不出 0 元分录）
        return;
      }
      await this.voucherHookService.generateVoucherDraft({
        sourceType: 'contract',
        sourceRef: `stamp-duty:${contract.code}`,
        voucherDate: contract.signDate ?? todayInShanghai(),
        summary: `印花税计提 ${contract.code}（${STAMP_DUTY_ITEM_LABELS[result.item]} ${result.rate}‰）`,
        lines,
        taxEntityId: contract.taxEntityId,
      });
    } catch (error: unknown) {
      // 印花税金额小、但不计提是明确的漏缴；失败必须留痕而不是静默
      this.logger.error(
        `合同 ${contract.code} 印花税计提失败（合同仍生效，请核查后补提）：${
          error instanceof Error ? error.message : String(error)
        }`
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
    // D-17：依赖 uq_erp_project_one_contract，并发生效时捕获 23505 返回既有项目
    let projectId: string;
    try {
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
      projectId = inserted[0].id;
    } catch (error) {
      const pgCode =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code)
          : '';
      if (pgCode !== '23505') throw error;
      const again = await this.db
        .select({ id: erpProject.id })
        .from(erpProject)
        .where(eq(erpProject.contractId, contract.id))
        .limit(1);
      if (again.length === 0) throw error;
      return;
    }
    if (milestones.length > 0) {
      await this.db.insert(erpProjectMilestone).values(
        milestones.map((row) => ({
          projectId,
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
