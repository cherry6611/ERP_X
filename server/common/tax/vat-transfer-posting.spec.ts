import { isBalanced, purchaseReturnLines } from './return-rules';
import { vatTransferOutLines } from './vat-transfer-posting';

/**
 * T-S3 单测：月末转出未交增值税分录。
 *
 * 锁两件事：① 借贷方向（借 222103 / 贷 222104）不能反——方向反了
 * "转出"变成"转入"，未交增值税会被记成借方余额；② 0 与负数不出行，
 * 留抵月份不产生凭证。
 */
describe('T-S3 转出未交增值税分录', () => {
  it('借 222103 / 贷 222104，金额等于应纳税额且借贷平衡', () => {
    const lines = vatTransferOutLines(1300);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ accountCode: '222103', debit: 1300 });
    expect(lines[1]).toEqual({ accountCode: '222104', credit: 1300 });
    expect(isBalanced(lines)).toBe(true);
  });

  it('应纳税额为 0（期末留抵 / 免税）时不产生分录', () => {
    expect(vatTransferOutLines(0)).toEqual([]);
  });

  it('负数（不可能出现的口径）同样不出行，绝不生成反向凭证', () => {
    expect(vatTransferOutLines(-100)).toEqual([]);
  });

  it('分位金额如实入账（不抹平尾差）', () => {
    const lines = vatTransferOutLines(0.01);
    expect(lines[0].debit).toBe(0.01);
    expect(lines[1].credit).toBe(0.01);
    expect(isBalanced(lines)).toBe(true);
  });

  it('与采购退货分录并存时仍各自平衡（组合场景自检）', () => {
    const transfer = vatTransferOutLines(1300);
    const ret = purchaseReturnLines(1000, 60, { netAccountCode: '6602' });
    expect(isBalanced(transfer)).toBe(true);
    expect(isBalanced(ret)).toBe(true);
  });
});
