import {
  ALLOWED_RATES,
  FALLBACK_RATE,
  VAT_RATES,
  isVatRate,
  lineAmount,
  rateAllowed,
  splitTax,
} from '@shared/tax';

describe('税额拆分（含税口径）', () => {
  it('字典内各档位的整除场景与业务口径一致', () => {
    expect(splitTax(101000, 1)).toEqual({ net: 100000, tax: 1000 });
    expect(splitTax(103000, 3)).toEqual({ net: 100000, tax: 3000 });
    expect(splitTax(106000, 6)).toEqual({ net: 100000, tax: 6000 });
    expect(splitTax(109000, 9)).toEqual({ net: 100000, tax: 9000 });
    expect(splitTax(113000, 13)).toEqual({ net: 100000, tax: 13000 });
  });

  it('税率为 0 时净额等于含税额、税额为 0', () => {
    expect(splitTax(100000, 0)).toEqual({ net: 100000, tax: 0 });
  });

  it('金额为 0 时不产生税额', () => {
    expect(splitTax(0, 13)).toEqual({ net: 0, tax: 0 });
  });

  it('不变式：net + tax 恒等于含税总额（尾差不超过 1 分）', () => {
    let seed = 20261013;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 2000; i += 1) {
      const amount = Math.round(rand() * 1_000_000 * 100) / 100;
      const rate = VAT_RATES[i % VAT_RATES.length];
      const { net, tax } = splitTax(amount, rate);
      expect(Math.abs(net + tax - amount)).toBeLessThanOrEqual(0.011);
    }
  });

  it('红字（负数金额）的方向与正数相反', () => {
    const positive = splitTax(11300, 13);
    const negative = splitTax(-11300, 13);
    expect(negative.tax).toBe(-positive.tax);
    expect(negative.net).toBe(-positive.net);
  });
});

describe('税率合法性', () => {
  it('只接受字典内的税率', () => {
    for (const rate of VAT_RATES) expect(isVatRate(rate)).toBe(true);
    for (const bad of [7, 17, -1, 1.5, 16]) expect(isVatRate(bad)).toBe(false);
  });

  it('一般纳税人可用 3%（简易计税），但不得使用小规模 1%', () => {
    expect(rateAllowed('general', 1)).toBe(false);
    expect(rateAllowed('general', 3)).toBe(true);
    expect(rateAllowed('general', 5)).toBe(true);
    expect(rateAllowed('general', 6)).toBe(true);
  });

  it('小规模纳税人不得使用 6% / 9% / 13%', () => {
    expect(rateAllowed('small', 6)).toBe(false);
    expect(rateAllowed('small', 13)).toBe(false);
    expect(rateAllowed('small', 1)).toBe(true);
  });

  it('兜底税率属于字典', () => {
    expect(isVatRate(FALLBACK_RATE)).toBe(true);
    expect(ALLOWED_RATES.general).toContain(FALLBACK_RATE);
  });
});

describe('含税行金额', () => {
  it('数量 × 单价 × (1 - 折扣%)', () => {
    expect(lineAmount(10, 1000, 0)).toBe(10000);
    expect(lineAmount(10, 1000, 10)).toBe(9000);
  });

  it('小数数量与折扣下保留两位', () => {
    expect(lineAmount(1.5, 333.33, 0)).toBe(500);
    // 3 × 99.99 × (1 − 33.33%) = 199.99… ，四舍五入到分即 199.99
    expect(lineAmount(3, 99.99, 33.33)).toBe(199.99);
  });

  it('折扣 100% 时行金额为 0', () => {
    expect(lineAmount(5, 100, 100)).toBe(0);
  });
});
