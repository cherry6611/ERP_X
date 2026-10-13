import { lineAmount, splitTax } from '@shared/tax';

describe('splitTax', () => {
  it('按含税口径拆出验收行', () => {
    expect(splitTax(101000, 1)).toEqual({ net: 100000, tax: 1000 });
    expect(splitTax(103000, 3)).toEqual({ net: 100000, tax: 3000 });
    expect(splitTax(106000, 6)).toEqual({ net: 100000, tax: 6000 });
    expect(splitTax(109000, 9)).toEqual({ net: 100000, tax: 9000 });
    expect(splitTax(113000, 13)).toEqual({ net: 100000, tax: 13000 });
    expect(splitTax(100000, 0)).toEqual({ net: 100000, tax: 0 });
  });

  it('行金额按折扣后含税价四舍五入到分', () => {
    expect(lineAmount(2, 100, 0)).toBe(200);
    expect(lineAmount(10, 100, 10)).toBe(900);
  });
});
