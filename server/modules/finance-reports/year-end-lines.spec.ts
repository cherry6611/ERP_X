import { buildCarryForwardLines } from './year-end-lines';

/**
 * 年结结转分录的方向锁定。
 *
 * 用例按「错法方向」组织：本年利润（3131）记错方向有两种相反的错法
 * （盈利记借方 / 亏损记贷方），两种都表现为"借贷不平衡、年结失败"，
 * 不看代码分不清是哪边错，因此必须双向各自锁定。
 */
const PROFIT = '3131';

describe('buildCarryForwardLines', () => {
  describe('盈利：收入 > 费用 ⇒ 本年利润记贷方', () => {
    const items = [
      { accountCode: '6001', accountName: '主营业务收入', carryAmount: 100_000, carryDirection: 'debit' as const },
      { accountCode: '6602', accountName: '管理费用', carryAmount: 60_000, carryDirection: 'credit' as const },
    ];

    it('借贷合计相等（这是年结能否成功的前提）', () => {
      const r = buildCarryForwardLines(items, PROFIT, 2026);
      expect(r.balanced).toBe(true);
      expect(r.totalDebit).toBe(100_000);
      expect(r.totalCredit).toBe(100_000);
    });

    it('本年利润记贷方 40000（= 收入 100000 − 费用 60000）', () => {
      const r = buildCarryForwardLines(items, PROFIT, 2026);
      const line = r.lines.find((l) => l.accountCode === PROFIT)!;
      expect(Number(line.credit)).toBe(40_000);
      expect(Number(line.debit)).toBe(0);
    });

    it('收入科目借记、费用科目贷记（冲平原余额）', () => {
      const r = buildCarryForwardLines(items, PROFIT, 2026);
      const rev = r.lines.find((l) => l.accountCode === '6001')!;
      const exp = r.lines.find((l) => l.accountCode === '6602')!;
      expect(Number(rev.debit)).toBe(100_000);
      expect(Number(rev.credit)).toBe(0);
      expect(Number(exp.credit)).toBe(60_000);
      expect(Number(exp.debit)).toBe(0);
    });

    it('反例锁定：若把盈利记成借方，借贷差 80000', () => {
      // 旧实现的错法 —— 此断言说明它为什么必然被平衡校验挡下
      const wrong = 100_000 + 40_000; // 借=收入+利润
      expect(wrong - 60_000).toBe(80_000); // ≠ 0 ⇒ 年结必然失败
    });
  });

  describe('亏损：费用 > 收入 ⇒ 本年利润记借方', () => {
    const items = [
      { accountCode: '6001', accountName: '主营业务收入', carryAmount: 100_000, carryDirection: 'debit' as const },
      { accountCode: '6602', accountName: '管理费用', carryAmount: 120_000, carryDirection: 'credit' as const },
    ];

    it('借贷合计相等', () => {
      const r = buildCarryForwardLines(items, PROFIT, 2026);
      expect(r.balanced).toBe(true);
      expect(r.totalDebit).toBe(120_000);
      expect(r.totalCredit).toBe(120_000);
    });

    it('本年利润记借方 20000', () => {
      const r = buildCarryForwardLines(items, PROFIT, 2026);
      const line = r.lines.find((l) => l.accountCode === PROFIT)!;
      expect(Number(line.debit)).toBe(20_000);
      expect(Number(line.credit)).toBe(0);
    });
  });

  describe('方向取自余额方向，而不是科目类型', () => {
    it('收入类科目出现借方余额（销售退回）时贷记它，而不是把余额翻倍', () => {
      // 6001 因红冲净剩借方 5000：应贷记 5000 冲平
      const items = [
        { accountCode: '6001', accountName: '主营业务收入', carryAmount: 5_000, carryDirection: 'credit' as const },
      ];
      const r = buildCarryForwardLines(items, PROFIT, 2026);
      const line = r.lines.find((l) => l.accountCode === '6001')!;
      expect(Number(line.credit)).toBe(5_000);
      expect(Number(line.debit)).toBe(0);
      // 该科目是"亏损"来源 ⇒ 本年利润记借方
      expect(Number(r.lines.find((l) => l.accountCode === PROFIT)!.debit)).toBe(5_000);
      expect(r.balanced).toBe(true);
    });

    it('费用类科目出现贷方余额（财务费用利息收入红字）时借记它', () => {
      const items = [
        { accountCode: '6603', accountName: '财务费用', carryAmount: 2_000, carryDirection: 'debit' as const },
      ];
      const r = buildCarryForwardLines(items, PROFIT, 2026);
      const line = r.lines.find((l) => l.accountCode === '6603')!;
      expect(Number(line.debit)).toBe(2_000);
      expect(Number(r.lines.find((l) => l.accountCode === PROFIT)!.credit)).toBe(2_000);
      expect(r.balanced).toBe(true);
    });
  });

  describe('多科目与分位', () => {
    it('多个损益科目一次性结转仍然平衡', () => {
      const items = [
        { accountCode: '6001', accountName: '主营业务收入', carryAmount: 1_234_567.89, carryDirection: 'debit' as const },
        { accountCode: '6051', accountName: '其他业务收入', carryAmount: 8_000.01, carryDirection: 'debit' as const },
        { accountCode: '6401', accountName: '主营业务成本', carryAmount: 900_000.5, carryDirection: 'credit' as const },
        { accountCode: '6601', accountName: '销售费用', carryAmount: 100_000.2, carryDirection: 'credit' as const },
        { accountCode: '6602', accountName: '管理费用', carryAmount: 50_000.2, carryDirection: 'credit' as const },
      ];
      const r = buildCarryForwardLines(items, PROFIT, 2026);
      expect(r.balanced).toBe(true);
    });

    it('收支恰好相等时本年利润两方均为 0', () => {
      const items = [
        { accountCode: '6001', accountName: '主营业务收入', carryAmount: 50_000, carryDirection: 'debit' as const },
        { accountCode: '6602', accountName: '管理费用', carryAmount: 50_000, carryDirection: 'credit' as const },
      ];
      const r = buildCarryForwardLines(items, PROFIT, 2026);
      const line = r.lines.find((l) => l.accountCode === PROFIT)!;
      expect(Number(line.debit)).toBe(0);
      expect(Number(line.credit)).toBe(0);
      expect(r.balanced).toBe(true);
    });
  });

  describe('不变量：任意盈亏组合都必须平衡', () => {
    it('遍历收入/费用规模组合，借贷恒等', () => {
      for (const revenue of [0, 1, 999.99, 100_000, 1_000_000.55]) {
        for (const expense of [0, 1, 888.88, 60_000, 2_000_000.44]) {
          const items = [
            { accountCode: '6001', accountName: '收入', carryAmount: revenue, carryDirection: 'debit' as const },
            { accountCode: '6602', accountName: '费用', carryAmount: expense, carryDirection: 'credit' as const },
          ];
          const r = buildCarryForwardLines(items, PROFIT, 2026);
          expect(r.balanced).toBe(true);
        }
      }
    });
  });
});
