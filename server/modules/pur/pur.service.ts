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
import { and, count, desc, eq, ne, sum } from 'drizzle-orm';
import {
  astAsset,
  erpApBill,
  erpContract,
  erpProject,
  erpProjectCost,
  hrDepartment,
  mdSupplier,
  purOrder,
  purRequest,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { inputIssueLines } from '@server/common/tax/posting';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { isVatRate } from '@shared/tax';
import type {
  AcceptPurOrderDto,
  CreatePurOrderDto,
  CreatePurRequestDto,
  PagedResult,
  PurChainSummary,
  PurOrderItem,
  PurOrderStatus,
  PurRequestAction,
  PurRequestItem,
  PurRequestStatus,
  UpdatePurOrderDto,
} from '@shared/api.interface';

interface PurRequestRow {
  id: string;
  code: string;
  title: string;
  requestType: string | null;
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  amount: string | null;
  expectDate: string | null;
  status: string | null;
  reason: string | null;
  remark: string | null;
  createdAt: Date;
}

interface PurOrderRow {
  id: string;
  code: string;
  requestId: string | null;
  requestCode: string | null;
  contractId: string | null;
  contractName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  projectId: string | null;
  projectName: string | null;
  itemName: string;
  category: string | null;
  quantity: number | null;
  unitPrice: string | null;
  amount: string | null;
  taxRate: string | null;
  orderDate: string | null;
  acceptedQuantity: number | null;
  acceptDate: string | null;
  status: string | null;
  remark: string | null;
  createdAt: Date;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

@Injectable()
export class PurService {
  private readonly logger = new Logger(PurService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService,
    private readonly taxResolver: TaxResolverService
  ) {}

  private toRequestItem(row: PurRequestRow): PurRequestItem {
    return {
      id: row.id,
      code: row.code,
      title: row.title,
      requestType: (row.requestType ?? 'service') as PurRequestItem['requestType'],
      departmentId: row.departmentId,
      departmentName: row.departmentName,
      projectId: row.projectId,
      projectName: row.projectName,
      supplierId: row.supplierId,
      supplierName: row.supplierName,
      amount: Number(row.amount ?? 0),
      expectDate: row.expectDate,
      status: (row.status ?? 'pending') as PurRequestStatus,
      reason: row.reason,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toOrderItem(row: PurOrderRow): PurOrderItem {
    return {
      id: row.id,
      code: row.code,
      requestId: row.requestId,
      requestCode: row.requestCode,
      contractId: row.contractId,
      contractName: row.contractName,
      supplierId: row.supplierId ?? '',
      supplierName: row.supplierName ?? '',
      projectId: row.projectId,
      projectName: row.projectName,
      itemName: row.itemName,
      category: (row.category ?? 'service') as PurOrderItem['category'],
      quantity: row.quantity ?? 0,
      unitPrice: Number(row.unitPrice ?? 0),
      amount: Number(row.amount ?? 0),
      taxRate: row.taxRate != null ? Number(row.taxRate) : null,
      orderDate: row.orderDate,
      acceptedQuantity: row.acceptedQuantity ?? 0,
      acceptDate: row.acceptDate,
      status: (row.status ?? 'pending') as PurOrderStatus,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private normalizePaging(page?: number, pageSize?: number): {
    page: number;
    pageSize: number;
  } {
    const p = page && page > 0 ? Math.floor(page) : 1;
    const size =
      pageSize && pageSize > 0
        ? Math.min(Math.floor(pageSize), MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;
    return { page: p, pageSize: size };
  }

  /* ========== 采购申请 ========== */

  async listRequests(params: {
    page?: number;
    pageSize?: number;
    status?: string;
    projectId?: string;
  }): Promise<PagedResult<PurRequestItem>> {
    const { page, pageSize } = this.normalizePaging(params.page, params.pageSize);
    const conditions = [];
    if (params.status) conditions.push(eq(purRequest.status, params.status));
    if (params.projectId) conditions.push(eq(purRequest.projectId, params.projectId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(purRequest)
      .where(where);
    const rows: PurRequestRow[] = await this.db
      .select({
        id: purRequest.id,
        code: purRequest.code,
        title: purRequest.title,
        requestType: purRequest.requestType,
        departmentId: purRequest.departmentId,
        departmentName: hrDepartment.name,
        projectId: purRequest.projectId,
        projectName: erpProject.name,
        supplierId: purRequest.supplierId,
        supplierName: mdSupplier.name,
        amount: purRequest.amount,
        expectDate: purRequest.expectDate,
        status: purRequest.status,
        reason: purRequest.reason,
        remark: purRequest.remark,
        createdAt: purRequest.createdAt,
      })
      .from(purRequest)
      .leftJoin(hrDepartment, eq(purRequest.departmentId, hrDepartment.id))
      .leftJoin(erpProject, eq(purRequest.projectId, erpProject.id))
      .leftJoin(mdSupplier, eq(purRequest.supplierId, mdSupplier.id))
      .where(where)
      .orderBy(desc(purRequest.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map((row: PurRequestRow) => this.toRequestItem(row)),
      total: totalRows[0]?.total ?? 0,
      page,
      pageSize,
    };
  }

  async createRequest(dto: CreatePurRequestDto): Promise<PurRequestItem> {
    const code = await generateBizCode(
      this.db,
      purRequest,
      purRequest.code,
      'PR'
    );
    const inserted = await this.db
      .insert(purRequest)
      .values({
        code,
        title: dto.title,
        requestType: dto.requestType,
        departmentId: dto.departmentId,
        projectId: dto.projectId,
        supplierId: dto.supplierId,
        amount: String(dto.amount),
        expectDate: dto.expectDate,
        status: 'pending',
        reason: dto.reason,
        remark: dto.remark,
      })
      .returning({ id: purRequest.id });
    return this.getRequestById(inserted[0].id);
  }

  async requestAction(
    id: string,
    action: PurRequestAction
  ): Promise<PurRequestItem> {
    const rows = await this.db
      .select({ id: purRequest.id, status: purRequest.status })
      .from(purRequest)
      .where(eq(purRequest.id, id));
    if (rows.length === 0) throw new NotFoundException('采购申请不存在');
    if ((rows[0].status ?? 'pending') !== 'pending') {
      throw new BadRequestException('该采购申请已处理，不可重复审批');
    }
    const updated = await this.db
      .update(purRequest)
      .set({
        status: action === 'approve' ? 'approved' : 'rejected',
        updatedAt: new Date(),
      })
      .where(eq(purRequest.id, id))
      .returning({ id: purRequest.id });
    if (updated.length === 0) throw new NotFoundException('采购申请不存在');
    return this.getRequestById(id);
  }

  private async getRequestById(id: string): Promise<PurRequestItem> {
    const rows: PurRequestRow[] = await this.db
      .select({
        id: purRequest.id,
        code: purRequest.code,
        title: purRequest.title,
        requestType: purRequest.requestType,
        departmentId: purRequest.departmentId,
        departmentName: hrDepartment.name,
        projectId: purRequest.projectId,
        projectName: erpProject.name,
        supplierId: purRequest.supplierId,
        supplierName: mdSupplier.name,
        amount: purRequest.amount,
        expectDate: purRequest.expectDate,
        status: purRequest.status,
        reason: purRequest.reason,
        remark: purRequest.remark,
        createdAt: purRequest.createdAt,
      })
      .from(purRequest)
      .leftJoin(hrDepartment, eq(purRequest.departmentId, hrDepartment.id))
      .leftJoin(erpProject, eq(purRequest.projectId, erpProject.id))
      .leftJoin(mdSupplier, eq(purRequest.supplierId, mdSupplier.id))
      .where(eq(purRequest.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('采购申请不存在');
    return this.toRequestItem(rows[0]);
  }

  /* ========== 采购订单 ========== */

  async listOrders(params: {
    page?: number;
    pageSize?: number;
    status?: string;
    supplierId?: string;
  }): Promise<PagedResult<PurOrderItem>> {
    const { page, pageSize } = this.normalizePaging(params.page, params.pageSize);
    const conditions = [];
    if (params.status) conditions.push(eq(purOrder.status, params.status));
    if (params.supplierId) conditions.push(eq(purOrder.supplierId, params.supplierId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(purOrder)
      .where(where);
    const rows: PurOrderRow[] = await this.db
      .select({
        id: purOrder.id,
        code: purOrder.code,
        requestId: purOrder.requestId,
        requestCode: purRequest.code,
        contractId: purOrder.contractId,
        contractName: erpContract.name,
        supplierId: purOrder.supplierId,
        supplierName: mdSupplier.name,
        projectId: purOrder.projectId,
        projectName: erpProject.name,
        itemName: purOrder.itemName,
        category: purOrder.category,
        quantity: purOrder.quantity,
        unitPrice: purOrder.unitPrice,
        amount: purOrder.amount,
        taxRate: purOrder.taxRate,
        orderDate: purOrder.orderDate,
        acceptedQuantity: purOrder.acceptedQuantity,
        acceptDate: purOrder.acceptDate,
        status: purOrder.status,
        remark: purOrder.remark,
        createdAt: purOrder.createdAt,
      })
      .from(purOrder)
      .leftJoin(purRequest, eq(purOrder.requestId, purRequest.id))
      .leftJoin(erpContract, eq(purOrder.contractId, erpContract.id))
      .leftJoin(mdSupplier, eq(purOrder.supplierId, mdSupplier.id))
      .leftJoin(erpProject, eq(purOrder.projectId, erpProject.id))
      .where(where)
      .orderBy(desc(purOrder.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map((row: PurOrderRow) => this.toOrderItem(row)),
      total: totalRows[0]?.total ?? 0,
      page,
      pageSize,
    };
  }

  async createOrder(dto: CreatePurOrderDto): Promise<PurOrderItem> {
    const supplierRows = await this.db
      .select({ id: mdSupplier.id, name: mdSupplier.name, status: mdSupplier.status })
      .from(mdSupplier)
      .where(eq(mdSupplier.id, dto.supplierId));
    if (supplierRows.length === 0) {
      throw new BadRequestException('供应商不存在，无法创建采购订单');
    }
    const supplier = supplierRows[0];
    if ((supplier.status ?? 'active') !== 'active') {
      throw new BadRequestException(
        `供应商 ${supplier.name ?? ''} 当前状态为 ${supplier.status ?? ''}，仅活跃供应商可下单`
      );
    }

    const amount = dto.quantity * dto.unitPrice;
    if (dto.taxRate != null && !isVatRate(dto.taxRate)) {
      throw new BadRequestException(
        `非法税率 ${dto.taxRate}，允许值为 0/1/3/6/9/13`
      );
    }

    if (dto.contractId) {
      const contractRows = await this.db
        .select({ code: erpContract.code, amount: erpContract.amount })
        .from(erpContract)
        .where(eq(erpContract.id, dto.contractId));
      if (contractRows.length === 0) {
        throw new BadRequestException('关联合同不存在，无法创建采购订单');
      }
      const contractAmount = Number(contractRows[0].amount ?? 0);
      const orderedRows = await this.db
        .select({ total: sum(purOrder.amount) })
        .from(purOrder)
        .where(
          and(
            eq(purOrder.contractId, dto.contractId),
            ne(purOrder.status, 'cancelled')
          )
        );
      const orderedAmount = Number(orderedRows[0]?.total ?? 0);
      const cumulative = orderedAmount + amount;
      if (cumulative > contractAmount) {
        throw new BadRequestException(
          `采购订单金额超出合同额度：合同 ${contractRows[0].code} ` +
            `总额 ${contractAmount.toFixed(2)}，已下单 ${orderedAmount.toFixed(2)}，` +
            `本次 ${amount.toFixed(2)}，累计 ${cumulative.toFixed(2)}，` +
            `超出 ${(cumulative - contractAmount).toFixed(2)}`
        );
      }
    }

    const code = await generateBizCode(this.db, purOrder, purOrder.code, 'PO');
    const inserted = await this.db
      .insert(purOrder)
      .values({
        code,
        requestId: dto.requestId,
        contractId: dto.contractId,
        supplierId: dto.supplierId,
        projectId: dto.projectId,
        itemName: dto.itemName,
        category: dto.category,
        quantity: dto.quantity,
        unitPrice: String(dto.unitPrice),
        amount: String(amount),
        taxRate: dto.taxRate != null ? String(dto.taxRate) : null,
        orderDate: dto.orderDate,
        status: 'pending',
        remark: dto.remark,
      })
      .returning({ id: purOrder.id });
    return this.getOrderById(inserted[0].id);
  }

  async updateOrder(id: string, dto: UpdatePurOrderDto): Promise<PurOrderItem> {
    const rows = await this.db
      .select({ id: purOrder.id, status: purOrder.status })
      .from(purOrder)
      .where(eq(purOrder.id, id));
    if (rows.length === 0) throw new NotFoundException('采购订单不存在');
    if ((rows[0].status ?? 'pending') !== 'pending') {
      throw new BadRequestException('仅待验收状态的订单可修改');
    }
    if (dto.taxRate != null && !isVatRate(dto.taxRate)) {
      throw new BadRequestException(
        `非法税率 ${dto.taxRate}，允许值为 0/1/3/6/9/13`
      );
    }
    const patch: {
      taxRate?: string | null;
      remark?: string;
      updatedAt: Date;
    } = { updatedAt: new Date() };
    if (dto.taxRate !== undefined) {
      patch.taxRate = dto.taxRate != null ? String(dto.taxRate) : null;
    }
    if (dto.remark !== undefined) {
      patch.remark = dto.remark;
    }
    await this.db.update(purOrder).set(patch).where(eq(purOrder.id, id));
    return this.getOrderById(id);
  }

  async acceptOrder(id: string, dto: AcceptPurOrderDto): Promise<PurOrderItem> {
    if (dto.quantity <= 0) {
      throw new BadRequestException('验收数量必须大于 0');
    }
    const apCode = await generateBizCode(this.db, erpApBill, erpApBill.code, 'APB');
    let voucherAmount = 0;
    let voucherSupplierId = '';
    let voucherTaxRate: number | null = null;
    let acceptDate = new Date().toISOString().slice(0, 10);
    let orderCode = '';

    await this.db.transaction(async (tx) => {
      // T12：事务内 FOR UPDATE，防并发重复验收
      const locked = await tx
        .select()
        .from(purOrder)
        .where(eq(purOrder.id, id))
        .for('update');
      if (locked.length === 0) throw new NotFoundException('采购订单不存在');
      const order = locked[0];
      if ((order.status ?? 'pending') !== 'pending') {
        throw new BadRequestException('仅待验收状态的订单可验收');
      }
      const quantity = order.quantity ?? 0;
      const accepted = order.acceptedQuantity ?? 0;
      const remaining = quantity - accepted;
      if (dto.quantity > remaining) {
        throw new BadRequestException(
          `验收数量超出订单余量：订单数量 ${quantity}，已验收 ${accepted}，` +
            `本次可验收上限 ${remaining}，实际提交 ${dto.quantity}`
        );
      }

      acceptDate = dto.acceptDate ?? new Date().toISOString().slice(0, 10);
      const period = acceptDate.slice(0, 7);
      const unitPrice = Number(order.unitPrice ?? 0);
      const amount = dto.quantity * unitPrice;
      const supplierId = order.supplierId ?? '';
      const projectId = order.projectId;
      const category = order.category ?? 'service';
      voucherAmount = amount;
      voucherSupplierId = supplierId;
      voucherTaxRate =
        order.taxRate != null && Number.isFinite(Number(order.taxRate))
          ? Number(order.taxRate)
          : null;
      orderCode = order.code;

      const pcCode =
        category === 'service' && projectId
          ? await generateBizCode(tx, erpProjectCost, erpProjectCost.code, 'PC')
          : null;
      const astCode =
        category === 'equipment'
          ? await generateBizCode(tx, astAsset, astAsset.code, 'AST')
          : null;

      const updated = await tx
        .update(purOrder)
        .set({
          acceptedQuantity: accepted + dto.quantity,
          acceptDate,
          status: 'accepted',
          updatedAt: new Date(),
        })
        .where(eq(purOrder.id, id))
        .returning({ id: purOrder.id });
      if (updated.length === 0) throw new NotFoundException('采购订单不存在');

      await tx.insert(erpApBill).values({
        code: apCode,
        supplierId,
        projectId,
        amount: String(amount),
        paidAmount: '0',
        status: 'pending',
        source: 'purchase',
        sourceRef: `po-accept:${order.code}:${apCode}`,
        remark: `采购订单${order.code}`,
      });

      if (pcCode) {
        await tx.insert(erpProjectCost).values({
          code: pcCode,
          projectId,
          costType: 'outsource',
          amount: String(amount),
          period,
          occurredDate: acceptDate,
          sourceRef: `po:${order.code}:${apCode}`,
          supplierId,
          remark: `采购订单${order.code}验收生成`,
        });
      }

      if (astCode) {
        await tx.insert(astAsset).values({
          code: astCode,
          name: order.itemName,
          category: 'other',
          originalValue: String(amount),
          residualValue: '0',
          netValue: String(amount),
          departmentId: null,
          projectId,
          purchaseOrderId: order.id,
          purchaseDate: acceptDate,
          usefulMonths: 36,
          status: 'in_use',
          remark: `采购订单${order.code}验收入库`,
        });
      }
    });

    // A3：采购验收补进项凭证（单价按含税口径）
    if (voucherAmount > 0) {
      try {
        // U-02：优先订单 taxRate 作为 TaxResolver upstream
        const resolved = await this.taxResolver.resolve({
          upstream: voucherTaxRate,
          supplierId: voucherSupplierId || undefined,
          side: 'input',
        });
        await this.voucherHookService.generateVoucherDraft({
          sourceType: 'ap',
          sourceRef: `ap:${apCode}`,
          voucherDate: acceptDate,
          summary: `采购验收 ${orderCode}`,
          lines: inputIssueLines(voucherAmount, resolved.rate),
        });
      } catch (error) {
        this.logger.error(
          `采购验收凭证失败 ap:${apCode}`,
          error instanceof Error ? error.stack : String(error)
        );
        await this.voucherHookService.recordCompensation(
          'ap',
          `ap:${apCode}`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return this.getOrderById(id);
  }

  async cancelOrder(id: string): Promise<PurOrderItem> {
    const rows = await this.db
      .select({
        id: purOrder.id,
        status: purOrder.status,
        acceptedQuantity: purOrder.acceptedQuantity,
      })
      .from(purOrder)
      .where(eq(purOrder.id, id));
    if (rows.length === 0) throw new NotFoundException('采购订单不存在');
    if ((rows[0].status ?? 'pending') !== 'pending') {
      throw new BadRequestException('仅待验收状态的订单可取消');
    }
    if ((rows[0].acceptedQuantity ?? 0) > 0) {
      throw new BadRequestException('订单已有验收记录，不可取消');
    }
    const updated = await this.db
      .update(purOrder)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(purOrder.id, id))
      .returning({ id: purOrder.id });
    if (updated.length === 0) throw new NotFoundException('采购订单不存在');
    return this.getOrderById(id);
  }

  private async getOrderById(id: string): Promise<PurOrderItem> {
    const rows: PurOrderRow[] = await this.db
      .select({
        id: purOrder.id,
        code: purOrder.code,
        requestId: purOrder.requestId,
        requestCode: purRequest.code,
        contractId: purOrder.contractId,
        contractName: erpContract.name,
        supplierId: purOrder.supplierId,
        supplierName: mdSupplier.name,
        projectId: purOrder.projectId,
        projectName: erpProject.name,
        itemName: purOrder.itemName,
        category: purOrder.category,
        quantity: purOrder.quantity,
        unitPrice: purOrder.unitPrice,
        amount: purOrder.amount,
        taxRate: purOrder.taxRate,
        orderDate: purOrder.orderDate,
        acceptedQuantity: purOrder.acceptedQuantity,
        acceptDate: purOrder.acceptDate,
        status: purOrder.status,
        remark: purOrder.remark,
        createdAt: purOrder.createdAt,
      })
      .from(purOrder)
      .leftJoin(purRequest, eq(purOrder.requestId, purRequest.id))
      .leftJoin(erpContract, eq(purOrder.contractId, erpContract.id))
      .leftJoin(mdSupplier, eq(purOrder.supplierId, mdSupplier.id))
      .leftJoin(erpProject, eq(purOrder.projectId, erpProject.id))
      .where(eq(purOrder.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('采购订单不存在');
    return this.toOrderItem(rows[0]);
  }

  /* ========== 采购链路看板 ========== */

  async getChainSummary(): Promise<PurChainSummary> {
    const [pendingRequestRows, pendingOrderRows, acceptedOrderRows, apRows] =
      await Promise.all([
        this.db
          .select({ total: count() })
          .from(purRequest)
          .where(eq(purRequest.status, 'pending')),
        this.db
          .select({ total: count() })
          .from(purOrder)
          .where(eq(purOrder.status, 'pending')),
        this.db
          .select({ total: count() })
          .from(purOrder)
          .where(eq(purOrder.status, 'accepted')),
        this.db
          .select({
            totalAmount: sum(erpApBill.amount),
            paidAmount: sum(erpApBill.paidAmount),
          })
          .from(erpApBill)
          .where(eq(erpApBill.source, 'purchase')),
      ]);

    const totalAmount = Number(apRows[0]?.totalAmount ?? 0);
    const paidAmount = Number(apRows[0]?.paidAmount ?? 0);
    return {
      pendingRequestCount: pendingRequestRows[0]?.total ?? 0,
      openOrderCount: pendingOrderRows[0]?.total ?? 0,
      acceptedOrderCount: acceptedOrderRows[0]?.total ?? 0,
      openApAmount: totalAmount - paidAmount,
      paidAmount,
    };
  }
}
