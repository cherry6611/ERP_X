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
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  finAccount,
  finPeriodClose,
  finVoucher,
  finVoucherLine,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import type {
  AccountItem,
  CreateAccountDto,
  CreateVoucherDto,
  PagedResult,
  PeriodStatus,
  VoucherAction,
  VoucherItem,
  VoucherStatus,
  VoucherSourceType,
} from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

interface AccountRow {
  id: string;
  code: string;
  name: string;
  accountType: string | null;
  status: string | null;
  remark: string | null;
  createdAt: Date;
}

interface VoucherHeadRow {
  id: string;
  code: string;
  voucherDate: string | null;
  period: string | null;
  summary: string | null;
  sourceType: string | null;
  sourceRef: string | null;
  status: string | null;
  remark: string | null;
  createdAt: Date;
}

interface VoucherLineRow {
  id: string;
  voucherId: string | null;
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
  summary: string | null;
  debit: string | null;
  credit: string | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

@Injectable()
export class VoucherService {
  private readonly logger = new Logger(VoucherService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  /* ========== 科目 ========== */

  private toAccountItem(row: AccountRow): AccountItem {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: (row.accountType ?? 'asset') as AccountItem['accountType'],
      status: row.status ?? 'active',
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listAccounts(
    page: number,
    pageSize: number,
    keyword?: string
  ): Promise<PagedResult<AccountItem>> {
    const conditions = [];
    if (keyword) {
      conditions.push(
        sql`(${finAccount.code} ilike ${`%${keyword}%`} or ${finAccount.name} ilike ${`%${keyword}%`})`
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(finAccount)
      .where(where);
    const rows: AccountRow[] = await this.db
      .select({
        id: finAccount.id,
        code: finAccount.code,
        name: finAccount.name,
        accountType: finAccount.accountType,
        status: finAccount.status,
        remark: finAccount.remark,
        createdAt: finAccount.createdAt,
      })
      .from(finAccount)
      .where(where)
      .orderBy(asc(finAccount.code))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: rows.map((row: AccountRow) => this.toAccountItem(row)),
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  async createAccount(dto: CreateAccountDto): Promise<AccountItem> {
    const dup = await this.db
      .select({ id: finAccount.id })
      .from(finAccount)
      .where(eq(finAccount.code, dto.code))
      .limit(1);
    if (dup.length > 0) {
      throw new ConflictException(`科目编码 ${dto.code} 已存在`);
    }
    try {
      const inserted = await this.db
        .insert(finAccount)
        .values({
          code: dto.code,
          name: dto.name,
          accountType: dto.accountType,
          status: 'active',
          remark: dto.remark,
        })
        .returning({ id: finAccount.id });
      return this.getAccountById(inserted[0].id);
    } catch (error) {
      if (this.extractPostgresErrorCode(error) === '23505') {
        throw new ConflictException(`科目编码 ${dto.code} 已存在`);
      }
      throw error;
    }
  }

  private async getAccountById(id: string): Promise<AccountItem> {
    const rows: AccountRow[] = await this.db
      .select({
        id: finAccount.id,
        code: finAccount.code,
        name: finAccount.name,
        accountType: finAccount.accountType,
        status: finAccount.status,
        remark: finAccount.remark,
        createdAt: finAccount.createdAt,
      })
      .from(finAccount)
      .where(eq(finAccount.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('科目不存在');
    return this.toAccountItem(rows[0]);
  }

  private extractPostgresErrorCode(error: unknown): string | undefined {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current; depth += 1) {
      if (typeof current !== 'object') break;
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === 'string') return code;
      current = cause;
    }
    return undefined;
  }

  /* ========== 凭证 ========== */

  private async assertPeriodOpen(period: string, action: string): Promise<void> {
    const closedRows = await this.db
      .select({ period: finPeriodClose.period })
      .from(finPeriodClose)
      .where(eq(finPeriodClose.period, period))
      .limit(1);
    if (closedRows.length > 0) {
      throw new BadRequestException(`期间 ${period} 已结账，禁止${action}`);
    }
  }

  private async getVoucherLines(
    voucherIds: string[]
  ): Promise<Map<string, VoucherLineRow[]>> {
    const result = new Map<string, VoucherLineRow[]>();
    if (voucherIds.length === 0) return result;
    const rows: VoucherLineRow[] = await this.db
      .select({
        id: finVoucherLine.id,
        voucherId: finVoucherLine.voucherId,
        accountId: finVoucherLine.accountId,
        accountCode: finAccount.code,
        accountName: finAccount.name,
        summary: finVoucherLine.summary,
        debit: finVoucherLine.debit,
        credit: finVoucherLine.credit,
      })
      .from(finVoucherLine)
      .leftJoin(finAccount, eq(finVoucherLine.accountId, finAccount.id))
      .where(inArray(finVoucherLine.voucherId, voucherIds));
    for (const row of rows) {
      const key = row.voucherId ?? '';
      result.set(key, [...(result.get(key) ?? []), row]);
    }
    return result;
  }

  private async getVoucherById(id: string): Promise<VoucherItem> {
    const rows: VoucherHeadRow[] = await this.db
      .select({
        id: finVoucher.id,
        code: finVoucher.code,
        voucherDate: finVoucher.voucherDate,
        period: finVoucher.period,
        summary: finVoucher.summary,
        sourceType: finVoucher.sourceType,
        sourceRef: finVoucher.sourceRef,
        status: finVoucher.status,
        remark: finVoucher.remark,
        createdAt: finVoucher.createdAt,
      })
      .from(finVoucher)
      .where(eq(finVoucher.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('凭证不存在');
    return this.buildVoucherItem(rows[0]);
  }

  private async buildVoucherItem(row: VoucherHeadRow): Promise<VoucherItem> {
    const lineMap = await this.getVoucherLines([row.id]);
    const lines = lineMap.get(row.id) ?? [];
    let totalDebit = 0;
    let totalCredit = 0;
    for (const line of lines) {
      totalDebit += Number(line.debit ?? 0);
      totalCredit += Number(line.credit ?? 0);
    }
    return {
      id: row.id,
      code: row.code,
      voucherDate: row.voucherDate,
      period: row.period ?? '',
      summary: row.summary,
      sourceType: (row.sourceType ??
        'manual') as VoucherItem['sourceType'],
      sourceRef: row.sourceRef,
      status: (row.status ?? 'draft') as VoucherStatus,
      remark: row.remark,
      lines: lines.map((line: VoucherLineRow) => ({
        id: line.id,
        accountId: line.accountId ?? '',
        accountCode: line.accountCode ?? '',
        accountName: line.accountName ?? '',
        summary: line.summary,
        debit: Number(line.debit ?? 0),
        credit: Number(line.credit ?? 0),
      })),
      totalDebit: round2(totalDebit),
      totalCredit: round2(totalCredit),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listVouchers(
    page: number,
    pageSize: number,
    status?: string,
    period?: string,
    sourceType?: string
  ): Promise<PagedResult<VoucherItem>> {
    const conditions = [];
    if (status) conditions.push(eq(finVoucher.status, status));
    if (period) conditions.push(eq(finVoucher.period, period));
    if (sourceType) conditions.push(eq(finVoucher.sourceType, sourceType));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(finVoucher)
      .where(where);
    const heads: VoucherHeadRow[] = await this.db
      .select({
        id: finVoucher.id,
        code: finVoucher.code,
        voucherDate: finVoucher.voucherDate,
        period: finVoucher.period,
        summary: finVoucher.summary,
        sourceType: finVoucher.sourceType,
        sourceRef: finVoucher.sourceRef,
        status: finVoucher.status,
        remark: finVoucher.remark,
        createdAt: finVoucher.createdAt,
      })
      .from(finVoucher)
      .where(where)
      .orderBy(desc(finVoucher.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const lineMap = await this.getVoucherLines(
      heads.map((row: VoucherHeadRow) => row.id)
    );
    const items: VoucherItem[] = [];
    for (const head of heads) {
      const lines = lineMap.get(head.id) ?? [];
      let totalDebit = 0;
      let totalCredit = 0;
      for (const line of lines) {
        totalDebit += Number(line.debit ?? 0);
        totalCredit += Number(line.credit ?? 0);
      }
      items.push({
        id: head.id,
        code: head.code,
        voucherDate: head.voucherDate,
        period: head.period ?? '',
        summary: head.summary,
        sourceType: (head.sourceType ?? 'manual') as VoucherSourceType,
        sourceRef: head.sourceRef,
        status: (head.status ?? 'draft') as VoucherStatus,
        remark: head.remark,
        lines: lines.map((line: VoucherLineRow) => ({
          id: line.id,
          accountId: line.accountId ?? '',
          accountCode: line.accountCode ?? '',
          accountName: line.accountName ?? '',
          summary: line.summary,
          debit: Number(line.debit ?? 0),
          credit: Number(line.credit ?? 0),
        })),
        totalDebit: round2(totalDebit),
        totalCredit: round2(totalCredit),
        createdAt: head.createdAt.toISOString(),
      });
    }
    return {
      items,
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  async createVoucher(dto: CreateVoucherDto): Promise<VoucherItem> {
    if (!PERIOD_PATTERN.test(dto.period)) {
      throw new BadRequestException('期间格式必须为 YYYY-MM');
    }
    if (!Array.isArray(dto.lines) || dto.lines.length < 2) {
      throw new BadRequestException('凭证分录至少 2 行');
    }
    let totalDebit = 0;
    let totalCredit = 0;
    for (const line of dto.lines) {
      totalDebit += Number(line.debit ?? 0);
      totalCredit += Number(line.credit ?? 0);
    }
    if (round2(totalDebit) !== round2(totalCredit)) {
      throw new BadRequestException(
        `借贷不平衡：借方合计 ${round2(totalDebit)}，贷方合计 ${round2(totalCredit)}`
      );
    }
    await this.assertPeriodOpen(dto.period, '新增凭证');

    const accountIds = Array.from(
      new Set(dto.lines.map((line) => line.accountId))
    );
    const accountRows = await this.db
      .select({ id: finAccount.id })
      .from(finAccount)
      .where(inArray(finAccount.id, accountIds));
    if (accountRows.length !== accountIds.length) {
      throw new BadRequestException('分录存在无效科目');
    }

    const code = await generateBizCode(
      this.db,
      finVoucher,
      finVoucher.code,
      'VCH'
    );
    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(finVoucher)
        .values({
          code,
          voucherDate: dto.voucherDate.slice(0, 10),
          period: dto.period,
          summary: dto.summary,
          sourceType: dto.sourceType ?? 'manual',
          sourceRef: dto.sourceRef,
          status: 'draft',
          remark: dto.remark,
        })
        .returning({ id: finVoucher.id });
      await tx.insert(finVoucherLine).values(
        dto.lines.map((line) => ({
          voucherId: inserted[0].id,
          accountId: line.accountId,
          summary: line.summary,
          debit: String(Number(line.debit ?? 0)),
          credit: String(Number(line.credit ?? 0)),
        }))
      );
    });
    const created = await this.db
      .select({ id: finVoucher.id })
      .from(finVoucher)
      .where(eq(finVoucher.code, code))
      .limit(1);
    return this.getVoucherById(created[0].id);
  }

  /** 状态机：post 仅 draft→posted；void 允许 draft|posted→voided */
  async voucherAction(id: string, action: VoucherAction): Promise<VoucherItem> {
    if (action !== 'post' && action !== 'void') {
      throw new BadRequestException(`非法的凭证操作：${action}`);
    }
    const rows: VoucherHeadRow[] = await this.db
      .select({
        id: finVoucher.id,
        code: finVoucher.code,
        voucherDate: finVoucher.voucherDate,
        period: finVoucher.period,
        summary: finVoucher.summary,
        sourceType: finVoucher.sourceType,
        sourceRef: finVoucher.sourceRef,
        status: finVoucher.status,
        remark: finVoucher.remark,
        createdAt: finVoucher.createdAt,
      })
      .from(finVoucher)
      .where(eq(finVoucher.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('凭证不存在');
    const voucher = rows[0];
    const current = (voucher.status ?? 'draft') as VoucherStatus;
    const period = voucher.period ?? '';

    await this.assertPeriodOpen(period, action === 'post' ? '过账' : '作废凭证');

    if (action === 'post') {
      if (current !== 'draft') {
        throw new BadRequestException(
          `非法的状态流转：${current} 状态不允许过账（仅草稿可过账）`
        );
      }
      const lineMap = await this.getVoucherLines([id]);
      const lines = lineMap.get(id) ?? [];
      let totalDebit = 0;
      let totalCredit = 0;
      for (const line of lines) {
        totalDebit += Number(line.debit ?? 0);
        totalCredit += Number(line.credit ?? 0);
      }
      if (round2(totalDebit) !== round2(totalCredit)) {
        throw new BadRequestException(
          `过账前借贷合计必须相等：借 ${round2(totalDebit)}，贷 ${round2(totalCredit)}`
        );
      }
    } else {
      if (current !== 'draft' && current !== 'posted') {
        throw new BadRequestException(
          `非法的状态流转：${current} 状态不允许作废`
        );
      }
    }

    const updated = await this.db
      .update(finVoucher)
      .set({
        status: action === 'post' ? 'posted' : 'voided',
        updatedAt: new Date(),
      })
      .where(eq(finVoucher.id, id))
      .returning({ id: finVoucher.id });
    if (updated.length === 0) throw new NotFoundException('凭证不存在');
    return this.getVoucherById(id);
  }

  /* ========== 期间 ========== */

  async listPeriods(): Promise<PeriodStatus[]> {
    const voucherRows: Array<{
      period: string | null;
      voucherCount: number;
      draftCount: number;
    }> = await this.db
      .select({
        period: finVoucher.period,
        voucherCount: sql<number>`count(*)::int`,
        draftCount: sql<number>`count(*) filter (where ${finVoucher.status} = 'draft')::int`,
      })
      .from(finVoucher)
      .groupBy(finVoucher.period);

    const amountRows: Array<{
      period: string | null;
      totalDebit: string | null;
      totalCredit: string | null;
    }> = await this.db
      .select({
        period: finVoucher.period,
        totalDebit: sql<string>`coalesce(sum(${finVoucherLine.debit}), 0)`,
        totalCredit: sql<string>`coalesce(sum(${finVoucherLine.credit}), 0)`,
      })
      .from(finVoucherLine)
      .innerJoin(finVoucher, eq(finVoucherLine.voucherId, finVoucher.id))
      .groupBy(finVoucher.period);

    const closedRows: Array<{ period: string }> = await this.db
      .select({ period: finPeriodClose.period })
      .from(finPeriodClose);

    const merged = new Map<
      string,
      {
        voucherCount: number;
        draftCount: number;
        totalDebit: number;
        totalCredit: number;
        closed: boolean;
      }
    >();
    for (const row of voucherRows) {
      const key = row.period ?? '';
      merged.set(key, {
        voucherCount: Number(row.voucherCount ?? 0),
        draftCount: Number(row.draftCount ?? 0),
        totalDebit: 0,
        totalCredit: 0,
        closed: false,
      });
    }
    for (const row of amountRows) {
      const key = row.period ?? '';
      const entry = merged.get(key) ?? {
        voucherCount: 0,
        draftCount: 0,
        totalDebit: 0,
        totalCredit: 0,
        closed: false,
      };
      entry.totalDebit = round2(Number(row.totalDebit ?? 0));
      entry.totalCredit = round2(Number(row.totalCredit ?? 0));
      merged.set(key, entry);
    }
    for (const row of closedRows) {
      const entry = merged.get(row.period) ?? {
        voucherCount: 0,
        draftCount: 0,
        totalDebit: 0,
        totalCredit: 0,
        closed: false,
      };
      entry.closed = true;
      merged.set(row.period, entry);
    }

    return Array.from(merged.entries())
      .filter(([period]) => PERIOD_PATTERN.test(period))
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([period, entry]) => ({
        period,
        voucherCount: entry.voucherCount,
        draftCount: entry.draftCount,
        totalDebit: entry.totalDebit,
        totalCredit: entry.totalCredit,
        balanced: entry.totalDebit === entry.totalCredit,
        closed: entry.closed,
      }));
  }

  async closePeriod(period: string, userId: string): Promise<PeriodStatus> {
    if (!PERIOD_PATTERN.test(period)) {
      throw new BadRequestException('期间格式必须为 YYYY-MM');
    }
    const closedRows = await this.db
      .select({ period: finPeriodClose.period })
      .from(finPeriodClose)
      .where(eq(finPeriodClose.period, period))
      .limit(1);
    if (closedRows.length > 0) {
      throw new BadRequestException(`期间 ${period} 已结账，不可重复结账`);
    }

    const draftRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(finVoucher)
      .where(and(eq(finVoucher.period, period), eq(finVoucher.status, 'draft')));
    if (Number(draftRows[0]?.total ?? 0) > 0) {
      throw new BadRequestException(`期间 ${period} 存在草稿凭证，不可结账`);
    }

    const amountRows: Array<{
      totalDebit: string | null;
      totalCredit: string | null;
    }> = await this.db
      .select({
        totalDebit: sql<string>`coalesce(sum(${finVoucherLine.debit}), 0)`,
        totalCredit: sql<string>`coalesce(sum(${finVoucherLine.credit}), 0)`,
      })
      .from(finVoucherLine)
      .innerJoin(finVoucher, eq(finVoucherLine.voucherId, finVoucher.id))
      .where(eq(finVoucher.period, period));
    const totalDebit = round2(Number(amountRows[0]?.totalDebit ?? 0));
    const totalCredit = round2(Number(amountRows[0]?.totalCredit ?? 0));
    if (totalDebit !== totalCredit) {
      throw new BadRequestException(
        `期间 ${period} 试算不平衡：借方合计 ${totalDebit}，贷方合计 ${totalCredit}`
      );
    }

    const inserted = await this.db
      .insert(finPeriodClose)
      .values({ period, closedBy: userId })
      .returning({ period: finPeriodClose.period });
    if (inserted.length === 0) {
      throw new NotFoundException('期间结账写入失败');
    }

    const voucherCountRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(finVoucher)
      .where(eq(finVoucher.period, period));
    return {
      period,
      voucherCount: Number(voucherCountRows[0]?.total ?? 0),
      draftCount: 0,
      totalDebit,
      totalCredit,
      balanced: true,
      closed: true,
    };
  }
}
