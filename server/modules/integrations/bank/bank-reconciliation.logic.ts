/**
 * C-03 银行存款余额调节表（纯公式，可单测）。
 *
 * 标准式：
 *   银行对账单余额 + 企业已收银行未收 − 企业已付银行未付
 *     = 企业账面余额 + 银行已收企业未收 − 银行已付企业未付
 *
 * 恒等式实现口径：左右两侧都由**同一份未达账项清单**推导，保证结构上必然相等；
 * 同时额外校验「账套期末余额 = 期初 + 账套已入账净额」这一独立数据链，
 * 避免用等式两边互相掩盖取数错误（见 checks 数组）。
 *
 * 口径假设（需财务确认）：
 *  1) 「企业已收银行未收」= 企业已登记收款（erp_receipt）但银行流水未匹配到它的部分；
 *     「银行已收企业未收」= 银行流水已入账但账套未登记的收款部分。
 *  2) 银行对账单余额优先取该账户该期间最后一条带余额的流水（balance 列），
 *     否则用账户主数据的手工维护值，再否则取期初 + 期间流水净额。
 *  3) 金额一律取正数（绝对值），方向由 direction 承载。
 */

import type {
  BankReconciliationCheck,
  BankReconciliationOutstandingItem,
  BankStatementDirection,
} from '@shared/api.interface';

/** 账套口径的一条发生额（由凭证 / 收付款单推导） */
export interface BookEntry {
  sourceId: string;
  sourceCode: string | null;
  tradeDate: string;
  direction: BankStatementDirection;
  amount: number;
  description: string;
  /** 是否已与银行流水建立匹配关系（已匹配的不属于未达账项） */
  matched: boolean;
}

/** 银行口径的一条流水（仅取未达账项需要的字段） */
export interface BankEntry {
  sourceId: string;
  sourceCode: string | null;
  tradeDate: string;
  direction: BankStatementDirection;
  amount: number;
  description: string;
  /** 已匹配到收付款/凭证的流水不属于「银行已收企业未收」 */
  matched: boolean;
  /** 用户主动忽略的流水不计入未达账项 */
  ignored?: boolean;
}

export interface ReconciliationInput {
  bankStatementBalance: number;
  chapterOpeningBalance: number;
  /** 账套期末余额（来自 fin_account 科目余额，取不到时传 null） */
  bookClosingBalance: number | null;
  entries: BookEntry[];
  statements: BankEntry[];
}

export interface ReconciliationResult {
  /** ② 企业已收银行未收（银行侧未达账项，加项） */
  enterpriseReceivedBankNotReceived: number;
  /** ③ 企业已付银行未付（银行侧未达账项，减项） */
  enterprisePaidBankNotPaid: number;
  /** ④ 银行已收企业未收（企业侧未达账项，加项） */
  bankReceivedEnterpriseNotReceived: number;
  /** ⑤ 银行已付企业未付（企业侧未达账项，减项） */
  bankPaidEnterpriseNotPaid: number;
  adjustedBankBalance: number;
  adjustedBookBalance: number;
  /** 未匹配的账套已入账净额（期末 − 期初） */
  bookMatchedNet: number;
  outstandingItems: BankReconciliationOutstandingItem[];
  checks: BankReconciliationCheck[];
  balanced: boolean;
}

// 统一取整口径：原先这里自带一份 `Math.round((v + EPSILON) * 100) / 100`，
// 对负数不对称（红冲差 1 分）。改为再导出全仓唯一实现，保持本模块的导出面不变。
import { round2 } from '@server/common/utils/number';

export { round2 };

/**
 * 生成调节表计算结果。
 * @param input 见 ReconciliationInput
 */
export function buildReconciliation(input: ReconciliationInput): ReconciliationResult {
  const outstandingItems: BankReconciliationOutstandingItem[] = [];

  let enterpriseReceivedBankNotReceived = 0;
  let enterprisePaidBankNotPaid = 0;
  let bookMatchedNet = 0;
  for (const entry of input.entries) {
    // 账套期间净额 = 该账户期间内全部账套发生额（含未匹配部分）：
    // 未匹配部分同时出现在未达账项清单里，二者都是"账套已记录"的事实。
    bookMatchedNet +=
      entry.direction === 'income' ? round2(entry.amount) : -round2(entry.amount);
    if (entry.matched) continue;
    if (entry.direction === 'income') {
      enterpriseReceivedBankNotReceived += round2(entry.amount);
    } else {
      enterprisePaidBankNotPaid += round2(entry.amount);
    }
    outstandingItems.push({
      side: 'book_only',
      direction: entry.direction,
      source: 'voucher',
      sourceId: entry.sourceId,
      sourceCode: entry.sourceCode,
      tradeDate: entry.tradeDate,
      amount: round2(entry.amount),
      description: entry.description,
    });
  }

  let bankReceivedEnterpriseNotReceived = 0;
  let bankPaidEnterpriseNotPaid = 0;
  for (const statement of input.statements) {
    if (statement.matched || statement.ignored === true) continue;
    if (statement.direction === 'income') {
      bankReceivedEnterpriseNotReceived += round2(statement.amount);
    } else {
      bankPaidEnterpriseNotPaid += round2(statement.amount);
    }
    outstandingItems.push({
      side: 'bank_only',
      direction: statement.direction,
      source: 'bank_statement',
      sourceId: statement.sourceId,
      sourceCode: statement.sourceCode,
      tradeDate: statement.tradeDate,
      amount: round2(statement.amount),
      description: statement.description,
    });
  }

  enterpriseReceivedBankNotReceived = round2(enterpriseReceivedBankNotReceived);
  enterprisePaidBankNotPaid = round2(enterprisePaidBankNotPaid);
  bankReceivedEnterpriseNotReceived = round2(bankReceivedEnterpriseNotReceived);
  bankPaidEnterpriseNotPaid = round2(bankPaidEnterpriseNotPaid);

  const adjustedBankBalance = round2(
    round2(input.bankStatementBalance) +
      enterpriseReceivedBankNotReceived -
      enterprisePaidBankNotPaid
  );
  const bookBalance = round2(input.bookClosingBalance ?? 0);
  const adjustedBookBalance = round2(
    bookBalance + bankReceivedEnterpriseNotReceived - bankPaidEnterpriseNotPaid
  );
  const difference = round2(adjustedBankBalance - adjustedBookBalance);

  // 恒等式断言：两侧均由同一份未达账项清单推导
  const identityCheck: BankReconciliationCheck = {
    key: 'balance_identity',
    label: '调节后银行对账单余额 = 调节后企业账面余额',
    left: adjustedBankBalance,
    right: adjustedBookBalance,
    difference,
    passed: Math.abs(difference) < 0.005,
  };

  // 独立数据链校验：账套期末余额应等于 期初 + 账套已入账净额
  const expectedClosing = round2(round2(input.chapterOpeningBalance) + bookMatchedNet);
  const chainDifference =
    input.bookClosingBalance === null ? 0 : round2(expectedClosing - round2(input.bookClosingBalance));
  const chainCheck: BankReconciliationCheck = {
    key: 'book_chain',
    label: '账套期末余额 = 期初 + 账套已入账净额',
    left: expectedClosing,
    right: bookBalance,
    difference: chainDifference,
    passed: input.bookClosingBalance === null || Math.abs(chainDifference) < 0.005,
  };

  const checks = [identityCheck, chainCheck];
  return {
    enterpriseReceivedBankNotReceived,
    enterprisePaidBankNotPaid,
    bankReceivedEnterpriseNotReceived,
    bankPaidEnterpriseNotPaid,
    adjustedBankBalance,
    adjustedBookBalance,
    bookMatchedNet: round2(bookMatchedNet),
    outstandingItems: outstandingItems.sort((a, b) => {
      if (a.tradeDate !== b.tradeDate) return a.tradeDate < b.tradeDate ? -1 : 1;
      if (a.side !== b.side) return a.side < b.side ? -1 : 1;
      return a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0;
    }),
    checks,
    balanced: checks.every((check) => check.passed),
  };
}

/**
 * 银行对账单期末余额推导：
 *  1) 期间内最后一条带余额的流水（按日期 + 创建顺序取最后一条）；
 *  2) 否则用账户主数据的手工值；
 *  3) 都取不到时返回 null，由接口提示需人工填写。
 */
export function deriveBankStatementBalance(input: {
  statementRows: Array<{ transactionDate: string; balance: number | null }>;
  manualBalance: number | null;
}): { balance: number | null; source: 'statement' | 'manual' | 'none' } {
  const withBalance = input.statementRows.filter(
    (row): row is { transactionDate: string; balance: number } => row.balance !== null
  );
  if (withBalance.length > 0) {
    const sorted = [...withBalance].sort((a, b) =>
      a.transactionDate < b.transactionDate ? -1 : a.transactionDate > b.transactionDate ? 1 : 0
    );
    return { balance: round2(sorted[sorted.length - 1].balance), source: 'statement' };
  }
  if (input.manualBalance !== null && Number.isFinite(input.manualBalance)) {
    return { balance: round2(input.manualBalance), source: 'manual' };
  }
  return { balance: null, source: 'none' };
}

/** 科目余额口径：把「银行账户关联科目」下的末级科目余额汇总成企业账面余额 */
export function sumAccountBalance(
  rows: Array<{ accountCode: string; isLeaf: boolean; closingDebit: number; closingCredit: number }>,
  accountCode: string
): number {
  const prefix = accountCode.trim();
  if (prefix === '') return 0;
  const hit = rows.filter(
    (row) => row.isLeaf && (row.accountCode === prefix || row.accountCode.startsWith(prefix))
  );
  return round2(
    hit.reduce((total, row) => total + round2(row.closingDebit) - round2(row.closingCredit), 0)
  );
}
