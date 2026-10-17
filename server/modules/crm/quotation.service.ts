import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, desc, eq, inArray, isNull, max } from 'drizzle-orm';
import {
  crmOpportunity,
  crmQuotation,
  crmQuotationItem,
  erpContract,
  erpContractItem,
  mdCustomer,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { round2 } from '@server/common/utils/number';
import {
  contractLineAmount,
  quotationTotals,
  rawLineAmount,
} from './quotation-totals';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { splitTax } from '@shared/tax';
import { NotificationsService } from '@server/modules/notifications/notifications.service';
import { todayInShanghai } from '@server/common/utils/biz-date';
import { duplicateContractConflict } from './contract-name-guard';
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

  /** 行金额**不取整**；取整时机由 `quotation-totals` 的口径决定（见该模块文件头） */
  private lineAmount(item: {
    quantity: number;
    unitPrice: number;
    discountPct: number;
  }): number {
    return rawLineAmount(item);
  }

  /**
   * T11（§4.6）：**报价与合同必须用同一套取整顺序**。
   *
   * ## 缺陷机理（实测复现，不是推测）
   *
   * 两条路径原先在**不同的位置**取整：
   *
   * ```
   * 报价（computeTotals）    ：round2( Σ未取整行金额 × (1 − 整单折扣) )
   * 合同（convertLineAmount）：Σ round2( 未取整行金额 × (1 − 整单折扣) )
   * ```
   *
   * 一边"先加再乘折扣再取整"，一边"先乘折扣、逐行取整、再求和"。
   * 实测（3 行 × 33.33 元、整单 9 折、税率 6%）：
   *
   * | | 金额 |
   * |---|---|
   * | 报价总额（旧口径） | **89.99** |
   * | 合同明细合计 | **90.00** |
   *
   * ## 为什么这 1 分是**真问题**
   *
   * `convert()` 的校验是 `Math.abs(itemSum - amount) > 0.01`，而 89.99 与 90.00
   * 的差**恰好等于 0.01** → `>` 不成立 → **静默放行**。合同带着
   * "头 89.99 / 明细合计 90.00"落库，接着：
   *   · 头税额 `splitTax(89.99, 6)` = 5.09；
   *   · Σ行税额 = 5.10；
   *   · 开票、收入确认、增值税底稿取的是明细口径 → **账表从第一天起就对不上**。
   *
   * ## 修法：向合同口径收敛（逐行取整后求和）
   *
   * 选择"逐行乘折扣 → 逐行取整 → 求和"，而不是"先求和再取整"，理由：
   *   ① 合同明细是**逐行落库**的（每行有独立 amount/net/tax 列），
   *      "先取整再加"是唯一能让"表头 = Σ行"在数据库层面成立的方式；
   *   ② 报价单的行金额同样逐行落库，本就应该自洽；
   *   ③ 反过来（把合同改成先加再取整）需要把分位差塞进某一行，
   *      那会让"哪一行被调整"变成隐藏状态，每次重算可能落到不同行 —— 更糟。
   *
   * **实测验证**：改后同一场景下 |报价 − 合同明细合计| = **0.00**（原为 0.0100），
   * 且 40×5 组混合场景下的最大偏差也从 0.0100 降到 0.0000。
   *
   * ⚠️ 诚实声明：本改动会让**多行报价单的总额最多变动 1 分**。
   * 这是把"两个数不一致"变成"一个自洽的数"的必要代价。
   */
  private computeTotals(
    items: QuotationItemInput[],
    discountPct: number
  ): { totalAmount: number; estimatedCost: number; grossAmount: number } {
    /* 口径与推导全部在 `./quotation-totals`（纯函数 + 22 条断言，含用户确认的 111.42） */
    return quotationTotals(items, discountPct);
  }

  /** 转合同明细行金额：行折扣后再乘整单折扣，与 computeTotals 同口径 */
  private convertLineAmount(
    item: { quantity: number; unitPrice: number; discountPct: number },
    headerDiscountPct: number,
  ): number {
    return contractLineAmount(item, headerDiscountPct);
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
      /*
       * 客户可改（原先**漏了这一段**，见 `UpdateQuotationDto.customerId` 的说明）。
       * 报价单转合同会把客户带过去，所以这里静默丢弃的代价不只是"页面上没变"——
       * 转出来的合同会挂在**旧的**客户名下。
       *
       * 放在 `title` 之前与字段声明顺序一致；判据用 `!== undefined`
       * 以便与其它字段统一（空串是非法客户，由 DTO 的 @IsString/@IsNotEmpty 拦）。
       */
      if (dto.customerId !== undefined) patch.customerId = dto.customerId;
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

  /**
   * 审批通过后一键生成合同草稿，报价金额与客户自动带入。
   *
   * ## B2 修正：行锁 + CAS + 同名查重（原先三样都没有）
   *
   * 原实现在**事务外**读报价、检查 `contractId` 是否为空，然后进事务直接 INSERT。
   * 并发时序（双击、两个标签页、两个用户）：
   *
   *   | 时刻 | 请求 A | 请求 B |
   *   |---|---|---|
   *   | T1 | 读到 `contractId = null` | |
   *   | T2 | | 读到 `contractId = null` |
   *   | T3 | INSERT 合同 CTR-A | |
   *   | T4 | | INSERT 合同 CTR-B |
   *   | T5 | UPDATE 报价（成功） | UPDATE 报价（成功，覆盖 A） |
   *
   * 结果：**一份 500 万报价 → 两份 500 万合同**，各自可立项、各自确认收入
   * → 收入与应收各虚增 500 万。前端按钮的 `loading` 防不住双击竞态。
   *
   * 三处收口：
   *   ① 事务内 `FOR UPDATE` 行锁重读，`contractId` 判空在锁内做；
   *   ② 按合同名查重（`AGENTS.md:25` 声称"同名合同查重防重复转换"，
   *      **实测该承诺从未落地** —— 全仓 22 处"查重"命中里没有一处在 crm 模块）；
   *   ③ UPDATE 带 `isNull(contractId)` 的 CAS，affected rows = 0 抛 409。
   *
   * > 同一模式在仓库内已有正确先例：`costs.service.ts` 的工时确认用 CAS。
   */
  async convert(id: string): Promise<Contract> {
    // ① 事务外只做**快速失败**（拦住明显不合法的调用），真正的判定在锁内重做 ——
    //    这里的检查不构成任何并发保证，只是省掉一次无谓的事务。
    /*
     * ⚠️ `contractId` 必须**先于**状态检查：已转合同的报价单状态是 `converted`，
     * 先查状态会报"仅已生效的报价单可转合同" —— 对一张**确实已生效并已转过**的单据，
     * 这句话是误导（使用者会以为报价单没生效）。走查实测到该文案，故调换顺序。
     */
    const existing = await this.getOrThrow(id);
    if (existing.contractId) {
      throw new BadRequestException('该报价已生成合同，请勿重复转换');
    }
    if ((existing.status ?? 'draft') !== 'approved') {
      throw new BadRequestException('仅已生效的报价单可转合同');
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
      // ① 锁内重读：并发下第二个请求会阻塞在这里，等第一个提交后再看到
      //    已写入的 contractId，从而走"已生成合同"分支。
      const locked = await tx
        .select()
        .from(crmQuotation)
        .where(eq(crmQuotation.id, id))
        .for('update');
      if (locked.length === 0) throw new NotFoundException('报价单不存在');
      const current = locked[0];
      // 与事务外同序：先判"是否已转过"，再判状态（理由见上）
      if (current.contractId) {
        throw new BadRequestException('该报价已生成合同，请勿重复转换');
      }
      if ((current.status ?? 'draft') !== 'approved') {
        throw new BadRequestException('仅已生效的报价单可转合同');
      }
      // ② 同名合同查重（兑现 `AGENTS.md:25` 的承诺；
      //    判据与文案与商机转合同共用 `contract-name-guard.ts`，两边不会分叉）
      const duplicated = await tx
        .select({ code: erpContract.code })
        .from(erpContract)
        .where(eq(erpContract.name, current.title))
        .limit(1);
      if (duplicated.length > 0) {
        throw duplicateContractConflict({
          name: current.title,
          existingCode: duplicated[0].code,
          sourceLabel: '报价单标题',
        });
      }
      const inserted = await tx
        .insert(erpContract)
        .values({
          code,
          name: current.title,
          customerId: current.customerId,
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
      const headerDiscountPct = Number(current.discountPct ?? 0);
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
        itemSum = round2(itemSum);
        if (Math.abs(itemSum - amount) > 0.01) {
          throw new BadRequestException(
            `报价明细合计 ${itemSum} 与报价总额 ${amount} 不一致，已回滚`
          );
        }
      }
      // ③ CAS 收口：WHERE 带 `contract_id IS NULL`，affected rows = 0 说明
      //    本事务之外已有并发写入（理论上锁已排除，这里是最后一道防线）。
      const updated = await tx
        .update(crmQuotation)
        .set({
          status: 'converted',
          contractId: inserted[0].id,
          updatedAt: new Date(),
        })
        .where(and(eq(crmQuotation.id, id), isNull(crmQuotation.contractId)))
        .returning({ id: crmQuotation.id });
      if (updated.length === 0) {
        throw new ConflictException('该报价已被转换，请刷新后重试');
      }
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
