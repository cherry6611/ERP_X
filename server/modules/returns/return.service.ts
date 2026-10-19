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
  erpApBill,
  erpContract,
  erpProject,
  erpProjectCost,
  erpProjectRevenue,
  finVoucher,
  finVoucherLine,
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
  salesReturnCostLines,
  salesReturnLines,
  validateReturnAction,
  type ReturnAction,
  type ReturnStatus,
} from '@server/common/tax/return-rules';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
// P0-D：销售退货同步登记红字发票（负数发票），让增值税底稿的销项口径随之冲减
import { InvoiceService } from '@server/modules/finance/invoice.service';
import { ACCOUNT_ADMIN_EXPENSE, ACCOUNT_AP, ACCOUNT_VAT_INPUT } from '@server/common/tax/account-codes';
import { round2 } from '@server/common/utils/number';
import {
  DEFAULT_SALES_RETURN_TAX_RATE,
  checkReturnAmount,
  salesReturnTaxSplit,
  toNumber,
} from './sales-return-rules';
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
 * - 采购退货：借 2202 应付账款（含税）/ 贷 {原采购净额科目}（净额）+ 贷 222102 进项税额。
 *   净额科目与原采购入账科目镜像（T-S4）：费用化 6602、设备资本化 1601，见
 *   `resolvePurchaseNetAccount`；查不到原凭证时回落 6602 并 warn。
 * - 销售退货：借 6001 主营业务收入（净额）+ 借 222101 销项税额 / 贷 1122 应收账款（含税）
 * - 销售退货**不自动红冲成本**（商品是否回库可用需业务判定）
 *
 * 唯一约束兜底：
 * - `uq_pur_return_ap_bill`：同一验收批次（应付单）只允许一张未作废退货单；
 * - `uq_pur_return_voucher_ref` / `uq_sales_return_voucher_ref`：一单只能出一张红字凭证。
 */


function periodOf(date: string): string {
  return date.slice(0, 7);
}

@Injectable()
export class ReturnService {
  private readonly logger = new Logger(ReturnService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService,
    // P0-D：红字发票登记（增值税申报口径必须与账务同步冲减）
    private readonly invoiceService: InvoiceService
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
      // T-S4：退货冲减的净额科目必须与原采购入账科目镜像——
      // 费用化采购借方是 6602、设备资本化是 1601，一律贷 1403 会造成
      // 「费用只借不冲 + 库存变负数」的双重错配。
      const netAccountCode = await this.resolvePurchaseNetAccount(current.apBillId);
      if (!netAccountCode) {
        this.logger.warn(
          `采购退货 ${current.code} 未反查到原采购凭证净额科目` +
            `（apBillId=${current.apBillId ?? 'null'}），回落 ${ACCOUNT_ADMIN_EXPENSE} 管理费用，请人工核对`
        );
      }
      const lines = purchaseReturnLines(current.netAmount, current.taxAmount, {
        netAccountCode: netAccountCode ?? ACCOUNT_ADMIN_EXPENSE,
      });
      if (!isBalanced(lines)) {
        throw new BadRequestException(
          `退货分录借贷不平（借 ${lines.reduce((s, l) => s + (l.debit ?? 0), 0)} / ` +
            `贷 ${lines.reduce((s, l) => s + (l.credit ?? 0), 0)}），请检查金额`
        );
      }
      const sourceRef = `purchase-return:${current.code}`;
      await this.voucherHookService.reserveCompensation(this.db, {
        sourceType: 'purchase_return',
        sourceRef,
        voucherDate: current.returnDate,
        summary: `采购退货 ${current.orderCode ?? ''} ${current.code}`.trim(),
        lines,
      }, `采购退货红字凭证待生成 ${current.code}`);
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

  /**
   * T-S4：反查原采购入账的**净额借方科目**（退货贷方必须与它镜像）。
   *
   * 链路：`pur_return.ap_bill_id` → `erp_ap_bill.code` →
   * 凭证（`source_type='ap'` 且 `source_ref='ap:{code}'`，采购验收/应付登记的
   * 幂等键）→ 借方行中排除 2202 应付与 222102 进项税后的净额科目。
   *
   * 为什么必须反查凭证而不是推判定：采购验收按是否建卡分叉——
   * `inputIssueLines` 借方 6602（费用化）、`inputCapitalizeLines` 借方 1601
   * （设备资本化），`pur_order` 表上没有标记位，只有凭证是权威记录。
   *
   * 返回 null 的两种情形：① 退货单未关联应付单（手工建单）；
   * ② 原凭证尚未生成（失败进了补偿队列）。由调用方回落默认科目并 warn。
   */
  private async resolvePurchaseNetAccount(
    apBillId: string | null
  ): Promise<string | null> {
    if (!apBillId) return null;
    const billRows = await this.db
      .select({ code: erpApBill.code })
      .from(erpApBill)
      .where(eq(erpApBill.id, apBillId))
      .limit(1);
    const apCode = billRows[0]?.code;
    if (!apCode) return null;
    const voucherRows = await this.db
      .select({ id: finVoucher.id })
      .from(finVoucher)
      .where(
        and(
          eq(finVoucher.sourceType, 'ap'),
          eq(finVoucher.sourceRef, `ap:${apCode}`)
        )
      )
      .orderBy(desc(finVoucher.createdAt))
      .limit(1);
    const voucherId = voucherRows[0]?.id;
    if (!voucherId) return null;
    const lineRows = await this.db
      .select({
        accountCode: finVoucherLine.accountCode,
        debit: finVoucherLine.debit,
      })
      .from(finVoucherLine)
      .where(eq(finVoucherLine.voucherId, voucherId));
    // 净额借方行 = 有发生额、且既不是应付（2202，退货借方冲它）
    // 也不是进项税（222102，退货单独贷方冲它）的借方行
    const netLine = lineRows.find(
      (line) =>
        Number(line.debit ?? 0) > 0 &&
        line.accountCode !== ACCOUNT_AP &&
        line.accountCode !== ACCOUNT_VAT_INPUT
    );
    return netLine?.accountCode ?? null;
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
      disposalType: item.disposalType === 'scrap' ? 'scrap' : 'restock',
      costAmount: round2(toNumber(item.costAmount)),
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
    /*
     * §5.9：累计可退额度闸门与价税分离已抽到 `./sales-return-rules`
     * （纯函数 + 23 条断言）。价税分离改走权威 `splitTax` —— 原先这里自己写了一遍
     * `round2(amount*100/(100+rate))`，实测与权威口径在 50 组上结果相同，
     * 所以是**消除副本**而不是纠错。
     */
    const amountCheck = checkReturnAmount({
      amount: dto.amount,
      revenueAmount,
      alreadyReturnedAmount: returnedAmount,
    });
    if (!amountCheck.ok) throw new BadRequestException(amountCheck.message);
    const amount = amountCheck.amount;
    /*
     * ⚠️ 落库的 `taxRate` 必须是**实际用到的那个值**（缺省 6%），不能存 null ——
     * 否则退货单上显示"税率未指定"，而净/税额是按 6% 算出来的，二者对不上。
     * 所以这里显式再取一次默认（与 `salesReturnTaxSplit` 用的是同一个常量）。
     */
    const taxRate = dto.taxRate ?? DEFAULT_SALES_RETURN_TAX_RATE;
    const { netAmount, taxAmount } = salesReturnTaxSplit({
      amount,
      taxRate,
    });

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
      // 逐单确定退货商品的处置方式：回库（借 1403）还是报废（借 6602）。
      // 未显式指定时沿用退货单上已有的值（默认 restock），不替业务做假设。
      const disposal: 'restock' | 'scrap' =
        dto.disposalType === 'scrap' || dto.disposalType === 'restock'
          ? dto.disposalType
          : current.disposalType === 'scrap'
            ? 'scrap'
            : 'restock';
      const costAmount = await this.resolveSalesReturnCost(current);
      const lines = [
        ...salesReturnLines(current.netAmount, current.taxAmount),
        ...salesReturnCostLines(costAmount, disposal),
      ];
      if (!isBalanced(lines)) {
        throw new BadRequestException('销售退货分录借贷不平，请检查金额');
      }
      if (costAmount <= 0) {
        this.logger.warn(
          `销售退货 ${current.code} 未算出可冲回成本（项目无收入或成本数据），仅生成收入红冲分录`
        );
      }
      const sourceRef = `sales-return:${current.code}`;
      await this.voucherHookService.reserveCompensation(this.db, {
        sourceType: 'sales_return',
        sourceRef,
        voucherDate: current.returnDate,
        summary: `销售退货 ${current.revenueCode ?? ''} ${current.code}`.trim(),
        lines,
      }, `销售退货红字凭证待生成 ${current.code}`);
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
      /*
       * P0-D（T4）：**同步登记红字发票**。
       *
       * 原先退货只生成红字凭证（借 6001 / 借 222101 / 贷 1122，分录方向正确），
       * 而增值税底稿的销项 **100% 来自 `erp_invoice` 台账**
       * （只取 `direction='sales' AND status='issued'`）。于是：
       *   · **申报口径不冲减** → 多缴增值税；
       *   · **账表永久差异** → 底稿每月必然报 `output_mismatch`，
       *     长期噪声把真实异常淹没（告警疲劳）。
       *
       * 红字发票用**负数**金额登记，底稿的 `sum()` 天然把它算作冲减，
       * 不需要在底稿里为退货写任何特例分支。
       *
       * 幂等：`sourceRef` 与凭证共用同一 `sales-return:<单号>`，
       * `createRedLetterInvoice` 内部按该键查重（且有部分唯一索引兜底），
       * 因此 `complete` 被重试不会重复冲减。
       */
      let redLetterInvoiceId: string | null = null;
      try {
        const detail = await this.getSalesReturn(current.id);
        const invoice = await this.invoiceService.createRedLetterInvoice({
          direction: 'sales',
          amount: detail.amount,
          // 税率与 `salesReturnLines(current.netAmount, current.taxAmount)` 同源：
          // 红字发票的销项税额必须与红字凭证的 222101 金额一致，否则"票账"又对不上。
          // `SalesReturnItem.taxRate` 类型上可空（历史兼容），库里 `tax_rate` 是
          // notNull，因此这里的 `?? 0` 只是类型收窄，不会改变实际取值。
          taxRate: current.taxRate ?? 0,
          sourceRef,
          invoiceDate: current.returnDate,
          contractId: detail.contractId ?? null,
          projectId: detail.projectId ?? null,
          remark: `销售退货红字发票（冲减 ${detail.revenueCode ?? current.code}）`,
        });
        redLetterInvoiceId = invoice.id;
      } catch (error: unknown) {
        // 红字发票登记失败**不阻断退货完成**：凭证已出、货已退，业务不应被卡住。
        // 但必须留痕 —— 这是"账表差异"的来源，靠日志与底稿差异项双重暴露。
        this.logger.error(
          `销售退货 ${current.code} 红字发票登记失败：${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      patch.status = 'completed';
      patch.completedAt = now;
      patch.voucherRef = voucherResult === 'created' ? sourceRef : null;
      patch.disposalType = disposal;
      patch.costAmount = String(costAmount);
      // 红字发票 ID 落库：前端与对账需要从退货单直接跳到那张负数发票。
      // 该字段原本就存在（`SalesReturnItem.redInvoiceId`）却从未被写入 ——
      // 这也是"退货不开红字发票"这个缺口留下的痕迹。
      if (redLetterInvoiceId) patch.redInvoiceId = redLetterInvoiceId;
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

  /**
   * 按含税收入占比分摊项目成本，算出本次退货应冲回的成本。
   *
   *   退货成本 = 项目累计成本 × (退货净额 / 项目累计净收入)
   *
   * 净收入口径与 `projects.service.ts getAccounting()` 完全一致（按合同税率拆税），
   * 避免同一项目在"毛利"和"退货成本"两处出现两套收入口径。
   *
   * 无项目、无成本或无收入数据时返回 0 —— 此时**不生成成本行**，
   * 由调用方记录告警，而不是用一个猜出来的金额去凑平报表。
   */
  private async resolveSalesReturnCost(row: {
    projectId: string | null;
    revenueId: string | null;
    netAmount: number;
  }): Promise<number> {
    let projectId = row.projectId;
    if (!projectId && row.revenueId) {
      const revenueRows = await this.db
        .select({ projectId: erpProjectRevenue.projectId })
        .from(erpProjectRevenue)
        .where(eq(erpProjectRevenue.id, row.revenueId))
        .limit(1);
      projectId = revenueRows[0]?.projectId ?? null;
    }
    if (!projectId || row.netAmount <= 0) return 0;

    const revenueRows = await this.db
      .select({
        total: sql<string>`coalesce(sum(
          coalesce(${erpProjectRevenue.amount}, 0) * 100.0
          / (100.0 + coalesce(${erpContract.taxRate}, 6))
        ), 0)`,
      })
      .from(erpProjectRevenue)
      .leftJoin(erpContract, eq(erpProjectRevenue.contractId, erpContract.id))
      .where(
        and(
          eq(erpProjectRevenue.projectId, projectId),
          eq(erpProjectRevenue.status, 'recognized')
        )
      );
    const costRows = await this.db
      .select({ total: sql<string>`coalesce(sum(${erpProjectCost.amount}), 0)` })
      .from(erpProjectCost)
      .where(eq(erpProjectCost.projectId, projectId));
    const netRevenue = Number(revenueRows[0]?.total ?? 0);
    const totalCost = Number(costRows[0]?.total ?? 0);
    if (netRevenue <= 0 || totalCost <= 0) return 0;
    const share = Math.min(1, row.netAmount / netRevenue);
    // 统一走 round2：本地 `Math.round(x*100)/100` 对负数量（红冲）取整不对称，
    // 会导致「原单 + 红冲」成本合计差 1 分（见 shared/number.ts 口径说明）。
    return round2(totalCost * share);
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
