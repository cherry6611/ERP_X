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
import { and, desc, eq, ne, sql, sum, type SQL } from 'drizzle-orm';
import {
  erpApBill,
  erpAr,
  erpContract,
  erpInvoice,
  erpProject,
  erpProjectRevenue,
  finVoucher,
  mdCustomer,
  mdSupplier,
  mdTaxEntity,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import {
  declaredVatPeriodSet,
  isVatPeriodDeclared,
} from '@server/common/utils/vat-declaration-period';
import { DataScopeService } from '@server/common/auth/data-scope.service';
import type { RequestActor } from '@server/common/auth/actor';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { TaxEntityService } from '@server/modules/tax/tax-entity.service';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { splitTax } from '@shared/tax';
import {
  CONTRACT_INVOICED_DIRECTION,
  computeBillable,
  decideFrameworkSalesLimit,
} from './invoice-billable';
import { listActiveTaxEntityIds } from '@server/common/tax/tax-entity-resolver';
import {
  inputIssueLines,
  inputVoidLines,
  outputIssueLines,
} from '@server/common/tax/posting';
import { todayInShanghai } from '@server/common/utils/biz-date';
import {
  decideInvoiceEdit,
  pickVoucherAffectingFields,
  shouldRebuildInvoiceVoucher,
} from './invoice-edit-guard';
import { moneyText, round2, yuanToCents } from '@shared/number';
import type {
  CreateInvoiceDto,
  InvoiceCertificationStatus,
  InvoiceDirection,
  InvoiceItem,
  InvoiceStatus,
  InvoiceType,
  InvoiceVerifyStatus,
  UpdateInvoiceDto,
} from '@shared/api.interface';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InvoiceLockRow {
  id: string;
  status: string | null;
  contract_id: string | null;
  amount: string | null;
  tax_rate: string | null;
  code: string | null;
  invoice_no: string | null;
  direction: string | null;
  /** P0-2：进项作废冲销凭证需要沿用发票自身的纳税主体 */
  tax_entity_id: string | null;
  /** P0-C：跨月作废闸门需要知道开票月份 */
  invoice_date: string | null;
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService,
    private readonly taxEntities: TaxEntityService,
    private readonly taxResolver: TaxResolverService,
    private readonly dataScope: DataScopeService
  ) {}

  /**
   * B-02：发票台账的行级可见范围（SQL 层过滤）。
   *
   * `finance_ledger` 资源在发票上的语义映射：
   *   - `custom`            → `erp_invoice.tax_entity_id IN (custom_ids)`
   *   - `self`              → 项目负责人 `erp_project.pm_user_id = 当前用户`
   *   - `dept/dept_and_child` → `erp_project.dept_name IN (本部门及下级)`
   * 口径说明（**需业务确认**）：erp_invoice 无责任人字段，`self` 以项目负责人代位；
   * 未挂项目的发票在 `self` 范围下不可见。
   */
  private async scopeCondition(actor?: RequestActor): Promise<SQL | undefined> {
    if (!actor) return undefined;
    const resolved = await this.dataScope.resolveScope(
      actor.roles ?? [],
      'finance_ledger'
    );
    if (resolved.from !== 'config') return undefined;
    return this.dataScope.conditionFor(
      'finance_ledger',
      actor,
      {
        primary: erpInvoice.taxEntityId,
        self: erpProject.pmUserId,
        dept: erpProject.deptName,
      },
      { departmentValueKind: 'name', resolved }
    );
  }

  async listInvoices(
    contractId?: string,
    direction?: string,
    actor?: RequestActor
  ): Promise<InvoiceItem[]> {
    const conditions: SQL[] = [];
    if (contractId) conditions.push(eq(erpInvoice.contractId, contractId));
    if (direction) conditions.push(eq(erpInvoice.direction, direction));
    // B-02：发票台账按纳税主体 / 部门行级过滤（SQL 层）
    const scopeWhere: SQL | undefined = await this.scopeCondition(actor);
    if (scopeWhere) conditions.push(scopeWhere);
    const rows = await this.db
      .select({
        invoice: erpInvoice,
        contractName: erpContract.name,
        customerName: mdCustomer.name,
        projectName: erpProject.name,
        supplierName: mdSupplier.name,
        arCode: erpAr.code,
        apCode: erpApBill.code,
      })
      .from(erpInvoice)
      .leftJoin(erpContract, eq(erpInvoice.contractId, erpContract.id))
      .leftJoin(mdCustomer, eq(erpInvoice.customerId, mdCustomer.id))
      .leftJoin(erpProject, eq(erpInvoice.projectId, erpProject.id))
      .leftJoin(mdSupplier, eq(erpInvoice.supplierId, mdSupplier.id))
      .leftJoin(erpAr, eq(erpInvoice.arId, erpAr.id))
      .leftJoin(erpApBill, eq(erpInvoice.apId, erpApBill.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(erpInvoice.createdAt));
    // P0-C：批量标注"所属期已申报"（一次查询，避免逐行 N+1）
    const declared = await declaredVatPeriodSet(
      this.db,
      rows
        .map((row) => (row.invoice.invoiceDate ?? '').slice(0, 7))
        .filter((period) => period.length === 7)
    );
    return rows.map((row) => this.toInvoiceItem(row, declared));
  }

  private toInvoiceItem(
    row: {
      invoice: typeof erpInvoice.$inferSelect;
      contractName: string | null;
      customerName: string | null;
      projectName: string | null;
      supplierName: string | null;
      arCode: string | null;
      apCode: string | null;
    },
    declaredPeriods?: Set<string>
  ): InvoiceItem {
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
      apId: row.invoice.apId ?? null,
      apCode: row.apCode,
      amount: Number(row.invoice.amount ?? 0),
      taxRate: Number(row.invoice.taxRate ?? 0),
      taxAmount: Number(row.invoice.taxAmount ?? 0),
      invoiceDate: row.invoice.invoiceDate,
      status: (row.invoice.status ?? 'issued') as InvoiceStatus,
      verifyStatus: (row.invoice.verifyStatus ?? 'unverified') as InvoiceVerifyStatus,
      verifyTime: row.invoice.verifyTime
        ? new Date(row.invoice.verifyTime).toISOString()
        : null,
      verifyError: row.invoice.verifyError ?? null,
      certificationStatus: (row.invoice.certificationStatus ??
        'uncertified') as InvoiceCertificationStatus,
      certificationPeriod: row.invoice.certificationPeriod ?? null,
      // P0-C / P0-D：红字发票 = 负数金额 + 有来源单据
      isRedLetter:
        Number(row.invoice.amount ?? 0) < 0 && Boolean(row.invoice.sourceRef),
      declaredPeriodConfirmed:
        (row.invoice.invoiceDate ?? '').slice(0, 7).length === 7 &&
        (declaredPeriods
          ? declaredPeriods.has((row.invoice.invoiceDate ?? '').slice(0, 7))
          : false),
      voidReason: row.invoice.voidReason ?? null,
      voidedAt: row.invoice.voidedAt
        ? new Date(row.invoice.voidedAt).toISOString()
        : null,
      voidedBy: row.invoice.voidedBy ?? null,
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
        apCode: erpApBill.code,
      })
      .from(erpInvoice)
      .leftJoin(erpContract, eq(erpInvoice.contractId, erpContract.id))
      .leftJoin(mdCustomer, eq(erpInvoice.customerId, mdCustomer.id))
      .leftJoin(erpProject, eq(erpInvoice.projectId, erpProject.id))
      .leftJoin(mdSupplier, eq(erpInvoice.supplierId, mdSupplier.id))
      .leftJoin(erpAr, eq(erpInvoice.arId, erpAr.id))
      .leftJoin(erpApBill, eq(erpInvoice.apId, erpApBill.id))
      .where(eq(erpInvoice.id, id));
    if (rows.length === 0) throw new NotFoundException('发票记录不存在');
    const period = (rows[0].invoice.invoiceDate ?? '').slice(0, 7);
    const declared = await declaredVatPeriodSet(
      this.db,
      period.length === 7 ? [period] : []
    );
    return this.toInvoiceItem(rows[0], declared);
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
    const replay = await this.findInvoiceByClientRequest(dto.clientRequestId);
    if (replay) return replay;
    const direction: InvoiceDirection = dto.direction ?? 'sales';
    try {
      if (direction === 'purchase') {
        return await this.createPurchaseInvoice(dto);
      }
      return await this.createSalesInvoice(dto);
    } catch (error) {
      const again = await this.findInvoiceByClientRequest(dto.clientRequestId);
      if (again && isUniqueViolation(error)) return again;
      throw error;
    }
  }

  private async findInvoiceByClientRequest(
    clientRequestId: string | undefined,
  ): Promise<InvoiceItem | null> {
    if (!clientRequestId) return null;
    const rows = await this.db
      .select({ id: erpInvoice.id })
      .from(erpInvoice)
      .where(eq(erpInvoice.clientRequestId, clientRequestId))
      .limit(1);
    if (rows.length === 0) return null;
    return this.getInvoiceItem(rows[0].id);
  }

  /** 销项开票：金额不得超过合同可开金额，可关联应收。事务内锁合同防并发超额 */
  private async createSalesInvoice(
    dto: CreateInvoiceDto
  ): Promise<InvoiceItem> {
    await this.taxEntities.assertReadyForPosting();
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
    // P1-2：税率解析与买卖双方主体信息**必须在事务外**完成。
    // `taxResolver.resolve` 走的是注入的 `this.db`（另一条连接），在 `db.transaction`
    // 内调用会形成「外层事务持有连接 + 内层另开连接」的嵌套（pglite 单连接直接冲突，
    // 真实 PG 下也是多余的连接占用）。这里先按合同读出税率/主体，再进事务写入。
    const contractTax = await this.db
      .select({
        taxRate: erpContract.taxRate,
        customerId: erpContract.customerId,
        taxEntityId: erpContract.taxEntityId,
      })
      .from(erpContract)
      .where(eq(erpContract.id, dto.contractId!))
      .limit(1);
    if (contractTax.length === 0) throw new NotFoundException('合同不存在');
    if (!contractTax[0].taxEntityId) {
      const active = await listActiveTaxEntityIds(this.db);
      if (active.length > 1) {
        throw new BadRequestException('请选择我方纳税主体');
      }
    }
    const resolved = await this.taxResolver.resolve({
      explicit: dto.taxRate,
      upstream: Number(contractTax[0].taxRate ?? NaN),
      customerId: contractTax[0].customerId,
      taxEntityId: contractTax[0].taxEntityId,
      side: 'output',
    });
    const taxRate = resolved.rate;
    const split = splitTax(dto.amount, taxRate);
    const seller = resolved.taxEntityId
      ? await this.db
          .select()
          .from(mdTaxEntity)
          .where(eq(mdTaxEntity.id, resolved.taxEntityId))
          .limit(1)
      : [];
    const buyer = contractTax[0].customerId
      ? await this.db
          .select()
          .from(mdCustomer)
          .where(eq(mdCustomer.id, contractTax[0].customerId))
          .limit(1)
      : [];

    const rows = await this.db.transaction(async (tx) => {
      const contractRows = await tx
        .select()
        .from(erpContract)
        .where(eq(erpContract.id, dto.contractId!))
        .for('update');
      if (contractRows.length === 0) throw new NotFoundException('合同不存在');
      const contract = contractRows[0];
      /*
       * 可开金额 = 合同额 − 该合同**已开销项**发票合计。
       *
       * ⚠️ `direction` 过滤不能省：`PATCH /api/finance/invoices/:id` 允许给
       * **进项**发票写 `contractId`（`createPurchaseInvoice` 自己忽略该字段，
       * 所以插入路径看不出来）。缺这一条，进项票会吃掉销项的可开额度，
       * 后续合法开票被误拒。口径与判据见 `invoice-billable.ts`。
       */
      const invoicedRows = await tx
        .select({ amount: erpInvoice.amount })
        .from(erpInvoice)
        .where(
          and(
            eq(erpInvoice.contractId, dto.contractId!),
            eq(erpInvoice.status, 'issued'),
            eq(erpInvoice.direction, CONTRACT_INVOICED_DIRECTION)
          )
        );
      if (contract.billingModel === 'framework') {
        if (!dto.projectId) {
          throw new BadRequestException('框架合同开票必须指定项目');
        }
        const projectOnly = await tx
          .select({ amount: erpInvoice.amount })
          .from(erpInvoice)
          .where(
            and(
              eq(erpInvoice.projectId, dto.projectId),
              eq(erpInvoice.status, 'issued'),
              eq(erpInvoice.direction, CONTRACT_INVOICED_DIRECTION),
            ),
          );
        const revenueRows = await tx
          .select({ total: sum(erpProjectRevenue.amount) })
          .from(erpProjectRevenue)
          .where(
            and(
              eq(erpProjectRevenue.projectId, dto.projectId),
              eq(erpProjectRevenue.status, 'recognized'),
            ),
          );
        const decision = decideFrameworkSalesLimit({
          headerAmount: Number(contract.amount ?? 0),
          invoiceAmount: dto.amount,
          contractInvoiced: invoicedRows.reduce(
            (total, row) => total + Number(row.amount ?? 0),
            0,
          ),
          projectRevenue: Number(revenueRows[0]?.total ?? 0),
          projectInvoiced: projectOnly.reduce(
            (total, row) => total + Number(row.amount ?? 0),
            0,
          ),
        });
        if (!decision.ok) throw new BadRequestException(decision.reason);
      } else {
        const billable = computeBillable(
          contract.amount,
          invoicedRows.map((row) => row.amount),
        );
        if (dto.amount > billable + 0.001) {
          throw new BadRequestException(
            `开票金额超过合同可开金额，当前可开 ${billable}`,
          );
        }
      }
      if (dto.arId) {
        const arRows = await tx
          .select()
          .from(erpAr)
          .where(eq(erpAr.id, dto.arId))
          .for('update');
        if (arRows.length === 0) throw new NotFoundException('应收记录不存在');
        const open =
          Number(arRows[0].amount ?? 0) - Number(arRows[0].settledAmount ?? 0);
        if (dto.amount > open + 0.001) {
          throw new BadRequestException(
            open <= 0.001
              ? '该应收已核销完毕，无法再关联开票。请选择仍有余额的应收，或不关联应收、仅按合同可开金额开票'
              : `开票金额超过未核销应收余额 ${open}。建议先开票再回款核销，或调低开票金额`,
          );
        }
      }
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
          taxAmount: String(split.tax),
          netAmount: String(split.net),
          taxEntityId: resolved.taxEntityId,
          buyerName: buyer[0]?.invoiceTitle || buyer[0]?.name || null,
          buyerUscc:
            buyer[0]?.uscc && buyer[0].uscc.length <= 20 ? buyer[0].uscc : null,
          sellerName: seller[0]?.invoiceTitle || seller[0]?.name || null,
          sellerUscc: seller[0]?.uscc ?? null,
          invoiceDate: dto.invoiceDate ?? todayInShanghai(),
          status: 'issued',
          remark: dto.remark,
          clientRequestId: dto.clientRequestId ?? null,
        })
        .returning();
    });
    const row = rows[0];
    // 方案 A：收入确认为准，销项开票只登记台账，不再生成收入/税凭证
    const item = await this.getInvoiceItem(row.id);
    const recognizedRows = await this.db
      .select({
        total: sql<string>`coalesce(sum(${erpProjectRevenue.amount}), 0)`,
      })
      .from(erpProjectRevenue)
      .where(eq(erpProjectRevenue.contractId, dto.contractId!));
    const recognized = Number(recognizedRows[0]?.total ?? 0);
    const invoicedAfter = await this.db
      .select({
        total: sql<string>`coalesce(sum(${erpInvoice.amount}), 0)`,
      })
      .from(erpInvoice)
      .where(
        and(
          eq(erpInvoice.contractId, dto.contractId!),
          eq(erpInvoice.status, 'issued'),
          // 与可开金额口径同源：只算销项，否则进项票会把「开票额超过已确认收入」
          // 这条提示误报出来（见 invoice-billable.ts 的说明）
          eq(erpInvoice.direction, CONTRACT_INVOICED_DIRECTION)
        )
      );
    const invoicedTotal = Number(invoicedAfter[0]?.total ?? 0);
    if (invoicedTotal > recognized + 0.01) {
      item.warning = `开票额（累计 ${invoicedTotal}）超过已确认收入 ${recognized}`;
    }
    return item;
  }

  /** 进项发票登记：可关联供应商与应付；F8 勾稽累计开票 ≤ 应付金额 */
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
    if (dto.apId && !UUID_PATTERN.test(dto.apId)) {
      throw new BadRequestException('apId 格式不合法');
    }
    await this.taxEntities.assertReadyForPosting();
    const resolved = await this.taxResolver.resolve({
      explicit: dto.taxRate,
      supplierId: dto.supplierId,
      side: 'input',
    });
    const taxRate = resolved.rate;
    const split = splitTax(dto.amount, taxRate);
    const code = await generateBizCode(
      this.db,
      erpInvoice,
      erpInvoice.code,
      'INV'
    );
    const rows = await this.db.transaction(async (tx) => {
      let supplierId = dto.supplierId ?? null;
      if (dto.apId) {
        const apRows = await tx
          .select()
          .from(erpApBill)
          .where(eq(erpApBill.id, dto.apId))
          .for('update');
        if (apRows.length === 0) throw new NotFoundException('应付记录不存在');
        const ap = apRows[0];
        if (supplierId && ap.supplierId && supplierId !== ap.supplierId) {
          throw new BadRequestException('进项发票供应商与应付供应商不一致');
        }
        if (!supplierId) supplierId = ap.supplierId ?? null;
        const invoicedRows = await tx
          .select({ total: sum(erpInvoice.amount) })
          .from(erpInvoice)
          .where(
            and(
              eq(erpInvoice.apId, dto.apId),
              eq(erpInvoice.status, 'issued'),
              eq(erpInvoice.direction, 'purchase'),
            ),
          );
        const invoiced = Number(invoicedRows[0]?.total ?? 0);
        const apAmount = Number(ap.amount ?? 0);
        const cumulative = round2(invoiced + dto.amount);
        if (cumulative > apAmount + 0.001) {
          throw new BadRequestException(
            `进项开票累计 ${cumulative} 超过应付金额 ${apAmount}（已开 ${invoiced}）`,
          );
        }
      }
      return tx
        .insert(erpInvoice)
        .values({
          code,
          projectId: dto.projectId,
          invoiceNo: dto.invoiceNo || code,
          invoiceType: dto.invoiceType,
          direction: 'purchase',
          supplierId,
          apId: dto.apId ?? null,
          amount: String(dto.amount),
          taxRate: String(taxRate),
          taxAmount: String(split.tax),
          netAmount: String(split.net),
          taxEntityId: resolved.taxEntityId,
          invoiceDate: dto.invoiceDate ?? todayInShanghai(),
          status: 'issued',
          remark: dto.remark,
          clientRequestId: dto.clientRequestId ?? null,
        })
        .returning();
    });
    const row = rows[0];
    await this.voucherHookService.generateVoucherDraft({
      sourceType: 'invoice',
      sourceRef: `invoice:${row.invoiceNo ?? row.code}`,
      voucherDate: row.invoiceDate ?? todayInShanghai(),
      summary: `进项发票 ${row.invoiceNo ?? row.code}`,
      lines: inputIssueLines(Number(row.amount ?? 0), taxRate),
      // P0-2：进项发票凭证的纳税主体与发票一致（解析器已按合同/主体给出）
      taxEntityId: resolved.taxEntityId,
    });
    return this.getInvoiceItem(row.id);
  }

  /**
   * 作废发票：锁发票与合同行，作废后对进项冲回凭证。
   *
   * ## P0-C 修正：跨月作废闸门
   *
   * 原实现只校验 `status='issued'`，**不限开票月份**。而增值税底稿按
   * `status='issued'` 取数 —— 于是已申报期间的销项发票可以被事后作废，
   * **已申报的销项税额被静默抹掉**：申报表里报过的数在系统里消失，
   * 而账面（销项开票不入账，方案 A）完全看不出来。
   *
   * 这是明确的税法问题：《增值税专用发票使用规定》（国税发〔2006〕156 号）
   * 第二十条与国家税务总局公告 2016 年第 47 号规定，**已申报/跨月**的发票
   * 不得作废，应按规定开具红字发票。
   *
   * 因此本方法现在分两步：
   *   ① 若发票所属期已存在**已确认**的申报底稿 → 拒绝作废，提示改走红字发票；
   *   ② 否则允许作废（同月作废是合法且常见的操作，不影响任何已申报数据）。
   *
   * ## 作废留痕
   *
   * 同时写入 `void_reason` / `voided_at` / `voided_by`：作废是**不可逆**的
   * （B1 的应收/应付作废更彻底，这里是"作废即退出申报口径"），
   * 事后必须能回答"谁、为什么、什么时候"。
   */
  async voidInvoice(
    id: string,
    userId: string,
    voidReason?: string
  ): Promise<InvoiceItem> {
    const locked = await this.db.transaction(async (tx) => {
      const rows: unknown = await tx.execute(sql`
        SELECT id, status, contract_id, amount, tax_rate, code, invoice_no, direction, tax_entity_id, invoice_date
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
      // P0-C：已申报期间的发票不得作废，必须走红字发票
      const period = (invoice.invoice_date ?? '').slice(0, 7);
      if (period && (await isVatPeriodDeclared(tx as unknown as PostgresJsDatabase, period))) {
        throw new BadRequestException(
          `发票所属期 ${period} 的增值税申报底稿已确认，跨月不得作废（国税发〔2006〕156 号第二十条）；` +
            `请改用「开具红字发票」冲减，红字发票会自动冲减当期销项税额`
        );
      }
      if (invoice.contract_id) {
        await tx.execute(sql`
          SELECT id FROM erp_contract WHERE id = ${invoice.contract_id} FOR UPDATE
        `);
      }
      const updated = await tx
        .update(erpInvoice)
        .set({
          status: 'voided',
          voidReason: voidReason?.trim() || '未填写作废原因',
          voidedAt: new Date(),
          voidedBy: userId,
          updatedAt: new Date(),
          updatedBy: userId,
        })
        .where(and(eq(erpInvoice.id, id), eq(erpInvoice.status, 'issued')))
        .returning({ id: erpInvoice.id });
      if (updated.length === 0) {
        throw new BadRequestException('仅已开票状态的发票可作废');
      }
      return invoice;
    });

    // 方案 A：销项作废只改状态；进项仍冲回凭证
    if ((locked.direction ?? 'sales') !== 'sales') {
      const amount = Number(locked.amount ?? 0);
      const rate = Number(locked.tax_rate ?? 0);
      const ref = locked.invoice_no ?? locked.code ?? id;
      const voucherStatus = await this.voucherHookService.generateVoucherDraft({
        sourceType: 'invoice',
        sourceRef: `invoice-void:${ref}`,
        voucherDate: todayInShanghai(),
        summary: `进项发票作废冲销 ${ref}`,
        lines: inputVoidLines(amount, rate),
        taxEntityId: locked.tax_entity_id,
      });
      if (voucherStatus !== 'created') {
        this.logger.error(
          `进项作废凭证 voucherStatus=${voucherStatus} invoice-void:${ref}`
        );
      }
    }
    return this.getInvoiceItem(id);
  }

  /**
   * P0-C / P0-D：**登记红字发票**（负数发票），冲减当期销项/进项税额。
   *
   * ## 为什么必须有这条路径
   *
   * 销售退货（`return.service.ts`）与收入冲回（`revenues.service.ts`）原先只生成
   * **红字凭证**（借 6001 / 借 222101 / 贷 1122，分录方向正确），而增值税底稿的销项
   * **100% 来自 `erp_invoice` 台账**（只取 `direction='sales' AND status='issued'`）。
   * 于是：
   *   · **申报口径不冲减** → 多缴增值税；
   *   · **账表永久差异** → 底稿每月必然报 `output_mismatch`，长期噪声把真实异常淹没。
   *
   * 红字发票让"票"与"账"重新对齐：负数 `amount/tax_amount/net_amount` 直接参与
   * 底稿汇总（`sum()` 天然就是冲减），不需要在底稿里为退货写特例分支。
   *
   * ## 为什么不复用 `createSalesInvoice`
   *
   * 开票路径要做"可开金额 ≤ 合同额 − 已开票额"的校验，而红字发票恰恰是**反向**动作
   * （它增加可开金额的回补空间）；且它必须能在**没有合同**的场景下登记
   * （如无合同的收入冲回）。因此单独一条路径，只做幂等与留痕。
   *
   * ## 幂等
   *
   * `sourceRef` 唯一标识来源单据（如 `sales-return:SRT2026100001`）。同一来源重复调用
   * 直接返回既有红字发票，不会重复冲减 —— 退货/冲回本身可能被重试。
   */
  async createRedLetterInvoice(
    input: {
      direction: InvoiceDirection;
      amount: number;
      taxRate: number;
      sourceRef: string;
      invoiceDate?: string;
      contractId?: string | null;
      customerId?: string | null;
      supplierId?: string | null;
      projectId?: string | null;
      taxEntityId?: string | null;
      remark?: string;
    },
    userId?: string
  ): Promise<InvoiceItem> {
    if (!(input.amount > 0)) {
      throw new BadRequestException('红字发票金额必须大于 0（系统按负数落账）');
    }
    if (!input.sourceRef || input.sourceRef.trim().length === 0) {
      throw new BadRequestException('红字发票必须携带 sourceRef 以标识来源单据');
    }
    const existing = await this.db
      .select({ id: erpInvoice.id })
      .from(erpInvoice)
      .where(
        and(
          eq(erpInvoice.sourceRef, input.sourceRef),
          ne(erpInvoice.status, 'voided'),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      // 幂等：同一来源单据只出一张有效红字发票；已作废的红字票可重开
      return this.getInvoiceItem(existing[0].id);
    }
    const split = splitTax(input.amount, input.taxRate);
    const code = await generateBizCode(
      this.db,
      erpInvoice,
      erpInvoice.code,
      'INV'
    );
    const invoiceDate = input.invoiceDate ?? todayInShanghai();
    const rows = await this.db
      .insert(erpInvoice)
      .values({
        code,
        contractId: input.contractId ?? null,
        customerId: input.customerId ?? null,
        projectId: input.projectId ?? null,
        // 红字发票的票号沿用来源单据生成的 `R` 前缀业务号：
        // 真实红字发票由税控系统开具，本系统只登记，票号字段由用户事后补齐。
        invoiceNo: code,
        invoiceType: 'vat_special',
        direction: input.direction,
        supplierId: input.supplierId ?? null,
        // 负数金额：底稿的 sum() 直接把它算作冲减，无需特例分支
        amount: String(-input.amount),
        taxRate: String(input.taxRate),
        taxAmount: String(-split.tax),
        netAmount: String(-split.net),
        taxEntityId: input.taxEntityId ?? null,
        invoiceDate,
        status: 'issued',
        sourceRef: input.sourceRef,
        remark: input.remark ?? `红字发票（冲减 ${input.sourceRef}）`,
        updatedBy: userId ?? null,
      })
      .returning({ id: erpInvoice.id });
    this.logger.log(
      `红字发票已登记 ${code} amount=-${input.amount} source=${input.sourceRef}`
    );
    return this.getInvoiceItem(rows[0].id);
  }

  /**
   * 发票登记后编辑。
   *
   * ## 放开范围与判据
   *
   * 原先只能改 `invoiceNo` / `arId` / `remark` —— 金额、税率、开票日期录错了
   * 只能作废重开。现在按本仓既有的记账哲学放开（用户要求）：
   *
   * > `voucher.controller.ts:317`：**仅草稿凭证可改（已过账凭证的分录摘要
   * > 属于已入账信息，改动需走红冲）**
   *
   * 因此：凭证 `draft` / 无凭证 / 已作废 → 可改**并重建凭证**；
   * 凭证 `posted` → 拒绝，提示先作废发票再重开。
   * 判据抽在 `./invoice-edit-guard`（纯函数 + 9 条断言），此处只调用。
   *
   * ## 为什么"重建凭证"要作废旧的而不是直接改
   *
   * `generateVoucherDraft` 的幂等判据是"同 sourceRef 且状态非 voided 则视为
   * 已出凭证"（`voucher-hook.service.ts:118-127`）。若不作废旧凭证，
   * 新的金额**根本不会被写进账**（函数直接 return 'created'）——
   * 于是发票台账改了、明细账没改，两者静默分叉。所以必须先作废。
   *
   * ## 为何不自动红冲已过账凭证
   *
   * 已过账凭证的红冲会**改变已结期间的账**。让它由"编辑发票"隐式触发很危险：
   * 使用者以为只改了张单子，实际却在已结账期间加了一对红蓝凭证。
   * 这条路径留给**显式**的「作废发票」（有跨月申报闸门、有冲回凭证、有审计留痕）。
   */
  async updateInvoice(
    id: string,
    dto: UpdateInvoiceDto,
    userId: string
  ): Promise<InvoiceItem> {
    const existingRows = await this.db
      .select()
      .from(erpInvoice)
      .where(eq(erpInvoice.id, id))
      .limit(1);
    if (existingRows.length === 0) throw new NotFoundException('发票记录不存在');
    const existing = existingRows[0];
    if (Object.prototype.hasOwnProperty.call(dto, 'direction')) {
      throw new BadRequestException('已开具发票不能修改方向，请作废后重新登记');
    }

    /* 本次请求里显式出现的字段（`!== undefined` 才算"要改"） */
    const presentKeys = Object.entries(dto)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    const affecting = pickVoucherAffectingFields(presentKeys);

    /* 只在"要改影响凭证的字段"时才去查凭证 —— 改备注不该被凭证状态挡住 */
    let voucherStatus: 'draft' | 'posted' | 'voided' | null = null;
    if (affecting.length > 0) {
      /*
       * ⚠️ 必须**优先取非 voided** 的那张，且排序确定。
       *
       * 一旦编辑过一次，同一个 `sourceRef` 下会同时存在
       * 「旧 voided 凭证」与「新 draft 凭证」两张（重建 = 作废旧 + 生成新）。
       * 若这里用 `.limit(1)` 且不带 `ORDER BY`，取到哪张是实现相关的 ——
       * 实测会取到 voided 那张，于是 `decideInvoiceEdit` 判为
       * "已作废 → 可改并重建"，**凭证已过账时也放行**（本会话真实复现：
       * 过账后再改金额返回 200，而期望 400）。
       *
       * 判据必须与 `generateVoucherDraft` 的幂等键一致：
       * 「同 sourceRef 且**状态非 voided**」才算"本业务已出凭证"
       * （`voucher-hook.service.ts:118-127`）。
       */
      const vRows = await this.db
        .select({ status: finVoucher.status })
        .from(finVoucher)
        .where(
          and(
            eq(finVoucher.sourceType, 'invoice'),
            eq(finVoucher.sourceRef, `invoice:${existing.invoiceNo ?? existing.code}`),
          ),
        )
        .orderBy(sql`case when ${finVoucher.status} = 'voided' then 1 else 0 end`)
        .limit(1);
      voucherStatus = (vRows[0]?.status as typeof voucherStatus) ?? null;
    }

    const decision = decideInvoiceEdit({
      invoiceStatus: existing.status ?? 'issued',
      voucherStatus,
      touchesVoucherFields: affecting.length > 0,
    });
    if (!decision.ok) throw new BadRequestException(decision.reason);
    /*
     * 已确认申报的期间不得再走"编辑"路径改金额/日期等影响凭证的字段。
     *
     * 作废路径已有 `isVatPeriodDeclared` 硬闸门（见 voidInvoice）；编辑路径
     * 原先没有，导致"已申报 106,000 → PATCH 成 10,600"后底稿重算、已申报数
     * 在系统里消失且无红字票/无留痕。要更正必须走红字发票，不能靠 PATCH。
     */
    if (affecting.length > 0) {
      const periodToCheck = (
        dto.invoiceDate ??
        existing.invoiceDate ??
        todayInShanghai()
      ).slice(0, 7);
      if (await isVatPeriodDeclared(this.db, periodToCheck)) {
        throw new BadRequestException(
          `发票所属期间 ${periodToCheck} 已确认申报，不能直接修改金额/税率/日期；` +
            `请先开具红字发票，再重新登记`,
        );
      }
    }
    /*
     * 方案 A：销项发票按设计不生成凭证。
     *
     * `voucherStatus === null` 对销项票是正常状态；若直接按 `decision.rebuildVoucher`
     * 走重建分支，会把一张从未入账的销项票补成一张收入/销项税凭证，导致
     * 收入、销项税、应收三重重复。这里必须按方向收口：只有进项票才允许重建。
     */
    let rebuildVoucher = shouldRebuildInvoiceVoucher(
      existing.direction,
      decision,
    );
    let voidExisting = voucherStatus != null && voucherStatus !== 'voided';

    /* ── 组装 patch（金额/税率变化必须重算价税分离）── */
    const patch: Partial<typeof erpInvoice.$inferInsert> = {};
    if (dto.invoiceNo !== undefined) patch.invoiceNo = dto.invoiceNo;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    if (dto.arId !== undefined) {
      if (dto.arId !== null) await this.assertArExists(dto.arId);
      patch.arId = dto.arId;
    }
    if (dto.invoiceType !== undefined) patch.invoiceType = dto.invoiceType;
    if (dto.projectId !== undefined) patch.projectId = dto.projectId;
    if (dto.contractId !== undefined) patch.contractId = dto.contractId;
    if (dto.supplierId !== undefined) patch.supplierId = dto.supplierId;
    if (dto.apId !== undefined) patch.apId = dto.apId;
    if (dto.invoiceDate !== undefined) patch.invoiceDate = dto.invoiceDate;

    const newAmount = dto.amount ?? Number(existing.amount ?? 0);
    if (newAmount <= 0) {
      throw new BadRequestException('开票金额必须大于 0');
    }
    /*
     * 税率解析与 `createSalesInvoice` 同源：显式 > 上游（合同）> 客户/主体默认。
     * 合约/主体用**本次请求后的值**（`dto.x ?? existing.x`），否则改归属后
     * 仍按旧合同解析税率 —— 这是最容易漏的一处。
     */
    const mergedContractId =
      dto.contractId !== undefined ? dto.contractId : existing.contractId;
    let upstreamRate: number | undefined;
    let upstreamContractAmount: number | undefined;
    let customerIdForRate: string | null = existing.customerId;
    let taxEntityIdForRate: string | null = existing.taxEntityId;
    if (mergedContractId) {
      const cRows = await this.db
        .select({
          amount: erpContract.amount,
          taxRate: erpContract.taxRate,
          customerId: erpContract.customerId,
          taxEntityId: erpContract.taxEntityId,
        })
        .from(erpContract)
        .where(eq(erpContract.id, mergedContractId))
        .limit(1);
      if (cRows.length === 0) throw new NotFoundException('合同不存在');
      upstreamRate = Number(cRows[0].taxRate ?? NaN);
      upstreamContractAmount = Number(cRows[0].amount ?? 0);
      customerIdForRate = cRows[0].customerId;
      taxEntityIdForRate = cRows[0].taxEntityId;
    }
    const isPurchase = (existing.direction ?? 'sales') === 'purchase';
    /*
     * 销售发票 PATCH 也必须复用「合同可开金额」校验（与 createSalesInvoice 同口径）。
     * 否则可以先生成 1 元发票、再 PATCH 到 1,000,000，绕过开票上限。
     * 计算时排除当前这张票，避免把它自己算成“已开票”。
     */
    if (
      !isPurchase &&
      mergedContractId &&
      (dto.amount !== undefined || dto.contractId !== undefined)
    ) {
      const otherInvoices = await this.db
        .select({ amount: erpInvoice.amount })
        .from(erpInvoice)
        .where(
          and(
            eq(erpInvoice.contractId, mergedContractId),
            eq(erpInvoice.status, 'issued'),
            eq(erpInvoice.direction, 'sales'),
            ne(erpInvoice.id, id),
          ),
        );
      const billable = computeBillable(
        upstreamContractAmount ?? 0,
        otherInvoices.map((row) => row.amount),
      );
      const amountCents = yuanToCents(newAmount);
      const billableCents = yuanToCents(billable);
      if (
        amountCents == null ||
        billableCents == null ||
        amountCents > billableCents + 1n
      ) {
        throw new BadRequestException(
          `开票金额 ${newAmount} 超过合同可开金额 ${billable}（合同额 − 其他已开销项发票）`,
        );
      }
    }
    const resolved = await this.taxResolver.resolve({
      explicit: dto.taxRate,
      upstream: upstreamRate,
      customerId: customerIdForRate,
      taxEntityId: taxEntityIdForRate,
      side: isPurchase ? 'input' : 'output',
    });
    const split = splitTax(newAmount, resolved.rate);
    if (dto.amount !== undefined || affecting.length > 0) {
      const amountStored = moneyText(newAmount);
      if (amountStored == null) {
        throw new BadRequestException('开票金额无法换算到分');
      }
      patch.amount = amountStored;
      patch.taxRate = String(resolved.rate);
      patch.netAmount = String(split.net);
      patch.taxAmount = String(split.tax);
      patch.taxEntityId = resolved.taxEntityId;
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }
    patch.updatedAt = new Date();
    patch.updatedBy = userId;

    /* ── 作废旧凭证（若需重建）→ 写发票（同一事务）→ 重建凭证 ── */
    let row: typeof erpInvoice.$inferSelect | undefined;
    await this.db.transaction(async (tx) => {
      await tx
        .select({ id: erpInvoice.id })
        .from(erpInvoice)
        .where(eq(erpInvoice.id, id))
        .for('update');
      if (affecting.length > 0) {
        const lockedVouchers = await tx
          .select({ status: finVoucher.status })
          .from(finVoucher)
          .where(
            and(
              eq(finVoucher.sourceType, 'invoice'),
              eq(finVoucher.sourceRef, `invoice:${existing.invoiceNo ?? existing.code}`),
            ),
          )
          .orderBy(sql`case when ${finVoucher.status} = 'voided' then 1 else 0 end`)
          .limit(1)
          .for('update');
        const lockedStatus = (lockedVouchers[0]?.status as typeof voucherStatus) ?? null;
        const lockedDecision = decideInvoiceEdit({
          invoiceStatus: existing.status ?? 'issued',
          voucherStatus: lockedStatus,
          touchesVoucherFields: true,
        });
        if (!lockedDecision.ok) throw new BadRequestException(lockedDecision.reason);
        rebuildVoucher = shouldRebuildInvoiceVoucher(existing.direction, lockedDecision);
        voidExisting = lockedStatus != null && lockedStatus !== 'voided';
      }
      if (rebuildVoucher && voidExisting) {
        /*
         * 先作废：`generateVoucherDraft` 视"非 voided 的同 sourceRef 凭证"为
         * 已出凭证，不作废就不会生成新的一张。
         */
        await tx
          .update(finVoucher)
          .set({ status: 'voided', updatedAt: new Date() })
          .where(
            and(
              eq(finVoucher.sourceType, 'invoice'),
              eq(finVoucher.sourceRef, `invoice:${existing.invoiceNo ?? existing.code}`),
              ne(finVoucher.status, 'voided'),
            ),
          );
      }

      const updated = await tx
        .update(erpInvoice)
        .set(patch)
        .where(eq(erpInvoice.id, id))
        .returning();
      if (updated.length === 0) throw new NotFoundException('发票记录不存在');
      const updatedRow = updated[0];
      row = updatedRow;

      if (rebuildVoucher) {
        const finalAmount = Number(updatedRow.amount ?? 0);
        const finalRate = Number(updatedRow.taxRate ?? 0);
        const isPurchaseRow = (updatedRow.direction ?? 'sales') === 'purchase';
        const lines = isPurchaseRow
          ? inputIssueLines(finalAmount, finalRate)
          : outputIssueLines(finalAmount, finalRate);
        const vStatus = await this.voucherHookService.generateVoucherDraft(
          {
            sourceType: 'invoice',
            sourceRef: `invoice:${updatedRow.invoiceNo ?? updatedRow.code}`,
            voucherDate: updatedRow.invoiceDate ?? todayInShanghai(),
            summary: `${isPurchaseRow ? '进项' : '销项'}发票 ${updatedRow.invoiceNo ?? updatedRow.code}`,
            lines,
            taxEntityId: updatedRow.taxEntityId ?? undefined,
          },
          tx as unknown as PostgresJsDatabase,
        );
        if (vStatus !== 'created') {
          throw new BadRequestException(
            '发票已更新，但重建凭证失败；本次修改已回滚，请检查期间/科目后重试',
          );
        }
      }
    });
    if (!row) throw new NotFoundException('发票记录不存在');

    return this.getInvoiceItem(id);
  }
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('23505') || message.includes('uq_erp_invoice_client_request')) {
    return true;
  }
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code) === '23505';
  }
  return false;
}
