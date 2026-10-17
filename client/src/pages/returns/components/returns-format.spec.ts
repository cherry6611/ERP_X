import { money } from './returns-format';

/**
 * 退货金额格式化规格（§5.9 / F8）。
 *
 * `money` 从 `ReturnsPage.tsx` 移到本目录后，页面（列表金额、净额/税额、台账
 * 指标卡）与 `PurchaseReturnCreateDialog`（可退数量区的含税单价）共用同一份实现。
 * 这里钉住两件事：
 *
 *   ① **两位小数 + 千分位**。少一位小数、丢了千分位，界面上"看起来仍然像个金额"
 *      （`1,234,567.50` 与 `1234567.5` 都像），只有对账时才会发现；
 *   ② **不带货币符号**。本函数与 `utils/format.ts` 的 `formatMoney`
 *      （`style: 'currency'`）**不是一回事** —— 表格列与指标卡的单位在表头/标签里，
 *      若有人把 `money` 换成 `formatMoney`，每个数字都会多一个可见符号。
 *      最后一条断言就是拦这个替换的。
 */
describe('退货金额格式化（money）', () => {
  it('固定两位小数并带千分位', () => {
    expect(money(1234567.5)).toBe('1,234,567.50');
    expect(money(0)).toBe('0.00');
    expect(money(1)).toBe('1.00');
    expect(money(89.99)).toBe('89.99');
    expect(money(2.5)).toBe('2.50');
  });

  it('红字（负数）保留负号', () => {
    expect(money(-100)).toBe('-100.00');
  });

  it('超过两位小数按四舍五入（含浮点噪声）', () => {
    expect(money(999.999)).toBe('1,000.00');
    expect(money(0.1 + 0.2)).toBe('0.30');
  });

  it('不带货币符号（与 formatMoney 的区别）', () => {
    expect(money(1234.5)).toBe('1,234.50');
    expect(money(1234.5)).not.toContain('¥');
  });
});
