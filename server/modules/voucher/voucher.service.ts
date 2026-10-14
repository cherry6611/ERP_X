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
  astAsset,
  crmQuotation,
  erpApBill,
  erpAr,
  erpContract,
  erpInvoice,
  erpPayment,
  erpProjectCost,
  erpProjectRevenue,
  erpReceipt,
  finAccount,
  finAuxDimension,
  finExpenseClaim,
  finPeriodClose,
  finPeriodCloseAudit,
  finVoucher,
  finVoucherLine,
  finVoucherLineAux,
  hrPayroll,
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
  VoucherLineAuxItem,
  VoucherSourceRef,
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
  parentCode: string | null;
  level: number;
  isLeaf: number;
  direction: string | null;
  auxRequired: string | null;
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
  aux?: VoucherLineAuxItem[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 解析 fin_account.aux_required（JSON 数组字符串），异常值按"无要求"处理 */
function parseAuxRequired(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/** A-10：科目类型 → 默认余额方向 */
function defaultDirection(accountType: string): 'debit' | 'credit' {
  return accountType === 'liability' ||
    accountType === 'equity' ||
    accountType === 'revenue' ||
    accountType === 'income'
    ? 'credit'
    : 'debit';
}

/** 科目查询列（listAccounts / getAccountById 共用） */
const ACCOUNT_SELECT = {
  id: finAccount.id,
  code: finAccount.code,
  name: finAccount.name,
  accountType: finAccount.accountType,
  status: finAccount.status,
  remark: finAccount.remark,
  createdAt: finAccount.createdAt,
  parentCode: finAccount.parentCode,
  level: finAccount.level,
  isLeaf: finAccount.isLeaf,
  direction: finAccount.direction,
  auxRequired: finAccount.auxRequired,
} as const;

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
      parentCode: row.parentCode ?? null,
      level: Number(row.level ?? 1),
      isLeaf: Number(row.isLeaf ?? 1) === 1,
      direction: (row.direction ?? 'debit') as AccountItem['direction'],
      auxRequired: parseAuxRequired(row.auxRequired),
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
    const rows = await this.db
      .select(ACCOUNT_SELECT)
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
    let level = 1;
    if (dto.parentCode) {
      const parent = await this.db
        .select({ id: finAccount.id, level: finAccount.level })
        .from(finAccount)
        .where(eq(finAccount.code, dto.parentCode))
        .limit(1);
      if (parent.length === 0) {
        throw new BadRequestException(`上级科目 ${dto.parentCode} 不存在`);
      }
      level = Number(parent[0].level ?? 1) + 1;
    }
    try {
      const inserted = await this.db
        .insert(finAccount)
        .values({
          code: dto.code,
          name: dto.name,
          accountType: dto.accountType,
          status: 'active',
          parentCode: dto.parentCode,
          level,
          isLeaf: 1,
          direction: dto.direction ?? defaultDirection(dto.accountType),
          auxRequired: JSON.stringify(dto.auxRequired ?? []),
          remark: dto.remark,
        })
        .returning({ id: finAccount.id });
      // A-10：父科目变成非末级，不再允许直接做账
      if (dto.parentCode) {
        await this.db
          .update(finAccount)
          .set({ isLeaf: 0, updatedAt: new Date() })
          .where(eq(finAccount.code, dto.parentCode));
      }
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
      .select(ACCOUNT_SELECT)
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
      .where(inArray(finVoucherLine.voucherId, voucherIds))
      // 排序必须稳定：同一事务写入的多个分录 `_created_at` 完全相同，
      // 仅按 id（随机 uuid）排序会导致凭证分录展示顺序随机（复现为"同一张凭证
      // 刷新两次分录顺序不同"）。这里再按借方降序、科目编码兜底，
      // 与会计惯例（先借后贷）一致且对同一凭证恒定。
      .orderBy(
        asc(finVoucherLine.createdAt),
        desc(finVoucherLine.debit),
        asc(finVoucherLine.accountCode),
        asc(finVoucherLine.id)
      );
    const auxMap = await this.getLineAux(rows.map((row) => row.id));
    for (const row of rows) {
      row.aux = auxMap.get(row.id) ?? [];
      const key = row.voucherId ?? '';
      result.set(key, [...(result.get(key) ?? []), row]);
    }
    return result;
  }

  /** A-05：批量读取凭证行的辅助核算值（含维度名称） */
  private async getLineAux(
    lineIds: string[]
  ): Promise<Map<string, VoucherLineAuxItem[]>> {
    const result = new Map<string, VoucherLineAuxItem[]>();
    if (lineIds.length === 0) return result;
    const rows: Array<{
      lineId: string | null;
      dimensionCode: string;
      dimensionId: string | null;
      dimensionValue: string | null;
      dimensionName: string | null;
    }> = await this.db
      .select({
        lineId: finVoucherLineAux.lineId,
        dimensionCode: finVoucherLineAux.dimensionCode,
        dimensionId: finVoucherLineAux.dimensionId,
        dimensionValue: finVoucherLineAux.dimensionValue,
        dimensionName: finAuxDimension.name,
      })
      .from(finVoucherLineAux)
      .leftJoin(
        finAuxDimension,
        eq(finVoucherLineAux.dimensionCode, finAuxDimension.code)
      )
      .where(inArray(finVoucherLineAux.lineId, lineIds));
    for (const row of rows) {
      const key = row.lineId ?? '';
      result.set(key, [
        ...(result.get(key) ?? []),
        {
          dimensionCode: row.dimensionCode,
          dimensionName: row.dimensionName ?? null,
          dimensionId: row.dimensionId ?? null,
          dimensionValue: row.dimensionValue ?? null,
        },
      ]);
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
        aux: line.aux ?? [],
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
          aux: line.aux ?? [],
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
    const voucherDate = dto.voucherDate.slice(0, 10);
    if (voucherDate.slice(0, 7) !== dto.period) {
      throw new BadRequestException(
        `凭证日期 ${voucherDate} 与会计期间 ${dto.period} 不一致`,
      );
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
      .select({
        id: finAccount.id,
        code: finAccount.code,
        name: finAccount.name,
        status: finAccount.status,
        isLeaf: finAccount.isLeaf,
        auxRequired: finAccount.auxRequired,
      })
      .from(finAccount)
      .where(inArray(finAccount.id, accountIds));
    if (accountRows.length !== accountIds.length) {
      throw new BadRequestException('分录存在无效科目');
    }
    const accountById = new Map(accountRows.map((row) => [row.id, row]));
    for (const id of accountIds) {
      const account = accountById.get(id);
      if (!account) continue;
      if ((account.status ?? 'active') !== 'active') {
        throw new BadRequestException(`科目 ${account.code} 已停用，不可做账`);
      }
      // A-10：只能对末级科目做账
      if (Number(account.isLeaf ?? 1) !== 1) {
        throw new BadRequestException(
          `科目 ${account.code} ${account.name} 为非末级（汇总）科目，不可直接做账；请选择其明细科目`
        );
      }
    }
    // A-05：科目要求的辅助核算维度必须填写
    for (const line of dto.lines) {
      const account = accountById.get(line.accountId);
      const required = parseAuxRequired(account?.auxRequired);
      if (required.length === 0) continue;
      const provided = new Set(
        (line.auxDimensions ?? []).map((item) => item.dimensionCode)
      );
      const missing = required.filter((code) => !provided.has(code));
      if (missing.length > 0) {
        throw new BadRequestException(
          `科目 ${account?.code ?? ''} 要求填写辅助核算维度：${missing.join('、')}`
        );
      }
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
          voucherDate,
          period: dto.period,
          summary: dto.summary,
          sourceType: dto.sourceType ?? 'manual',
          sourceRef: dto.sourceRef,
          status: 'draft',
          remark: dto.remark,
        })
        .returning({ id: finVoucher.id });
      const lineRows = await tx
        .insert(finVoucherLine)
        .values(
          dto.lines.map((line) => ({
            voucherId: inserted[0].id,
            accountId: line.accountId,
            accountCode: accountById.get(line.accountId)?.code ?? null,
            summary: line.summary,
            debit: String(Number(line.debit ?? 0)),
            credit: String(Number(line.credit ?? 0)),
          }))
        )
        .returning({ id: finVoucherLine.id });
      // A-05：写入辅助核算值（按行序一一对应）
      const auxValues: Array<{
        lineId: string;
        voucherId: string;
        dimensionCode: string;
        dimensionId: string | null;
        dimensionValue: string | null;
      }> = [];
      dto.lines.forEach((line, index) => {
        const lineId = lineRows[index]?.id;
        if (!lineId) return;
        for (const aux of line.auxDimensions ?? []) {
          auxValues.push({
            lineId,
            voucherId: inserted[0].id,
            dimensionCode: aux.dimensionCode,
            dimensionId: aux.dimensionId ?? null,
            dimensionValue: aux.dimensionValue ?? null,
          });
        }
      });
      if (auxValues.length > 0) {
        await tx.insert(finVoucherLineAux).values(auxValues);
      }
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
    // F9：期间汇总排除作废凭证
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
      .where(sql`${finVoucher.status} <> 'voided'`)
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
      .where(sql`${finVoucher.status} <> 'voided'`)
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
      .where(
        and(
          eq(finVoucher.period, period),
          sql`${finVoucher.status} <> 'voided'`,
        ),
      );
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
      .where(
        and(
          eq(finVoucher.period, period),
          sql`${finVoucher.status} <> 'voided'`,
        ),
      );
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

  /** 反结账：仅 admin；若存在更晚期间已结账则拒绝 */
  async unclosePeriod(
    period: string,
    userId: string,
    remark?: string,
  ): Promise<PeriodStatus> {
    if (!PERIOD_PATTERN.test(period)) {
      throw new BadRequestException('期间格式必须为 YYYY-MM');
    }
    const closedRows = await this.db
      .select({ period: finPeriodClose.period })
      .from(finPeriodClose)
      .where(eq(finPeriodClose.period, period))
      .limit(1);
    if (closedRows.length === 0) {
      throw new BadRequestException(`期间 ${period} 未结账，无需反结账`);
    }
    const later = await this.db
      .select({ period: finPeriodClose.period })
      .from(finPeriodClose)
      .where(sql`${finPeriodClose.period} > ${period}`)
      .limit(1);
    if (later.length > 0) {
      throw new BadRequestException(
        `存在更晚已结账期间 ${later[0].period}，请先反结账后续期间`,
      );
    }
    await this.db
      .delete(finPeriodClose)
      .where(eq(finPeriodClose.period, period));
    await this.db.insert(finPeriodCloseAudit).values({
      period,
      action: 'unclose',
      actorUserId: userId,
      remark: remark ?? null,
    });
    const list = await this.listPeriods();
    const found = list.find((p) => p.period === period);
    return (
      found ?? {
        period,
        voucherCount: 0,
        draftCount: 0,
        totalDebit: 0,
        totalCredit: 0,
        balanced: true,
        closed: false,
      }
    );
  }

  /* ========== A-11：来源单据关联与分录备注 ========== */

  /**
   * 把 `source_type` + `source_ref` 解析为可跳转的单据引用。
   *
   * 为什么需要：审计要求"凭证可追溯到原始单据"，而 `fin_voucher.source_ref`
   * 是自由文本。实际形态（全仓 grep 实测，见下表）：
   *   `invoice:{invoiceNo|code}` / `receipt:{code}` / `receipt-void:{code}`
   *   `payment:{code}` / `payment-void:{code}` / `ar:{code}` / `ap:{code}`
   *   `expense:{code}` / `payroll:{code}` / `accrual-reverse:{code}:{projectId}`
   *   `revenue:{code}` / `revenue-reverse:{code}` / `revenue-adjust:{code}`
   *   `cost:{code}` / `cost-void:{code}` / `timesheet:{code}` / `allocation:{code}`
   *   `asset:{code}` / `po:{orderCode}:{apCode}` / `po-accept:{orderCode}:{apCode}`
   *   `quotation:{code}` / `change:{code}`
   *
   * 解析策略：**按业务编码格式**（前缀 + YYYYMM + 流水）提取编码，
   * 再查对应表拿主键（uuid），从而给出可直接打开的详情页链接；
   * 查不到记录时 url 为 null（前端展示"未关联到具体单据"而非死链）。
   */
  async resolveSourceRef(id: string): Promise<VoucherSourceRef> {
    const rows = await this.db
      .select({
        sourceType: finVoucher.sourceType,
        sourceRef: finVoucher.sourceRef,
      })
      .from(finVoucher)
      .where(eq(finVoucher.id, id))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundException('凭证不存在');
    }
    const sourceType = (rows[0].sourceType ?? 'manual') as VoucherSourceType;
    const sourceRef = rows[0].sourceRef;

    // 业务编码统一为「2~6 位大写字母 + 6 位年月 + 3~6 位流水」。
    // 用全局匹配取**第一个**业务编码：`po:PO2026100001:APB2026100001`
    // 的第一个编码是采购订单（更贴近"原始单据"），符合审计追溯方向。
    const codes = sourceRef
      ? [...sourceRef.matchAll(/([A-Z]{2,6}\d{6}\d{3,6})/g)].map((m) => m[1])
      : [];
    const bizCode = codes[0] ?? null;

    /** 来源类型 → 业务类型、标题、按编码反查主键并拼路由 */
    const spec: Record<
      string,
      {
        bizType: string;
        label: string;
        resolve: (code: string) => Promise<string | null>;
      }
    > = {
      invoice: {
        bizType: 'invoice',
        label: '发票',
        resolve: async (code) => {
          const hit = await this.db
            .select({ id: erpInvoice.id })
            .from(erpInvoice)
            .where(
              sql`(${erpInvoice.code} = ${code} OR ${erpInvoice.invoiceNo} = ${code})`
            )
            .limit(1);
          return hit[0] ? `/finance/invoices/${hit[0].id}` : null;
        },
      },
      receipt: {
        bizType: 'receipt',
        label: '回款单',
        resolve: async (code) => {
          const hit = await this.db
            .select({ id: erpReceipt.id })
            .from(erpReceipt)
            .where(sql`${erpReceipt.code} = ${code}`)
            .limit(1);
          return hit[0]
            ? `/finance?tab=ar&receiptId=${hit[0].id}`
            : `/finance?tab=ar&highlight=${code}`;
        },
      },
      payment: {
        bizType: 'payment',
        label: '付款单',
        resolve: async (code) => {
          const hit = await this.db
            .select({ id: erpPayment.id })
            .from(erpPayment)
            .where(sql`${erpPayment.code} = ${code}`)
            .limit(1);
          return hit[0]
            ? `/finance?tab=ap&paymentId=${hit[0].id}`
            : `/finance?tab=ap&highlight=${code}`;
        },
      },
      ar: {
        bizType: 'ar',
        label: '应收单',
        resolve: async (code) => {
          const hit = await this.db
            .select({ id: erpAr.id })
            .from(erpAr)
            .where(sql`${erpAr.code} = ${code}`)
            .limit(1);
          return hit[0]
            ? `/finance?tab=ar&arId=${hit[0].id}`
            : `/finance?tab=ar&highlight=${code}`;
        },
      },
      ap: {
        bizType: 'ap',
        label: '应付单',
        resolve: async (code) => {
          const hit = await this.db
            .select({ id: erpApBill.id })
            .from(erpApBill)
            .where(sql`${erpApBill.code} = ${code}`)
            .limit(1);
          return hit[0]
            ? `/finance?tab=ap&apId=${hit[0].id}`
            : `/finance?tab=ap&highlight=${code}`;
        },
      },
      cost: {
        bizType: 'cost',
        label: '项目成本',
        resolve: async (code) => {
          const hit = await this.db
            .select({ id: erpProjectCost.id, projectId: erpProjectCost.projectId })
            .from(erpProjectCost)
            .where(sql`${erpProjectCost.code} = ${code}`)
            .limit(1);
          return hit[0]?.projectId
            ? `/projects/${hit[0].projectId}`
            : hit[0]
              ? `/costs?highlight=${code}`
              : null;
        },
      },
      expense: {
        bizType: 'expense_claim',
        label: '报销单',
        resolve: async (code) => {
          const hit = await this.db
            .select({ id: finExpenseClaim.id })
            .from(finExpenseClaim)
            .where(sql`${finExpenseClaim.code} = ${code}`)
            .limit(1);
          return hit[0] ? `/fin-expense/claims/${hit[0].id}` : null;
        },
      },
      payroll: {
        bizType: 'payroll',
        label: '工资单',
        resolve: async (code) => {
          const hit = await this.db
            .select({ id: hrPayroll.id })
            .from(hrPayroll)
            .where(sql`${hrPayroll.code} = ${code}`)
            .limit(1);
          return hit[0] ? `/hr?tab=payroll&payrollId=${hit[0].id}` : null;
        },
      },
      depreciation: {
        bizType: 'asset',
        label: '资产折旧',
        resolve: async (code) => {
          const hit = await this.db
            .select({ id: astAsset.id })
            .from(astAsset)
            .where(sql`${astAsset.code} = ${code}`)
            .limit(1);
          return hit[0] ? `/asset?assetId=${hit[0].id}` : null;
        },
      },
      revenue: {
        bizType: 'revenue',
        label: '收入确认',
        resolve: async (code) => {
          const hit = await this.db
            .select({ id: erpProjectRevenue.id, projectId: erpProjectRevenue.projectId })
            .from(erpProjectRevenue)
            .where(sql`${erpProjectRevenue.code} = ${code}`)
            .limit(1);
          return hit[0]?.projectId ? `/projects/${hit[0].projectId}` : null;
        },
      },
      quotation: {
        bizType: 'quotation',
        label: '报价单',
        resolve: async (code) => {
          const hit = await this.db
            .select({ id: crmQuotation.id })
            .from(crmQuotation)
            .where(sql`${crmQuotation.code} = ${code}`)
            .limit(1);
          return hit[0] ? `/crm/quotations/${hit[0].id}` : null;
        },
      },
      change: {
        bizType: 'contract_change',
        label: '合同变更',
        resolve: async (code) => {
          const hit = await this.db
            .select({ id: erpContract.id })
            .from(erpContract)
            .where(sql`${erpContract.code} = ${code}`)
            .limit(1);
          return hit[0] ? `/contracts/${hit[0].id}` : null;
        },
      },
      manual: { bizType: 'manual', label: '手工录入', resolve: async () => null },
    };

    const matched = spec[sourceType];
    const label = matched?.label ?? sourceType;
    const bizId = matched && bizCode ? await matched.resolve(bizCode) : null;
    return {
      sourceType,
      bizType: matched?.bizType ?? sourceType,
      // bizId 语义为"业务单据主键"，这里只在确实反查到 uuid 时给出；
      // 为避免把路由字符串误当主键，统一返回 null（路由信息在 url 字段）。
      bizId: null,
      sourceRef,
      bizCode,
      title: bizCode ? `${label} ${bizCode}` : label,
      url: bizId,
      manual: sourceType === 'manual' || bizCode === null,
    };
  }

  /**
   * A-11：凭证行备注（摘要）编辑。
   *
   * 仅草稿凭证可改：已过账凭证的分录摘要属于已入账信息，
   * 修改必须走"红冲 + 重开"，否则账证不符（会计基础工作规范）。
   */
  async updateVoucherLine(
    voucherId: string,
    lineId: string,
    dto: { summary?: string }
  ): Promise<VoucherItem> {
    const rows = await this.db
      .select({ status: finVoucher.status })
      .from(finVoucher)
      .where(eq(finVoucher.id, voucherId))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('凭证不存在');
    const status = (rows[0].status ?? 'draft') as VoucherStatus;
    if (status !== 'draft') {
      throw new BadRequestException(
        `凭证当前状态为 ${status}，仅草稿凭证可修改分录摘要；已过账凭证请先作废并重开`
      );
    }
    const lineRows = await this.db
      .select({ id: finVoucherLine.id, voucherId: finVoucherLine.voucherId })
      .from(finVoucherLine)
      .where(and(eq(finVoucherLine.id, lineId), eq(finVoucherLine.voucherId, voucherId)))
      .limit(1);
    if (lineRows.length === 0) {
      throw new NotFoundException('分录不存在或不属于该凭证');
    }
    await this.db
      .update(finVoucherLine)
      .set({ summary: dto.summary ?? null, updatedAt: new Date() })
      .where(eq(finVoucherLine.id, lineId));
    return this.getVoucherById(voucherId);
  }
}
