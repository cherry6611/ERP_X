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
import { and, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  erpAr,
  erpArWriteoff,
  erpContract,
  erpInvoice,
  erpProject,
  erpReceipt,
  mdCustomer,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { DataScopeService } from '@server/common/auth/data-scope.service';
import type { RequestActor } from '@server/common/auth/actor';
import {
  arRegisterLines,
  receiptLines,
  receiptVoidLines,
} from '@server/common/tax/posting';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { arSettleStatus, receiptMatchStatus } from './ar-match';
import { todayInShanghai, addDaysInShanghai } from '@server/common/utils/biz-date';
import {
  WRITEOFFABLE_AR_STATUSES,
  blockedReasonForWriteAction,
} from './void-guard';
import { assertPeriodOpen } from '@server/common/utils/period-guard';
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
    private readonly voucherHookService: VoucherHookService,
    private readonly taxResolver: TaxResolverService,
    private readonly dataScope: DataScopeService,
  ) {}

  private async buildArItem(row: {
    ar: typeof erpAr.$inferSelect;
    contractName: string | null;
    customerName: string | null;
    projectName: string | null;
  }): Promise<ArItem> {
    const today = todayInShanghai();
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
      voidReason: row.ar.voidReason ?? null,
      voidedAt: row.ar.voidedAt ? new Date(row.ar.voidedAt).toISOString() : null,
      voidedBy: row.ar.voidedBy ?? null,
      remark: row.ar.remark,
      createdAt: row.ar.createdAt.toISOString(),
    };
  }

  /**
   * B-02：应收列表的行级可见范围（SQL 层过滤，非 UI 隐藏）。
   *
   * `finance_ledger` 资源的语义映射：
   *   - `custom`            → 被授权的**纳税主体**：`erp_contract.tax_entity_id IN (custom_ids)`
   *   - `self`              → 回款责任人：`erp_ar.owner_user_id = 当前用户`
   *   - `dept/dept_and_child` → 项目归属部门名称：`erp_project.dept_name IN (本部门及下级)`
   * 未配置该资源时返回 undefined（保持既有全量可见，避免未配置即收紧）。
   * 口径说明（**需业务确认**）：erp_ar 自身无 tax_entity_id，故以合同主体代位；
   * 无合同的应收单在 `custom` 范围下会被排除（这是要求的"最小权限"方向）。
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
        primary: erpContract.taxEntityId,
        self: erpAr.ownerUserId,
        dept: erpProject.deptName,
      },
      { departmentValueKind: 'name', resolved }
    );
  }

  async listArs(
    customerId?: string,
    status?: string,
    actor?: RequestActor
  ): Promise<ArItem[]> {
    const conditions: SQL[] = [];
    if (customerId) conditions.push(eq(erpAr.customerId, customerId));
    if (status) conditions.push(eq(erpAr.status, status));
    const scopeWhere: SQL | undefined = await this.scopeCondition(actor);
    if (scopeWhere) conditions.push(scopeWhere);
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
    return this.createArWith(this.db, dto);
  }

  /**
   * N-3/B-4：把应收插入并入调用方的事务。
   *
   * 收入确认若先落收入、再单独登记应收，则在两次写入之间失败会留下
   * 「已确认收入、无应收」的静默不一致（原来只 `logger.error`，无台账、无重试入口）。
   * 事务入口让收入主表与应收**同生共死**：任一步失败整体回滚，调用方可直接重试。
   */
  async createArInTransaction(
    tx: PostgresJsDatabase,
    dto: CreateArDto
  ): Promise<ArItem> {
    return this.createArWith(tx, dto);
  }

  /** 应收登记实现；`db` 允许是外部事务句柄（见 `createArInTransaction`） */
  private async createArWith(
    db: PostgresJsDatabase,
    dto: CreateArDto
  ): Promise<ArItem> {
    if (dto.amount <= 0) {
      throw new BadRequestException('应收金额必须大于 0');
    }
    const contract = await db
      .select()
      .from(erpContract)
      .where(eq(erpContract.id, dto.contractId));
    if (contract.length === 0) throw new NotFoundException('合同不存在');
    const customer = await db
      .select({ id: mdCustomer.id, name: mdCustomer.name, termsDays: mdCustomer.termsDays })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, contract[0].customerId ?? ''));
    if (customer.length === 0) throw new NotFoundException('客户不存在');
    let dueDate = dto.dueDate ?? null;
    if (!dueDate) {
      const terms = customer[0].termsDays ?? 30;
      // P1-6：按业务时区做日期加减，避免 UTC 转换把到期日偏一天
      dueDate = addDaysInShanghai(terms);
    }
    const source = dto.source ?? 'manual';
    // P1-5：期间闸门必须校验**业务发生日（登记日）**所在期间。
    // 原实现校验的是「账期到期日」所在期间：登记日已结账时漏拦，到期日落在已结账
    // 期间时又误拦。到期日只是账期推算结果，不对应任何业务发生。
    await assertPeriodOpen(db, todayInShanghai(), '登记应收');
    // D-03'：手工应收先解析税率，失败不落库
    let voucherRate: number | null = null;
    if (source === 'manual') {
      const resolved = await this.taxResolver.resolve({
        upstream:
          contract[0].taxRate != null ? Number(contract[0].taxRate) : null,
        customerId: contract[0].customerId,
        taxEntityId: contract[0].taxEntityId,
        side: 'output',
      });
      if (resolved.source === 'fallback' || resolved.taxEntityId == null) {
        throw new BadRequestException(
          '手工应收无法解析税率：请配置纳税主体或合同税率后再登记',
        );
      }
      voucherRate = resolved.rate;
    }
    // D-19：同 sourceRef 幂等返回既有应收；已作废的不算"已存在"
    if (dto.sourceRef) {
      const existed = await db
        .select()
        .from(erpAr)
        .where(
          and(
            eq(erpAr.sourceRef, dto.sourceRef),
            ne(erpAr.status, 'voided'),
          ),
        )
        .limit(1);
      if (existed.length > 0) {
        return this.buildArItem({
          ar: existed[0],
          contractName: contract[0].name,
          customerName: customer[0].name,
          projectName: null,
        });
      }
    }
    const code = await generateBizCode(db, erpAr, erpAr.code, 'ARR');
    let rows: (typeof erpAr.$inferSelect)[];
    try {
      rows = await db
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
          source,
          sourceRef: dto.sourceRef ?? null,
          remark: dto.remark,
          ownerUserId: dto.ownerUserId ?? null,
        })
        .returning();
    } catch (error) {
      const pgCode =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code)
          : '';
      if (pgCode === '23505' && dto.sourceRef) {
        const existed = await db
          .select()
          .from(erpAr)
          .where(eq(erpAr.sourceRef, dto.sourceRef))
          .limit(1);
        if (existed.length > 0) {
          return this.buildArItem({
            ar: existed[0],
            contractName: contract[0].name,
            customerName: customer[0].name,
            projectName: null,
          });
        }
      }
      throw error;
    }
    /**
     * P0-4：手工应收只登记债权，**不确认收入**。
     * 借 1122 / 贷 2203 预收账款（合同结算）/ 贷 222101 销项税；
     * 收入统一由「收入确认」模块单点产生，避免双通道重复贷记 6001。
     * source=revenue 仍不出凭证（收入侧已生成）。
     */
    if (source === 'manual' && voucherRate != null) {
      await this.voucherHookService.generateVoucherDraft({
        sourceType: 'ar',
        sourceRef: `ar:${code}`,
        voucherDate: todayInShanghai(),
        summary: `手工应收登记 ${code}`,
        lines: arRegisterLines(dto.amount, voucherRate),
        // P0-2：沿用合同主体（同一合同的其他凭证也据此归属，保证主体内自洽）
        taxEntityId: contract[0].taxEntityId,
      });
    }
    return this.buildArItem({
      ar: rows[0],
      contractName: contract[0].name,
      customerName: customer[0].name,
      projectName: null,
    });
  }

  /** 收入调整：冲减未结清应收（优先同合同 open 行），避免生成负数 AR（M-05） */
  async applyCredit(
    contractId: string,
    amount: number,
    remark: string
  ): Promise<void> {
    const credit = Math.abs(amount);
    if (credit <= 0) return;
    await this.db.transaction(async (tx) => {
      // 修复 P1-13：原只匹配 status='open'，漏掉 'partial'。
      // 已被部分回款的应收（partial）仍有未结清余额，收入折让/退回冲减时
      // 这部分被跳过 → 直接抛「调整金额超过未结清应收」，冲减做不下去。
      const openRows = await tx
        .select()
        .from(erpAr)
        .where(
          and(
            eq(erpAr.contractId, contractId),
            inArray(erpAr.status, ['open', 'partial'])
          )
        )
        .for('update');
      let left = credit;
      for (const row of openRows) {
        if (left <= 0.001) break;
        const open =
          Number(row.amount ?? 0) - Number(row.settledAmount ?? 0);
        if (open <= 0.001) continue;
        const apply = Math.min(open, left);
        const newSettled = Number(row.settledAmount ?? 0) + apply;
        const fullySettled = newSettled + 0.001 >= Number(row.amount ?? 0);
        await tx
          .update(erpAr)
          .set({
            settledAmount: String(newSettled),
            status: fullySettled ? 'settled' : 'partial',
            remark: [row.remark, remark].filter(Boolean).join('；'),
            updatedAt: new Date(),
          })
          .where(eq(erpAr.id, row.id));
        left -= apply;
      }
      if (left > 0.01) {
        throw new BadRequestException(
          `调整金额超过未结清应收，剩余无法冲减 ${left}`
        );
      }
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
    if (dto.amount <= 0) {
      throw new BadRequestException('回款金额必须大于 0');
    }
    const customer = await this.db
      .select({ id: mdCustomer.id, name: mdCustomer.name })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, dto.customerId));
    if (customer.length === 0) throw new NotFoundException('客户不存在');
    const receiptDate = dto.receiptDate ?? todayInShanghai();
    // P1-5：回款登记原先完全没有期间闸门；且校验须用**回款业务日**而非登记当天。
    await assertPeriodOpen(this.db, receiptDate, '登记回款');
    const code = await generateBizCode(
      this.db,
      erpReceipt,
      erpReceipt.code,
      'RCV'
    );
    /*
     * 插入与（可选的）核销放在**同一事务**内：若使用者指定了应收单，
     * 那么"回款已登记"与"该应收已核销"要么都成立、要么都不成立 ——
     * 不允许出现"回款建好了但核销失败"的半成品（那会让使用者以为已回款）。
     */
    let receiptStatus: ReceiptStatus = 'unmatched';
    const row = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(erpReceipt)
        .values({
          code,
          customerId: dto.customerId,
          amount: String(dto.amount),
          receiptDate,
          method: dto.method ?? 'bank',
          source: dto.source,
          status: 'unmatched',
          remark: dto.remark,
        })
        .returning();
      const inserted = rows[0];
      if (dto.arId) {
        await this.applyWriteoffInTx(tx, {
          arId: dto.arId,
          receiptId: inserted.id,
          amount: dto.amount,
        });
        /*
         * 核销已把回款状态写成 matched/partial，但 `inserted` 是 INSERT 时的
         * 快照（status 仍是 unmatched）。这里按与 `receiptMatchStatus` 同源的
         * 判据复算一次，避免返回给前端的状态是旧的。
         * 本入口不做部分核销（核销金额恒等于回款金额）→ matched。
         */
        receiptStatus = receiptMatchStatus(dto.amount, dto.amount);
      }
      return inserted;
    });

    /* 回款登记成功 → 生成凭证草稿：借 银行存款(1002/100201) / 贷 应收账款(1122) */
    const receiptAmount = Number(row.amount ?? 0);
    const voucherStatus = await this.voucherHookService.generateVoucherDraft({
      sourceType: 'receipt',
      sourceRef: `receipt:${row.code}`,
      voucherDate: row.receiptDate ?? todayInShanghai(),
      summary: `回款登记 ${row.code}`,
      lines: receiptLines(receiptAmount),
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
      status: receiptStatus,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 作废未核销回款，并冲回银存凭证。 */
  async voidReceipt(id: string): Promise<ReceiptItem> {
    const rows = await this.db
      .update(erpReceipt)
      .set({ status: 'voided', updatedAt: new Date() })
      .where(and(eq(erpReceipt.id, id), eq(erpReceipt.status, 'unmatched')))
      .returning();
    if (rows.length === 0) {
      throw new BadRequestException('只有未核销的回款可以作废');
    }
    const row = rows[0];
    const amount = Number(row.amount ?? 0);
    await this.voucherHookService.generateVoucherDraft({
      sourceType: 'receipt',
      sourceRef: `receipt-void:${row.code}`,
      voucherDate: todayInShanghai(),
      summary: `回款作废 ${row.code}`,
      lines: receiptVoidLines(amount),
    });
    const customer = await this.db
      .select({ name: mdCustomer.name })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, row.customerId ?? ''));
    return {
      id: row.id,
      code: row.code,
      customerId: row.customerId ?? '',
      customerName: customer[0]?.name ?? '',
      amount,
      receiptDate: row.receiptDate,
      method: row.method ?? 'bank',
      source: row.source,
      status: 'voided',
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * 应收核销（支持部分核销）：事务内 FOR UPDATE 锁行（不可 SKIP LOCKED，需等待持锁方完成）
   *
   * 校验与写库逻辑抽到 `applyWriteoffInTx`，因为「登记回款」也要在**同一事务内**
   * 直接核销（见 `createReceipt` 的 `arId` 参数）—— 两处必须用**同一份**校验，
   * 否则一条路径能绕过的守卫在另一条路径上仍然存在。
   */
  async writeoff(dto: ArWriteoffDto): Promise<ArItem> {
    if (dto.amount <= 0) {
      throw new BadRequestException('核销金额必须大于 0');
    }
    await this.db.transaction(async (tx) => {
      await this.applyWriteoffInTx(tx, dto);
    });
    return this.buildWriteoffResult(dto);
  }

  /**
   * 核销的**唯一实现**（校验 + 写库），事务由调用方提供。
   *
   * 拆出来是因为核销现在有**两个**入口，且都必须走同一份校验：
   *   ① 独立的「核销」操作（`writeoff`，自己开事务）；
   *   ② 「登记回款」时若指定了应收单（`createReceipt` 的 `arId`），
   *      在**同一事务内**顺带核销 —— 回款与其核销要么都成立、要么都不成立。
   *
   * ⚠️ 绝不要把这段逻辑复制成第二份：这里的守卫（作废状态、未核销余额、
   * 客户一致性、并发条件更新）是针对"作废了还能收款"那类问题加的，
   * 一份副本漂移就会重新打开那个口子。
   */
  private async applyWriteoffInTx(
    tx: Parameters<Parameters<typeof this.db.transaction>[0]>[0],
    dto: ArWriteoffDto
  ): Promise<void> {
    const arRows = await tx
      .select()
      .from(erpAr)
      .where(eq(erpAr.id, dto.arId))
      .for('update');
    if (arRows.length === 0) throw new NotFoundException('应收记录不存在');
    const ar = arRows[0];
    /*
     * ⚠️ **必须挡在金额校验之前**：作废的应收单 `amount − settledAmount` 通常
     * 仍是正数，所以"未核销余额 > 0"这条**拦不住它**。B1 加了作废路径
     * （`voidAr` 把 status 写成 `'voided'`）却没在核销入口补守卫，
     * 后果是作废单仍可被核销 —— 而作废时已经开具了冲回凭证，
     * 再核销会让账面上的应收重新出现变动，等于"作废了还能收款"。
     *
     * 客户端下拉已改为排除 `voided`（`ArTab` 的 `openArItems`），
     * 但服务端必须是**权威**的一方：接口可被直接调用，且并发下
     * 客户端读到的状态可能已过期。
     */
    const arBlocked = blockedReasonForWriteAction(
      ar.status,
      WRITEOFFABLE_AR_STATUSES,
      '核销',
      '应收',
    );
    if (arBlocked) throw new BadRequestException(arBlocked);
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
    if (receipt.status === 'voided') {
      throw new BadRequestException('回款已作废，不可核销');
    }
    if (receipt.customerId !== ar.customerId) {
      throw new BadRequestException('回款客户与应收客户不一致，不可核销');
    }
    // F4X-3：条件更新 used_amount，并发超额时 affected-rows=0
    const receiptUpdated = await tx
      .update(erpReceipt)
      .set({
        usedAmount: sql`${erpReceipt.usedAmount} + ${dto.amount}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(erpReceipt.id, dto.receiptId),
          sql`${erpReceipt.usedAmount} + ${dto.amount} <= ${erpReceipt.amount}`,
        ),
      )
      .returning({
        id: erpReceipt.id,
        usedAmount: erpReceipt.usedAmount,
        amount: erpReceipt.amount,
      });
    if (receiptUpdated.length === 0) {
      throw new BadRequestException(
        '回款可用余额不足（可能已被并发核销）',
      );
    }
    const arUpdated = await tx
      .update(erpAr)
      .set({
        settledAmount: sql`${erpAr.settledAmount} + ${dto.amount}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(erpAr.id, dto.arId),
          sql`coalesce(${erpAr.settledAmount}, 0) + ${dto.amount} <= ${erpAr.amount}`,
        ),
      )
      .returning({
        settledAmount: erpAr.settledAmount,
        amount: erpAr.amount,
      });
    if (arUpdated.length === 0) {
      throw new BadRequestException(
        '应收可用余额不足（可能已被并发核销）',
      );
    }
    const newSettled = Number(arUpdated[0].settledAmount ?? 0);
    const newUsed = Number(receiptUpdated[0].usedAmount ?? 0);
    await tx
      .update(erpAr)
      .set({
        status: arSettleStatus(newSettled, Number(arUpdated[0].amount)),
        updatedAt: new Date(),
      })
      .where(eq(erpAr.id, dto.arId));
    await tx
      .update(erpReceipt)
      .set({
        status: receiptMatchStatus(newUsed, Number(receiptUpdated[0].amount)),
        updatedAt: new Date(),
      })
      .where(eq(erpReceipt.id, dto.receiptId));
    await tx.insert(erpArWriteoff).values({
      arId: dto.arId,
      receiptId: dto.receiptId,
      amount: String(dto.amount),
      writeoffDate: todayInShanghai(),
    });
  }

  private async buildWriteoffResult(dto: ArWriteoffDto): Promise<ArItem> {
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

  /** 反核销：生成红字核销行，恢复应收/回款余额 */
  async reverseWriteoff(
    writeoffId: string,
    remark?: string,
  ): Promise<ArItem> {
    let arId = '';
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(erpArWriteoff)
        .where(eq(erpArWriteoff.id, writeoffId))
        .for('update');
      if (rows.length === 0) throw new NotFoundException('核销记录不存在');
      const src = rows[0];
      if (src.reversalOf) {
        throw new BadRequestException('红字核销行不可再次冲回');
      }
      const already = await tx
        .select({ id: erpArWriteoff.id })
        .from(erpArWriteoff)
        .where(eq(erpArWriteoff.reversalOf, writeoffId))
        .limit(1);
      if (already.length > 0) {
        throw new BadRequestException('该核销已冲回，请勿重复操作');
      }
      const amount = Number(src.amount ?? 0);
      if (amount <= 0) throw new BadRequestException('核销金额无效');
      arId = src.arId ?? '';
      const arRows = await tx
        .select()
        .from(erpAr)
        .where(eq(erpAr.id, arId))
        .for('update');
      if (arRows.length === 0) throw new NotFoundException('应收记录不存在');
      const receiptRows = await tx
        .select()
        .from(erpReceipt)
        .where(eq(erpReceipt.id, src.receiptId ?? ''))
        .for('update');
      if (receiptRows.length === 0) throw new NotFoundException('回款记录不存在');
      if (receiptRows[0].status === 'voided') {
        throw new BadRequestException('回款已作废，请先处理作废对账后再冲回');
      }
      try {
        await tx.insert(erpArWriteoff).values({
          arId,
          receiptId: src.receiptId,
          amount: String(-amount),
          writeoffDate: todayInShanghai(),
          reversalOf: writeoffId,
          remark: remark ?? '核销冲回',
        });
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code: unknown }).code)
            : '';
        if (code === '23505') {
          throw new ConflictException('该核销已被冲回，请勿重复操作');
        }
        throw error;
      }
      const newSettled = Math.max(0, Number(arRows[0].settledAmount ?? 0) - amount);
      await tx
        .update(erpAr)
        .set({
          settledAmount: String(newSettled),
          status: arSettleStatus(newSettled, Number(arRows[0].amount)),
          updatedAt: new Date(),
        })
        .where(eq(erpAr.id, arId));
      const receiptDec = await tx
        .update(erpReceipt)
        .set({
          usedAmount: sql`greatest(0, ${erpReceipt.usedAmount} - ${amount})`,
          updatedAt: new Date(),
        })
        .where(eq(erpReceipt.id, src.receiptId ?? ''))
        .returning({
          usedAmount: erpReceipt.usedAmount,
          amount: erpReceipt.amount,
        });
      const newUsed = Number(receiptDec[0]?.usedAmount ?? 0);
      await tx
        .update(erpReceipt)
        .set({
          status: receiptMatchStatus(newUsed, Number(receiptRows[0].amount)),
          updatedAt: new Date(),
        })
        .where(eq(erpReceipt.id, src.receiptId ?? ''));
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
      .where(eq(erpAr.id, arId));
    return this.buildArItem(updated[0]);
  }

  /**
   * B1：**作废应收**（终态，不可逆）。
   *
   * ## 为什么需要它（本报告最高优先级的业务风险）
   *
   * 原状态集只有 `open / partial / settled` —— **没有退出路径**。3 月手工登记
   * 一笔 100 万应收、4 月发现客户搞错时，系统里**没有任何入口**可撤销它：
   *   ① 它永久停留在 `open`，**每天**污染四个下游：
   *      - 现金流预测（`cash-flow.service.ts` 把 `open/partial` 当作未来流入）
   *      - 账龄与催款（`ar_due_reminder_daily` 每天推送飞书催款）
   *      - 客户信用额度（`admin.automation.ts` 计入额度占用 → 该客户被误判超限）
   *      - BI / 报表（应收余额、周转率全部失真）
   *   ② **系统里没有任何对账能发现它** —— `reconcileRevenueChain` 只检查
   *      "有收入无应收／无凭证"，不检查"应收是否有真实业务依据"。
   *   ③ 唯一"解法"是**伪造一笔回款核销掉它** —— 那一步把"数据录入错误"
   *      升级为"人为掩盖"，且核销会生成银行收款凭证，账实从此不符。
   *
   * ## 前置条件（三条，缺一不可）
   *
   *   1. `settled_amount = 0`：已核销的应收不能作废（必须先反核销）。
   *      部分核销同理 —— 作废一笔已收过钱的债权会让已收款的银行流水悬空。
   *   2. 无**有效**发票引用：`erp_invoice.ar_id = 该应收 AND status = 'issued'`。
   *      已开票就意味着纳税义务已经发生，作废应收而不作废发票会让
   *      "票在、债权不在"，申报口径与账簿脱节。
   *   3. 非终态：已 `voided` 的不能重复作废。
   *
   * ## 同事务红字凭证
   *
   * 手工应收登记时会出「借 1122 / 贷 2203 + 贷 222101」（`arRegisterLines`）。
   * 作废必须出**等额反向**，且与状态变更**同事务** —— 否则会产生新的
   * "有业务无凭证"（或反之），正是前序 S4 治理过的那类非原子写。
   * `source = 'revenue'` 的应收不出凭证（收入侧已生成），作废时也不出。
   *
   * ## 红字凭证的分录方向
   *
   * 作废分录 = 登记分录的镜像：借 2203（预收账款）/ 借 222101（销项税）
   * / 贷 1122（应收）。用 `arRegisterLines` 取反即可保证两侧恒等，
   * 不手写第二套方向（手写方向正是 `round2` 与红冲对称性那类缺陷的来源）。
   */
  async voidAr(
    id: string,
    userId: string,
    reason?: string
  ): Promise<ArItem> {
    const voidReason = reason?.trim() || '未填写作废原因';
    // 事务外先取税率与主体（进事务前读，缩短持锁时间；解析器走另一条连接）
    const pre = await this.db
      .select({
        ar: erpAr,
        contractTaxRate: erpContract.taxRate,
        contractTaxEntityId: erpContract.taxEntityId,
      })
      .from(erpAr)
      .leftJoin(erpContract, eq(erpAr.contractId, erpContract.id))
      .where(eq(erpAr.id, id));
    if (pre.length === 0) throw new NotFoundException('应收记录不存在');
    const before = pre[0];
    const current = (before.ar.status ?? 'open') as ArStatus;
    if (current === 'voided') {
      throw new ConflictException('该应收已作废，请勿重复操作');
    }
    /*
     * 期间闸门：作废是对已结账期间的账务改写，必须与登记同口径拦截。
     *
     * 这里曾用 `dueDate`，与 createAr 的 todayInShanghai 不一致：
     *   · 到期日落在未结期间、当前期间已结账 → 放行，红字凭证生成失败；
     *   · 到期日落在已结期间、当前期间已开账 → 误拦。
     * 红字凭证日期也是 today，因此闸门必须用 today。
     */
    await assertPeriodOpen(this.db, todayInShanghai(), '作废应收');

    const affected = await this.db.transaction(async (tx) => {
      // ① 行锁重读 + CAS：并发双击/两个标签页同时作废时只有一个能成功
      const lockedRows = await tx
        .select()
        .from(erpAr)
        .where(eq(erpAr.id, id))
        .for('update');
      if (lockedRows.length === 0) throw new NotFoundException('应收记录不存在');
      const ar = lockedRows[0];
      const status = (ar.status ?? 'open') as ArStatus;
      if (status === 'voided') {
        throw new ConflictException('该应收已作废，请勿重复操作');
      }
      const settled = Number(ar.settledAmount ?? 0);
      if (settled > 0.001) {
        throw new BadRequestException(
          `该应收已有核销金额 ${settled}，不能作废；请先在核销明细中反核销，再作废`
        );
      }
      // ② 有效发票引用检查
      const invoiceRows = await tx
        .select({ code: erpInvoice.code })
        .from(erpInvoice)
        .where(
          and(eq(erpInvoice.arId, id), eq(erpInvoice.status, 'issued'))
        )
        .limit(1);
      if (invoiceRows.length > 0) {
        throw new BadRequestException(
          `该应收已被发票 ${invoiceRows[0].code} 引用，不能作废；` +
            `请先作废该发票（同月）或开具红字发票（跨月），再作废应收`
        );
      }
      // ③ CAS 收口：WHERE 带状态条件，affected rows = 0 即并发已被处理
      const updated = await tx
        .update(erpAr)
        .set({
          status: 'voided',
          voidReason,
          voidedAt: new Date(),
          voidedBy: userId,
          updatedAt: new Date(),
        })
        .where(and(eq(erpAr.id, id), ne(erpAr.status, 'voided')))
        .returning({ id: erpAr.id });
      if (updated.length === 0) {
        throw new ConflictException('该应收已被作废，请刷新后重试');
      }
      // ④ 同事务红字凭证（只有手工应收出过凭证，收入侧不出）
      const amount = Number(ar.amount ?? 0);
      const source = ar.source ?? 'manual';
      if (source === 'manual' && amount !== 0) {
        const rate = Number(before.contractTaxRate ?? NaN);
        if (Number.isFinite(rate)) {
          // 登记分录的镜像：借 2203 / 借 222101 / 贷 1122
          const lines = arRegisterLines(amount, rate).map((line) => ({
            accountCode: line.accountCode,
            debit: line.credit,
            credit: line.debit,
          }));
          const voucherStatus = await this.voucherHookService.generateVoucherDraft({
            sourceType: 'ar',
            sourceRef: `ar-void:${ar.code}`,
            voucherDate: todayInShanghai(),
            summary: `应收作废 ${ar.code}`,
            lines,
            taxEntityId: before.contractTaxEntityId ?? null,
          });
          if (voucherStatus === 'failed') {
            /*
             * 不能只 log 后继续：事务已把应收置为 voided，若凭证没生成，
             * 就成了"业务作废、账还挂着"。抛错让整个事务回滚，由使用者
             * 先处理已结账期间/科目问题再重试。
             */
            throw new BadRequestException(
              '作废应收失败：红字凭证生成失败（当前期间可能已结账），请检查期间后重试',
            );
          }
        } else {
          // 取不到税率时不静默跳过：宁可作废失败，也不要留下"业务已作废、
          // 凭证还挂在账上"的悬空账（那种差额对账时极难归因）。
          throw new BadRequestException(
            '作废应收失败：合同税率缺失，无法生成红字凭证；请先补齐合同税率后重试'
          );
        }
      }
      return true;
    });
    if (!affected) throw new ConflictException('该应收已被作废，请刷新后重试');

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
      .where(eq(erpAr.id, id));
    return this.buildArItem(rows[0]);
  }

  async listWriteoffs(arId?: string): Promise<
    Array<{
      id: string;
      arId: string;
      receiptId: string;
      amount: number;
      writeoffDate: string | null;
      reversalOf: string | null;
      remark: string | null;
    }>
  > {
    const rows = await this.db
      .select()
      .from(erpArWriteoff)
      .where(arId ? eq(erpArWriteoff.arId, arId) : undefined)
      .orderBy(desc(erpArWriteoff.createdAt))
      .limit(200);
    return rows.map((r) => ({
      id: r.id,
      arId: r.arId ?? '',
      receiptId: r.receiptId ?? '',
      amount: Number(r.amount ?? 0),
      writeoffDate: r.writeoffDate,
      reversalOf: r.reversalOf ?? null,
      remark: r.remark ?? null,
    }));
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
    const today = todayInShanghai();
    const buckets: AgingBucket[] = AGING_BUCKETS.map((b) => ({
      label: b.label,
      amount: 0,
      count: 0,
    }));
    for (const row of rows) {
      if (row.status === 'settled') continue;
      // B1：作废应收必须从账龄里排除 —— 否则误录的 100 万会永久挂在
      // "90天以上"桶里，账龄表每天都在提示一笔根本不存在的债权。
      if (row.status === 'voided') continue;
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
