import { decideProjectBaseline, moneyToCents } from './project-baseline';

describe('项目预算基线按分比较', () => {
  it('把两位小数收成整数分', () => {
    expect(moneyToCents('10.2')).toBe(1020n);
    expect(moneyToCents('-0.05')).toBe(-5n);
    expect(moneyToCents(null)).toBe(0n);
  });

  it('预算为 0 时拒绝，并要求先填写预算', () => {
    const decision = decideProjectBaseline({
      projectExists: true,
      budget: '0.00',
      occupied: '0',
      amount: '1.00',
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain('请先在项目上填写大于 0 的预算');
    }
  });

  it('已占用加本次超过预算时拒绝，相等时通过', () => {
    expect(
      decideProjectBaseline({
        projectExists: true,
        budget: '100000.00',
        occupied: '60000.00',
        amount: '40000.00',
      }).ok,
    ).toBe(true);
    const over = decideProjectBaseline({
      projectExists: true,
      budget: '100000.00',
      occupied: '60000.00',
      amount: '40000.01',
    });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toContain('100000.00');
      expect(over.reason).toContain('40000.01');
    }
  });

  it('项目不存在时不在这里拦截', () => {
    expect(
      decideProjectBaseline({
        projectExists: false,
        budget: '0',
        occupied: '0',
        amount: '1',
      }).ok,
    ).toBe(true);
  });
});
