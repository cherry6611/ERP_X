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
import { and, asc, count, eq, gte, lte, sum, type SQL } from 'drizzle-orm';
import { resolveDocumentTaxEntity } from '@server/common/tax/document-tax-entity';
import dayjs from 'dayjs';
import {
  erpAdminAffair,
  erpAdminAsset,
  erpAdminBill,
  erpAdminRentContract,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { todayInShanghai } from '@server/common/utils/biz-date';
import type {
  AdminAffairAction,
  AdminAffairItem,
  AdminAffairStatus,
  AdminAssetItem,
  AdminAssetStatus,
  AdminBillAction,
  AdminBillItem,
  AdminBillStatus,
  AdminBillStats,
  AdminPaymentCycle,
  AdminRentContractAction,
  AdminRentContractItem,
  AdminRentContractStatus,
  AdminRentContractStats,
  CreateAdminAffairDto,
  CreateAdminAssetDto,
  CreateAdminBillDto,
  CreateAdminRentContractDto,
  PagedResult,
  UpdateAdminAffairDto,
  UpdateAdminAssetDto,
  UpdateAdminBillDto,
  UpdateAdminRentContractDto,
} from '@shared/api.interface';

/* 合同状态机：activate: draft→active；terminate: draft|active→terminated */
const RENT_TRANSITIONS: Record<AdminRentContractAction, Record<string, AdminRentContractStatus>> = {
  activate: { draft: 'active' },
  terminate: { draft: 'terminated', active: 'terminated' },
};

/* 缴费状态机 */
const BILL_TRANSITIONS: Record<AdminBillAction, Record<string, AdminBillStatus>> = {
  submit: { draft: 'submitted', rejected: 'submitted' },
  approve: { submitted: 'approved' },
  reject: { submitted: 'rejected' },
  pay: { approved: 'paid' },
};

/* 事务状态机：settle: registered→settled */
const AFFAIR_TRANSITIONS: Record<AdminAffairAction, Record<string, AdminAffairStatus>> = {
  settle: { registered: 'settled' },
};

type RentContractRow = typeof erpAdminRentContract.$inferSelect;
type BillRow = typeof erpAdminBill.$inferSelect;
type AssetRow = typeof erpAdminAsset.$inferSelect;
type AffairRow = typeof erpAdminAffair.$inferSelect;

interface BillJoinedRow {
  bill: BillRow;
  rentContractCode: string | null;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  /* ========== 租房合同 ========== */

  async listRentContracts(
    page: number,
    pageSize: number,
    status?: string
  ): Promise<PagedResult<AdminRentContractItem>> {
    const conditions: SQL[] = [];
    if (status) conditions.push(eq(erpAdminRentContract.status, status));
    const where: SQL | undefined =
      conditions.length > 0 ? and(...conditions) : undefined;

    const [{ total }] = await this.db
      .select({ total: count() })
      .from(erpAdminRentContract)
      .where(where);
    const rows: RentContractRow[] = await this.db
      .select()
      .from(erpAdminRentContract)
      .where(where)
      .orderBy(asc(erpAdminRentContract.code))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map((row: RentContractRow) => this.mapRentContract(row)),
      total,
      page,
      pageSize,
    };
  }

  async getRentContractStats(): Promise<AdminRentContractStats> {
    const today: string = todayInShanghai();
    const horizon: string = dayjs(today).add(30, 'day').format('YYYY-MM-DD');

    const [activeRow] = await this.db
      .select({
        total: count(),
        rent: sum(erpAdminRentContract.monthlyRent),
      })
      .from(erpAdminRentContract)
      .where(eq(erpAdminRentContract.status, 'active'));
    const [expiringRow] = await this.db
      .select({ total: count() })
      .from(erpAdminRentContract)
      .where(
        and(
          eq(erpAdminRentContract.status, 'active'),
          gte(erpAdminRentContract.endDate, today),
          lte(erpAdminRentContract.endDate, horizon)
        )
      );

    return {
      activeCount: activeRow.total,
      expiringCount: expiringRow.total,
      totalMonthlyRent: Number(activeRow.rent ?? 0),
    };
  }

  async createRentContract(
    dto: CreateAdminRentContractDto
  ): Promise<AdminRentContractItem> {
    const taxEntityId = await resolveDocumentTaxEntity(this.db, {
      taxEntityId: dto.taxEntityId,
      kind: 'expense',
    });
    const code: string = await generateBizCode(
      this.db,
      erpAdminRentContract,
      erpAdminRentContract.code,
      'RNT'
    );
    const rows: RentContractRow[] = await this.db
      .insert(erpAdminRentContract)
      .values({
        code,
        name: dto.name,
        propertyAddress: dto.propertyAddress,
        lessor: dto.lessor,
        monthlyRent: String(dto.monthlyRent),
        deposit: dto.deposit !== undefined ? String(dto.deposit) : null,
        area: dto.area !== undefined ? String(dto.area) : null,
        startDate: dto.startDate,
        endDate: dto.endDate,
        paymentCycle: (dto.paymentCycle ?? 'monthly') satisfies AdminPaymentCycle,
        status: 'draft',
        taxEntityId,
        remark: dto.remark ?? null,
      })
      .returning();
    return this.mapRentContract(rows[0]);
  }

  async updateRentContract(
    id: string,
    dto: UpdateAdminRentContractDto
  ): Promise<AdminRentContractItem> {
    const existing: RentContractRow = await this.findRentContract(id);
    if (existing.status !== 'draft') {
      throw new BadRequestException('仅草稿状态的合同可编辑');
    }

    const patch: Partial<typeof erpAdminRentContract.$inferInsert> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.propertyAddress !== undefined) patch.propertyAddress = dto.propertyAddress;
    if (dto.lessor !== undefined) patch.lessor = dto.lessor;
    if (dto.monthlyRent !== undefined) patch.monthlyRent = String(dto.monthlyRent);
    if (dto.deposit !== undefined) {
      patch.deposit = dto.deposit === null ? null : String(dto.deposit);
    }
    if (dto.area !== undefined) {
      patch.area = dto.area === null ? null : String(dto.area);
    }
    if (dto.startDate !== undefined) patch.startDate = dto.startDate;
    if (dto.endDate !== undefined) patch.endDate = dto.endDate;
    if (dto.paymentCycle !== undefined) patch.paymentCycle = dto.paymentCycle;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }
    patch.updatedAt = new Date();

    const rows: RentContractRow[] = await this.db
      .update(erpAdminRentContract)
      .set(patch)
      .where(eq(erpAdminRentContract.id, id))
      .returning();
    return this.mapRentContract(rows[0]);
  }

  async rentContractAction(
    id: string,
    action: AdminRentContractAction
  ): Promise<AdminRentContractItem> {
    const existing: RentContractRow = await this.findRentContract(id);
    const next: AdminRentContractStatus | undefined =
      RENT_TRANSITIONS[action][existing.status];
    if (!next) {
      throw new BadRequestException(`合同当前状态 ${existing.status} 不支持操作 ${action}`);
    }
    const rows: RentContractRow[] = await this.db
      .update(erpAdminRentContract)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(erpAdminRentContract.id, id))
      .returning();
    return this.mapRentContract(rows[0]);
  }

  private async findRentContract(id: string): Promise<RentContractRow> {
    const rows: RentContractRow[] = await this.db
      .select()
      .from(erpAdminRentContract)
      .where(eq(erpAdminRentContract.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('租房合同不存在');
    return rows[0];
  }

  private mapRentContract(row: RentContractRow): AdminRentContractItem {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      propertyAddress: row.propertyAddress,
      lessor: row.lessor,
      monthlyRent: Number(row.monthlyRent),
      deposit: row.deposit === null ? null : Number(row.deposit),
      area: row.area === null ? null : Number(row.area),
      startDate: row.startDate,
      endDate: row.endDate,
      paymentCycle: row.paymentCycle as AdminPaymentCycle,
      status: row.status as AdminRentContractStatus,
      taxEntityId: row.taxEntityId ?? null,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /* ========== 行政缴费 ========== */

  async listBills(
    page: number,
    pageSize: number,
    billType?: string,
    period?: string,
    status?: string
  ): Promise<PagedResult<AdminBillItem>> {
    const conditions: SQL[] = [];
    if (billType) conditions.push(eq(erpAdminBill.billType, billType));
    if (period) conditions.push(eq(erpAdminBill.period, period));
    if (status) conditions.push(eq(erpAdminBill.status, status));
    const where: SQL | undefined =
      conditions.length > 0 ? and(...conditions) : undefined;

    const [{ total }] = await this.db
      .select({ total: count() })
      .from(erpAdminBill)
      .where(where);
    const rows: BillJoinedRow[] = await this.db
      .select({
        bill: erpAdminBill,
        rentContractCode: erpAdminRentContract.code,
      })
      .from(erpAdminBill)
      .leftJoin(
        erpAdminRentContract,
        eq(erpAdminBill.rentContractId, erpAdminRentContract.id)
      )
      .where(where)
      .orderBy(asc(erpAdminBill.code))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map((row: BillJoinedRow) =>
        this.mapBill(row.bill, row.rentContractCode)
      ),
      total,
      page,
      pageSize,
    };
  }

  async getBillStats(): Promise<AdminBillStats> {
    const today: string = todayInShanghai();
    const period: string = today.slice(0, 7);

    const [paidRow] = await this.db
      .select({ total: sum(erpAdminBill.amount) })
      .from(erpAdminBill)
      .where(
        and(eq(erpAdminBill.period, period), eq(erpAdminBill.status, 'paid'))
      );
    const [submittedRow] = await this.db
      .select({ total: count() })
      .from(erpAdminBill)
      .where(eq(erpAdminBill.status, 'submitted'));
    const [draftRow] = await this.db
      .select({ total: count() })
      .from(erpAdminBill)
      .where(eq(erpAdminBill.status, 'draft'));

    return {
      monthPaidAmount: Number(paidRow.total ?? 0),
      submittedCount: submittedRow.total,
      draftCount: draftRow.total,
    };
  }

  async createBill(dto: CreateAdminBillDto): Promise<AdminBillItem> {
    const code: string = await generateBizCode(
      this.db,
      erpAdminBill,
      erpAdminBill.code,
      'ADB'
    );
    const rows: BillRow[] = await this.db
      .insert(erpAdminBill)
      .values({
        code,
        title: dto.title,
        billType: dto.billType,
        amount: String(dto.amount),
        period: dto.period,
        payee: dto.payee ?? null,
        expenseDate: dto.expenseDate,
        rentContractId: dto.rentContractId ?? null,
        status: 'draft',
        remark: dto.remark ?? null,
      })
      .returning();
    return this.mapBill(rows[0], null);
  }

  async updateBill(
    id: string,
    dto: UpdateAdminBillDto
  ): Promise<AdminBillItem> {
    const existing: BillJoinedRow = await this.findBillJoined(id);
    if (existing.bill.status !== 'draft' && existing.bill.status !== 'rejected') {
      throw new BadRequestException('仅草稿或被驳回的缴费单可编辑');
    }

    const patch: Partial<typeof erpAdminBill.$inferInsert> = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.billType !== undefined) patch.billType = dto.billType;
    if (dto.amount !== undefined) patch.amount = String(dto.amount);
    if (dto.period !== undefined) patch.period = dto.period;
    if (dto.expenseDate !== undefined) patch.expenseDate = dto.expenseDate;
    if (dto.payee !== undefined) patch.payee = dto.payee;
    if (dto.rentContractId !== undefined) patch.rentContractId = dto.rentContractId;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }
    patch.updatedAt = new Date();

    await this.db
      .update(erpAdminBill)
      .set(patch)
      .where(eq(erpAdminBill.id, id))
      .returning({ id: erpAdminBill.id });
    const joined: BillJoinedRow = await this.findBillJoined(id);
    return this.mapBill(joined.bill, joined.rentContractCode);
  }

  async billAction(
    id: string,
    action: AdminBillAction,
    dto: { payDate?: string; payMethod?: string; approveRemark?: string }
  ): Promise<AdminBillItem> {
    const existing: BillJoinedRow = await this.findBillJoined(id);
    const next: AdminBillStatus | undefined =
      BILL_TRANSITIONS[action][existing.bill.status];
    if (!next) {
      throw new BadRequestException(
        `缴费单当前状态 ${existing.bill.status} 不支持操作 ${action}`
      );
    }

    const patch: Partial<typeof erpAdminBill.$inferInsert> = {
      status: next,
      updatedAt: new Date(),
    };
    if (action === 'reject' && dto.approveRemark !== undefined) {
      patch.approveRemark = dto.approveRemark;
    }
    if (action === 'pay') {
      patch.payDate = dto.payDate ?? todayInShanghai();
      if (dto.payMethod !== undefined) patch.payMethod = dto.payMethod;
    }

    await this.db
      .update(erpAdminBill)
      .set(patch)
      .where(eq(erpAdminBill.id, id))
      .returning({ id: erpAdminBill.id });
    const joined: BillJoinedRow = await this.findBillJoined(id);
    return this.mapBill(joined.bill, joined.rentContractCode);
  }

  private async findBillJoined(id: string): Promise<BillJoinedRow> {
    const rows: BillJoinedRow[] = await this.db
      .select({
        bill: erpAdminBill,
        rentContractCode: erpAdminRentContract.code,
      })
      .from(erpAdminBill)
      .leftJoin(
        erpAdminRentContract,
        eq(erpAdminBill.rentContractId, erpAdminRentContract.id)
      )
      .where(eq(erpAdminBill.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('行政缴费单不存在');
    return rows[0];
  }

  private mapBill(bill: BillRow, rentContractCode: string | null): AdminBillItem {
    return {
      id: bill.id,
      code: bill.code,
      title: bill.title,
      billType: bill.billType as AdminBillItem['billType'],
      amount: Number(bill.amount),
      period: bill.period,
      payee: bill.payee,
      expenseDate: bill.expenseDate,
      rentContractId: bill.rentContractId,
      rentContractCode,
      status: bill.status as AdminBillStatus,
      payDate: bill.payDate,
      payMethod: bill.payMethod,
      approveRemark: bill.approveRemark,
      remark: bill.remark,
      createdAt: bill.createdAt.toISOString(),
    };
  }

  /* ========== 行政资产 ========== */

  async listAssets(
    page: number,
    pageSize: number,
    category?: string,
    status?: string
  ): Promise<PagedResult<AdminAssetItem>> {
    const conditions: SQL[] = [];
    if (category) conditions.push(eq(erpAdminAsset.category, category));
    if (status) conditions.push(eq(erpAdminAsset.status, status));
    const where: SQL | undefined =
      conditions.length > 0 ? and(...conditions) : undefined;

    const [{ total }] = await this.db
      .select({ total: count() })
      .from(erpAdminAsset)
      .where(where);
    const rows: AssetRow[] = await this.db
      .select()
      .from(erpAdminAsset)
      .where(where)
      .orderBy(asc(erpAdminAsset.code))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map((row: AssetRow) => this.mapAsset(row)),
      total,
      page,
      pageSize,
    };
  }

  async createAsset(dto: CreateAdminAssetDto): Promise<AdminAssetItem> {
    const code: string = await generateBizCode(
      this.db,
      erpAdminAsset,
      erpAdminAsset.code,
      'AST'
    );
    const amount: number = dto.quantity * dto.unitPrice;
    const rows: AssetRow[] = await this.db
      .insert(erpAdminAsset)
      .values({
        code,
        name: dto.name,
        category: dto.category,
        quantity: dto.quantity,
        unitPrice: String(dto.unitPrice),
        amount: String(amount),
        location: dto.location ?? null,
        owner: dto.owner ?? null,
        purchaseDate: dto.purchaseDate ?? null,
        status: dto.status ?? 'in_use',
        remark: dto.remark ?? null,
      })
      .returning();
    return this.mapAsset(rows[0]);
  }

  async updateAsset(
    id: string,
    dto: UpdateAdminAssetDto
  ): Promise<AdminAssetItem> {
    const existing: AssetRow = await this.findAsset(id);

    const patch: Partial<typeof erpAdminAsset.$inferInsert> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.category !== undefined) patch.category = dto.category;
    if (dto.quantity !== undefined) patch.quantity = dto.quantity;
    if (dto.unitPrice !== undefined) patch.unitPrice = String(dto.unitPrice);
    if (dto.location !== undefined) patch.location = dto.location;
    if (dto.owner !== undefined) patch.owner = dto.owner;
    if (dto.purchaseDate !== undefined) patch.purchaseDate = dto.purchaseDate;
    if (dto.status !== undefined) patch.status = dto.status satisfies AdminAssetStatus;
    if (dto.remark !== undefined) patch.remark = dto.remark;

    if (dto.quantity !== undefined || dto.unitPrice !== undefined) {
      const quantity: number = dto.quantity ?? existing.quantity;
      const unitPrice: number =
        dto.unitPrice !== undefined ? dto.unitPrice : Number(existing.unitPrice);
      patch.amount = String(quantity * unitPrice);
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }
    patch.updatedAt = new Date();

    const rows: AssetRow[] = await this.db
      .update(erpAdminAsset)
      .set(patch)
      .where(eq(erpAdminAsset.id, id))
      .returning();
    return this.mapAsset(rows[0]);
  }

  async deleteAsset(id: string): Promise<void> {
    const rows: Array<{ id: string }> = await this.db
      .delete(erpAdminAsset)
      .where(eq(erpAdminAsset.id, id))
      .returning({ id: erpAdminAsset.id });
    if (rows.length === 0) throw new NotFoundException('资产不存在');
  }

  private async findAsset(id: string): Promise<AssetRow> {
    const rows: AssetRow[] = await this.db
      .select()
      .from(erpAdminAsset)
      .where(eq(erpAdminAsset.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('资产不存在');
    return rows[0];
  }

  private mapAsset(row: AssetRow): AdminAssetItem {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      category: row.category as AdminAssetItem['category'],
      quantity: row.quantity,
      unitPrice: Number(row.unitPrice),
      amount: Number(row.amount ?? 0),
      location: row.location,
      owner: row.owner,
      purchaseDate: row.purchaseDate,
      status: row.status as AdminAssetStatus,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /* ========== 车辆/差旅事务 ========== */

  async listAffairs(
    page: number,
    pageSize: number,
    affairType?: string,
    status?: string
  ): Promise<PagedResult<AdminAffairItem>> {
    const conditions: SQL[] = [];
    if (affairType) conditions.push(eq(erpAdminAffair.affairType, affairType));
    if (status) conditions.push(eq(erpAdminAffair.status, status));
    const where: SQL | undefined =
      conditions.length > 0 ? and(...conditions) : undefined;

    const [{ total }] = await this.db
      .select({ total: count() })
      .from(erpAdminAffair)
      .where(where);
    const rows: AffairRow[] = await this.db
      .select()
      .from(erpAdminAffair)
      .where(where)
      .orderBy(asc(erpAdminAffair.code))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map((row: AffairRow) => this.mapAffair(row)),
      total,
      page,
      pageSize,
    };
  }

  async createAffair(dto: CreateAdminAffairDto): Promise<AdminAffairItem> {
    const code: string = await generateBizCode(
      this.db,
      erpAdminAffair,
      erpAdminAffair.code,
      'AFR'
    );
    const rows: AffairRow[] = await this.db
      .insert(erpAdminAffair)
      .values({
        code,
        affairType: dto.affairType,
        title: dto.title,
        participants: dto.participants ?? null,
        startDate: dto.startDate,
        endDate: dto.endDate ?? null,
        amount: dto.amount !== undefined ? String(dto.amount) : null,
        status: 'registered',
        remark: dto.remark ?? null,
      })
      .returning();
    return this.mapAffair(rows[0]);
  }

  async updateAffair(
    id: string,
    dto: UpdateAdminAffairDto
  ): Promise<AdminAffairItem> {
    const existing: AffairRow = await this.findAffair(id);
    if (existing.status !== 'registered') {
      throw new BadRequestException('仅已登记状态的事务可编辑');
    }

    const patch: Partial<typeof erpAdminAffair.$inferInsert> = {};
    if (dto.affairType !== undefined) patch.affairType = dto.affairType;
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.participants !== undefined) patch.participants = dto.participants;
    if (dto.startDate !== undefined) patch.startDate = dto.startDate;
    if (dto.endDate !== undefined) patch.endDate = dto.endDate;
    if (dto.amount !== undefined) {
      patch.amount = dto.amount === null ? null : String(dto.amount);
    }
    if (dto.remark !== undefined) patch.remark = dto.remark;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }
    patch.updatedAt = new Date();

    const rows: AffairRow[] = await this.db
      .update(erpAdminAffair)
      .set(patch)
      .where(eq(erpAdminAffair.id, id))
      .returning();
    return this.mapAffair(rows[0]);
  }

  async affairAction(
    id: string,
    action: AdminAffairAction
  ): Promise<AdminAffairItem> {
    const existing: AffairRow = await this.findAffair(id);
    const next: AdminAffairStatus | undefined =
      AFFAIR_TRANSITIONS[action][existing.status];
    if (!next) {
      throw new BadRequestException(
        `事务当前状态 ${existing.status} 不支持操作 ${action}`
      );
    }
    const rows: AffairRow[] = await this.db
      .update(erpAdminAffair)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(erpAdminAffair.id, id))
      .returning();
    return this.mapAffair(rows[0]);
  }

  async deleteAffair(id: string): Promise<void> {
    const rows: Array<{ id: string }> = await this.db
      .delete(erpAdminAffair)
      .where(eq(erpAdminAffair.id, id))
      .returning({ id: erpAdminAffair.id });
    if (rows.length === 0) throw new NotFoundException('事务不存在');
  }

  private async findAffair(id: string): Promise<AffairRow> {
    const rows: AffairRow[] = await this.db
      .select()
      .from(erpAdminAffair)
      .where(eq(erpAdminAffair.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('事务不存在');
    return rows[0];
  }

  private mapAffair(row: AffairRow): AdminAffairItem {
    const rawParticipants: unknown = row.participants;
    const participants: string[] = Array.isArray(rawParticipants)
      ? (rawParticipants as string[])
      : [];
    return {
      id: row.id,
      code: row.code,
      affairType: row.affairType as AdminAffairItem['affairType'],
      title: row.title,
      participants,
      startDate: row.startDate,
      endDate: row.endDate,
      amount: row.amount === null ? null : Number(row.amount),
      status: row.status as AdminAffairStatus,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
