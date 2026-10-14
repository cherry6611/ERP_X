/**
 * C-03 银行存款余额调节表单测（纯公式，无数据库）。
 * 关键断言：左右两侧**金额完全相同**（恒等式），且 difference = 0。
 */
import {
  buildReconciliation,
  deriveBankStatementBalance,
  round2,
  sumAccountBalance,
  type BankEntry,
  type BookEntry,
} from './bank-reconciliation.logic';

function bookEntry(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    sourceId: '11111111-1111-1111-1111-111111111111',
    sourceCode: 'RCV2026100001',
    tradeDate: '2026-10-10',
    direction: 'income',
    amount: 10000,
    description: '收款单 RCV2026100001',
    matched: false,
    ...overrides,
  };
}

function bankEntry(overrides: Partial<BankEntry> = {}): BankEntry {
  return {
    sourceId: '22222222-2222-2222-2222-222222222222',
    sourceCode: 'NO-2',
    tradeDate: '2026-10-12',
    direction: 'expense',
    amount: 5700,
    description: '银行手续费及代扣',
    matched: false,
    ...overrides,
  };
}

describe('C-03 银行存款余额调节表', () => {
  it('恒等式由同一份未达账项清单推导：有差异时如实报出（不得强制归零）', () => {
    const result = buildReconciliation({
      bankStatementBalance: 230000,
      chapterOpeningBalance: 210000,
      bookClosingBalance: 220000,
      entries: [
        bookEntry(), // 企业已收银行未收 10000（未匹配）
        bookEntry({
          sourceId: '33333333-3333-3333-3333-333333333333',
          sourceCode: 'PAY2026100001',
          direction: 'expense',
          amount: 20000,
          matched: true,
        }),
        bookEntry({
          sourceId: '55555555-5555-5555-5555-555555555555',
          sourceCode: 'RCV2026100002',
          direction: 'income',
          amount: 20000,
          matched: true,
        }),
      ],
      statements: [
        bankEntry({
          direction: 'income',
          amount: 30000,
          description: '银行代收货款',
        }),
        bankEntry({
          sourceId: '44444444-4444-4444-4444-444444444444',
          direction: 'expense',
          amount: 20000,
          matched: true, // 已匹配 → 不计入未达账项
        }),
      ],
    });

    // 加项/减项金额
    expect(result.enterpriseReceivedBankNotReceived).toBe(10000);
    expect(result.enterprisePaidBankNotPaid).toBe(0);
    expect(result.bankReceivedEnterpriseNotReceived).toBe(30000);
    expect(result.bankPaidEnterpriseNotPaid).toBe(0);
    // 账套已入账净额 = 10000 + 20000 − 20000 = 10000
    expect(result.bookMatchedNet).toBe(10000);
    // 左侧 = 230000 + 10000 − 0 = 240000
    expect(result.adjustedBankBalance).toBe(240000);
    // 右侧 = 220000 + 30000 − 0 = 250000
    expect(result.adjustedBookBalance).toBe(250000);
    expect(round2(result.adjustedBankBalance - result.adjustedBookBalance)).toBe(-10000);

    const identity = result.checks.find((check) => check.key === 'balance_identity');
    // 银行侧有 30000 已入账但企业侧未登记 → 差额如实报出（不得强制归零）
    expect(identity).toMatchObject({
      left: 240000,
      right: 250000,
      difference: -10000,
      passed: false,
    });
    // 账套数据链：期初 210000 + 净额 10000 = 220000 = 期末 → 通过
    const chain = result.checks.find((check) => check.key === 'book_chain');
    expect(chain).toMatchObject({ left: 220000, right: 220000, difference: 0, passed: true });
    expect(result.balanced).toBe(false);
  });

  it('未达账项清单完整：企业侧未匹配入账与银行侧未匹配流水都在清单里', () => {
    const result = buildReconciliation({
      bankStatementBalance: 240000,
      chapterOpeningBalance: 220000,
      bookClosingBalance: 220000,
      entries: [bookEntry()],
      statements: [],
    });
    // 企业已收银行未收 10000 → 左 250000；右 220000 → 差额 30000
    expect(result.enterpriseReceivedBankNotReceived).toBe(10000);
    expect(result.adjustedBankBalance).toBe(250000);
    expect(result.adjustedBookBalance).toBe(220000);
    expect(result.balanced).toBe(false);
    expect(result.outstandingItems).toEqual([
      {
        side: 'book_only',
        direction: 'income',
        source: 'voucher',
        sourceId: '11111111-1111-1111-1111-111111111111',
        sourceCode: 'RCV2026100001',
        tradeDate: '2026-10-10',
        amount: 10000,
        description: '收款单 RCV2026100001',
      },
    ]);
  });

  it('存在未匹配的银行入账时，恒等式如实报出差异（不得强制归零）', () => {
    const result = buildReconciliation({
      bankStatementBalance: 100000,
      chapterOpeningBalance: 80000,
      bookClosingBalance: 100000,
      entries: [
        bookEntry({ amount: 20000, direction: 'income' }), // 企业已收银行未收 20000
        bookEntry({
          sourceId: 'aaaaaaaa-1111-1111-1111-111111111111',
          sourceCode: 'PAY2026100009',
          direction: 'expense',
          amount: 5000,
        }), // 企业已付银行未付 5000
      ],
      statements: [
        bankEntry({ amount: 30000, direction: 'income' }), // 银行已收企业未收 30000
        bankEntry({
          sourceId: 'dddddddd-1111-1111-1111-111111111111',
          direction: 'expense',
          amount: 12000,
        }), // 银行已付企业未付 12000
      ],
    });

    expect(result.enterpriseReceivedBankNotReceived).toBe(20000);
    expect(result.enterprisePaidBankNotPaid).toBe(5000);
    expect(result.bankReceivedEnterpriseNotReceived).toBe(30000);
    expect(result.bankPaidEnterpriseNotPaid).toBe(12000);
    // 左：100000 + 20000 − 5000 = 115000
    expect(result.adjustedBankBalance).toBe(115000);
    // 右：100000 + 30000 − 12000 = 118000，差额 3000 = 银行侧多出的 3000
    expect(result.adjustedBookBalance).toBe(118000);
    const identity = result.checks.find((check) => check.key === 'balance_identity');
    expect(identity?.left).toBe(115000);
    expect(identity?.right).toBe(118000);
    expect(identity?.difference).toBe(-3000);
    expect(identity?.passed).toBe(false);
    expect(result.balanced).toBe(false);
    // 未达账项：企业侧 2 条 + 银行侧 2 条
    expect(result.outstandingItems).toHaveLength(4);
    expect(result.outstandingItems.filter((item) => item.side === 'book_only')).toHaveLength(2);
    expect(result.outstandingItems.filter((item) => item.side === 'bank_only')).toHaveLength(2);
    // 可追溯：book_only 指向凭证/单据，bank_only 指向流水
    for (const item of result.outstandingItems) {
      expect(item.sourceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(['bank_statement', 'voucher']).toContain(item.source);
      expect(item.amount).toBeGreaterThan(0);
    }
    // 明细按日期升序，便于人工核对
    expect(result.outstandingItems.map((item) => item.tradeDate)).toEqual([
      '2026-10-10',
      '2026-10-10',
      '2026-10-12',
      '2026-10-12',
    ]);
  });

  it('完全对平（银行流水已全部匹配且账套链一致）→ 所有断言通过', () => {
    const result = buildReconciliation({
      bankStatementBalance: 220000,
      chapterOpeningBalance: 210000,
      bookClosingBalance: 220000,
      entries: [bookEntry({ amount: 10000, matched: true })],
      statements: [bankEntry({ direction: 'income', amount: 10000, matched: true })],
    });
    expect(result.bookMatchedNet).toBe(10000);
    expect(result.adjustedBankBalance).toBe(220000);
    expect(result.adjustedBookBalance).toBe(220000);
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(result.balanced).toBe(true);
    expect(result.outstandingItems).toHaveLength(0);
  });

  it('被忽略的流水不计入未达账项', () => {
    const result = buildReconciliation({
      bankStatementBalance: 1000,
      chapterOpeningBalance: 1000,
      bookClosingBalance: 1000,
      entries: [],
      statements: [
        bankEntry({ amount: 999, ignored: true }),
        bankEntry({
          sourceId: 'eeeeeeee-1111-1111-1111-111111111111',
          amount: 1,
          ignored: true,
        }),
      ],
    });
    expect(result.bankReceivedEnterpriseNotReceived).toBe(0);
    expect(result.bankPaidEnterpriseNotPaid).toBe(0);
    expect(result.outstandingItems).toHaveLength(0);
    expect(result.balanced).toBe(true);
  });
});

describe('C-03 银行对账单余额取数口径', () => {
  it('优先取期间内最后一条带余额的流水', () => {
    const derived = deriveBankStatementBalance({
      statementRows: [
        { transactionDate: '2026-10-03', balance: 100 },
        { transactionDate: '2026-10-28', balance: 88000.5 },
        { transactionDate: '2026-10-15', balance: null },
      ],
      manualBalance: 1,
    });
    expect(derived).toEqual({ balance: 88000.5, source: 'statement' });
  });

  it('无余额列时回退账户手工值，都没有则返回 none', () => {
    expect(
      deriveBankStatementBalance({
        statementRows: [{ transactionDate: '2026-10-03', balance: null }],
        manualBalance: 5000,
      })
    ).toEqual({ balance: 5000, source: 'manual' });
    expect(
      deriveBankStatementBalance({ statementRows: [], manualBalance: null })
    ).toEqual({ balance: null, source: 'none' });
  });
});

describe('C-03 关联合计科目余额汇总', () => {
  it('1002 父级科目取末级明细之和（100201 + 100202）', () => {
    const rows = [
      { accountCode: '1002', isLeaf: false, closingDebit: 0, closingCredit: 0 },
      { accountCode: '100201', isLeaf: true, closingDebit: 120000.5, closingCredit: 0 },
      { accountCode: '100202', isLeaf: true, closingDebit: 79500.25, closingCredit: 0 },
      { accountCode: '1001', isLeaf: true, closingDebit: 3000, closingCredit: 0 },
    ];
    expect(sumAccountBalance(rows, '1002')).toBe(199500.75);
  });

  it('末级科目为贷方余额时为负数（银行透支场景）', () => {
    const rows = [
      { accountCode: '100201', isLeaf: true, closingDebit: 1000, closingCredit: 1500 },
    ];
    expect(sumAccountBalance(rows, '1002')).toBe(-500);
  });

  it('科目编码为空时返回 0（不误取全表）', () => {
    expect(
      sumAccountBalance(
        [{ accountCode: '100201', isLeaf: true, closingDebit: 1, closingCredit: 0 }],
        ''
      )
    ).toBe(0);
  });
});
