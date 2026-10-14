import {
  assetDisposalLines,
  assetImpairmentLines,
  type PostingLine,
} from './posting';

function debitTotal(lines: PostingLine[]): number {
  return Math.round(lines.reduce((sum, line) => sum + (line.debit ?? 0), 0) * 100) / 100;
}

function creditTotal(lines: PostingLine[]): number {
  return Math.round(lines.reduce((sum, line) => sum + (line.credit ?? 0), 0) * 100) / 100;
}

function amountOn(lines: PostingLine[], accountCode: string): {
  debit: number;
  credit: number;
} {
  const match = lines.filter((line) => line.accountCode === accountCode);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    debit: round(match.reduce((sum, line) => sum + (line.debit ?? 0), 0)),
    credit: round(match.reduce((sum, line) => sum + (line.credit ?? 0), 0)),
  };
}

/**
 * D-08：固定资产减值与处置的会计口径单测。
 *
 * 这组断言的价值在于把「需财务确认」的口径固化成可执行检查：
 * 一旦有人改了 posting.ts 的科目或方向，测试会立刻失败并指出偏离点，
 * 而不是等到月度结账时才发现资产原值与净值对不上。
 */
describe('D-08 固定资产减值与处置分录', () => {
  describe('assetImpairmentLines（计提减值）', () => {
    it('借 6701 资产减值损失 / 贷 1604 固定资产减值准备，且借贷平衡', () => {
      const lines = assetImpairmentLines(12_345.67);
      expect(debitTotal(lines)).toBe(12_345.67);
      expect(creditTotal(lines)).toBe(12_345.67);
      expect(amountOn(lines, '6701').debit).toBe(12_345.67);
      expect(amountOn(lines, '1604').credit).toBe(12_345.67);
    });

    it('不触碰 1601 固定资产原值（减值必须走备抵科目）', () => {
      const lines = assetImpairmentLines(1000);
      expect(amountOn(lines, '1601')).toEqual({ debit: 0, credit: 0 });
    });

    it('损失为 0 时既不平衡也不报错，直接返回空/零金额需要调用方拦截', () => {
      // 金额为 0 时不应产生任何分录（避免出现 0 元凭证）
      const lines = assetImpairmentLines(0);
      expect(debitTotal(lines)).toBe(0);
      expect(creditTotal(lines)).toBe(0);
    });
  });

  describe('assetDisposalLines（处置）', () => {
    const base = {
      originalValue: 100_000,
      accumulatedDepreciation: 60_000,
      impairmentProvision: 10_000,
      disposalIncome: 0,
      outputTax: 0,
      disposalType: 'scrap' as const,
    };

    it('恒定满足借贷平衡（净值 30000 报废）', () => {
      const { lines } = assetDisposalLines(base);
      expect(debitTotal(lines)).toBe(creditTotal(lines));
    });

    it('报废净损失 = −(原值 − 累计折旧 − 减值) 并走 6711 营业外支出', () => {
      const { lines, gainLoss } = assetDisposalLines(base);
      // 净值 = 100000 − 60000 − 10000 = 30000
      expect(gainLoss).toBe(-30_000);
      expect(amountOn(lines, '6711').debit).toBe(30_000);
      expect(amountOn(lines, '6301').credit).toBe(0);
    });

    it('转入清理时 1603 借方为净值、1602/1604 借方为累计数、1601 贷方为原值', () => {
      const { lines } = assetDisposalLines(base);
      expect(amountOn(lines, '1603').debit).toBe(30_000);
      expect(amountOn(lines, '1602').debit).toBe(60_000);
      expect(amountOn(lines, '1604').debit).toBe(10_000);
      expect(amountOn(lines, '1601').credit).toBe(100_000);
    });

    it('1603 固定资产清理最终轧平为 0（这是分录正确性的核心不变量）', () => {
      const { lines } = assetDisposalLines(base);
      const clean = amountOn(lines, '1603');
      expect(Math.round((clean.debit - clean.credit) * 100) / 100).toBe(0);
    });

    it('出售有收益：收入 50000、销项税 0 时 gainLoss = 50000 − 30000 = +20000', () => {
      const { lines, gainLoss } = assetDisposalLines({
        ...base,
        disposalType: 'sale',
        disposalIncome: 50_000,
      });
      expect(gainLoss).toBe(20_000);
      expect(amountOn(lines, '6301').credit).toBe(20_000);
      expect(amountOn(lines, '6711').debit).toBe(0);
      expect(debitTotal(lines)).toBe(creditTotal(lines));
      expect(amountOn(lines, '100201').debit).toBe(50_000);
      expect(Math.round((amountOn(lines, '1603').debit - amountOn(lines, '1603').credit) * 100) / 100).toBe(0);
    });

    it('出售有销项税：收入 50000、税 3000 时 gainLoss = 50000 − 3000 − 30000 = +17000', () => {
      const { lines, gainLoss } = assetDisposalLines({
        ...base,
        disposalType: 'sale',
        disposalIncome: 50_000,
        outputTax: 3_000,
      });
      expect(gainLoss).toBe(17_000);
      // 银行收款为含税
      expect(amountOn(lines, '100201').debit).toBe(53_000);
      expect(amountOn(lines, '222101').credit).toBe(3_000);
      expect(debitTotal(lines)).toBe(creditTotal(lines));
    });

    it('出售亏损：收入 10000 时 gainLoss = 10000 − 30000 = −20000，走 6711', () => {
      const { lines, gainLoss } = assetDisposalLines({
        ...base,
        disposalType: 'sale',
        disposalIncome: 10_000,
      });
      expect(gainLoss).toBe(-20_000);
      expect(amountOn(lines, '6711').debit).toBe(20_000);
      expect(amountOn(lines, '6301').credit).toBe(0);
      expect(debitTotal(lines)).toBe(creditTotal(lines));
    });

    it('捐赠无收入：等同全额报废损失（捐赠支出计入营业外支出）', () => {
      const { lines, gainLoss } = assetDisposalLines({
        ...base,
        disposalType: 'donate',
      });
      expect(gainLoss).toBe(-30_000);
      expect(amountOn(lines, '6711').debit).toBe(30_000);
      expect(amountOn(lines, '100201').debit).toBe(0);
      expect(debitTotal(lines)).toBe(creditTotal(lines));
    });

    it('恰好平账（收入 = 净值）时不产生 6711/6301 损益行', () => {
      const { lines, gainLoss } = assetDisposalLines({
        ...base,
        disposalType: 'sale',
        disposalIncome: 30_000,
      });
      expect(gainLoss).toBe(0);
      expect(amountOn(lines, '6711').debit).toBe(0);
      expect(amountOn(lines, '6301').credit).toBe(0);
      expect(debitTotal(lines)).toBe(creditTotal(lines));
    });

    it('无折旧无减值的全新资产报废：净值 = 原值', () => {
      const { lines, gainLoss } = assetDisposalLines({
        originalValue: 8000,
        accumulatedDepreciation: 0,
        impairmentProvision: 0,
        disposalIncome: 0,
        outputTax: 0,
        disposalType: 'scrap',
      });
      expect(gainLoss).toBe(-8_000);
      expect(amountOn(lines, '1603').debit).toBe(8_000);
      expect(amountOn(lines, '1601').credit).toBe(8_000);
      expect(debitTotal(lines)).toBe(creditTotal(lines));
    });

    it('金额保留两位小数（分）不引入浮点尾差', () => {
      const { lines } = assetDisposalLines({
        originalValue: 10_000.01,
        accumulatedDepreciation: 3333.33,
        impairmentProvision: 0,
        disposalIncome: 0,
        outputTax: 0,
        disposalType: 'scrap',
      });
      expect(debitTotal(lines)).toBe(creditTotal(lines));
    });
  });
});
