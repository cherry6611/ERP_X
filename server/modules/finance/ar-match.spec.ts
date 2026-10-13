import {
  arSettleStatus,
  isVoucherBalanced,
  openAmount,
  receiptMatchStatus,
} from './ar-match';

describe('ar-match helpers', () => {
  it('openAmount 计算未核销余额', () => {
    expect(openAmount(1000, 300)).toBe(700);
    expect(openAmount(100, 100)).toBe(0);
  });

  it('arSettleStatus / receiptMatchStatus 按阈值切换状态', () => {
    expect(arSettleStatus(500, 1000)).toBe('partial');
    expect(arSettleStatus(1000, 1000)).toBe('settled');
    expect(receiptMatchStatus(200, 500)).toBe('partial');
    expect(receiptMatchStatus(500, 500)).toBe('matched');
  });

  it('isVoucherBalanced 分比较借贷', () => {
    expect(
      isVoucherBalanced([
        { debit: 106 },
        { credit: 100 },
        { credit: 6 },
      ])
    ).toBe(true);
    expect(
      isVoucherBalanced([{ debit: 100 }, { credit: 99.99 }])
    ).toBe(false);
  });
});
