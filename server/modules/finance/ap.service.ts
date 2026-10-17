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
import { and, desc, eq, inArray, ne, sql, sum, type SQL } from 'drizzle-orm';
import {
  erpApBill,
  erpApWriteoff,
  erpInvoice,
  erpPayment,
  erpProject,
  mdSupplier,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { DataScopeService } from '@server/common/auth/data-scope.service';
import type { RequestActor } from '@server/common/auth/actor';
import {
  inputIssueLines,
  inputVoidLines,
  paymentLines,
  paymentVoidLines,
} from '@server/common/tax/posting';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { todayInShanghai } from '@server/common/utils/biz-date';
import {
  PAYABLE_AP_STATUSES,
  WRITEOFFABLE_AP_STATUSES,
  blockedReasonForWriteAction,
} from './void-guard';
import {
  apWriteoffReversalStatus,
  apWriteoffStatus,
  isPaymentFullyUsed,
  paymentStatusAfterReversal,
  type ApBillStatus,
} from './writeoff-status';
import { assertPeriodOpen } from '@server/common/utils/period-guard';
import type {
  ApItem,
  ApStatus,
  ApWriteoffDto,
  CreateApDto,
  CreatePaymentDto,
  PaymentItem,
  PaymentStatus,
} from '@shared/api.interface';

@Injectable()
export class ApService {
  private readonly logger = new Logger(ApService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService,
    private readonly taxResolver: TaxResolverService,
    private readonly dataScope: DataScopeService
  ) {}

  /**
   * B-02：应付列表的行级可见范围（SQL 层过滤）。
   *
   * `finance_ledger` 资源在应付上的语义映射：
   *   - `custom`            → 被授权的**纳税主体**：`md_supplier.tax_entity_id IN (custom_ids)`
   *   - `self`              → 项目负责人：`erp_project.pm_user_id = 当前用户`
   *   - `dept/dept_and_child` → `erp_project.dept_name IN (本部门及下级)`
   * 口径说明（**需业务确认**）：erp_ap_bill 自身既无 tax_entity_id 也无 owner 字段，
   * 故分别以供应商主体与项目负责人代位；无项目/无供应商的应付单在收窄范围下会被排除。
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
        primary: mdSupplier.taxEntityId,
        self: erpProject.pmUserId,
        dept: erpProject.deptName,
      },
      { departmentValueKind: 'name', resolved }
    );
  }

  /**
   * P0-2：应付/付款凭证的纳税主体。
   *
   * `erp_ap_bill` / `erp_payment` 都没有 `tax_entity_id` 列，故按**供应商档案**归属
   * —— 与列表数据权限口径（`md_supplier.tax_entity_id`）保持一致，避免"看得到却归不了主体"。
   * 供应商未配置主体时返回 null，交给凭证钩子兜底（唯一默认主体 / 暴露为未归属）。
   */
  private async supplierTaxEntityId(
    supplierId: string | null | undefined
  ): Promise<string | null> {
    if (!supplierId) return null;
    const rows = await this.db
      .select({ taxEntityId: mdSupplier.taxEntityId })
      .from(mdSupplier)
      .where(eq(mdSupplier.id, supplierId))
      .limit(1);
    return rows[0]?.taxEntityId ?? null;
  }

  async listAps(
    supplierId?: string,
    status?: string,
    actor?: RequestActor
  ): Promise<ApItem[]> {
    const conditions: SQL[] = [];
    if (supplierId) conditions.push(eq(erpApBill.supplierId, supplierId));
    if (status) conditions.push(eq(erpApBill.status, status));
    const scopeWhere: SQL | undefined = await this.scopeCondition(actor);
    if (scopeWhere) conditions.push(scopeWhere);
    const rows = await this.db
      .select({
        ap: erpApBill,
        supplierName: mdSupplier.name,
        projectName: erpProject.name,
      })
      .from(erpApBill)
      .leftJoin(mdSupplier, eq(erpApBill.supplierId, mdSupplier.id))
      .leftJoin(erpProject, eq(erpApBill.projectId, erpProject.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(erpApBill.createdAt));
    return rows.map((row) => ({
      id: row.ap.id,
      code: row.ap.code,
      supplierId: row.ap.supplierId ?? '',
      supplierName: row.supplierName ?? '',
      projectId: row.ap.projectId,
      projectName: row.projectName,
      amount: Number(row.ap.amount ?? 0),
      paidAmount: Number(row.ap.paidAmount ?? 0),
      dueDate: row.ap.dueDate,
      status: (row.ap.status ?? 'pending') as ApStatus,
      source: row.ap.source ?? 'manual',
      sourceRef: row.ap.sourceRef,
      voidReason: row.ap.voidReason ?? null,
      voidedAt: row.ap.voidedAt ? new Date(row.ap.voidedAt).toISOString() : null,
      voidedBy: row.ap.voidedBy ?? null,
      remark: row.ap.remark,
      createdAt: row.ap.createdAt.toISOString(),
    }));
  }

  async createAp(dto: CreateApDto): Promise<ApItem> {
    if (dto.amount <= 0) {
      throw new BadRequestException('应付金额必须大于 0');
    }
    // P1-5（同类缺陷，报告只在 ar 侧点名）：期间闸门必须校验**业务发生日（登记日）**。
    // 校验 `dueDate` 是错的 —— 到期日 = 登记日 + 账期，既会漏拦（登记日已结账仍能登记），
    // 又会误拦（到期日落在已结账期间被拒）。与 ar.service 的修法保持一致。
    await assertPeriodOpen(this.db, todayInShanghai(), '登记应付');
    const supplier = await this.db
      .select({ id: mdSupplier.id, name: mdSupplier.name })
      .from(mdSupplier)
      .where(eq(mdSupplier.id, dto.supplierId));
    if (supplier.length === 0) throw new NotFoundException('供应商不存在');
    const code = await generateBizCode(
      this.db,
      erpApBill,
      erpApBill.code,
      'APB'
    );
    const rows = await this.db
      .insert(erpApBill)
      .values({
        code,
        supplierId: dto.supplierId,
        projectId: dto.projectId,
        amount: String(dto.amount),
        paidAmount: '0',
        dueDate: dto.dueDate,
        status: 'pending',
        source: dto.source ?? 'manual',
        sourceRef: dto.sourceRef,
        remark: dto.remark,
      })
      .returning();
    const row = rows[0];
    const resolved = await this.taxResolver.resolve({
      supplierId: dto.supplierId,
      side: 'input',
    });
    await this.voucherHookService.generateVoucherDraft({
      sourceType: 'ap',
      sourceRef: `ap:${row.code}`,
      voucherDate: todayInShanghai(),
      summary: `应付登记 ${row.code}`,
      lines: inputIssueLines(Number(row.amount ?? 0), resolved.rate),
      // P0-2：应付单自身无 tax_entity_id，主体随供应商/解析结果归属
      taxEntityId: resolved.taxEntityId ?? (await this.supplierTaxEntityId(dto.supplierId)),
    });
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
      supplierId: row.supplierId ?? '',
      supplierName: supplier[0].name,
      projectId: row.projectId,
      projectName,
      amount: Number(row.amount ?? 0),
      paidAmount: Number(row.paidAmount ?? 0),
      dueDate: row.dueDate,
      status: (row.status ?? 'pending') as ApStatus,
      source: row.source ?? 'manual',
      sourceRef: row.sourceRef,
      voidReason: row.voidReason ?? null,
      voidedAt: row.voidedAt ? new Date(row.voidedAt).toISOString() : null,
      voidedBy: row.voidedBy ?? null,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * B1：**作废应付**（终态，不可逆）。
   *
   * 与 `ArService.voidAr` 同源问题、同套修法：原状态集
   * `pending / approved / partial / paid` **没有退出路径**，误录的应付会永久
   * 占用资金计划（现金流预测的流出、BI 未付应付、供应商对账单）。
   *
   * ## 前置条件（三条，缺一不可）
   *
   *   1. `paid_amount = 0`：已有付款的应付不能作废（必须先冲销核销记录）。
   *   2. 无**未作废**的付款单引用：`erp_payment.ap_id = 该应付 AND status <> 'voided'`。
   *      否则会出现"钱已付出、应付已被作废"的悬空付款。
   *   3. 无有效进项发票引用（`erp_invoice.ap_id = 该应付 AND status='issued'`）：
   *      已登记进项票意味着进项税已入账，作废应付会让账票脱节。
   *
   * ## 同事务红字凭证
   *
   * `createAp` 出的是「借 6602 + 借 222102 / 贷 2202」（`inputIssueLines`），
   * 作废必须出等额反向（即 `inputVoidLines` 的分录），且与状态变更**同事务**。
   *
   * ⚠️ 但 `source='vendor_settlement'` / `'expense'` 等由其他模块创建的应付，
   * 其原凭证可能挂在别的 `sourceType` 下（外协结算、报销挂账等）。这里统一以
   * `ap-void:{code}` 出反向分录 —— 分录方向恒等于 `inputVoidLines`，
   * 与来源模块无关（2202 与费用/进项税的对冲关系对所有应付来源都成立）。
   */
  async voidAp(
    id: string,
    userId: string,
    reason?: string
  ): Promise<ApItem> {
    const voidReason = reason?.trim() || '未填写作废原因';
    const pre = await this.db
      .select({
        ap: erpApBill,
        supplierTaxEntityId: mdSupplier.taxEntityId,
        supplierDefaultRate: mdSupplier.defaultTaxRate,
        supplierName: mdSupplier.name,
      })
      .from(erpApBill)
      .leftJoin(mdSupplier, eq(erpApBill.supplierId, mdSupplier.id))
      .where(eq(erpApBill.id, id));
    if (pre.length === 0) throw new NotFoundException('应付记录不存在');
    const before = pre[0];
    if ((before.ap.status ?? 'pending') === 'voided') {
      throw new ConflictException('该应付已作废，请勿重复操作');
    }
    await assertPeriodOpen(
      this.db,
      before.ap.dueDate ?? todayInShanghai(),
      '作废应付'
    );

    await this.db.transaction(async (tx) => {
      // ① 行锁重读
      const lockedRows = await tx
        .select()
        .from(erpApBill)
        .where(eq(erpApBill.id, id))
        .for('update');
      if (lockedRows.length === 0) throw new NotFoundException('应付记录不存在');
      const ap = lockedRows[0];
      if ((ap.status ?? 'pending') === 'voided') {
        throw new ConflictException('该应付已作废，请勿重复操作');
      }
      const paid = Number(ap.paidAmount ?? 0);
      if (paid > 0.001) {
        throw new BadRequestException(
          `该应付已有付款金额 ${paid}，不能作废；请先冲销对应的付款核销记录`
        );
      }
      // ② 未作废付款单引用
      const paymentRows = await tx
        .select({ code: erpPayment.code, status: erpPayment.status })
        .from(erpPayment)
        .where(and(eq(erpPayment.apId, id), ne(erpPayment.status, 'voided')))
        .limit(1);
      if (paymentRows.length > 0) {
        throw new BadRequestException(
          `该应付已存在付款单 ${paymentRows[0].code}（状态 ${paymentRows[0].status ?? '-'}），` +
            `不能作废；请先作废该付款单`
        );
      }
      // ③ 有效进项发票引用
      const invoiceRows = await tx
        .select({ code: erpInvoice.code })
        .from(erpInvoice)
        .where(and(eq(erpInvoice.apId, id), eq(erpInvoice.status, 'issued')))
        .limit(1);
      if (invoiceRows.length > 0) {
        throw new BadRequestException(
          `该应付已被进项发票 ${invoiceRows[0].code} 引用，不能作废；` +
            `请先作废该发票（同月）或开具红字发票（跨月），再作废应付`
        );
      }
      // ④ CAS 收口
      const updated = await tx
        .update(erpApBill)
        .set({
          status: 'voided',
          voidReason,
          voidedAt: new Date(),
          voidedBy: userId,
          updatedAt: new Date(),
        })
        .where(and(eq(erpApBill.id, id), ne(erpApBill.status, 'voided')))
        .returning({ id: erpApBill.id });
      if (updated.length === 0) {
        throw new ConflictException('该应付已被作废，请刷新后重试');
      }
      // ⑤ 同事务红字凭证
      const amount = Number(ap.amount ?? 0);
      if (amount !== 0) {
        // 税率从供应商档案取（与 createAp 的解析链同源）；取不到时按 0 处理，
        // 此时反向分录退化为「借 2202 / 贷 6602」全额冲减费用 —— 与
        // `inputIssueLines(amount, 0)` 的分录严格镜像，借贷仍平。
        const rate = Number(before.supplierDefaultRate ?? 0);
        const lines = inputVoidLines(
          amount,
          Number.isFinite(rate) ? rate : 0
        );
        await this.voucherHookService.generateVoucherDraft({
          sourceType: 'ap',
          sourceRef: `ap-void:${ap.code}`,
          voucherDate: todayInShanghai(),
          summary: `应付作废 ${ap.code}`,
          lines,
          taxEntityId: before.supplierTaxEntityId ?? null,
        });
      }
    });

    const rows = await this.db
      .select({
        ap: erpApBill,
        supplierName: mdSupplier.name,
        projectName: erpProject.name,
      })
      .from(erpApBill)
      .leftJoin(mdSupplier, eq(erpApBill.supplierId, mdSupplier.id))
      .leftJoin(erpProject, eq(erpApBill.projectId, erpProject.id))
      .where(eq(erpApBill.id, id));
    const row = rows[0];
    return {
      id: row.ap.id,
      code: row.ap.code,
      supplierId: row.ap.supplierId ?? '',
      supplierName: row.supplierName ?? '',
      projectId: row.ap.projectId,
      projectName: row.projectName,
      amount: Number(row.ap.amount ?? 0),
      paidAmount: Number(row.ap.paidAmount ?? 0),
      dueDate: row.ap.dueDate,
      status: 'voided' as ApStatus,
      source: row.ap.source ?? 'manual',
      sourceRef: row.ap.sourceRef,
      voidReason: row.ap.voidReason ?? null,
      voidedAt: row.ap.voidedAt ? new Date(row.ap.voidedAt).toISOString() : null,
      voidedBy: row.ap.voidedBy ?? null,
      remark: row.ap.remark,
      createdAt: row.ap.createdAt.toISOString(),
    };
  }

  async listPayments(apId?: string): Promise<PaymentItem[]> {
    const rows = await this.db
      .select({
        payment: erpPayment,
        apCode: erpApBill.code,
        supplierName: mdSupplier.name,
      })
      .from(erpPayment)
      .leftJoin(erpApBill, eq(erpPayment.apId, erpApBill.id))
      .leftJoin(mdSupplier, eq(erpPayment.supplierId, mdSupplier.id))
      .where(apId ? eq(erpPayment.apId, apId) : undefined)
      .orderBy(desc(erpPayment.createdAt));
    return rows.map((row) => ({
      id: row.payment.id,
      code: row.payment.code,
      apId: row.payment.apId ?? '',
      apCode: row.apCode,
      supplierId: row.payment.supplierId ?? '',
      supplierName: row.supplierName ?? '',
      amount: Number(row.payment.amount ?? 0),
      payDate: row.payment.payDate,
      method: row.payment.method ?? 'bank',
      status: (row.payment.status ?? 'pending') as PaymentStatus,
      approver: row.payment.approver,
      remark: row.payment.remark,
      createdAt: row.payment.createdAt.toISOString(),
    }));
  }

  /** 付款登记（草稿），审批通过后才能核销 */
  async createPayment(dto: CreatePaymentDto): Promise<PaymentItem> {
    const code = await generateBizCode(
      this.db,
      erpPayment,
      erpPayment.code,
      'PAY'
    );
    const rows = await this.db.transaction(async (tx) => {
      const apRows = await tx
        .select()
        .from(erpApBill)
        .where(eq(erpApBill.id, dto.apId))
        .for('update');
      if (apRows.length === 0) throw new NotFoundException('应付记录不存在');
      const ap = apRows[0];
      /*
       * ⚠️ 作废的应付单**不得**再登记付款（与 `ArService.writeoff` 同一缺陷类）。
       *
       * `voidAp` 会写入 `status='voided'` 并开具冲回凭证；若仍允许对它登记付款，
       * 后续核销会把 `paidAmount` 加上去，并在状态重算里把 `'voided'`
       * **覆盖成 `'paid'`/`'partial'`** —— 已被作废（且已冲回）的单据被"复活"，
       * 而冲回凭证还挂在账上 → 账实不符。
       *
       * 守卫放在余额校验**之前**：作废单的 `amount − reserved` 通常仍为正数，
       * 余额校验拦不住它。客户端下拉也已排除 `voided`，但服务端是权威一方
       * （接口可被直接调用，且并发下客户端读到的状态可能已过期）。
       */
      const payableBlocked = blockedReasonForWriteAction(
        ap.status,
        PAYABLE_AP_STATUSES,
        '登记付款',
        '应付',
      );
      if (payableBlocked) throw new BadRequestException(payableBlocked);
      const reservedRows = await tx
        .select({
          total: sql<string>`coalesce(sum(${erpPayment.amount}), 0)`,
        })
        .from(erpPayment)
        .where(
          and(
            eq(erpPayment.apId, dto.apId),
            inArray(erpPayment.status, ['pending', 'approved', 'paid'])
          )
        );
      const reserved = Number(reservedRows[0]?.total ?? 0);
      // 占用口径：pending/approved/paid 付款单合计（paidAmount 与 paid 状态同源，不再重复扣）
      const remaining = Number(ap.amount) - reserved;
      if (dto.amount > remaining + 0.001) {
        throw new BadRequestException(
          `付款金额超过应付可付余额 ${remaining}（已占用 ${reserved}）`
        );
      }
      return tx
        .insert(erpPayment)
        .values({
          code,
          apId: dto.apId,
          supplierId: ap.supplierId,
          amount: String(dto.amount),
          payDate: dto.payDate,
          method: dto.method ?? 'bank',
          status: 'pending',
          remark: dto.remark,
        })
        .returning();
    });
    const row = rows[0];
    const ap = await this.db
      .select({ code: erpApBill.code })
      .from(erpApBill)
      .where(eq(erpApBill.id, row.apId ?? ''));
    const supplier = await this.db
      .select({ name: mdSupplier.name })
      .from(mdSupplier)
      .where(eq(mdSupplier.id, row.supplierId ?? ''));
    return {
      id: row.id,
      code: row.code,
      apId: row.apId ?? '',
      apCode: ap[0]?.code ?? null,
      supplierId: row.supplierId ?? '',
      supplierName: supplier[0]?.name ?? '',
      amount: Number(row.amount ?? 0),
      payDate: row.payDate,
      method: row.method ?? 'bank',
      status: (row.status ?? 'pending') as PaymentStatus,
      approver: row.approver,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 付款审批：approve 置为已批准，reject 驳回；事务内 CAS + 再校验可付余额 */
  async approvePayment(
    id: string,
    action: 'approve' | 'reject',
    approver: string
  ): Promise<PaymentItem> {
    const row = await this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(erpPayment)
        .where(eq(erpPayment.id, id))
        .for('update');
      if (locked.length === 0) throw new NotFoundException('付款记录不存在');
      if ((locked[0].status ?? '') !== 'pending') {
        throw new BadRequestException('该付款已审批');
      }
      if (action === 'approve' && locked[0].apId) {
        const apRows = await tx
          .select()
          .from(erpApBill)
          .where(eq(erpApBill.id, locked[0].apId))
          .for('update');
        if (apRows.length === 0) throw new NotFoundException('应付记录不存在');
        const reservedRows = await tx
          .select({
            total: sql<string>`coalesce(sum(${erpPayment.amount}), 0)`,
          })
          .from(erpPayment)
          .where(
            and(
              eq(erpPayment.apId, locked[0].apId),
              inArray(erpPayment.status, [
                'pending',
                'approved',
                'paid',
              ]),
              sql`${erpPayment.id} <> ${id}`
            )
          );
        const reserved = Number(reservedRows[0]?.total ?? 0);
        const remaining = Number(apRows[0].amount) - reserved;
        if (Number(locked[0].amount ?? 0) > remaining + 0.001) {
          throw new BadRequestException(
            `审批失败：付款超过应付可付余额 ${remaining}`
          );
        }
      }
      const updated = await tx
        .update(erpPayment)
        .set({
          status: action === 'approve' ? 'approved' : 'rejected',
          approver,
          updatedAt: new Date(),
        })
        .where(and(eq(erpPayment.id, id), eq(erpPayment.status, 'pending')))
        .returning();
      if (updated.length === 0) {
        throw new BadRequestException('该付款已审批');
      }
      return updated[0];
    });

    /* 付款审批通过 → 生成凭证草稿：借 应付账款(2202) / 贷 银行存款(1002/100201) */
    if (action === 'approve') {
      const payAmount = Number(row.amount ?? 0);
      const voucherStatus = await this.voucherHookService.generateVoucherDraft({
        sourceType: 'payment',
        sourceRef: `payment:${row.code}`,
        voucherDate: row.payDate ?? todayInShanghai(),
        summary: `付款审批 ${row.code}`,
        lines: paymentLines(payAmount),
        taxEntityId: await this.supplierTaxEntityId(row.supplierId),
      });
      if (voucherStatus !== 'created') {
        this.logger.error(
          `付款凭证 voucherStatus=${voucherStatus} payment:${row.code}`
        );
      }
    }

    const ap = await this.db
      .select({ code: erpApBill.code })
      .from(erpApBill)
      .where(eq(erpApBill.id, row.apId ?? ''));
    const supplier = await this.db
      .select({ name: mdSupplier.name })
      .from(mdSupplier)
      .where(eq(mdSupplier.id, row.supplierId ?? ''));
    return {
      id: row.id,
      code: row.code,
      apId: row.apId ?? '',
      apCode: ap[0]?.code ?? null,
      supplierId: row.supplierId ?? '',
      supplierName: supplier[0]?.name ?? '',
      amount: Number(row.amount ?? 0),
      payDate: row.payDate,
      method: row.method ?? 'bank',
      status: (row.status ?? 'pending') as PaymentStatus,
      approver: row.approver,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 作废未核销付款。已审批付款同时冲回银存凭证。 */
  async voidPayment(id: string): Promise<PaymentItem> {
    // 修复 P0-4：部分核销后付款单仍是 approved（只有全额核销才置 paid），
    // 直接作废会释放额度占用却留下 erp_ap_writeoff 记录与 ap.paidAmount，
    // 于是可以再建一张付款单 → 重复付款、账实不符。
    const usedRows = await this.db
      .select({
        total: sql<string>`coalesce(sum(${erpApWriteoff.amount}), 0)`,
      })
      .from(erpApWriteoff)
      .where(eq(erpApWriteoff.paymentId, id));
    if (Number(usedRows[0]?.total ?? 0) > 0) {
      throw new BadRequestException(
        '该付款单已有核销记录，不可作废；请先冲销对应的核销记录'
      );
    }
    const rows = await this.db
      .update(erpPayment)
      .set({ status: 'voided', updatedAt: new Date() })
      .where(
        and(eq(erpPayment.id, id), eq(erpPayment.status, 'approved'))
      )
      .returning();
    const pending =
      rows.length > 0
        ? rows
        : await this.db
            .update(erpPayment)
            .set({ status: 'voided', updatedAt: new Date() })
            .where(and(eq(erpPayment.id, id), eq(erpPayment.status, 'pending')))
            .returning();
    if (pending.length === 0) {
      throw new BadRequestException('只有待审批或已审批且未付款的记录可以作废');
    }
    const row = pending[0];
    if (rows.length > 0) {
      const payAmount = Number(row.amount ?? 0);
      await this.voucherHookService.generateVoucherDraft({
        sourceType: 'payment',
        sourceRef: `payment-void:${row.code}`,
        voucherDate: todayInShanghai(),
        summary: `付款作废 ${row.code}`,
        lines: paymentVoidLines(payAmount),
        taxEntityId: await this.supplierTaxEntityId(row.supplierId),
      });
    }
    const ap = await this.db
      .select({ code: erpApBill.code })
      .from(erpApBill)
      .where(eq(erpApBill.id, row.apId ?? ''));
    const supplier = await this.db
      .select({ name: mdSupplier.name })
      .from(mdSupplier)
      .where(eq(mdSupplier.id, row.supplierId ?? ''));
    return {
      id: row.id,
      code: row.code,
      apId: row.apId ?? '',
      apCode: ap[0]?.code ?? null,
      supplierId: row.supplierId ?? '',
      supplierName: supplier[0]?.name ?? '',
      amount: Number(row.amount ?? 0),
      payDate: row.payDate,
      method: row.method ?? 'bank',
      status: 'voided' as PaymentStatus,
      approver: row.approver,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 付款核销：事务内 FOR UPDATE 锁行（不可 SKIP LOCKED，需等待持锁方完成） */
  async apWriteoff(dto: ApWriteoffDto): Promise<ApItem> {
    if (dto.amount <= 0) {
      throw new BadRequestException('核销金额必须大于 0');
    }
    await this.db.transaction(async (tx) => {
      const apRows = await tx
        .select()
        .from(erpApBill)
        .where(eq(erpApBill.id, dto.apId))
        .for('update');
      if (apRows.length === 0) throw new NotFoundException('应付记录不存在');
      const ap = apRows[0];
      /*
       * ⚠️ 这条守卫同时挡住**两个**后果，缺了它下面的状态重算会"复活"作废单：
       *
       * 核销末尾会按新的 `paidAmount` 重算状态
       * （`newPaid >= amount ? 'paid' : newPaid > 0 ? 'partial' : 原状态`）——
       * 一旦 `newPaid > 0`，`'voided'` 就被**覆盖**成 `'paid'`/`'partial'`。
       * 而 `voidAp` 作废时已经开具了冲回凭证，于是出现：
       * 单据状态回到"已付/部分付"、冲回凭证仍在账上 → 重复计数。
       *
       * 必须在重算**之前**拦（放在读取 `ap` 之后即最早可行点）。
       */
      const apWriteoffBlocked = blockedReasonForWriteAction(
        ap.status,
        WRITEOFFABLE_AP_STATUSES,
        '核销',
        '应付',
      );
      if (apWriteoffBlocked) throw new BadRequestException(apWriteoffBlocked);
      const payRows = await tx
        .select()
        .from(erpPayment)
        .where(eq(erpPayment.id, dto.paymentId))
        .for('update');
      if (payRows.length === 0) throw new NotFoundException('付款记录不存在');
      const payment = payRows[0];
      if (payment.status !== 'approved') {
        throw new BadRequestException('仅已批准的付款可核销');
      }
      if (payment.apId !== dto.apId) {
        throw new BadRequestException('付款与应付不匹配，不可核销');
      }
      // F4X-4：条件更新 paid_amount / used_amount，防并发超额
      const apUpdated = await tx
        .update(erpApBill)
        .set({
          paidAmount: sql`coalesce(${erpApBill.paidAmount}, 0) + ${dto.amount}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(erpApBill.id, dto.apId),
            sql`coalesce(${erpApBill.paidAmount}, 0) + ${dto.amount} <= ${erpApBill.amount}`,
          ),
        )
        .returning({
          paidAmount: erpApBill.paidAmount,
          amount: erpApBill.amount,
          status: erpApBill.status,
        });
      if (apUpdated.length === 0) {
        throw new BadRequestException(
          '应付可用余额不足（可能已被并发核销）',
        );
      }
      const payUpdated = await tx
        .update(erpPayment)
        .set({
          usedAmount: sql`${erpPayment.usedAmount} + ${dto.amount}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(erpPayment.id, dto.paymentId),
            sql`${erpPayment.usedAmount} + ${dto.amount} <= ${erpPayment.amount}`,
          ),
        )
        .returning({
          usedAmount: erpPayment.usedAmount,
          amount: erpPayment.amount,
        });
      if (payUpdated.length === 0) {
        throw new BadRequestException(
          '付款可用余额不足（可能已被并发核销）',
        );
      }
      await tx.insert(erpApWriteoff).values({
        apId: dto.apId,
        paymentId: dto.paymentId,
        amount: String(dto.amount),
        writeoffDate: todayInShanghai(),
      });
      const newPaid = Number(apUpdated[0].paidAmount ?? 0);
      /*
       * §5.9：状态重算公式已抽到 `./writeoff-status`（纯函数 + 13 条断言）。
       * 该模块把 `voided` 做成**显式一档**（原样返回、不参与重算）——
       * 等于给"作废单被复活"这条规则加了第二道防线（第一道是本方法开头的
       * `blockedReasonForWriteAction` 守卫；见模块文件头的论证）。
       */
      const apStatus = apWriteoffStatus({
        currentStatus: (apUpdated[0].status ?? 'pending') as ApBillStatus,
        newPaidAmount: newPaid,
        totalAmount: Number(apUpdated[0].amount),
      });
      await tx
        .update(erpApBill)
        .set({
          status: apStatus,
          updatedAt: new Date(),
        })
        .where(eq(erpApBill.id, dto.apId));
      const newUsed = Number(payUpdated[0].usedAmount ?? 0);
      if (isPaymentFullyUsed(newUsed, Number(payUpdated[0].amount))) {
        await tx
          .update(erpPayment)
          .set({ status: 'paid', updatedAt: new Date() })
          .where(eq(erpPayment.id, dto.paymentId));
      }
    });
    const updated = await this.db
      .select({
        ap: erpApBill,
        supplierName: mdSupplier.name,
        projectName: erpProject.name,
      })
      .from(erpApBill)
      .leftJoin(mdSupplier, eq(erpApBill.supplierId, mdSupplier.id))
      .leftJoin(erpProject, eq(erpApBill.projectId, erpProject.id))
      .where(eq(erpApBill.id, dto.apId));
    const row = updated[0];
    return {
      id: row.ap.id,
      code: row.ap.code,
      supplierId: row.ap.supplierId ?? '',
      supplierName: row.supplierName ?? '',
      projectId: row.ap.projectId,
      projectName: row.projectName,
      amount: Number(row.ap.amount ?? 0),
      paidAmount: Number(row.ap.paidAmount ?? 0),
      dueDate: row.ap.dueDate,
      status: (row.ap.status ?? 'pending') as ApStatus,
      source: row.ap.source ?? 'manual',
      sourceRef: row.ap.sourceRef,
      voidReason: row.ap.voidReason ?? null,
      voidedAt: row.ap.voidedAt ? new Date(row.ap.voidedAt).toISOString() : null,
      voidedBy: row.ap.voidedBy ?? null,
      remark: row.ap.remark,
      createdAt: row.ap.createdAt.toISOString(),
    };
  }

  /** 应付核销冲回 */
  async reverseWriteoff(writeoffId: string, remark?: string): Promise<ApItem> {
    let apId = '';
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(erpApWriteoff)
        .where(eq(erpApWriteoff.id, writeoffId))
        .for('update');
      if (rows.length === 0) throw new NotFoundException('核销记录不存在');
      const src = rows[0];
      if (src.reversalOf) {
        throw new BadRequestException('红字核销行不可再次冲回');
      }
      const already = await tx
        .select({ id: erpApWriteoff.id })
        .from(erpApWriteoff)
        .where(eq(erpApWriteoff.reversalOf, writeoffId))
        .limit(1);
      if (already.length > 0) {
        throw new BadRequestException('该核销已冲回，请勿重复操作');
      }
      const amount = Number(src.amount ?? 0);
      if (amount <= 0) throw new BadRequestException('核销金额无效');
      apId = src.apId ?? '';
      const apRows = await tx
        .select()
        .from(erpApBill)
        .where(eq(erpApBill.id, apId))
        .for('update');
      if (apRows.length === 0) throw new NotFoundException('应付记录不存在');
      const payRows = await tx
        .select()
        .from(erpPayment)
        .where(eq(erpPayment.id, src.paymentId ?? ''))
        .for('update');
      if (payRows.length === 0) throw new NotFoundException('付款记录不存在');
      try {
        await tx.insert(erpApWriteoff).values({
          apId,
          paymentId: src.paymentId,
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
      const newPaid = Math.max(0, Number(apRows[0].paidAmount ?? 0) - amount);
      /* §5.9：冲回路径的状态判据（含 0.001 归零容差）见 `./writeoff-status` */
      const apStatus = apWriteoffReversalStatus({
        newPaidAmount: newPaid,
        totalAmount: Number(apRows[0].amount),
      });
      await tx
        .update(erpPayment)
        .set({
          usedAmount: sql`greatest(0, ${erpPayment.usedAmount} - ${amount})`,
          updatedAt: new Date(),
        })
        .where(eq(erpPayment.id, src.paymentId ?? ''));
      await tx
        .update(erpApBill)
        .set({
          paidAmount: String(newPaid),
          status: apStatus,
          updatedAt: new Date(),
        })
        .where(eq(erpApBill.id, apId));
      const usedRows = await tx
        .select({ total: sum(erpApWriteoff.amount) })
        .from(erpApWriteoff)
        .where(eq(erpApWriteoff.paymentId, src.paymentId ?? ''));
      const newUsed = Number(usedRows[0]?.total ?? 0);
      await tx
        .update(erpPayment)
        .set({
          status: paymentStatusAfterReversal(newUsed, Number(payRows[0].amount)),
          updatedAt: new Date(),
        })
        .where(eq(erpPayment.id, src.paymentId ?? ''));
    });
    const updated = await this.db
      .select({
        ap: erpApBill,
        supplierName: mdSupplier.name,
        projectName: erpProject.name,
      })
      .from(erpApBill)
      .leftJoin(mdSupplier, eq(erpApBill.supplierId, mdSupplier.id))
      .leftJoin(erpProject, eq(erpApBill.projectId, erpProject.id))
      .where(eq(erpApBill.id, apId));
    const row = updated[0];
    return {
      id: row.ap.id,
      code: row.ap.code,
      supplierId: row.ap.supplierId ?? '',
      supplierName: row.supplierName ?? '',
      projectId: row.ap.projectId,
      projectName: row.projectName,
      amount: Number(row.ap.amount ?? 0),
      paidAmount: Number(row.ap.paidAmount ?? 0),
      dueDate: row.ap.dueDate,
      status: (row.ap.status ?? 'pending') as ApStatus,
      source: row.ap.source ?? 'manual',
      sourceRef: row.ap.sourceRef,
      voidReason: row.ap.voidReason ?? null,
      voidedAt: row.ap.voidedAt ? new Date(row.ap.voidedAt).toISOString() : null,
      voidedBy: row.ap.voidedBy ?? null,
      remark: row.ap.remark,
      createdAt: row.ap.createdAt.toISOString(),
    };
  }
}
