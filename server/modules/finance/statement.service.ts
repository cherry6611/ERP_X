import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@server/platform';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  erpApBill,
  erpAr,
  erpInvoice,
  erpPayment,
  erpProject,
  erpReceipt,
  mdCustomer,
  mdSupplier,
  mdTaxEntity,
} from '@server/database/schema';
import { DataScopeService } from '@server/common/auth/data-scope.service';
import type { RequestActor } from '@server/common/auth/actor';
import { toRmbUpper } from '@server/common/utils/rmb-upper';
import {
  computeStatement,
  roundAmount,
  statementReconStatus,
  statementSortKey,
  type StatementDocType,
  type StatementStatus,
  type StatementTxn,
} from './statement.logic';
import type {
  StatementCounterparty,
  StatementCounterpartyOption,
  StatementDirection,
  StatementLineItem,
  StatementOrgProfile,
  StatementResult,
} from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * C-11：客户/供应商对账单（对**外**确认用的单据）。
 *
 * 与 `ReconciliationService` 的区别（不要混用）：
 *   - `ReconciliationService`：**内部**三方勾稽（发票↔应收/应付、回款↔核销覆盖），
 *     面向财务自查，输出"未勾稽/超额/作废风险"。
 *   - 本服务：**对手方**对账单，按期列示期初余额、本期逐笔发生、运行余额、期末余额，
 *     并标注每张单据的核对状态，末行给出可确认的余额与中文大写金额。
 *
 * 数据来源（全部读既有表，不新增表/迁移）：
 *   客户：`erp_ar`（增加）+ `erp_receipt`（减少）+ `erp_invoice.direction='sales'`（备查）
 *   供应商：`erp_ap_bill`（增加）+ `erp_payment`（减少）+ `erp_invoice.direction='purchase'`（备查）
 *
 * ⚠️ 会计口径见 `statement.logic.ts` 文件头，其中三条**需财务确认**：
 *   ① 期初 = 期间开始日**之前**的发生额净额（本系统无期末余额快照，期末由发生额推导）；
 *   ② 期间边界左闭右开（期间开始日算本期，次月 1 日算下期）；
 *   ③ 作废单据整单剔除；发票金额作备查行，**不重复计入余额**。
 */
@Injectable()
export class StatementService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly dataScope: DataScopeService
  ) {}

  /* ==================== 对外入口 ==================== */

  async getCustomerStatement(
    counterpartyId: string,
    period: string,
    actor?: RequestActor
  ): Promise<StatementResult> {
    return this.buildStatement('customer', counterpartyId, period, actor);
  }

  async getSupplierStatement(
    counterpartyId: string,
    period: string,
    actor?: RequestActor
  ): Promise<StatementResult> {
    return this.buildStatement('supplier', counterpartyId, period, actor);
  }

  /**
   * 对手方下拉：只列出确实发生过业务的对手方（有应收/应付 或 有回款/付款）。
   * `lastDocDate` 取业务日期（应收/应付登记日、回款/付款日）的最大值，
   * 而不是到期日 —— 到期日可能远在未来，用来排序会误导。
   *
   * 实现说明（踩过的坑）：**不要**在这里写 `FROM ${erpAr} WHERE erp_ar.customer_id = md_customer.id`
   * 形式的相关子查询 —— Drizzle 渲染整表对象 `${erpAr}` 时不带别名，与外层的
   * `"erp_ar"."customer_id"` 同表名互相遮蔽，子查询会静默返回 NULL（不报错），
   * 结果是下拉永远为空。这里改为两个聚合查询 + 内存合并，语义相同且不依赖别名。
   */
  async listCounterparties(
    direction: StatementDirection
  ): Promise<StatementCounterpartyOption[]> {
    if (direction === 'customer') {
      const [parties, lastAr, lastReceipt] = await Promise.all([
        this.db
          .select({
            id: mdCustomer.id,
            code: mdCustomer.code,
            name: mdCustomer.name,
          })
          .from(mdCustomer)
          .orderBy(mdCustomer.name),
        this.db
          .select({
            counterpartyId: erpAr.customerId,
            lastDate: sql<
              string | null
            >`MAX((${erpAr.createdAt} AT TIME ZONE 'Asia/Shanghai')::date)`,
          })
          .from(erpAr)
          .groupBy(erpAr.customerId),
        this.db
          .select({
            counterpartyId: erpReceipt.customerId,
            lastDate: sql<string | null>`MAX(${erpReceipt.receiptDate})`,
          })
          .from(erpReceipt)
          .groupBy(erpReceipt.customerId),
      ]);
      const map = toDateMap(lastAr, lastReceipt);
      return parties
        .map((party) => ({
          id: party.id,
          code: party.code,
          name: party.name,
          lastDocDate: map.get(party.id) ?? null,
        }))
        .filter((party) => map.has(party.id));
    }
    const [parties, lastAp, lastPayment] = await Promise.all([
      this.db
        .select({
          id: mdSupplier.id,
          code: mdSupplier.code,
          name: mdSupplier.name,
        })
        .from(mdSupplier)
        .orderBy(mdSupplier.name),
      this.db
        .select({
          counterpartyId: erpApBill.supplierId,
          lastDate: sql<
            string | null
          >`MAX((${erpApBill.createdAt} AT TIME ZONE 'Asia/Shanghai')::date)`,
        })
        .from(erpApBill)
        .groupBy(erpApBill.supplierId),
      this.db
        .select({
          counterpartyId: erpPayment.supplierId,
          lastDate: sql<string | null>`MAX(${erpPayment.payDate})`,
        })
        .from(erpPayment)
        .groupBy(erpPayment.supplierId),
    ]);
    const map = toDateMap(lastAp, lastPayment);
    return parties
      .map((party) => ({
        id: party.id,
        code: party.code,
        name: party.name,
        lastDocDate: map.get(party.id) ?? null,
      }))
      .filter((party) => map.has(party.id));
  }

  /* ==================== 主流程 ==================== */

  private async buildStatement(
    direction: StatementDirection,
    counterpartyId: string,
    period: string,
    actor?: RequestActor
  ): Promise<StatementResult> {
    if (!counterpartyId) {
      throw new BadRequestException(
        direction === 'customer' ? 'customerId 必填' : 'supplierId 必填'
      );
    }
    if (!PERIOD_PATTERN.test(period)) {
      throw new BadRequestException('period 格式必须为 YYYY-MM');
    }

    const counterparty: StatementCounterparty =
      direction === 'customer'
        ? await this.findCustomer(counterpartyId)
        : await this.findSupplier(counterpartyId);

    // B-02：行级可见范围。`finance_ledger` 的可见范围由 `sys_data_scope` 配置决定；
    // 本接口是"按对手方取全部发生额"，若不校验，被收窄的用户可绕过 `/api/finance/ars`
    // 的列表过滤直接读到他人余额，故按单条数据做 fail-closed 校验（越权 403）。
    if (actor) {
      await this.assertCounterpartyVisible(direction, counterpartyId, actor);
    }

    const txns =
      direction === 'customer'
        ? await this.collectCustomerTxns(counterpartyId)
        : await this.collectSupplierTxns(counterpartyId);

    const computation = computeStatement(direction, period, txns);
    const org = await this.resolveOrgProfile();

    return {
      direction,
      period,
      periodRange: computation.period,
      counterpartyId,
      counterparty,
      org,
      openingBalance: computation.openingBalance,
      periodDebit: computation.periodDebit,
      periodCredit: computation.periodCredit,
      closingBalance: computation.closingBalance,
      closingBalanceInWords: toRmbUpper(computation.closingBalance),
      lines: computation.lines.map(toLineItem),
      openingLines: computation.openingLines.map(toLineItem),
      excludedLines: computation.excludedLines.map(toLineItem),
      reconSummary: computation.reconSummary,
      generatedAt: new Date().toISOString(),
    };
  }

  /* ==================== 客户对账单数据 ==================== */

  private async collectCustomerTxns(
    customerId: string
  ): Promise<StatementTxn[]> {
    const [arRows, receiptRows, invoiceRows] = await Promise.all([
      this.db
        .select({
          id: erpAr.id,
          code: erpAr.code,
          amount: erpAr.amount,
          settledAmount: erpAr.settledAmount,
          // 应收表**没有单据日期列**（schema 确认：只有 due_date 与 _created_at），
          // 因此业务日期取登记日（业务时区）。口径说明（**需财务确认**）。
          bizDate: sql<string>`(${erpAr.createdAt} AT TIME ZONE 'Asia/Shanghai')::date`,
          status: erpAr.status,
          remark: erpAr.remark,
        })
        .from(erpAr)
        .where(eq(erpAr.customerId, customerId)),
      this.db
        .select({
          id: erpReceipt.id,
          code: erpReceipt.code,
          amount: erpReceipt.amount,
          usedAmount: erpReceipt.usedAmount,
          receiptDate: erpReceipt.receiptDate,
          status: erpReceipt.status,
          method: erpReceipt.method,
          remark: erpReceipt.remark,
        })
        .from(erpReceipt)
        .where(eq(erpReceipt.customerId, customerId)),
      this.db
        .select({
          id: erpInvoice.id,
          code: erpInvoice.code,
          invoiceNo: erpInvoice.invoiceNo,
          amount: erpInvoice.amount,
          invoiceDate: erpInvoice.invoiceDate,
          status: erpInvoice.status,
          arId: erpInvoice.arId,
          arCode: erpAr.code,
        })
        .from(erpInvoice)
        .leftJoin(erpAr, eq(erpInvoice.arId, erpAr.id))
        .where(
          and(
            eq(erpInvoice.direction, 'sales'),
            eq(erpInvoice.customerId, customerId)
          )
        ),
    ]);

    const out: StatementTxn[] = [];
    for (const row of arRows) {
      const voided = row.status === 'voided';
      const amount = Number(row.amount ?? 0);
      out.push({
        date: normalizeDate(row.bizDate),
        docType: 'ar',
        docCode: row.code,
        // 应收增加 = 我方债权增加（借方）
        debit: amount,
        credit: 0,
        affectsBalance: true,
        status: statementReconStatus({
          voided,
          amount,
          settled: Number(row.settledAmount ?? 0),
        }),
        voided,
        relatedDocCode: null,
        remark: row.remark,
        sortKey: statementSortKey('ar'),
      });
    }
    for (const row of receiptRows) {
      const voided = row.status === 'voided';
      const amount = Number(row.amount ?? 0);
      out.push({
        date: normalizeDate(row.receiptDate),
        docType: 'receipt',
        docCode: row.code,
        // 回款减少应收（贷方）。**未核销回款同样计入**（现金已收到），
        // 状态显示未核销/部分核销，提示业务去挂账。
        debit: 0,
        credit: amount,
        affectsBalance: true,
        status: statementReconStatus({
          voided,
          amount,
          settled: Number(row.usedAmount ?? 0),
        }),
        voided,
        relatedDocCode: null,
        remark: [row.method, row.remark].filter(Boolean).join(' / ') || null,
        sortKey: statementSortKey('receipt'),
      });
    }
    for (const row of invoiceRows) {
      const voided = row.status === 'voided';
      out.push({
        date: normalizeDate(row.invoiceDate),
        docType: 'invoice',
        docCode: row.invoiceNo || row.code,
        // 备查行：销项发票金额已由对应应收计量，在此计入会**重复**虚增余额
        debit: Number(row.amount ?? 0),
        credit: 0,
        affectsBalance: false,
        status: statementReconStatus({
          voided,
          informational: true,
          amount: 0,
        }),
        voided,
        relatedDocCode: row.arCode ?? null,
        remark: row.arCode
          ? `销项发票（对应应收 ${row.arCode}）`
          : '销项发票（未关联应收）',
        sortKey: statementSortKey('invoice'),
      });
    }
    return out;
  }

  /* ==================== 供应商对账单数据 ==================== */

  private async collectSupplierTxns(
    supplierId: string
  ): Promise<StatementTxn[]> {
    const [apRows, paymentRows, invoiceRows] = await Promise.all([
      this.db
        .select({
          id: erpApBill.id,
          code: erpApBill.code,
          amount: erpApBill.amount,
          paidAmount: erpApBill.paidAmount,
          bizDate: sql<string>`(${erpApBill.createdAt} AT TIME ZONE 'Asia/Shanghai')::date`,
          status: erpApBill.status,
          remark: erpApBill.remark,
        })
        .from(erpApBill)
        .where(eq(erpApBill.supplierId, supplierId)),
      this.db
        .select({
          id: erpPayment.id,
          code: erpPayment.code,
          amount: erpPayment.amount,
          usedAmount: erpPayment.usedAmount,
          payDate: erpPayment.payDate,
          status: erpPayment.status,
          method: erpPayment.method,
          remark: erpPayment.remark,
        })
        .from(erpPayment)
        .where(eq(erpPayment.supplierId, supplierId)),
      this.db
        .select({
          id: erpInvoice.id,
          code: erpInvoice.code,
          invoiceNo: erpInvoice.invoiceNo,
          amount: erpInvoice.amount,
          invoiceDate: erpInvoice.invoiceDate,
          status: erpInvoice.status,
          apId: erpInvoice.apId,
          apCode: erpApBill.code,
        })
        .from(erpInvoice)
        .leftJoin(erpApBill, eq(erpInvoice.apId, erpApBill.id))
        .where(
          and(
            eq(erpInvoice.direction, 'purchase'),
            eq(erpInvoice.supplierId, supplierId)
          )
        ),
    ]);

    const out: StatementTxn[] = [];
    for (const row of apRows) {
      const voided = row.status === 'voided';
      const amount = Number(row.amount ?? 0);
      out.push({
        date: normalizeDate(row.bizDate),
        docType: 'ap',
        docCode: row.code,
        // 应付增加 = 我方付款义务增加（借方）
        debit: amount,
        credit: 0,
        affectsBalance: true,
        status: statementReconStatus({
          voided,
          amount,
          settled: Number(row.paidAmount ?? 0),
        }),
        voided,
        relatedDocCode: null,
        remark: row.remark,
        sortKey: statementSortKey('ap'),
      });
    }
    for (const row of paymentRows) {
      const voided = row.status === 'voided';
      const amount = Number(row.amount ?? 0);
      out.push({
        date: normalizeDate(row.payDate),
        docType: 'payment',
        docCode: row.code,
        debit: 0,
        credit: amount,
        affectsBalance: true,
        status: statementReconStatus({
          voided,
          amount,
          settled: Number(row.usedAmount ?? 0),
        }),
        voided,
        relatedDocCode: null,
        remark: [row.method, row.remark].filter(Boolean).join(' / ') || null,
        sortKey: statementSortKey('payment'),
      });
    }
    for (const row of invoiceRows) {
      const voided = row.status === 'voided';
      out.push({
        date: normalizeDate(row.invoiceDate),
        docType: 'invoice',
        docCode: row.invoiceNo || row.code,
        debit: Number(row.amount ?? 0),
        credit: 0,
        affectsBalance: false,
        status: statementReconStatus({
          voided,
          informational: true,
          amount: 0,
        }),
        voided,
        relatedDocCode: row.apCode ?? null,
        remark: row.apCode
          ? `进项发票（勾稽应付 ${row.apCode}）`
          : '进项发票（未勾稽应付）',
        sortKey: statementSortKey('invoice'),
      });
    }
    return out;
  }

  /* ==================== 档案与抬头 ==================== */

  private async findCustomer(customerId: string): Promise<StatementCounterparty> {
    const rows = await this.db
      .select({
        id: mdCustomer.id,
        code: mdCustomer.code,
        name: mdCustomer.name,
        uscc: mdCustomer.uscc,
        invoicePhone: mdCustomer.invoicePhone,
      })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, customerId));
    if (rows.length === 0) throw new NotFoundException('客户不存在');
    const row = rows[0];
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      uscc: row.uscc ?? null,
      contactName: null,
      contactPhone: row.invoicePhone ?? null,
    };
  }

  private async findSupplier(supplierId: string): Promise<StatementCounterparty> {
    const rows = await this.db
      .select({
        id: mdSupplier.id,
        code: mdSupplier.code,
        name: mdSupplier.name,
        contactName: mdSupplier.contactName,
        contactPhone: mdSupplier.contactPhone,
      })
      .from(mdSupplier)
      .where(eq(mdSupplier.id, supplierId));
    if (rows.length === 0) throw new NotFoundException('供应商不存在');
    const row = rows[0];
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      // 供应商档案无 uscc 列（schema 确认），不编造
      uscc: null,
      contactName: row.contactName ?? null,
      contactPhone: row.contactPhone ?? null,
    };
  }

  /**
   * 我方抬头：取默认纳税主体（`md_tax_entity.is_default = 1`），
   * 缺失时回落到启用主体中的第一条；再缺失则全 null（打印件不编造名称）。
   */
  private async resolveOrgProfile(): Promise<StatementOrgProfile> {
    const rows = await this.db
      .select({
        name: mdTaxEntity.name,
        uscc: mdTaxEntity.uscc,
        invoiceTitle: mdTaxEntity.invoiceTitle,
        invoiceAddress: mdTaxEntity.invoiceAddress,
        invoicePhone: mdTaxEntity.invoicePhone,
        invoiceBank: mdTaxEntity.invoiceBank,
        invoiceAccount: mdTaxEntity.invoiceAccount,
      })
      .from(mdTaxEntity)
      .where(eq(mdTaxEntity.status, 'active'))
      .orderBy(sql`${mdTaxEntity.isDefault} DESC`);
    const row = rows[0];
    if (!row) {
      return {
        companyName: null,
        uscc: null,
        address: null,
        phone: null,
        bankName: null,
        bankAccount: null,
      };
    }
    return {
      companyName: row.invoiceTitle || row.name,
      uscc: row.uscc ?? null,
      address: row.invoiceAddress ?? null,
      phone: row.invoicePhone ?? null,
      bankName: row.invoiceBank ?? null,
      bankAccount: row.invoiceAccount ?? null,
    };
  }

  /* ==================== B-02 行级权限 ==================== */

  /**
   * 单条对手方的越权校验（fail-closed）：
   *   - `custom`：对手方 id 必须落在 `custom_ids` 内（空集→403）；
   *   - `self`  ：客户=该客户存在本人负责的应收（`erp_ar.owner_user_id`）；
   *              供应商=该供应商存在本人任项目经理的项目（**口径需业务确认**）；
   *   - `dept*` ：该对手方名下存在归属本部门（及下级）项目的应收/应付。
   *
   * 未配置该角色×资源的范围时 `resolveScope()` 返回 `from='default'`，
   * 按既有行为放行（与 `/api/finance/ars` 的"未配置即不收紧"一致）。
   */
  private async assertCounterpartyVisible(
    direction: StatementDirection,
    counterpartyId: string,
    actor: RequestActor
  ): Promise<void> {
    const resolved = await this.dataScope.resolveScope(
      actor.roles ?? [],
      'finance_ledger'
    );
    if (resolved.from !== 'config' || resolved.scope === 'all') return;

    const label = direction === 'customer' ? '客户' : '供应商';
    const condition: SQL | undefined =
      direction === 'customer'
        ? await this.customerVisibilityCondition(actor, resolved.scope, resolved.customIds)
        : await this.supplierVisibilityCondition(actor, resolved.scope, resolved.customIds);
    if (!condition) return;

    const visible =
      direction === 'customer'
        ? await this.db
            .select({ id: mdCustomer.id })
            .from(mdCustomer)
            .where(and(eq(mdCustomer.id, counterpartyId), condition))
            .limit(1)
        : await this.db
            .select({ id: mdSupplier.id })
            .from(mdSupplier)
            .where(and(eq(mdSupplier.id, counterpartyId), condition))
            .limit(1);
    if (visible.length === 0) {
      throw new ForbiddenException(`没有访问该${label}对账单的数据权限`);
    }
  }

  private async customerVisibilityCondition(
    actor: RequestActor,
    scope: string,
    customIds: string[]
  ): Promise<SQL | undefined> {
    if (scope === 'custom') return customScopeCondition(mdCustomer.id, customIds);
    if (scope === 'self') {
      const selfValue = await this.selfValueOf(actor);
      return sql`EXISTS (
        SELECT 1 FROM ${erpAr}
        WHERE ${erpAr.customerId} = ${mdCustomer.id}
          AND ${erpAr.ownerUserId} = ${selfValue}
      )`;
    }
    const names = await this.departmentNamesOf(actor);
    return sql`EXISTS (
      SELECT 1 FROM ${erpAr}
      INNER JOIN ${erpProject} ON ${erpProject.id} = ${erpAr.projectId}
      WHERE ${erpAr.customerId} = ${mdCustomer.id}
        AND ${erpProject.deptName} IN ${names}
    )`;
  }

  private async supplierVisibilityCondition(
    actor: RequestActor,
    scope: string,
    customIds: string[]
  ): Promise<SQL | undefined> {
    if (scope === 'custom') return customScopeCondition(mdSupplier.id, customIds);
    if (scope === 'self') {
      const selfValue = await this.selfValueOf(actor);
      return sql`EXISTS (
        SELECT 1 FROM ${erpApBill}
        INNER JOIN ${erpProject} ON ${erpProject.id} = ${erpApBill.projectId}
        WHERE ${erpApBill.supplierId} = ${mdSupplier.id}
          AND ${erpProject.pmUserId} = ${selfValue}
      )`;
    }
    const names = await this.departmentNamesOf(actor);
    return sql`EXISTS (
      SELECT 1 FROM ${erpApBill}
      INNER JOIN ${erpProject} ON ${erpProject.id} = ${erpApBill.projectId}
      WHERE ${erpApBill.supplierId} = ${mdSupplier.id}
        AND ${erpProject.deptName} IN ${names}
    )`;
  }

  private async selfValueOf(actor: RequestActor): Promise<string> {
    const binding = await this.dataScope.findEmployeeBinding(actor.userId);
    const selfValue = binding?.employeeId ?? actor.userId;
    if (!selfValue) {
      throw new ForbiddenException('没有访问该对账单的数据权限');
    }
    return selfValue;
  }

  private async departmentNamesOf(actor: RequestActor): Promise<string[]> {
    const context = await this.dataScope.resolveContext(actor, 'finance_ledger');
    const names = context.departmentNames ?? [];
    if (names.length === 0) {
      throw new ForbiddenException('没有访问该对账单的数据权限');
    }
    return names;
  }
}

/** custom 范围：id 必须落在 custom_ids 内；配置为空按 fail-closed 处理 */
function customScopeCondition(
  column: typeof mdCustomer.id | typeof mdSupplier.id,
  customIds: string[]
): SQL {
  if (customIds.length === 0) {
    throw new ForbiddenException('没有访问该对账单的数据权限');
  }
  return sql`${column} IN ${customIds}`;
}

/**
 * 两个可空日期取最大（均为 YYYY-MM-DD 字符串，可直接字典序比较）
 *
 * 同时登记了"子查询别名遮蔽"的坑：`FROM ${table}` 形式的自引用子查询
 * 在 Drizzle 下会静默返回 NULL（详见 `listCounterparties` 注释），
 * 因此所有需要关联对手方的取数都改成了独立聚合 + 内存合并。
 */
function maxDate(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return a >= b ? a : b;
}

/** 把若干「对手方 → 最近业务日期」的聚合结果合并成一张表（取最大日期） */
function toDateMap(
  ...groups: Array<Array<{ counterpartyId: string | null; lastDate: string | null }>>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of groups) {
    for (const row of group) {
      if (!row.counterpartyId) continue;
      const date = normalizeDate(row.lastDate);
      if (!date) continue;
      map.set(row.counterpartyId, maxDate(map.get(row.counterpartyId) ?? null, date) as string);
    }
  }
  return map;
}

/**
 * 日期列归一化成 `YYYY-MM-DD` 字符串。
 *
 * 为什么必须有这一层：数据库驱动对 `date` 列的返回类型不一致 ——
 * 生产用的 postgres-js 返回字符串，而集成测试用的 pglite（drizzle 的 pglite 驱动
 * 未注册 date 的自定义类型解析）返回 `Date`。若直接把 `Date` 当字符串比较，
 * `date < periodStart` 这类判断会静默走错分支，**余额算错且不报错**。
 * 这里统一成字符串，保证两种驱动下口径一致。
 */
function normalizeDate(value: string | Date | null | undefined): string {
  if (value == null) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? ''
      : value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

/** 内部行 → 契约行（分离是为了让 service 不直接依赖契约字段名） */
function toLineItem(line: {
  date: string;
  docType: StatementDocType;
  docCode: string;
  debit: number;
  credit: number;
  runningBalance?: number | null;
  affectsBalance: boolean;
  status: StatementStatus;
  relatedDocCode: string | null;
  remark: string | null;
}): StatementLineItem {
  return {
    date: line.date,
    docType: line.docType,
    docCode: line.docCode,
    debit: roundAmount(line.debit),
    credit: roundAmount(line.credit),
    runningBalance:
      line.runningBalance == null ? null : roundAmount(line.runningBalance),
    affectsBalance: line.affectsBalance,
    status: line.status,
    relatedDocCode: line.relatedDocCode,
    remark: line.remark,
  };
}
