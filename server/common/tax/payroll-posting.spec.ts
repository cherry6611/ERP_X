import { payrollAccrualLines } from './payroll-posting';

/**
 * N-1 工资计提分录锁定。
 *
 * 这组用例的核心不是"某个金额对不对"，而是三条**结构性不变量**：
 *   1. 借贷必须相等（不平就是记账事故）；
 *   2. `2211-工资` 的净额必须等于**实发**（否则银行发放金额与账面永远对不上）；
 *   3. 代扣项必须落到各自的负债科目（个税 → 222112、社保 → 221102、
 *      公积金 → 221103），不能全挂在 2211 里 —— 否则缴税/缴社保时无处可冲。
 */
describe('工资按应发计提（payrollAccrualLines）', () => {
  const sum = (lines: ReturnType<typeof payrollAccrualLines>, side: 'debit' | 'credit') =>
    Math.round(lines.reduce((acc, line) => acc + (line[side] ?? 0), 0) * 100) / 100;

  const netOf = (lines: ReturnType<typeof payrollAccrualLines>, code: string) =>
    Math.round(
      lines
        .filter((line) => line.accountCode === code)
        .reduce((acc, line) => acc + (line.credit ?? 0) - (line.debit ?? 0), 0) * 100
    ) / 100;

  it('完整工资：借=贷，且 2211-工资 净额 = 实发，代扣各归其位', () => {
    const lines = payrollAccrualLines({
      gross: 20000,
      expenseAccountCode: '660201',
      individualIncomeTax: 890,
      socialInsurance: 1600,
      housingFund: 1200,
      otherDeduction: 310,
    });

    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
    // 实发 = 20000 - 890 - 1600 - 1200 - 310
    expect(netOf(lines, '221101')).toBe(16000);

    expect(lines).toContainEqual(
      expect.objectContaining({ accountCode: '660201', debit: 20000 })
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ accountCode: '222112', credit: 890 })
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ accountCode: '221102', credit: 1600 })
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ accountCode: '221103', credit: 1200 })
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ accountCode: '221104', credit: 310 })
    );
  });

  it('无任何代扣时只出两行，且按应发入账（不是按净额）', () => {
    const lines = payrollAccrualLines({
      gross: 8000,
      expenseAccountCode: '6401',
    });

    expect(lines).toEqual([
      { accountCode: '6401', debit: 8000 },
      { accountCode: '221101', credit: 8000 },
    ]);
  });

  it('只有个税时不含社保/公积金/其他行（避免出现 0 金额分录）', () => {
    const lines = payrollAccrualLines({
      gross: 10000,
      expenseAccountCode: '6401',
      individualIncomeTax: 150,
    });

    expect(lines).toHaveLength(4);
    expect(lines.filter((line) => line.accountCode === '221102')).toHaveLength(0);
    expect(netOf(lines, '221101')).toBe(9850);
  });

  it('负数代扣项被夹到 0，不产生反向分录', () => {
    const lines = payrollAccrualLines({
      gross: 5000,
      expenseAccountCode: '6401',
      individualIncomeTax: -100,
      socialInsurance: 200,
    });

    expect(lines.some((line) => (line.debit ?? 0) < 0 || (line.credit ?? 0) < 0)).toBe(
      false
    );
    expect(netOf(lines, '221101')).toBe(4800);
  });

  it('应发非正数时不出任何分录', () => {
    expect(payrollAccrualLines({ gross: 0, expenseAccountCode: '6401' })).toEqual([]);
    expect(payrollAccrualLines({ gross: -1, expenseAccountCode: '6401' })).toEqual([]);
  });

  it('金额带小数时借贷仍严格相等', () => {
    const lines = payrollAccrualLines({
      gross: 12345.67,
      expenseAccountCode: '6401',
      individualIncomeTax: 123.45,
      socialInsurance: 987.65,
    });

    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });
});
