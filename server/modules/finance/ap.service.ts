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
import { and, desc, eq, inArray, sql, sum, type SQL } from 'drizzle-orm';
import {
  erpApBill,
  erpApWriteoff,
  erpPayment,
  erpProject,
  mdSupplier,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { DataScopeService } from '@server/common/auth/data-scope.service';
import type { RequestActor } from '@server/common/auth/actor';
import { inputIssueLines, paymentLines, paymentVoidLines } from '@server/common/tax/posting';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { todayInShanghai } from '@server/common/utils/biz-date';
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
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
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
      const apStatus =
        newPaid >= Number(apUpdated[0].amount)
          ? 'paid'
          : newPaid > 0
            ? 'partial'
            : (apUpdated[0].status ?? 'pending');
      await tx
        .update(erpApBill)
        .set({
          status: apStatus,
          updatedAt: new Date(),
        })
        .where(eq(erpApBill.id, dto.apId));
      const newUsed = Number(payUpdated[0].usedAmount ?? 0);
      if (newUsed >= Number(payUpdated[0].amount)) {
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
      const apStatus =
        newPaid <= 0.001
          ? 'pending'
          : newPaid >= Number(apRows[0].amount)
            ? 'paid'
            : 'partial';
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
          status: newUsed >= Number(payRows[0].amount) - 0.001 ? 'paid' : 'approved',
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
      remark: row.ap.remark,
      createdAt: row.ap.createdAt.toISOString(),
    };
  }
}
