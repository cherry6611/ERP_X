import { unbilledRevenueNet } from './vat-unbilled';

/**
 * 增值税底稿「未开票收入」不含税额口径规格。
 *
 * ## 守的是什么
 *
 * 这个数直接进申报表**第 1 行（按适用税率计税销售额）**，算错就是申报数错：
 *   · 算**大**了 → 销售额虚增（可能把小规模主体误推出免征额度）；
 *   · 算**小**了 → 销售额少计，且方向不可逆。
 *
 * ## 负差为什么必须截为 0
 *
 * 负差意味着"以前期间确认的收入在本期开票"，那部分已在上期申报过。
 * 若让它冲减本期销售额，就是**重复冲减 → 少缴**。
 * 这条是本文件最重要的一条断言。
 */
describe('unbilledRevenueNet（未开票收入不含税额）', () => {
  it('已确认收入大于已开票净额时，差额即未开票收入', () => {
    // 走查实测数据：本期已确认 63600（含税）、已开销项净额 30000
    expect(unbilledRevenueNet(63600, 30000)).toBe(33600);
  });

  it('两者相等时为 0', () => {
    expect(unbilledRevenueNet(31800, 31800)).toBe(0);
  });

  it('⚠️ 负差一律为 0，不得冲减当期销售额（否则少缴）', () => {
    expect(unbilledRevenueNet(10000, 31800)).toBe(0);
    expect(unbilledRevenueNet(0, 5)).toBe(0);
  });

  it('本期无收入但开票（以前期间收入在本期开票）也为 0', () => {
    expect(unbilledRevenueNet(0, 106000)).toBe(0);
  });

  it('字符串 / null / 非数字按 0 处理，不产生 NaN', () => {
    expect(unbilledRevenueNet('63600.00', '30000.00')).toBe(33600);
    expect(unbilledRevenueNet(null, undefined)).toBe(0);
    expect(unbilledRevenueNet('abc', 100)).toBe(0);
  });

  it('分位取整与 splitTax 同源：0.005 级尾差不放大', () => {
    expect(unbilledRevenueNet(100.005, 0)).toBe(100.01);
    expect(unbilledRevenueNet(0.005, 0.005)).toBe(0);
  });
});
