import { moneyText, round2, yuanToCents } from '@shared/number';

/**
 * 金额取整的口径锁定。
 *
 * 用例按「错法方向」组织，而不是按函数组织 —— 因为这里历史上踩过两次坑：
 *   1. 二进制浮点让 1.005 舍成 1.00（会计口径应为 1.01）；
 *   2. `Math.round` 向 +∞ 取整，导致负数（红冲）与正数方向不对称。
 * 两种都不报错、不平账，只能靠双向断言锁死。
 */
describe('round2', () => {
  describe('会计口径：十进制四舍五入（远离零）', () => {
    it.each([
      [1.005, 1.01],
      [2.675, 2.68],
      [0.145, 0.15],
      [1.015, 1.02],
      [8.835, 8.84],
      [123.455, 123.46],
      [0.1, 0.1],
      [3.14159, 3.14],
    ])('round2(%p) === %p', (input, expected) => {
      expect(round2(input)).toBe(expected);
    });

    it('不因二进制浮点把 .005 舍丢（1.005 应为 1.01 而非 1.00）', () => {
      // 反例锁定：若实现退回 Math.round(v * 100) / 100，此断言会失败
      expect(round2(1.005)).toBe(1.01);
      expect(round2(1.005)).not.toBe(1.0);
    });
  });

  describe('红冲对称性：round2(x) + round2(-x) === 0', () => {
    it.each([1.005, 2.675, 0.145, 1.015, 8.835, 123.455, 99.999, 0.335])(
      'round2(%p) + round2(%p) === 0',
      (v) => {
        expect(round2(v) + round2(-v)).toBe(0);
      }
    );

    it('红冲分录借贷轧平（原凭证与红冲凭证合计为 0）', () => {
      // 真实缺陷：旧实现下 2.675 与 -2.675 分别舍成 2.68 / -2.67，合计 0.01，
      // 红冲后科目余额凭空多出 1 分且不报错
      const lines = [2.675, -2.675, 1.005, -1.005, 0.145, -0.145];
      const sum = lines.reduce((acc, v) => acc + round2(v), 0);
      expect(sum).toBe(0);
    });

    it('负数方向同样远离零（-2.675 应为 -2.68 而非 -2.67）', () => {
      expect(round2(-2.675)).toBe(-2.68);
      expect(round2(-1.005)).toBe(-1.01);
      expect(round2(-0.145)).toBe(-0.15);
    });
  });

  describe('进位跨整数位', () => {
    it('99.999 → 100（小数进位传递到整数位）', () => {
      expect(round2(99.999)).toBe(100);
      expect(round2(-99.999)).toBe(-100);
    });

    it('999.999 → 1000（连续进位）', () => {
      expect(round2(999.999)).toBe(1000);
      expect(round2(-999.999)).toBe(-1000);
    });

    it('0 与 -0 都返回 0（不产生 -0）', () => {
      expect(round2(0)).toBe(0);
      expect(Object.is(round2(-0), 0)).toBe(true);
    });
  });

  describe('价税拆分后的借贷平衡', () => {
    it.each([0, 1, 3, 6, 9, 13])('含税金额按 %p%% 拆分后净额+税额 === 含税额', (rate) => {
      for (const gross of [10000, 333.33, 1234.56, 99.99]) {
        const tax = round2((gross * rate) / (100 + rate));
        const net = round2(gross - tax);
        expect(round2(net + tax)).toBe(round2(gross));
      }
    });
  });

  describe('非有限数不静默归零', () => {
    it('NaN 原样返回（不抹成 0）', () => {
      expect(round2(NaN)).toBeNaN();
    });

    it('Infinity 原样返回', () => {
      expect(round2(Infinity)).toBe(Infinity);
      expect(round2(-Infinity)).toBe(-Infinity);
    });
  });
});

describe('yuanToCents / moneyText', () => {
  it('1.005 元是 101 分，落库为 1.01', () => {
    expect(yuanToCents(1.005)).toBe(101n);
    expect(moneyText(1.005)).toBe('1.01');
  });

  it('红冲与正数分值互为相反数', () => {
    expect(yuanToCents(-1.005)).toBe(-101n);
    expect(moneyText(-1.005)).toBe('-1.01');
  });

  it('非有限数不能换成 0 分', () => {
    expect(yuanToCents(Number.NaN)).toBeNull();
    expect(moneyText(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
