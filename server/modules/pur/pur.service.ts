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
import { and, count, desc, eq, ne, sql, sum } from 'drizzle-orm';
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
import { round2 } from '@server/common/utils/number';
import { accumulateCapitalizedValue } from './pur-capitalize';
import { inputCapitalizeLines, inputIssueLines } from '@server/common/tax/posting';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { isVatRate } from '@shared/tax';
import { todayInShanghai } from '@server/common/utils/biz-date';
import { assertPeriodOpen } from '@server/common/utils/period-guard';
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
  /** 已验收金额（聚合列，见 `orderSelect()`） */
  acceptedAmount: number | null;
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

  /**
   * 采购订单的**共享查询列**（列表与详情必须用同一份，否则两处口径会漂移）。
   *
   * `acceptedAmount` 是**已验收金额**：该订单所有**有效**验收应付之和。
   * 关联键是验收时写入的 `erp_ap_bill.source_ref = 'po-accept:{订单号}:{应付号}'`
   * （见 `acceptOrder`），因此用 `'po-accept:' || code || ':%'` 前缀匹配。
   *
   * 为什么必须排除 `voided`：作废的应付已经从资金计划里退出（B1 按 status 判定），
   * 若把它算进已验收金额，打印件会显示一个**已作废**的金额。
   * 用白名单语义（`status <> 'voided'`）而不是列举有效态，避免将来新增状态时
   * 又把它算进来。
   *
   * ⚠️ 这里**不**用 `unitPrice * acceptedQuantity` 推导 —— 服务端落库时是
   * **逐次验收各自 round2** 后相加，与"合计数量一次性取整"不等（单价 0.333、
   * 分 3 次各验 1 时两者差 1 分）。只有聚合真实落库金额才与应付一致。
   */
  private orderSelect() {
    return {
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
      acceptedAmount: sql<number | null>`(
        SELECT SUM(ap.amount)
          FROM erp_ap_bill ap
         WHERE ap.source = 'purchase'
           AND ap.source_ref LIKE 'po-accept:' || ${purOrder.code} || ':%'
           AND ap.status <> 'voided'
      )::float8`,
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
      acceptedAmount: Number(row.acceptedAmount ?? 0),
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
        amount: String(round2(dto.amount)),
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
      .select(this.orderSelect())
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

    // F4：金额按分取整，避免凭证借贷 1 分差（round2 为全仓唯一取整实现）
    const amount = round2(dto.quantity * dto.unitPrice);
    if (dto.taxRate != null && !isVatRate(dto.taxRate)) {
      throw new BadRequestException(
        `非法税率 ${dto.taxRate}，允许值为 0/1/3/6/9/13`
      );
    }

    const code = await generateBizCode(this.db, purOrder, purOrder.code, 'PO');
    const inserted = await this.db.transaction(async (tx) => {
      // F4X-7：必须关联已批准采购申请，且一申请一有效订单
      if (!dto.requestId) {
        throw new BadRequestException('采购订单必须关联已批准的采购申请');
      }
      const reqRows = await tx
        .select({
          id: purRequest.id,
          code: purRequest.code,
          status: purRequest.status,
        })
        .from(purRequest)
        .where(eq(purRequest.id, dto.requestId))
        .for('update');
      if (reqRows.length === 0) {
        throw new BadRequestException('采购申请不存在');
      }
      if (reqRows[0].status !== 'approved') {
        throw new BadRequestException(
          `采购申请 ${reqRows[0].code} 当前状态为 ${reqRows[0].status}，仅已批准申请可下单`,
        );
      }
      const occupied = await tx
        .select({ id: purOrder.id })
        .from(purOrder)
        .where(
          and(
            eq(purOrder.requestId, dto.requestId),
            ne(purOrder.status, 'cancelled'),
          ),
        )
        .limit(1);
      if (occupied.length > 0) {
        throw new ConflictException(
          `采购申请 ${reqRows[0].code} 已生成订单，请勿重复下单`,
        );
      }

      // F5：合同额度校验加行锁，防并发超额穿透
      if (dto.contractId) {
        const contractRows = await tx
          .select({ code: erpContract.code, amount: erpContract.amount })
          .from(erpContract)
          .where(eq(erpContract.id, dto.contractId))
          .for('update');
        if (contractRows.length === 0) {
          throw new BadRequestException('关联合同不存在，无法创建采购订单');
        }
        const contractAmount = Number(contractRows[0].amount ?? 0);
        const orderedRows = await tx
          .select({ total: sum(purOrder.amount) })
          .from(purOrder)
          .where(
            and(
              eq(purOrder.contractId, dto.contractId),
              ne(purOrder.status, 'cancelled')
            )
          );
        const orderedAmount = Number(orderedRows[0]?.total ?? 0);
        /*
         * ⚠️ 统一走 `round2`（原为内联 `Math.round(x*100)/100`）。
         * 这里是**合同额度闸门**：累计口径必须与合同/成本侧同源，否则
         * "已下单 + 本次"与合同总额的比较会在半分位上分叉（同一组数在闸门处
         * 判"未超额"、在凭证/成本处却算出超额 1 分）。
         * 全仓另 5 处同类内联写法已统一迁移到 `round2`；本处与项目权重闸门是遗漏。
         */
        const cumulative = round2(orderedAmount + amount);
        if (cumulative > contractAmount + 0.001) {
          throw new BadRequestException(
            `采购订单金额超出合同额度：合同 ${contractRows[0].code} ` +
              `总额 ${contractAmount.toFixed(2)}，已下单 ${orderedAmount.toFixed(2)}，` +
              `本次 ${amount.toFixed(2)}，累计 ${cumulative.toFixed(2)}，` +
              `超出 ${(cumulative - contractAmount).toFixed(2)}`
          );
        }
      }

      return tx
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
    });
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
    let acceptDate = todayInShanghai();
    let orderCode = '';
    let capitalizeAsset = false;

    await this.db.transaction(async (tx) => {
      // T12：事务内 FOR UPDATE，防并发重复验收
      const locked = await tx
        .select()
        .from(purOrder)
        .where(eq(purOrder.id, id))
        .for('update');
      if (locked.length === 0) throw new NotFoundException('采购订单不存在');
      const order = locked[0];
      // F6：已整单验收不可再验；分批验收期间保持 pending，收满后才置 accepted
      if ((order.status ?? 'pending') === 'accepted') {
        throw new BadRequestException('订单已整单验收完成，不可再次验收');
      }
      if ((order.status ?? 'pending') !== 'pending') {
        throw new BadRequestException('仅待验收状态的订单可验收');
      }
      const quantity = order.quantity ?? 0;
      const accepted = order.acceptedQuantity ?? 0;
      const remaining = quantity - accepted;
      if (remaining <= 0) {
        throw new BadRequestException('订单已全部验收，不可再次验收');
      }
      if (dto.quantity > remaining) {
        throw new BadRequestException(
          `验收数量超出订单余量：订单数量 ${quantity}，已验收 ${accepted}，` +
            `本次可验收上限 ${remaining}，实际提交 ${dto.quantity}`
        );
      }

      acceptDate = dto.acceptDate ?? todayInShanghai();
      await assertPeriodOpen(this.db, acceptDate, '采购验收');
      const period = acceptDate.slice(0, 7);
      const unitPrice = Number(order.unitPrice ?? 0);
      const amount = round2(dto.quantity * unitPrice);
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
      /*
       * 一张采购订单只能有一张固定资产卡片
       * （`uq_ast_asset_purchase_order`，`WHERE purchase_order_id IS NOT NULL`）。
       *
       * 因此分批验收时**不能**再插一张卡：原实现每次验收都无条件 INSERT，
       * 第 2 次验收必然撞唯一索引 → 409「该采购订单已生成固定资产卡片」，
       * 于是订单永远收不完（剩余数量每次都被挡回）。正确做法是先看本订单
       * 是否已有卡片，有则把本次验收金额**累加**进去（金额口径见
       * `pur-capitalize.ts`，已配单测）。
       *
       * 订单行在本事务开头已 `FOR UPDATE`，同一订单的验收是串行的，
       * 因此这里读到的卡片不会被其它验收并发改动。
       */
      const capitalizedCard =
        category === 'equipment'
          ? ((
              await tx
                .select({
                  id: astAsset.id,
                  originalValue: astAsset.originalValue,
                  netValue: astAsset.netValue,
                })
                .from(astAsset)
                .where(eq(astAsset.purchaseOrderId, order.id))
                .limit(1)
            )[0] ?? null)
          : null;
      const astCode =
        category === 'equipment' && !capitalizedCard
          ? await generateBizCode(tx, astAsset, astAsset.code, 'AST')
          : null;
      // 资本化口径由「类别」决定（决定凭证走 1601 还是费用），与是否新建卡片无关
      capitalizeAsset = category === 'equipment';
      const capitalizedValues = accumulateCapitalizedValue(
        capitalizedCard,
        amount
      );

      const newAccepted = accepted + dto.quantity;
      const fullyAccepted = newAccepted >= quantity;
      const updated = await tx
        .update(purOrder)
        .set({
          acceptedQuantity: newAccepted,
          acceptDate,
          status: fullyAccepted ? 'accepted' : 'pending',
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

      if (category === 'equipment') {
        // 已有卡片 → 累计；没有 → 建卡。两者都保持「一张订单一张卡」的不变式。
        if (capitalizedCard && astCode === null) {
          await tx
            .update(astAsset)
            .set({
              originalValue: String(capitalizedValues.originalValue),
              netValue: String(capitalizedValues.netValue),
              updatedAt: new Date(),
            })
            .where(eq(astAsset.id, capitalizedCard.id));
        } else if (astCode) {
          await tx.insert(astAsset).values({
            code: astCode,
            name: order.itemName,
            category: 'other',
            originalValue: String(capitalizedValues.originalValue),
            residualValue: '0',
            netValue: String(capitalizedValues.netValue),
            departmentId: null,
            projectId,
            purchaseOrderId: order.id,
            purchaseDate: acceptDate,
            usefulMonths: 36,
            status: 'in_use',
            remark: `采购订单${order.code}验收入库`,
          });
        }
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
          // F4X-8：设备资本化走 1601，不进当期管理费用
          lines: capitalizeAsset
            ? inputCapitalizeLines(voucherAmount, resolved.rate)
            : inputIssueLines(voucherAmount, resolved.rate),
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
      .select(this.orderSelect())
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
