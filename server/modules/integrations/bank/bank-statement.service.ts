import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import {
  erpBankStatement,
  erpBankStatementMatch,
  erpPayment,
  erpReceipt,
  finVoucher,
  mdBankAccount,
  mdCustomer,
  mdSupplier,
} from '@server/database/schema';
import { unwrapRows } from '@server/common/utils/rows';
import { assertLocalUploadFile } from '@server/common/security/upload-policy';
import { parseImportFile } from './bank-import.parser';
import {
  bestMatch,
  computeMatchRate,
  parseStatementRows,
  round2,
  type MatchCandidate,
} from './bank-statement.logic';
import { BankAccountService } from './bank-account.service';
import type {
  AutoMatchResult,
  BankMatchBizType,
  BankStatementImportError,
  BankStatementImportResult,
  BankStatementItem,
  BankStatementMapping,
  BankStatementMatchStat,
  BankStatementMatchStatus,
  ManualMatchBankStatementDto,
  PagedResult,
} from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 上传文件的最小结构（与 multer 的 File 结构兼容，避免依赖 @types/multer 全局声明） */
export interface UploadedFileLike {
  originalname: string;
  size: number;
  buffer: Buffer;
}

export interface BankStatementRowRaw {
  id: string;
  bankAccountId: string;
  transactionDate: string;
  direction: string;
  amount: string | null;
  balance: string | null;
  counterpartyName: string | null;
  counterpartyAccount: string | null;
  summary: string | null;
  transactionNo: string | null;
  dedupeKey: string;
  matchStatus: string;
  bizType: string | null;
  bizId: string | null;
  bizCode: string | null;
  matchScore: string | null;
  remark: string | null;
  createdAt: Date;
  bankAccountName: string | null;
}

/** 期间起止日期（业务时区口径，纯字符串运算，无时区歧义） */
export function periodRange(period: string): { from: string; to: string } {
  if (!PERIOD_PATTERN.test(period)) {
    throw new BadRequestException('期间格式必须为 YYYY-MM');
  }
  const [yearText, monthText] = period.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${yearText}-${monthText}-01`,
    to: `${yearText}-${monthText}-${String(lastDay).padStart(2, '0')}`,
  };
}

/**
 * C-02 银行流水：导入（去重）、匹配、未匹配清单与人工关联。
 *
 * 去重双保险：应用层先按 (账户, dedupeKey) 查已存在键，数据库唯一索引兜底
 * （并发导入时由 onConflictDoNothing 保证不重复写入）。
 */
@Injectable()
export class BankStatementService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly bankAccounts: BankAccountService
  ) {}

  /* ==================== 查询 ==================== */

  private baseQuery() {
    return this.db
      .select({
        id: erpBankStatement.id,
        bankAccountId: erpBankStatement.bankAccountId,
        transactionDate: erpBankStatement.transactionDate,
        direction: erpBankStatement.direction,
        amount: erpBankStatement.amount,
        balance: erpBankStatement.balance,
        counterpartyName: erpBankStatement.counterpartyName,
        counterpartyAccount: erpBankStatement.counterpartyAccount,
        summary: erpBankStatement.summary,
        transactionNo: erpBankStatement.transactionNo,
        dedupeKey: erpBankStatement.dedupeKey,
        matchStatus: erpBankStatement.matchStatus,
        bizType: erpBankStatement.bizType,
        bizId: erpBankStatement.bizId,
        bizCode: erpBankStatement.bizCode,
        matchScore: erpBankStatement.matchScore,
        remark: erpBankStatement.remark,
        createdAt: erpBankStatement.createdAt,
        bankAccountName: mdBankAccount.name,
      })
      .from(erpBankStatement)
      .leftJoin(mdBankAccount, eq(erpBankStatement.bankAccountId, mdBankAccount.id));
  }

  private toItem(row: BankStatementRowRaw): BankStatementItem {
    return {
      id: row.id,
      bankAccountId: row.bankAccountId,
      bankAccountName: row.bankAccountName,
      transactionDate: row.transactionDate,
      direction: row.direction === 'expense' ? 'expense' : 'income',
      amount: round2(Number(row.amount ?? 0)),
      balance: row.balance === null ? null : round2(Number(row.balance)),
      counterpartyName: row.counterpartyName,
      counterpartyAccount: row.counterpartyAccount,
      summary: row.summary,
      transactionNo: row.transactionNo,
      dedupeKey: row.dedupeKey,
      matchStatus: (row.matchStatus ?? 'unmatched') as BankStatementMatchStatus,
      bizType: (row.bizType ?? null) as BankMatchBizType | null,
      bizId: row.bizId,
      bizCode: row.bizCode,
      matchScore: row.matchScore === null ? null : round2(Number(row.matchScore)),
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listStatements(params: {
    bankAccountId?: string;
    period?: string;
    matchStatus?: BankStatementMatchStatus;
    page?: number;
    pageSize?: number;
  }): Promise<PagedResult<BankStatementItem>> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 20));
    const conditions = [];
    if (params.bankAccountId) {
      conditions.push(eq(erpBankStatement.bankAccountId, params.bankAccountId));
    }
    if (params.period) {
      const range = periodRange(params.period);
      conditions.push(gte(erpBankStatement.transactionDate, range.from));
      conditions.push(lte(erpBankStatement.transactionDate, range.to));
    }
    if (params.matchStatus) {
      conditions.push(eq(erpBankStatement.matchStatus, params.matchStatus));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(erpBankStatement)
      .where(where);
    const total = Number(totalRows[0]?.total ?? 0);

    const rows: BankStatementRowRaw[] = await this.baseQuery()
      .where(where)
      .orderBy(desc(erpBankStatement.transactionDate), asc(erpBankStatement.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items: rows.map((row) => this.toItem(row)), total, page, pageSize };
  }

  /** 未匹配流水清单（unmatched + ignored 之外的状态；用于人工核对） */
  async listUnmatched(params: {
    bankAccountId?: string;
    period?: string;
    page?: number;
    pageSize?: number;
  }): Promise<PagedResult<BankStatementItem>> {
    return this.listStatements({
      bankAccountId: params.bankAccountId,
      period: params.period,
      matchStatus: 'unmatched',
      page: params.page,
      pageSize: params.pageSize,
    });
  }

  async getStatement(id: string): Promise<BankStatementItem> {
    const rows: BankStatementRowRaw[] = await this.baseQuery()
      .where(eq(erpBankStatement.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('银行流水不存在');
    return this.toItem(rows[0]);
  }

  async matchStatistic(params: {
    bankAccountId?: string;
    period?: string;
  }): Promise<BankStatementMatchStat> {
    const conditions = [];
    if (params.bankAccountId) {
      conditions.push(eq(erpBankStatement.bankAccountId, params.bankAccountId));
    }
    if (params.period) {
      const range = periodRange(params.period);
      conditions.push(gte(erpBankStatement.transactionDate, range.from));
      conditions.push(lte(erpBankStatement.transactionDate, range.to));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows: Array<{ status: string; total: number }> = await this.db
      .select({ status: erpBankStatement.matchStatus, total: count() })
      .from(erpBankStatement)
      .where(where)
      .groupBy(erpBankStatement.matchStatus);
    let matched = 0;
    let unmatched = 0;
    let ignored = 0;
    for (const row of rows) {
      const total = Number(row.total ?? 0);
      if (row.status === 'matched' || row.status === 'manual') matched += total;
      else if (row.status === 'ignored') ignored += total;
      else unmatched += total;
    }
    const total = matched + unmatched + ignored;
    return {
      bankAccountId: params.bankAccountId ?? null,
      period: params.period ?? null,
      total,
      matched,
      unmatched,
      ignored,
      matchRate: computeMatchRate(total, matched, ignored),
    };
  }

  /* ==================== 导入 ==================== */

  async importStatements(input: {
    bankAccountId: string;
    file: UploadedFileLike;
    mapping: BankStatementMapping;
    remark?: string;
    autoMatch?: boolean;
  }): Promise<BankStatementImportResult> {
    const account = await this.bankAccounts.getAccount(input.bankAccountId);
    assertLocalUploadFile(input.file);
    if (!input.mapping?.transactionDate || !input.mapping?.amount) {
      throw new BadRequestException('字段映射必须包含交易日期列与金额列');
    }

    // 外部文件解析：在解析前后都不持有数据库事务（C-07/B-22 约束），
    // 解析为纯 CPU 操作，落库才是数据库写入。
    const table = await parseImportFile(input.file.originalname, input.file.buffer, {
      sheetName: input.mapping.sheetName,
      hasHeader: input.mapping.hasHeader !== false,
    }).catch((error: unknown) => {
      throw new BadRequestException(
        `文件解析失败：${error instanceof Error ? error.message : String(error)}`
      );
    });

    const parsed = parseStatementRows(table.rows, input.mapping);
    if (parsed.rows.length === 0) {
      throw new BadRequestException(
        parsed.errors.length > 0
          ? `没有可导入的有效流水：${parsed.errors[0].reason}`
          : '文件中没有数据行'
      );
    }

    const dedupeKeys = parsed.rows.map((row) => row.dedupeKey);
    const existing: Array<{ dedupeKey: string }> = await this.db
      .select({ dedupeKey: erpBankStatement.dedupeKey })
      .from(erpBankStatement)
      .where(
        and(
          eq(erpBankStatement.bankAccountId, input.bankAccountId),
          inArray(erpBankStatement.dedupeKey, dedupeKeys)
        )
      );
    const existingKeys = new Set(existing.map((row) => row.dedupeKey));
    const fresh = parsed.rows.filter((row) => !existingKeys.has(row.dedupeKey));
    const duplicated = parsed.rows.length - fresh.length;

    const errors: BankStatementImportError[] = parsed.errors.map((error) => ({
      row: error.row,
      reason: error.reason,
    }));
    if (duplicated > 0) {
      errors.push({
        row: 0,
        reason: `跳过 ${String(duplicated)} 条重复流水（按交易流水号/业务指纹去重）`,
      });
    }

    const importBatch = `IMP${Date.now().toString(36).toUpperCase()}`;
    let imported = 0;
    if (fresh.length > 0) {
      const values = fresh.map((row) => ({
        bankAccountId: input.bankAccountId,
        transactionDate: row.transactionDate,
        direction: row.direction,
        amount: String(row.amount),
        balance: row.balance === null ? null : String(row.balance),
        counterpartyName: row.counterpartyName,
        counterpartyAccount: row.counterpartyAccount,
        summary: row.summary,
        transactionNo: row.transactionNo,
        dedupeKey: row.dedupeKey,
        matchStatus: 'unmatched',
        importBatch,
        remark: input.remark ?? null,
      }));
      // 分批写入，避免单条 SQL 参数过多（PostgreSQL 上限 65535）
      for (let offset = 0; offset < values.length; offset += 500) {
        const chunk = values.slice(offset, offset + 500);
        const inserted = await this.db
          .insert(erpBankStatement)
          .values(chunk)
          .onConflictDoNothing({
            target: [erpBankStatement.bankAccountId, erpBankStatement.dedupeKey],
          })
          .returning({ id: erpBankStatement.id });
        imported += inserted.length;
      }
      if (imported < fresh.length) {
        errors.push({
          row: 0,
          reason: `并发导入导致 ${String(fresh.length - imported)} 条被唯一索引拦截，未重复写入`,
        });
      }
    }

    const autoMatch =
      input.autoMatch === false
        ? { scanned: 0, matched: 0, details: [] }
        : await this.autoMatch({
            bankAccountId: input.bankAccountId,
            importBatch,
          });

    return {
      bankAccountId: input.bankAccountId,
      totalRows: table.rows.length,
      imported,
      duplicated,
      invalid: parsed.errors.length,
      errors: errors.slice(0, 50),
      match: await this.matchStatistic({ bankAccountId: input.bankAccountId }),
    };
  }

  /* ==================== 自动匹配 ==================== */

  /** 拉取候选单据：收付款单（含对方名称）与已记账凭证 */
  private async loadCandidates(input: {
    from: string;
    to: string;
  }): Promise<MatchCandidate[]> {
    const [receipts, payments, vouchers] = await Promise.all([
      this.db
        .select({
          id: erpReceipt.id,
          code: erpReceipt.code,
          amount: erpReceipt.amount,
          receiptDate: erpReceipt.receiptDate,
          customerName: mdCustomer.name,
          remark: erpReceipt.remark,
        })
        .from(erpReceipt)
        .leftJoin(mdCustomer, eq(erpReceipt.customerId, mdCustomer.id))
        .where(
          and(
            gte(erpReceipt.receiptDate, input.from),
            lte(erpReceipt.receiptDate, input.to)
          )
        ),
      this.db
        .select({
          id: erpPayment.id,
          code: erpPayment.code,
          amount: erpPayment.amount,
          payDate: erpPayment.payDate,
          supplierName: mdSupplier.name,
          remark: erpPayment.remark,
        })
        .from(erpPayment)
        .leftJoin(mdSupplier, eq(erpPayment.supplierId, mdSupplier.id))
        .where(
          and(gte(erpPayment.payDate, input.from), lte(erpPayment.payDate, input.to))
        ),
      this.db
        .select({
          id: finVoucher.id,
          code: finVoucher.code,
          voucherDate: finVoucher.voucherDate,
          summary: finVoucher.summary,
          amount: sql<string>`(
            SELECT coalesce(sum(l.debit), 0) FROM fin_voucher_line l
            WHERE l.voucher_id = ${finVoucher.id}
              AND (l.account_code LIKE '1001%' OR l.account_code LIKE '1002%')
          )`,
        })
        .from(finVoucher)
        .where(
          and(
            gte(finVoucher.voucherDate, input.from),
            lte(finVoucher.voucherDate, input.to),
            sql`${finVoucher.status} <> 'voided'`
          )
        ),
    ]);

    const candidates: MatchCandidate[] = [];
    for (const row of receipts) {
      if (!row.receiptDate) continue;
      candidates.push({
        bizType: 'receipt',
        bizId: row.id,
        bizCode: row.code,
        amount: Number(row.amount ?? 0),
        date: row.receiptDate,
        texts: [row.code, row.customerName, row.remark],
      });
    }
    for (const row of payments) {
      if (!row.payDate) continue;
      candidates.push({
        bizType: 'payment',
        bizId: row.id,
        bizCode: row.code,
        amount: Number(row.amount ?? 0),
        date: row.payDate,
        texts: [row.code, row.supplierName, row.remark],
      });
    }
    for (const row of vouchers) {
      if (!row.voucherDate) continue;
      const amount = Number(row.amount ?? 0);
      if (amount <= 0) continue;
      candidates.push({
        bizType: 'voucher',
        bizId: row.id,
        bizCode: row.code,
        amount,
        date: row.voucherDate,
        texts: [row.code, row.summary],
      });
    }
    return candidates;
  }

  async autoMatch(input: {
    bankAccountId?: string;
    period?: string;
    importBatch?: string;
    limit?: number;
  }): Promise<AutoMatchResult> {
    const conditions = [eq(erpBankStatement.matchStatus, 'unmatched')];
    if (input.bankAccountId) {
      conditions.push(eq(erpBankStatement.bankAccountId, input.bankAccountId));
    }
    if (input.period) {
      const range = periodRange(input.period);
      conditions.push(gte(erpBankStatement.transactionDate, range.from));
      conditions.push(lte(erpBankStatement.transactionDate, range.to));
    }
    if (input.importBatch) {
      conditions.push(eq(erpBankStatement.importBatch, input.importBatch));
    }
    const idRows: Array<{ id: string }> = await this.db
      .select({ id: erpBankStatement.id })
      .from(erpBankStatement)
      .where(and(...conditions))
      .orderBy(asc(erpBankStatement.transactionDate))
      .limit(Math.min(2000, Math.max(1, input.limit ?? 1000)));
    if (idRows.length === 0) return { scanned: 0, matched: 0, details: [] };

    const scannedIds = idRows.map((row) => row.id);
    const rows: BankStatementRowRaw[] = await this.baseQuery()
      .where(inArray(erpBankStatement.id, scannedIds))
      .orderBy(asc(erpBankStatement.transactionDate));

    const dates = rows.map((row) => row.transactionDate).sort();
    const earliest = shiftDate(dates[0], -7);
    const latest = shiftDate(dates[dates.length - 1], 7);
    const candidates = await this.loadCandidates({ from: earliest, to: latest });

    // 已匹配的候选单据不再参与（避免一张收款单被多条流水重复匹配）
    const usedRows: Array<{ bizId: string | null }> = await this.db
      .select({ bizId: erpBankStatement.bizId })
      .from(erpBankStatement)
      .where(
        and(
          inArray(erpBankStatement.matchStatus, ['matched', 'manual']),
          sql`${erpBankStatement.bizId} IS NOT NULL`
        )
      );
    const used = new Set(usedRows.map((row) => row.bizId).filter(Boolean) as string[]);

    const details: AutoMatchResult['details'] = [];
    for (const row of rows) {
      const available = candidates.filter((item) => !used.has(item.bizId));
      if (available.length === 0) break;
      const winner = bestMatch(
        {
          amount: Number(row.amount ?? 0),
          transactionDate: row.transactionDate,
          texts: [row.summary, row.counterpartyName, row.transactionNo],
        },
        available
      );
      if (!winner) continue;
      used.add(winner.candidate.bizId);
      await this.linkMatch({
        statementId: row.id,
        bankAccountId: row.bankAccountId,
        bizType: winner.candidate.bizType,
        bizId: winner.candidate.bizId,
        bizCode: winner.candidate.bizCode,
        score: winner.score,
        amount: Number(row.amount ?? 0),
        matchType: 'auto',
        matchedBy: 'system',
        remark: null,
      });
      details.push({
        statementId: row.id,
        bizType: winner.candidate.bizType,
        bizId: winner.candidate.bizId,
        bizCode: winner.candidate.bizCode ?? '',
        score: winner.score,
      });
    }

    return { scanned: rows.length, matched: details.length, details };
  }

  /* ==================== 人工关联 ==================== */

  private async assertBizExists(
    bizType: BankMatchBizType,
    bizId: string
  ): Promise<{ code: string | null }> {
    if (bizType === 'receipt') {
      const rows = await this.db
        .select({ code: erpReceipt.code })
        .from(erpReceipt)
        .where(eq(erpReceipt.id, bizId))
        .limit(1);
      if (rows.length === 0) throw new BadRequestException('关联的收款单不存在');
      return { code: rows[0].code };
    }
    if (bizType === 'payment') {
      const rows = await this.db
        .select({ code: erpPayment.code })
        .from(erpPayment)
        .where(eq(erpPayment.id, bizId))
        .limit(1);
      if (rows.length === 0) throw new BadRequestException('关联的付款单不存在');
      return { code: rows[0].code };
    }
    const rows = await this.db
      .select({ code: finVoucher.code })
      .from(finVoucher)
      .where(eq(finVoucher.id, bizId))
      .limit(1);
    if (rows.length === 0) throw new BadRequestException('关联的凭证不存在');
    return { code: rows[0].code };
  }

  private async linkMatch(input: {
    statementId: string;
    bankAccountId: string;
    bizType: BankMatchBizType;
    bizId: string;
    bizCode: string | null;
    score: number | null;
    amount: number;
    matchType: 'auto' | 'manual';
    matchedBy: string;
    remark: string | null;
  }): Promise<void> {
    const existing = await this.db
      .select({ id: erpBankStatementMatch.id })
      .from(erpBankStatementMatch)
      .where(eq(erpBankStatementMatch.statementId, input.statementId))
      .limit(1);
    const payload = {
      statementId: input.statementId,
      bankAccountId: input.bankAccountId,
      bizType: input.bizType,
      bizId: input.bizId,
      bizCode: input.bizCode,
      matchType: input.matchType,
      score: input.score === null ? null : String(input.score),
      amount: String(round2(input.amount)),
      remark: input.remark,
      matchedAt: new Date(),
      matchedBy: input.matchedBy,
      updatedAt: new Date(),
    };
    if (existing.length > 0) {
      await this.db
        .update(erpBankStatementMatch)
        .set(payload)
        .where(eq(erpBankStatementMatch.id, existing[0].id));
    } else {
      await this.db.insert(erpBankStatementMatch).values(payload);
    }
    await this.db
      .update(erpBankStatement)
      .set({
        matchStatus: input.matchType === 'manual' ? 'manual' : 'matched',
        bizType: input.bizType,
        bizId: input.bizId,
        bizCode: input.bizCode,
        matchScore: input.score === null ? null : String(input.score),
        matchedAt: new Date(),
        matchedBy: input.matchedBy,
        updatedAt: new Date(),
      })
      .where(eq(erpBankStatement.id, input.statementId));
  }

  async manualMatch(
    statementId: string,
    dto: ManualMatchBankStatementDto,
    actor: string
  ): Promise<BankStatementItem> {
    const statement = await this.getStatement(statementId);
    const biz = await this.assertBizExists(dto.bizType, dto.bizId);
    const already = await this.db
      .select({ id: erpBankStatementMatch.id })
      .from(erpBankStatementMatch)
      .where(eq(erpBankStatementMatch.statementId, statementId))
      .limit(1);
    if (
      already.length > 0 &&
      statement.bizId === dto.bizId &&
      statement.bizType === dto.bizType
    ) {
      throw new ConflictException('该流水已关联同一单据，请勿重复提交');
    }
    await this.linkMatch({
      statementId,
      bankAccountId: statement.bankAccountId,
      bizType: dto.bizType,
      bizId: dto.bizId,
      bizCode: biz.code,
      score: null,
      amount: statement.amount,
      matchType: 'manual',
      matchedBy: actor,
      remark: dto.remark ?? null,
    });
    return this.getStatement(statementId);
  }

  /** 取消关联：回到未匹配；若本无匹配则幂等返回当前流水（不报错） */
  async unmatch(statementId: string, remark: string | undefined, actor: string): Promise<BankStatementItem> {
    await this.getStatement(statementId);
    await this.db
      .delete(erpBankStatementMatch)
      .where(eq(erpBankStatementMatch.statementId, statementId));
    await this.db
      .update(erpBankStatement)
      .set({
        matchStatus: 'unmatched',
        bizType: null,
        bizId: null,
        bizCode: null,
        matchScore: null,
        matchedAt: null,
        matchedBy: actor,
        remark: remark ?? null,
        updatedAt: new Date(),
      })
      .where(eq(erpBankStatement.id, statementId));
    return this.getStatement(statementId);
  }

  /** 标记忽略（如手续费重复行），幂等：已忽略再标记返回当前状态 */
  async ignore(statementId: string, remark: string | undefined, actor: string): Promise<BankStatementItem> {
    await this.getStatement(statementId);
    await this.db
      .delete(erpBankStatementMatch)
      .where(eq(erpBankStatementMatch.statementId, statementId));
    await this.db
      .update(erpBankStatement)
      .set({
        matchStatus: 'ignored',
        bizType: null,
        bizId: null,
        bizCode: null,
        remark: remark ?? null,
        matchedBy: actor,
        updatedAt: new Date(),
      })
      .where(eq(erpBankStatement.id, statementId));
    return this.getStatement(statementId);
  }

  /* ==================== 供对账使用的批量取数 ==================== */

  async listForReconciliation(input: {
    bankAccountId: string;
    from: string;
    to: string;
  }): Promise<BankStatementRowRaw[]> {
    return this.baseQuery()
      .where(
        and(
          eq(erpBankStatement.bankAccountId, input.bankAccountId),
          gte(erpBankStatement.transactionDate, input.from),
          lte(erpBankStatement.transactionDate, input.to)
        )
      )
      .orderBy(asc(erpBankStatement.transactionDate));
  }

  /**
   * 日期平移（业务时区字符串运算）。用于把匹配窗口从流水日期扩展到候选单据日期。
   */
  static shiftDate(date: string, days: number): string {
    const base = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(base)) return date;
    return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
  }
}

function shiftDate(date: string, days: number): string {
  return BankStatementService.shiftDate(date, days);
}

/** 供导出与对账复用：把接口返回项转成适合落表的原始行结构 */
export function statementItemToRow(item: BankStatementItem): BankStatementRowRaw {
  return {
    id: item.id,
    bankAccountId: item.bankAccountId,
    transactionDate: item.transactionDate,
    direction: item.direction,
    amount: String(item.amount),
    balance: item.balance === null ? null : String(item.balance),
    counterpartyName: item.counterpartyName,
    counterpartyAccount: item.counterpartyAccount,
    summary: item.summary,
    transactionNo: item.transactionNo,
    dedupeKey: item.dedupeKey,
    matchStatus: item.matchStatus,
    bizType: item.bizType,
    bizId: item.bizId,
    bizCode: item.bizCode,
    matchScore: item.matchScore === null ? null : String(item.matchScore),
    remark: item.remark,
    createdAt: new Date(item.createdAt),
    bankAccountName: item.bankAccountName,
  };
}

/** 供导出任务复用：把原始行转为可导出的扁平记录 */
export function toExportRecord(row: BankStatementRowRaw): Record<string, string | number | null> {
  return {
    tradeDate: row.transactionDate,
    account: row.bankAccountName ?? '',
    direction: row.direction === 'income' ? '收入' : '支出',
    amount: round2(Number(row.amount ?? 0)),
    balance: row.balance === null ? null : round2(Number(row.balance)),
    counterpartyName: row.counterpartyName,
    counterpartyAccount: row.counterpartyAccount,
    summary: row.summary,
    transactionNo: row.transactionNo,
    matchStatus: matchStatusLabel(row.matchStatus),
    bizCode: row.bizCode,
    matchScore: row.matchScore === null ? null : round2(Number(row.matchScore)),
  };
}

export function matchStatusLabel(status: string): string {
  switch (status) {
    case 'matched':
      return '已自动匹配';
    case 'manual':
      return '已人工关联';
    case 'ignored':
      return '已忽略';
    default:
      return '未匹配';
  }
}
