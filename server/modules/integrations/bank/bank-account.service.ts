import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, or, sql } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { finAccount, mdBankAccount } from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { round2 } from './bank-reconciliation.logic';
import type {
  BankAccountItem,
  CreateBankAccountDto,
  PagedResult,
  UpdateBankAccountDto,
} from '@shared/api.interface';

interface BankAccountRow {
  id: string;
  code: string;
  name: string;
  accountNo: string;
  bankName: string;
  branchName: string | null;
  currency: string;
  accountCode: string | null;
  accountName: string | null;
  openingBalance: string | null;
  isDefault: number;
  status: string;
  contactPerson: string | null;
  contactPhone: string | null;
  remark: string | null;
  createdAt: Date;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * C-02 银行账户主数据。
 * 唯一键：账号 + 币种（重复创建返回 409）；每币种最多一个默认账户。
 */
@Injectable()
export class BankAccountService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  private toItem(row: BankAccountRow): BankAccountItem {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      accountNo: row.accountNo,
      bankName: row.bankName,
      branchName: row.branchName,
      currency: row.currency,
      accountCode: row.accountCode,
      accountName: row.accountName,
      openingBalance: round2(Number(row.openingBalance ?? 0)),
      isDefault: row.isDefault === 1,
      status: row.status,
      contactPerson: row.contactPerson,
      contactPhone: row.contactPhone,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private baseQuery() {
    return this.db
      .select({
        id: mdBankAccount.id,
        code: mdBankAccount.code,
        name: mdBankAccount.name,
        accountNo: mdBankAccount.accountNo,
        bankName: mdBankAccount.bankName,
        branchName: mdBankAccount.branchName,
        currency: mdBankAccount.currency,
        accountCode: mdBankAccount.accountCode,
        accountName: finAccount.name,
        openingBalance: mdBankAccount.openingBalance,
        isDefault: mdBankAccount.isDefault,
        status: mdBankAccount.status,
        contactPerson: mdBankAccount.contactPerson,
        contactPhone: mdBankAccount.contactPhone,
        remark: mdBankAccount.remark,
        createdAt: mdBankAccount.createdAt,
      })
      .from(mdBankAccount)
      .leftJoin(finAccount, eq(mdBankAccount.accountCode, finAccount.code));
  }

  async listAccounts(params: {
    page?: number;
    pageSize?: number;
    status?: string;
    keyword?: string;
  }): Promise<PagedResult<BankAccountItem>> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const conditions = [];
    if (params.status) conditions.push(eq(mdBankAccount.status, params.status));
    if (params.keyword) {
      const keyword = `%${params.keyword}%`;
      conditions.push(
        or(
          sql`${mdBankAccount.name} ILIKE ${keyword}`,
          sql`${mdBankAccount.accountNo} ILIKE ${keyword}`,
          sql`${mdBankAccount.bankName} ILIKE ${keyword}`
        )
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(mdBankAccount)
      .where(where);
    const total = Number(totalRows[0]?.total ?? 0);

    const rows: BankAccountRow[] = await this.baseQuery()
      .where(where)
      .orderBy(sql`${mdBankAccount.isDefault} DESC`, asc(mdBankAccount.code))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map((row) => this.toItem(row)),
      total,
      page,
      pageSize,
    };
  }

  async getAccount(id: string): Promise<BankAccountItem> {
    const rows: BankAccountRow[] = await this.baseQuery()
      .where(eq(mdBankAccount.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('银行账户不存在');
    return this.toItem(rows[0]);
  }

  /** 未指定账户时取默认账户（同币种唯一），用于对账默认口径 */
  async getDefaultAccount(currency = 'CNY'): Promise<BankAccountItem | null> {
    const rows: BankAccountRow[] = await this.baseQuery()
      .where(and(eq(mdBankAccount.isDefault, 1), eq(mdBankAccount.currency, currency)))
      .limit(1);
    return rows.length > 0 ? this.toItem(rows[0]) : null;
  }

  private async assertAccountCode(accountCode: string | undefined): Promise<void> {
    if (!accountCode) return;
    const rows = await this.db
      .select({ code: finAccount.code })
      .from(finAccount)
      .where(eq(finAccount.code, accountCode))
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException(`会计科目 ${accountCode} 不存在，请先在科目表维护`);
    }
  }

  private async assertAccountNoUnique(
    accountNo: string,
    currency: string,
    excludeId?: string
  ): Promise<void> {
    const conditions = [
      eq(mdBankAccount.accountNo, accountNo),
      eq(mdBankAccount.currency, currency),
    ];
    if (excludeId) conditions.push(sql`${mdBankAccount.id} <> ${excludeId}`);
    const rows = await this.db
      .select({ id: mdBankAccount.id })
      .from(mdBankAccount)
      .where(and(...conditions))
      .limit(1);
    if (rows.length > 0) {
      throw new ConflictException(
        `账号 ${accountNo}（${currency}）已存在，请勿重复创建`
      );
    }
  }

  private async clearDefault(currency: string, excludeId?: string): Promise<void> {
    const conditions = [eq(mdBankAccount.isDefault, 1), eq(mdBankAccount.currency, currency)];
    if (excludeId) conditions.push(sql`${mdBankAccount.id} <> ${excludeId}`);
    await this.db
      .update(mdBankAccount)
      .set({ isDefault: 0 })
      .where(and(...conditions));
  }

  async createAccount(dto: CreateBankAccountDto): Promise<BankAccountItem> {
    const currency = (dto.currency ?? 'CNY').toUpperCase();
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new BadRequestException('币种必须为 3 位大写字母代码（如 CNY/USD）');
    }
    await this.assertAccountNoUnique(dto.accountNo, currency);
    await this.assertAccountCode(dto.accountCode);
    if (dto.isDefault) await this.clearDefault(currency);
    const code = await generateBizCode(
      this.db,
      mdBankAccount,
      mdBankAccount.code,
      'BNK'
    );
    const inserted = await this.db
      .insert(mdBankAccount)
      .values({
        code,
        name: dto.name,
        accountNo: dto.accountNo,
        bankName: dto.bankName,
        branchName: dto.branchName ?? null,
        currency,
        accountCode: dto.accountCode ?? '1002',
        openingBalance: String(round2(dto.openingBalance ?? 0)),
        isDefault: dto.isDefault ? 1 : 0,
        status: dto.status ?? 'active',
        contactPerson: dto.contactPerson ?? null,
        contactPhone: dto.contactPhone ?? null,
        remark: dto.remark ?? null,
      })
      .returning({ id: mdBankAccount.id });
    return this.getAccount(inserted[0].id);
  }

  async updateAccount(
    id: string,
    dto: UpdateBankAccountDto
  ): Promise<BankAccountItem> {
    const current = await this.getAccount(id);
    const currency = (dto.currency ?? current.currency).toUpperCase();
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new BadRequestException('币种必须为 3 位大写字母代码（如 CNY/USD）');
    }
    if (dto.accountNo !== undefined && dto.accountNo !== current.accountNo) {
      await this.assertAccountNoUnique(dto.accountNo, currency, id);
    }
    if (dto.accountCode !== undefined) await this.assertAccountCode(dto.accountCode);
    if (dto.isDefault === true) await this.clearDefault(currency, id);

    const patch: Partial<typeof mdBankAccount.$inferInsert> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.accountNo !== undefined) patch.accountNo = dto.accountNo;
    if (dto.bankName !== undefined) patch.bankName = dto.bankName;
    if (dto.branchName !== undefined) patch.branchName = dto.branchName;
    if (dto.currency !== undefined) patch.currency = currency;
    if (dto.accountCode !== undefined) patch.accountCode = dto.accountCode;
    if (dto.openingBalance !== undefined) {
      patch.openingBalance = String(round2(dto.openingBalance));
    }
    if (dto.isDefault !== undefined) patch.isDefault = dto.isDefault ? 1 : 0;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.contactPerson !== undefined) patch.contactPerson = dto.contactPerson;
    if (dto.contactPhone !== undefined) patch.contactPhone = dto.contactPhone;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }
    patch.updatedAt = new Date();
    const rows = await this.db
      .update(mdBankAccount)
      .set(patch)
      .where(eq(mdBankAccount.id, id))
      .returning({ id: mdBankAccount.id });
    if (rows.length === 0) throw new NotFoundException('银行账户不存在');
    return this.getAccount(id);
  }

  /** 供对账取数使用：账户 + 关联合计科目编码（缺省 1002） */
  async resolveAccountForReconciliation(bankAccountId?: string): Promise<BankAccountItem> {
    if (bankAccountId) return this.getAccount(bankAccountId);
    const fallback = await this.getDefaultAccount('CNY');
    if (fallback) return fallback;
    const any = await this.listAccounts({ page: 1, pageSize: 1 });
    if (any.items.length === 0) {
      throw new BadRequestException('尚未维护银行账户，请先在「银行账户」中创建');
    }
    return any.items[0];
  }
}
