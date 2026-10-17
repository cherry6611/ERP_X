import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import type { RequestActor } from '@server/common/auth/actor';
import { and, count, desc, eq, ne, or } from 'drizzle-orm';
import {
  ilikeEscaped,
  likeContains,
} from '@server/common/utils/sql-like';
import {
  crmContact,
  erpAr,
  hrDepartment,
  hrPosition,
  mdCustomer,
  mdEmployee,
  mdSupplier,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { todayInShanghai } from '@server/common/utils/biz-date';
import type {
  CreateContactDto,
  CreateCustomerDto,
  CreateSupplierDto,
  CreditSummary,
  Customer,
  CustomerContact,
  Employee,
  PagedResult,
  Supplier,
  UpdateCustomerDto,
  UpdateSupplierDto,
} from '@shared/api.interface';

interface CustomerRow {
  id: string;
  code: string;
  name: string;
  uscc: string | null;
  industry: string | null;
  creditLevel: string | null;
  creditLimit: string | null;
  termsDays: number | null;
  status: string | null;
  remark: string | null;
  taxEntityId?: string | null;
  defaultTaxRate?: string | null;
  createdAt: Date;
}

@Injectable()
export class MasterDataService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  private toCustomer(row: CustomerRow): Customer {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      uscc: row.uscc,
      industry: row.industry,
      creditLevel: row.creditLevel,
      creditLimit: Number(row.creditLimit ?? 0),
      termsDays: row.termsDays ?? 30,
      status: row.status ?? 'active',
      remark: row.remark,
      taxEntityId: row.taxEntityId ?? null,
      defaultTaxRate:
        row.defaultTaxRate != null ? Number(row.defaultTaxRate) : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toContact(row: {
    id: string;
    customerId: string | null;
    name: string;
    phone: string | null;
    email: string | null;
    position: string | null;
    isPrimary: boolean | null;
    remark: string | null;
  }): CustomerContact {
    return {
      id: row.id,
      customerId: row.customerId ?? '',
      name: row.name,
      phone: row.phone,
      email: row.email,
      position: row.position,
      isPrimary: row.isPrimary ?? false,
      remark: row.remark,
    };
  }

  async listCustomers(
    keyword?: string,
    page = 1,
    pageSize = 20
  ): Promise<PagedResult<Customer>> {
    // S4：原实现把 `%${keyword}%` 直接交给 ilike —— 传 `keyword=%` 模式变成
    // `%%%` 即**匹配全表**，任意登录用户都能用搜索接口枚举全部客户。
    // 这不是 SQL 注入（drizzle 已绑定参数），但同样越过了"搜索"语义。
    // `likeContains` 同时做长度上限与 `%`/`_`/`\` 转义，`ilikeEscaped` 补 ESCAPE 子句。
    const pattern = likeContains(keyword);
    const where = pattern
      ? or(
          ilikeEscaped(mdCustomer.name, pattern),
          ilikeEscaped(mdCustomer.code, pattern)
        )
      : undefined;
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(mdCustomer)
      .where(where);
    const rows = await this.db
      .select({
        id: mdCustomer.id,
        code: mdCustomer.code,
        name: mdCustomer.name,
        uscc: mdCustomer.uscc,
        industry: mdCustomer.industry,
        creditLevel: mdCustomer.creditLevel,
        creditLimit: mdCustomer.creditLimit,
        termsDays: mdCustomer.termsDays,
        status: mdCustomer.status,
        remark: mdCustomer.remark,
        taxEntityId: mdCustomer.taxEntityId,
        defaultTaxRate: mdCustomer.defaultTaxRate,
        createdAt: mdCustomer.createdAt,
      })
      .from(mdCustomer)
      .where(where)
      .orderBy(desc(mdCustomer.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: rows.map((row: CustomerRow) => this.toCustomer(row)),
      total,
      page,
      pageSize,
    };
  }

  async createCustomer(dto: CreateCustomerDto): Promise<Customer> {
    const code = await generateBizCode(this.db, mdCustomer, mdCustomer.code, 'CUS');
    const rows: CustomerRow[] = await this.db
      .insert(mdCustomer)
      .values({
        code,
        name: dto.name,
        uscc: dto.uscc,
        industry: dto.industry,
        creditLevel: dto.creditLevel,
        creditLimit: String(dto.creditLimit ?? 0),
        termsDays: dto.termsDays ?? 30,
        status: dto.status ?? 'active',
        remark: dto.remark,
        taxEntityId: dto.taxEntityId ?? null,
        defaultTaxRate:
          dto.defaultTaxRate != null ? String(dto.defaultTaxRate) : null,
      })
      .returning();
    return this.toCustomer(rows[0]);
  }

  async updateCustomer(id: string, dto: UpdateCustomerDto): Promise<Customer> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.uscc !== undefined) patch.uscc = dto.uscc;
    if (dto.industry !== undefined) patch.industry = dto.industry;
    if (dto.creditLevel !== undefined) patch.creditLevel = dto.creditLevel;
    if (dto.creditLimit !== undefined) patch.creditLimit = String(dto.creditLimit);
    if (dto.termsDays !== undefined) patch.termsDays = dto.termsDays;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    if (dto.taxEntityId !== undefined) patch.taxEntityId = dto.taxEntityId;
    if (dto.defaultTaxRate !== undefined) {
      patch.defaultTaxRate =
        dto.defaultTaxRate == null ? null : String(dto.defaultTaxRate);
    }
    const rows: CustomerRow[] = await this.db
      .update(mdCustomer)
      .set(patch)
      .where(eq(mdCustomer.id, id))
      .returning();
    if (rows.length === 0) throw new NotFoundException('客户不存在');
    return this.toCustomer(rows[0]);
  }

  /** 启用/停用客户主数据（admin） */
  async setCustomerStatus(
    id: string,
    status: 'active' | 'inactive'
  ): Promise<Customer> {
    if (status !== 'active' && status !== 'inactive') {
      throw new BadRequestException('客户状态仅支持 active / inactive');
    }
    return this.updateCustomer(id, { status });
  }

  async listContacts(customerId: string): Promise<CustomerContact[]> {
    const rows = await this.db
      .select({
        id: crmContact.id,
        customerId: crmContact.customerId,
        name: crmContact.name,
        phone: crmContact.phone,
        email: crmContact.email,
        position: crmContact.position,
        isPrimary: crmContact.isPrimary,
        remark: crmContact.remark,
      })
      .from(crmContact)
      .where(eq(crmContact.customerId, customerId))
      .orderBy(desc(crmContact.isPrimary));
    return rows.map((row) => this.toContact(row));
  }

  async createContact(customerId: string, dto: CreateContactDto): Promise<CustomerContact> {
    const customer = await this.db
      .select({ id: mdCustomer.id })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, customerId));
    if (customer.length === 0) throw new NotFoundException('客户不存在');
    if (dto.isPrimary === true) {
      await this.db
        .update(crmContact)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(eq(crmContact.customerId, customerId));
    }
    const rows = await this.db
      .insert(crmContact)
      .values({
        customerId,
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        position: dto.position,
        isPrimary: dto.isPrimary ?? false,
        remark: dto.remark,
      })
      .returning({
        id: crmContact.id,
        customerId: crmContact.customerId,
        name: crmContact.name,
        phone: crmContact.phone,
        email: crmContact.email,
        position: crmContact.position,
        isPrimary: crmContact.isPrimary,
        remark: crmContact.remark,
      });
    return this.toContact(rows[0]);
  }

  async updateContact(id: string, dto: CreateContactDto): Promise<CustomerContact> {
    const existing = await this.db
      .select({ customerId: crmContact.customerId })
      .from(crmContact)
      .where(eq(crmContact.id, id));
    if (existing.length === 0) throw new NotFoundException('联系人不存在');
    const existingCustomerId = existing[0].customerId;
    if (dto.isPrimary === true && existingCustomerId) {
      await this.db
        .update(crmContact)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(
          and(
            eq(crmContact.customerId, existingCustomerId),
            ne(crmContact.id, id)
          )
        );
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.phone !== undefined) patch.phone = dto.phone;
    if (dto.email !== undefined) patch.email = dto.email;
    if (dto.position !== undefined) patch.position = dto.position;
    if (dto.isPrimary !== undefined) patch.isPrimary = dto.isPrimary;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    const rows = await this.db
      .update(crmContact)
      .set(patch)
      .where(eq(crmContact.id, id))
      .returning({
        id: crmContact.id,
        customerId: crmContact.customerId,
        name: crmContact.name,
        phone: crmContact.phone,
        email: crmContact.email,
        position: crmContact.position,
        isPrimary: crmContact.isPrimary,
        remark: crmContact.remark,
      });
    return this.toContact(rows[0]);
  }

  async deleteContact(id: string): Promise<void> {
    const rows = await this.db
      .delete(crmContact)
      .where(eq(crmContact.id, id))
      .returning({ id: crmContact.id });
    if (rows.length === 0) throw new NotFoundException('联系人不存在');
  }

  async getCredit(customerId: string): Promise<CreditSummary> {
    const customers = await this.db
      .select({
        id: mdCustomer.id,
        name: mdCustomer.name,
        creditLimit: mdCustomer.creditLimit,
      })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, customerId));
    if (customers.length === 0) throw new NotFoundException('客户不存在');
    const arRows = await this.db
      .select({
        amount: erpAr.amount,
        settledAmount: erpAr.settledAmount,
        dueDate: erpAr.dueDate,
        status: erpAr.status,
      })
      .from(erpAr)
      .where(eq(erpAr.customerId, customerId));
    let openArAmount = 0;
    let overdueAmount = 0;
    const today = todayInShanghai();
    for (const row of arRows) {
      if (row.status === 'settled') continue;
      const open = Number(row.amount) - Number(row.settledAmount ?? 0);
      openArAmount += open;
      if (row.dueDate !== null && row.dueDate < today) overdueAmount += open;
    }
    const limit = Number(customers[0].creditLimit ?? 0);
    return {
      customerId,
      customerName: customers[0].name,
      creditLimit: limit,
      openArAmount,
      overdueAmount,
      exceedLimit: limit > 0 && openArAmount > limit,
      hasOverdue: overdueAmount > 0,
    };
  }

  async listSuppliers(keyword?: string): Promise<Supplier[]> {
    // S4：与 listCustomers 同一修法（转义 + ESCAPE）
    const pattern = likeContains(keyword);
    const where = pattern
      ? or(
          ilikeEscaped(mdSupplier.name, pattern),
          ilikeEscaped(mdSupplier.code, pattern)
        )
      : undefined;
    const rows = await this.db
      .select()
      .from(mdSupplier)
      .where(where)
      .orderBy(desc(mdSupplier.createdAt));
    return rows.map((row) => this.mapSupplier(row));
  }

  async createSupplier(dto: CreateSupplierDto): Promise<Supplier> {
    const code = await generateBizCode(this.db, mdSupplier, mdSupplier.code, 'SUP');
    const rows = await this.db
      .insert(mdSupplier)
      .values({
        code,
        name: dto.name,
        type: dto.type,
        contactName: dto.contactName,
        contactPhone: dto.contactPhone,
        bankAccount: dto.bankAccount,
        rating: String(dto.rating ?? 0),
        status: dto.status ?? 'active',
        remark: dto.remark,
        taxEntityId: dto.taxEntityId ?? null,
        defaultTaxRate:
          dto.defaultTaxRate != null ? String(dto.defaultTaxRate) : null,
      })
      .returning();
    return this.mapSupplier(rows[0]);
  }

  async updateSupplier(id: string, dto: UpdateSupplierDto): Promise<Supplier> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.type !== undefined) patch.type = dto.type;
    if (dto.contactName !== undefined) patch.contactName = dto.contactName;
    if (dto.contactPhone !== undefined) patch.contactPhone = dto.contactPhone;
    if (dto.bankAccount !== undefined) patch.bankAccount = dto.bankAccount;
    if (dto.rating !== undefined) patch.rating = String(dto.rating);
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    if (dto.taxEntityId !== undefined) patch.taxEntityId = dto.taxEntityId;
    if (dto.defaultTaxRate !== undefined) {
      patch.defaultTaxRate =
        dto.defaultTaxRate == null ? null : String(dto.defaultTaxRate);
    }
    const rows = await this.db
      .update(mdSupplier)
      .set(patch)
      .where(eq(mdSupplier.id, id))
      .returning();
    if (rows.length === 0) throw new NotFoundException('供应商不存在');
    return this.mapSupplier(rows[0]);
  }

  /** 启用/停用供应商主数据（admin） */
  async setSupplierStatus(
    id: string,
    status: 'active' | 'inactive'
  ): Promise<Supplier> {
    if (status !== 'active' && status !== 'inactive') {
      throw new BadRequestException('供应商状态仅支持 active / inactive');
    }
    return this.updateSupplier(id, { status });
  }

  private mapSupplier(row: typeof mdSupplier.$inferSelect): Supplier {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      contactName: row.contactName,
      contactPhone: row.contactPhone,
      bankAccount: row.bankAccount,
      rating: Number(row.rating ?? 0),
      status: row.status ?? 'active',
      remark: row.remark,
      taxEntityId: row.taxEntityId ?? null,
      defaultTaxRate:
        row.defaultTaxRate != null ? Number(row.defaultTaxRate) : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listEmployees(actor?: RequestActor): Promise<Employee[]> {
    // 员工手机号/飞书身份属于 PII：只给 admin / HR 看；项目负责人只需要姓名/部门。
    const canSeePii =
      actor?.roles?.some((role) => role === 'admin' || role === 'hr_manager') ??
      false;
    const rows = await this.db
      .select({
        id: mdEmployee.id,
        code: mdEmployee.code,
        name: mdEmployee.name,
        orgName: mdEmployee.orgName,
        position: mdEmployee.position,
        status: mdEmployee.status,
        departmentId: mdEmployee.departmentId,
        departmentName: hrDepartment.name,
        positionId: mdEmployee.positionId,
        roleName: hrPosition.roleName,
        hireDate: mdEmployee.hireDate,
        employmentType: mdEmployee.employmentType,
        phone: mdEmployee.phone,
        resignDate: mdEmployee.resignDate,
        platformUserId: mdEmployee.platformUserId,
        supplierId: mdEmployee.supplierId,
        supplierName: mdSupplier.name,
      })
      .from(mdEmployee)
      .leftJoin(hrDepartment, eq(hrDepartment.id, mdEmployee.departmentId))
      .leftJoin(hrPosition, eq(hrPosition.id, mdEmployee.positionId))
      .leftJoin(mdSupplier, eq(mdSupplier.id, mdEmployee.supplierId))
      .orderBy(mdEmployee.code);
    return rows.map((row) => ({
      ...row,
      status: row.status ?? 'active',
      phone: canSeePii ? row.phone : null,
      platformUserId: canSeePii ? (row.platformUserId ?? null) : null,
      supplierId: row.supplierId ?? null,
      supplierName: row.supplierName ?? null,
    }));
  }

}
