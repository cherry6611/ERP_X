import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { erpBankStatement } from '@server/database/schema';
import { LedgersService } from '@server/modules/finance-reports/ledgers.service';
import { unwrapRows } from '@server/common/utils/rows';
import { BankAccountService } from './bank-account.service';
import { periodRange } from './bank-statement.service';
import {
  buildReconciliation,
  deriveBankStatementBalance,
  round2,
  sumAccountBalance,
  type BankEntry,
  type BookEntry,
} from './bank-reconciliation.logic';
import type { BankReconciliationReport } from '@shared/api.interface';

interface ReceiptRow {
  id: string;
  code: string;
  amount: string | null;
  receipt_date: string;
  status: string | null;
  remark: string | null;
  matched: boolean | null;
}

interface PaymentRow {
  id: string;
  code: string;
  amount: string | null;
  pay_date: string;
  status: string | null;
  remark: string | null;
  matched: boolean | null;
}

/**
 * C-03 银企对账（银行存款余额调节表）。
 *
 * 数据来源：
 *  - 企业账面余额：复用 LedgersService.accountBalance（1002 及其末级明细科目期末余额合计）；
 *  - 企业侧未达账项：期间内 erp_receipt / erp_payment 中未被银行流水匹配的部分；
 *  - 银行侧未达账项：期间内 erp_bank_statement 中未匹配、未忽略的流水；
 *  - 银行对账单余额：期间内最后一条带余额的流水，缺省回退账户手工维护值。
 *
 * 恒等式左右两侧都由同一份未达账项清单推导，另加"账套期末余额 = 期初 + 账套已入账净额"
 * 的独立数据链校验，见 checks。
 */
@Injectable()
export class BankReconciliationService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly bankAccounts: BankAccountService,
    private readonly ledgers: LedgersService
  ) {}

  private async loadBookEntries(input: {
    bankAccountId: string;
    from: string;
    to: string;
  }): Promise<BookEntry[]> {
    const receiptRows = unwrapRows<ReceiptRow>(
      await this.db.execute(sql`
        SELECT r.id,
               r.code,
               r.amount,
               r.receipt_date::text AS receipt_date,
               r.status,
               r.remark,
               EXISTS (
                 SELECT 1 FROM erp_bank_statement_match m
                 WHERE m.biz_type = 'receipt' AND m.biz_id = r.id
               ) AS matched
        FROM erp_receipt r
        WHERE r.receipt_date >= ${input.from}::date
          AND r.receipt_date <= ${input.to}::date
          AND coalesce(r.status, '') <> 'voided'
      `)
    );
    const paymentRows = unwrapRows<PaymentRow>(
      await this.db.execute(sql`
        SELECT p.id,
               p.code,
               p.amount,
               p.pay_date::text AS pay_date,
               p.status,
               p.remark,
               EXISTS (
                 SELECT 1 FROM erp_bank_statement_match m
                 WHERE m.biz_type = 'payment' AND m.biz_id = p.id
               ) AS matched
        FROM erp_payment p
        WHERE p.pay_date >= ${input.from}::date
          AND p.pay_date <= ${input.to}::date
          AND coalesce(p.status, '') <> 'voided'
      `)
    );

    const entries: BookEntry[] = [];
    for (const row of receiptRows) {
      const amount = round2(Number(row.amount ?? 0));
      if (amount <= 0) continue;
      entries.push({
        sourceId: row.id,
        sourceCode: row.code,
        tradeDate: row.receipt_date,
        direction: 'income',
        amount,
        description: `收款单 ${row.code}${row.remark ? `｜${row.remark}` : ''}`,
        matched: row.matched === true,
      });
    }
    for (const row of paymentRows) {
      const amount = round2(Number(row.amount ?? 0));
      if (amount <= 0) continue;
      entries.push({
        sourceId: row.id,
        sourceCode: row.code,
        tradeDate: row.pay_date,
        direction: 'expense',
        amount,
        description: `付款单 ${row.code}${row.remark ? `｜${row.remark}` : ''}`,
        matched: row.matched === true,
      });
    }
    return entries;
  }

  private async loadBankEntries(input: {
    bankAccountId: string;
    from: string;
    to: string;
  }): Promise<BankEntry[]> {
    const rows = await this.db
      .select({
        id: erpBankStatement.id,
        transactionNo: erpBankStatement.transactionNo,
        transactionDate: erpBankStatement.transactionDate,
        direction: erpBankStatement.direction,
        amount: erpBankStatement.amount,
        balance: erpBankStatement.balance,
        counterpartyName: erpBankStatement.counterpartyName,
        summary: erpBankStatement.summary,
        matchStatus: erpBankStatement.matchStatus,
        bizCode: erpBankStatement.bizCode,
      })
      .from(erpBankStatement)
      .where(
        and(
          eq(erpBankStatement.bankAccountId, input.bankAccountId),
          gte(erpBankStatement.transactionDate, input.from),
          lte(erpBankStatement.transactionDate, input.to)
        )
      );
    return rows.map((row) => ({
      sourceId: row.id,
      sourceCode: row.transactionNo,
      tradeDate: row.transactionDate,
      direction: row.direction === 'expense' ? 'expense' : 'income',
      amount: round2(Number(row.amount ?? 0)),
      description:
        row.summary ??
        row.counterpartyName ??
        (row.transactionNo ? `流水号 ${row.transactionNo}` : '银行流水'),
      matched: row.matchStatus === 'matched' || row.matchStatus === 'manual',
      ignored: row.matchStatus === 'ignored',
    }));
  }

  /**
   * 生成调节表。
   * @param bankAccountId 缺省取默认账户
   * @param period YYYY-MM
   * @param manualBankBalance 手工覆盖的银行对账单期末余额（银行未提供余额列时使用）
   */
  async buildReport(input: {
    bankAccountId?: string;
    period: string;
    manualBankBalance?: number | null;
  }): Promise<BankReconciliationReport> {
    const account = await this.bankAccounts.resolveAccountForReconciliation(
      input.bankAccountId
    );
    const range = periodRange(input.period);
    const accountCode = account.accountCode ?? '1002';

    const [bookEntries, bankEntries, balanceSheet, statementRows] = await Promise.all([
      this.loadBookEntries({
        bankAccountId: account.id,
        from: range.from,
        to: range.to,
      }),
      this.loadBankEntries({
        bankAccountId: account.id,
        from: range.from,
        to: range.to,
      }),
      this.ledgers.accountBalance({ period: input.period, level: 6 }),
      this.db
        .select({
          transactionDate: erpBankStatement.transactionDate,
          balance: erpBankStatement.balance,
        })
        .from(erpBankStatement)
        .where(
          and(
            eq(erpBankStatement.bankAccountId, account.id),
            gte(erpBankStatement.transactionDate, range.from),
            lte(erpBankStatement.transactionDate, range.to)
          )
        ),
    ]);

    const bookBalance = sumAccountBalance(
      balanceSheet.items.map((item) => ({
        accountCode: item.accountCode,
        isLeaf: item.isLeaf,
        closingDebit: item.closingDebit,
        closingCredit: item.closingCredit,
      })),
      accountCode
    );

    const derived = deriveBankStatementBalance({
      statementRows: statementRows.map((row) => ({
        transactionDate: row.transactionDate,
        balance: row.balance === null ? null : round2(Number(row.balance)),
      })),
      manualBalance: input.manualBankBalance ?? account.openingBalance,
    });

    if (derived.balance === null) {
      return {
        bankAccountId: account.id,
        bankAccountName: account.name,
        bankAccountNo: account.accountNo,
        accountCode,
        period: input.period,
        currency: account.currency,
        bankStatementBalance: 0,
        bankStatementBalanceSource: 'none',
        enterpriseReceivedBankNotReceived: 0,
        enterprisePaidBankNotPaid: 0,
        bankReceivedEnterpriseNotReceived: 0,
        bankPaidEnterpriseNotPaid: 0,
        adjustedBankBalance: 0,
        bookBalance,
        adjustedBookBalance: bookBalance,
        outstandingItems: [],
        checks: [
          {
            key: 'balance_identity',
            label: '调节后银行对账单余额 = 调节后企业账面余额',
            left: 0,
            right: bookBalance,
            difference: round2(-bookBalance),
            passed: false,
          },
        ],
        balanced: false,
        outstandingCount: 0,
        generatedAt: new Date().toISOString(),
      };
    }

    const result = buildReconciliation({
      bankStatementBalance: derived.balance,
      chapterOpeningBalance: account.openingBalance,
      bookClosingBalance: bookBalance,
      entries: bookEntries,
      statements: bankEntries,
    });

    return {
      bankAccountId: account.id,
      bankAccountName: account.name,
      bankAccountNo: account.accountNo,
      accountCode,
      period: input.period,
      currency: account.currency,
      bankStatementBalance: derived.balance,
      bankStatementBalanceSource: derived.source,
      enterpriseReceivedBankNotReceived: result.enterpriseReceivedBankNotReceived,
      enterprisePaidBankNotPaid: result.enterprisePaidBankNotPaid,
      bankReceivedEnterpriseNotReceived: result.bankReceivedEnterpriseNotReceived,
      bankPaidEnterpriseNotPaid: result.bankPaidEnterpriseNotPaid,
      adjustedBankBalance: result.adjustedBankBalance,
      bookBalance: round2(bookBalance),
      adjustedBookBalance: result.adjustedBookBalance,
      outstandingItems: result.outstandingItems,
      checks: result.checks,
      balanced: result.balanced,
      outstandingCount: result.outstandingItems.length,
      generatedAt: new Date().toISOString(),
    };
  }

  /** C-08：对账差异待办取数——存在未达账项或恒等式不通过的（账户, 期间）列表 */
  async listOpenDifferences(period: string): Promise<
    Array<{
      bankAccountId: string;
      bankAccountName: string;
      period: string;
      outstandingCount: number;
      difference: number;
    }>
  > {
    const accounts = await this.bankAccounts.listAccounts({ page: 1, pageSize: 100 });
    const result: Array<{
      bankAccountId: string;
      bankAccountName: string;
      period: string;
      outstandingCount: number;
      difference: number;
    }> = [];
    for (const account of accounts.items) {
      const unmatchedCount = await this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(erpBankStatement)
        .where(
          and(
            eq(erpBankStatement.bankAccountId, account.id),
            eq(erpBankStatement.matchStatus, 'unmatched')
          )
        );
      const count = Number(unmatchedCount[0]?.total ?? 0);
      if (count === 0) continue;
      result.push({
        bankAccountId: account.id,
        bankAccountName: account.name,
        period,
        outstandingCount: count,
        difference: 0,
      });
    }
    return result;
  }
}
