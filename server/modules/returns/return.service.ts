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
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  erpProject,
  erpProjectCost,
  erpProjectRevenue,
  mdCustomer,
  mdSupplier,
  purOrder,
  purReturn,
  salesReturn,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import {
  RETURN_STATUS_LABELS,
  RETURN_ACTION_LABELS,
  RETURN_STATUSES,
  isBalanced,
  purchaseReturnLines,
  returnAmount,
  returnableQuantity,
  salesReturnLines,
  validateReturnAction,
  type ReturnAction,
  type ReturnStatus,
} from '@server/common/tax/return-rules';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import type {
  CreatePurchaseReturnDto,
  CreateSalesReturnDto,
  PagedResult,
  PurchaseReturnItem,
  PurchaseReturnListParams,
  ReturnActionDto,
  ReturnRegisterResult,
  ReturnableQuantityResult,
  SalesReturnItem,
  SalesReturnListParams,
} from '@shared/api.interface';

/**
 * C-05：采购/销售退货闭环。
 *
 * ## 为什么需要"可退数量"接口
 *
 * 退货最危险的错误是**超退**：同一张订单分多次退货时若每次都按"订购数量"
 * 判断，第二张单就会退超出已验收的量，导致库存与应付同时变成负数。
 * 因此下单前必须先查 `returnableQuantity`（已验收 − 已退），
 * 服务端在建单与完成时都会再校验一次（前端校验不可信）。
 *
 * ## 凭证口径（需财务确认，见 `server/common/tax/return-rules.ts`）
 *
 * - 采购退货：借 2202 应付账款（含税）/ 贷 1403 原材料（净额）+ 贷 222102 进项税额
 * - 销售退货：借 6001 主营业务收入（净额）+ 借 222101 销项税额 / 贷 1122 应收账款（含税）
 * - 销售退货**不自动红冲成本**（商品是否回库可用需业务判定）
 *
 * 唯一约束兜底：
 * - `uq_pur_return_ap_bill`：同一验收批次（应付单）只允许一张未作废退货单；
 * - `uq_pur_return_voucher_ref` / `uq_sales_return_voucher_ref`：一单只能出一张红字凭证。
 */

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function periodOf(date: string): string {
  return date.slice(0, 7);
}

@Injectable()
export class ReturnService {
  private readonly logger = new Logger(ReturnService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService
  ) {}

  /* ========== 可退数量 ========== */

  /**
   * 可退数量查询。同一订单可能有多次退货，必须把**未作废**退货单的数量全减掉。
   * 作废的退货单不占用额度（否则作废一次就永久少一次可退机会）。
   */
  async returnable(orderId: string): Promise<ReturnableQuantityResult> {
    const orderRows = await this.db
      .select({
        id: purOrder.id,
        code: purOrder.code,
        itemName: purOrder.itemName,
        quantity: purOrder.quantity,
        acceptedQuantity: purOrder.acceptedQuantity,
        unitPrice: purOrder.unitPrice,
        taxRate: purOrder.taxRate,
        supplierId: purOrder.supplierId,
        supplierName: mdSupplier.name,
        projectId: purOrder.projectId,
      })
      .from(purOrder)
      .leftJoin(mdSupplier, eq(purOrder.supplierId, mdSupplier.id))
      .where(eq(purOrder.id, orderId))
      .limit(1);
    if (orderRows.length === 0) throw new NotFoundException('采购订单不存在');
    const order = orderRows[0];

    const returnedRows = await this.db
      .select({
        total: sql<string>`coalesce(sum(${purReturn.returnQuantity}), 0)`,
      })
      .from(purReturn)
      .where(
        and(eq(purReturn.orderId, orderId), sql`${purReturn.status} <> 'void'`)
      );
    const returnedQuantity = Math.trunc(toNumber(returnedRows[0]?.total));

    const result = returnableQuantity({
      quantity: Number(order.quantity ?? 0),
      acceptedQuantity: Number(order.acceptedQuantity ?? 0),
      returnedQuantity,
    });
    return {
      orderId: order.id,
      orderCode: order.code,
      itemName: order.itemName,
      quantity: Math.trunc(Number(order.quantity ?? 0)),
      acceptedQuantity: result.acceptedQuantity,
      returnedQuantity: result.returnedQuantity,
      returnableQuantity: result.returnableQuantity,
      notAccepted: result.notAccepted,
      unitPrice: round2(toNumber(order.unitPrice)),
      taxRate: round2(toNumber(order.taxRate)),
      supplierId: order.supplierId,
      supplierName: order.supplierName,
      projectId: order.projectId,
    };
  }

  /* ========== 采购退货 ========== */

  private purchaseSelect() {
    return this.db
      .select({
        row: purReturn,
        supplierName: mdSupplier.name,
        projectName: erpProject.name,
      })
      .from(purReturn)
      .leftJoin(mdSupplier, eq(purReturn.supplierId, mdSupplier.id))
      .leftJoin(erpProject, eq(purReturn.projectId, erpProject.id));
  }

  private toPurchaseItem(row: {
    row: typeof purReturn.$inferSelect;
    supplierName: string | null;
    projectName: string | null;
  }): PurchaseReturnItem {
    const item = row.row;
    return {
      id: item.id,
      code: item.code,
      orderId: item.orderId,
      orderCode: item.orderCode,
      supplierId: item.supplierId,
      supplierName: row.supplierName,
      projectId: item.projectId,
      projectName: row.projectName,
      returnDate: item.returnDate,
      returnQuantity: Math.trunc(toNumber(item.returnQuantity)),
      amount: round2(toNumber(item.amount)),
      taxRate: item.taxRate === null ? null : round2(toNumber(item.taxRate)),
      netAmount: round2(toNumber(item.netAmount)),
      taxAmount: round2(toNumber(item.taxAmount)),
      apBillId: item.apBillId,
      redInvoiceId: item.redInvoiceId,
      status: item.status as ReturnStatus,
      reason: item.reason,
      remark: item.remark,
      voucherRef: item.voucherRef,
      createdByUser: item.createdByUser,
      approvedBy: item.approvedBy,
      submittedAt: item.submittedAt?.toISOString() ?? null,
      approvedAt: item.approvedAt?.toISOString() ?? null,
      completedAt: item.completedAt?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
    };
  }

  async listPurchaseReturns(
    params: PurchaseReturnListParams
  ): Promise<PagedResult<PurchaseReturnItem>> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 200);
    const conditions = [];
    if (params.status) conditions.push(eq(purReturn.status, params.status));
    if (params.orderId) conditions.push(eq(purReturn.orderId, params.orderId));
    if (params.supplierId) {
      conditions.push(eq(purReturn.supplierId, params.supplierId));
    }
    if (params.projectId) {
      conditions.push(eq(purReturn.projectId, params.projectId));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const totalRows = await this.db
      .select({ total: count() })
      .from(purReturn)
      .where(where);
    const rows = await this.purchaseSelect()
      .where(where)
      .orderBy(desc(purReturn.returnDate), desc(purReturn.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: rows.map((row) => this.toPurchaseItem(row)),
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  async getPurchaseReturn(id: string): Promise<PurchaseReturnItem> {
    const rows = await this.purchaseSelect()
      .where(eq(purReturn.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('采购退货单不存在');
    return this.toPurchaseItem(rows[0]);
  }

  async createPurchaseReturn(
    dto: CreatePurchaseReturnDto,
    operator: string
  ): Promise<PurchaseReturnItem> {
    const info = await this.returnable(dto.orderId);
    if (info.notAccepted) {
      throw new BadRequestException(
        `订单 ${info.orderCode} 尚未验收，无可退数量（退货基准是已验收数量）`
      );
    }
    const quantity = Math.trunc(dto.returnQuantity);
    if (quantity <= 0) {
      throw new BadRequestException('退货数量必须为大于 0 的整数');
    }
    if (quantity > info.returnableQuantity) {
      throw new BadRequestException(
        `退货数量 ${quantity} 超过可退数量 ${info.returnableQuantity}` +
          `（已验收 ${info.acceptedQuantity}，已退 ${info.returnedQuantity}）`
      );
    }
    const unitPrice = dto.unitPrice ?? info.unitPrice;
    const { amount, netAmount, taxAmount } = returnAmount({
      unitPrice,
      quantity,
      taxRate: info.taxRate,
    });
    const code = await generateBizCode(
      this.db,
      purReturn,
      purReturn.code,
      'PRT',
      new Date(),
      { bizType: 'PUR_RETURN' }
    );
    try {
      const inserted = await this.db
        .insert(purReturn)
        .values({
          code,
          orderId: dto.orderId,
          orderCode: info.orderCode,
          supplierId: info.supplierId,
          projectId: info.projectId,
          returnDate: dto.returnDate,
          returnQuantity: quantity,
          amount: String(amount),
          taxRate: String(info.taxRate),
          netAmount: String(netAmount),
          taxAmount: String(taxAmount),
          apBillId: dto.apBillId ?? null,
          status: 'draft',
          reason: dto.reason ?? null,
          remark: dto.remark ?? null,
          createdByUser: operator,
        })
        .returning({ id: purReturn.id });
      this.logger.log(
        `采购退货建单 ${code} 订单=${info.orderCode} 数量=${quantity} 金额=${amount}`
      );
      return this.getPurchaseReturn(inserted[0].id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('uq_pur_return_ap_bill')) {
        throw new ConflictException(
          '该验收批次（应付单）已存在未作废的退货单，请先处理原退货单'
        );
      }
      throw error;
    }
  }

  async purchaseReturnAction(
    id: string,
    dto: ReturnActionDto,
    operator: string
  ): Promise<PurchaseReturnItem> {
    const current = await this.getPurchaseReturn(id);
    const errors = validateReturnAction(current.status, dto.action);
    if (errors.length > 0) throw new BadRequestException(errors.join('；'));

    // 完成前再校验一次可退数量：建单后可能又有别的退货单占用了额度
    if (dto.action === 'complete') {
      const info = await this.returnable(current.orderId);
      // 本单自身的数量也要算进"已退"，因此比较时加回来
      const usedByOthers = info.returnedQuantity - current.returnQuantity;
      if (usedByOthers + current.returnQuantity > info.acceptedQuantity) {
        throw new BadRequestException(
          `完成退货将导致累计退货 ${usedByOthers + current.returnQuantity} ` +
            `超过已验收 ${info.acceptedQuantity}，请先核对其他退货单`
        );
      }
    }

    const target = await this.applyPurchaseAction(
      current,
      dto.action,
      dto.remark ?? null,
      operator
    );
    return target;
  }

  private async applyPurchaseAction(
    current: PurchaseReturnItem,
    action: ReturnAction,
    remark: string | null,
    operator: string
  ): Promise<PurchaseReturnItem> {
    const now = new Date();
    const patch: Record<string, unknown> = { updatedAt: now };

    if (action === 'submit') {
      patch.status = 'submitted';
      patch.submittedAt = now;
    } else if (action === 'approve') {
      patch.status = 'approved';
      patch.approvedAt = now;
      patch.approvedBy = operator;
    } else if (action === 'reject') {
      patch.status = 'draft';
      patch.approvedAt = null;
      patch.approvedBy = null;
    } else if (action === 'void') {
      patch.status = 'void';
    } else if (action === 'complete') {
      // 红字凭证：失败进补偿队列，业务状态照常推进
      const lines = purchaseReturnLines(current.netAmount, current.taxAmount);
      if (!isBalanced(lines)) {
        throw new BadRequestException(
          `退货分录借贷不平（借 ${lines.reduce((s, l) => s + (l.debit ?? 0), 0)} / ` +
            `贷 ${lines.reduce((s, l) => s + (l.credit ?? 0), 0)}），请检查金额`
        );
      }
      const sourceRef = `purchase-return:${current.code}`;
      const voucherResult = await this.voucherHookService.generateVoucherDraft({
        sourceType: 'purchase_return',
        sourceRef,
        voucherDate: current.returnDate,
        summary: `采购退货 ${current.orderCode ?? ''} ${current.code}`.trim(),
        lines,
      });
      if (voucherResult === 'failed') {
        await this.voucherHookService.recordCompensation(
          'purchase_return',
          sourceRef,
          `采购退货红字凭证生成失败 ${current.code}`,
          lines,
          current.returnDate
        );
      }
      patch.status = 'completed';
      patch.completedAt = now;
      patch.voucherRef = voucherResult === 'created' ? sourceRef : null;
    }

    if (remark) patch.remark = remark;
    await this.db.update(purReturn).set(patch).where(eq(purReturn.id, current.id));
    this.logger.log(
      `采购退货 ${current.code} ${current.status}→${action} by=${operator}`
    );
    return this.getPurchaseReturn(current.id);
  }

  /* ========== 销售退货 ========== */

  private salesSelect() {
    return this.db
      .select({
        row: salesReturn,
        customerName: mdCustomer.name,
        projectName: erpProject.name,
      })
      .from(salesReturn)
      .leftJoin(mdCustomer, eq(salesReturn.customerId, mdCustomer.id))
      .leftJoin(erpProject, eq(salesReturn.projectId, erpProject.id));
  }

  private toSalesItem(row: {
    row: typeof salesReturn.$inferSelect;
    customerName: string | null;
    projectName: string | null;
  }): SalesReturnItem {
    const item = row.row;
    return {
      id: item.id,
      code: item.code,
      revenueId: item.revenueId,
      revenueCode: item.revenueCode,
      contractId: item.contractId,
      customerId: item.customerId,
      customerName: row.customerName,
      projectId: item.projectId,
      projectName: row.projectName,
      returnDate: item.returnDate,
      amount: round2(toNumber(item.amount)),
      taxRate: item.taxRate === null ? null : round2(toNumber(item.taxRate)),
      netAmount: round2(toNumber(item.netAmount)),
      taxAmount: round2(toNumber(item.taxAmount)),
      redInvoiceId: item.redInvoiceId,
      revenueAdjustId: item.revenueAdjustId,
      status: item.status as ReturnStatus,
      reason: item.reason,
      remark: item.remark,
      voucherRef: item.voucherRef,
      createdByUser: item.createdByUser,
      approvedBy: item.approvedBy,
      submittedAt: item.submittedAt?.toISOString() ?? null,
      approvedAt: item.approvedAt?.toISOString() ?? null,
      completedAt: item.completedAt?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
    };
  }

  async listSalesReturns(
    params: SalesReturnListParams
  ): Promise<PagedResult<SalesReturnItem>> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 200);
    const conditions = [];
    if (params.status) conditions.push(eq(salesReturn.status, params.status));
    if (params.revenueId) {
      conditions.push(eq(salesReturn.revenueId, params.revenueId));
    }
    if (params.customerId) {
      conditions.push(eq(salesReturn.customerId, params.customerId));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const totalRows = await this.db
      .select({ total: count() })
      .from(salesReturn)
      .where(where);
    const rows = await this.salesSelect()
      .where(where)
      .orderBy(desc(salesReturn.returnDate), desc(salesReturn.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: rows.map((row) => this.toSalesItem(row)),
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  async getSalesReturn(id: string): Promise<SalesReturnItem> {
    const rows = await this.salesSelect()
      .where(eq(salesReturn.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('销售退货单不存在');
    return this.toSalesItem(rows[0]);
  }

  /**
   * 销售退货建单。
   *
   * **超额校验**：退货含税金额不得超过该收入确认单的金额减去已退金额。
   * 与采购退货同理——不校验就会把收入冲成负数。
   */
  async createSalesReturn(
    dto: CreateSalesReturnDto,
    operator: string
  ): Promise<SalesReturnItem> {
    const revenueRows = await this.db
      .select({
        id: erpProjectRevenue.id,
        code: erpProjectRevenue.code,
        amount: erpProjectRevenue.amount,
        status: erpProjectRevenue.status,
        contractId: erpProjectRevenue.contractId,
        projectId: erpProjectRevenue.projectId,
      })
      .from(erpProjectRevenue)
      .where(eq(erpProjectRevenue.id, dto.revenueId))
      .limit(1);
    if (revenueRows.length === 0) throw new NotFoundException('收入确认单不存在');
    const revenue = revenueRows[0];

    const returnedRows = await this.db
      .select({
        total: sql<string>`coalesce(sum(${salesReturn.amount}), 0)`,
      })
      .from(salesReturn)
      .where(
        and(
          eq(salesReturn.revenueId, dto.revenueId),
          sql`${salesReturn.status} <> 'void'`
        )
      );
    const returnedAmount = round2(toNumber(returnedRows[0]?.total));
    const revenueAmount = round2(toNumber(revenue.amount));
    const amount = round2(dto.amount);
    if (amount <= 0) {
      throw new BadRequestException('退货金额必须大于 0');
    }
    if (amount + returnedAmount > revenueAmount) {
      throw new BadRequestException(
        `退货金额 ${amount} 超过可退金额 ${round2(revenueAmount - returnedAmount)}` +
          `（收入确认 ${revenueAmount}，已退 ${returnedAmount}）`
      );
    }
    // 税率优先取入参，缺省沿用 6%（与收入确认默认税率一致）
    const taxRate = dto.taxRate ?? 6;
    const netAmount = round2((amount * 100) / (100 + taxRate));
    const taxAmount = round2(amount - netAmount);

    const code = await generateBizCode(
      this.db,
      salesReturn,
      salesReturn.code,
      'SRT',
      new Date(),
      { bizType: 'SALES_RETURN' }
    );
    const inserted = await this.db
      .insert(salesReturn)
      .values({
        code,
        revenueId: dto.revenueId,
        revenueCode: revenue.code,
        contractId: revenue.contractId,
        projectId: revenue.projectId,
        returnDate: dto.returnDate,
        amount: String(amount),
        taxRate: String(taxRate),
        netAmount: String(netAmount),
        taxAmount: String(taxAmount),
        status: 'draft',
        reason: dto.reason ?? null,
        remark: dto.remark ?? null,
        createdByUser: operator,
      })
      .returning({ id: salesReturn.id });
    this.logger.log(
      `销售退货建单 ${code} 收入=${revenue.code} 金额=${amount}`
    );
    return this.getSalesReturn(inserted[0].id);
  }

  async salesReturnAction(
    id: string,
    dto: ReturnActionDto,
    operator: string
  ): Promise<SalesReturnItem> {
    const current = await this.getSalesReturn(id);
    const errors = validateReturnAction(current.status, dto.action);
    if (errors.length > 0) throw new BadRequestException(errors.join('；'));

    const now = new Date();
    const patch: Record<string, unknown> = { updatedAt: now };

    if (dto.action === 'submit') {
      patch.status = 'submitted';
      patch.submittedAt = now;
    } else if (dto.action === 'approve') {
      patch.status = 'approved';
      patch.approvedAt = now;
      patch.approvedBy = operator;
    } else if (dto.action === 'reject') {
      patch.status = 'draft';
      patch.approvedAt = null;
      patch.approvedBy = null;
    } else if (dto.action === 'void') {
      patch.status = 'void';
    } else if (dto.action === 'complete') {
      const lines = salesReturnLines(current.netAmount, current.taxAmount);
      if (!isBalanced(lines)) {
        throw new BadRequestException('销售退货分录借贷不平，请检查金额');
      }
      const sourceRef = `sales-return:${current.code}`;
      const voucherResult = await this.voucherHookService.generateVoucherDraft({
        sourceType: 'sales_return',
        sourceRef,
        voucherDate: current.returnDate,
        summary: `销售退货 ${current.revenueCode ?? ''} ${current.code}`.trim(),
        lines,
      });
      if (voucherResult === 'failed') {
        await this.voucherHookService.recordCompensation(
          'sales_return',
          sourceRef,
          `销售退货红字凭证生成失败 ${current.code}`,
          lines,
          current.returnDate
        );
      }
      patch.status = 'completed';
      patch.completedAt = now;
      patch.voucherRef = voucherResult === 'created' ? sourceRef : null;
    }
    if (dto.remark) patch.remark = dto.remark;

    await this.db
      .update(salesReturn)
      .set(patch)
      .where(eq(salesReturn.id, current.id));
    this.logger.log(
      `销售退货 ${current.code} ${current.status}→${dto.action} by=${operator}`
    );
    return this.getSalesReturn(current.id);
  }

  /* ========== 台账 ========== */

  /** 退货台账：采购与销售分别按状态汇总 */
  async register(): Promise<ReturnRegisterResult> {
    const [purchaseRows, salesRows] = await Promise.all([
      this.db
        .select({ status: purReturn.status, amount: purReturn.amount })
        .from(purReturn),
      this.db
        .select({ status: salesReturn.status, amount: salesReturn.amount })
        .from(salesReturn),
    ]);
    const summarise = (
      rows: Array<{ status: string | null; amount: string | null }>
    ) => {
      const byStatus = RETURN_STATUSES.map((status) => {
        const matched = rows.filter((row) => (row.status ?? 'draft') === status);
        return {
          status,
          count: matched.length,
          amount: round2(matched.reduce((sum, r) => sum + toNumber(r.amount), 0)),
        };
      });
      return {
        byStatus,
        totalAmount: round2(rows.reduce((sum, r) => sum + toNumber(r.amount), 0)),
        completedAmount: round2(
          rows
            .filter((row) => (row.status ?? 'draft') === 'completed')
            .reduce((sum, r) => sum + toNumber(r.amount), 0)
        ),
      };
    };
    return { purchase: summarise(purchaseRows), sales: summarise(salesRows) };
  }

  /** 状态与动作字典（前端不硬编码状态机） */
  dictionaries(): {
    statuses: Array<{ value: ReturnStatus; label: string }>;
    actions: Array<{ value: ReturnAction; label: string; target: ReturnStatus }>;
  } {
    return {
      statuses: RETURN_STATUSES.map((value) => ({
        value,
        label: RETURN_STATUS_LABELS[value],
      })),
      actions: (
        ['submit', 'approve', 'reject', 'complete', 'void'] as ReturnAction[]
      ).map((value) => ({
        value,
        label: RETURN_ACTION_LABELS[value],
        target:
          value === 'submit'
            ? 'submitted'
            : value === 'approve'
              ? 'approved'
              : value === 'reject'
                ? 'draft'
                : value === 'complete'
                  ? 'completed'
                  : 'void',
      })),
    };
  }

  /** 退货对项目成本的影响（采购退货应冲减项目成本，供项目详情页展示提示） */
  async projectImpact(projectId: string): Promise<{
    purchaseReturnedAmount: number;
    salesReturnedAmount: number;
    costAmount: number;
  }> {
    const [purchaseRows, salesRows, costRows] = await Promise.all([
      this.db
        .select({ total: sql<string>`coalesce(sum(${purReturn.amount}), 0)` })
        .from(purReturn)
        .where(
          and(eq(purReturn.projectId, projectId), inArray(purReturn.status, ['completed']))
        ),
      this.db
        .select({ total: sql<string>`coalesce(sum(${salesReturn.amount}), 0)` })
        .from(salesReturn)
        .where(
          and(
            eq(salesReturn.projectId, projectId),
            inArray(salesReturn.status, ['completed'])
          )
        ),
      this.db
        .select({ total: sql<string>`coalesce(sum(${erpProjectCost.amount}), 0)` })
        .from(erpProjectCost)
        .where(eq(erpProjectCost.projectId, projectId)),
    ]);
    return {
      purchaseReturnedAmount: round2(toNumber(purchaseRows[0]?.total)),
      salesReturnedAmount: round2(toNumber(salesRows[0]?.total)),
      costAmount: round2(toNumber(costRows[0]?.total)),
    };
  }

  /** 期间归属（凭证期间由 return_date 派生，暴露给前端展示，避免前端自己算） */
  periodOfReturn(returnDate: string): string {
    return periodOf(returnDate);
  }
}
