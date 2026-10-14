/**
 * A-12 验收标准③：金额大写必须正确（含 0、整、角分）。
 *
 * 这里的断言全部是**外部可核对的具体值**（需求书给的示例 + 《正确填写票据和
 * 结算凭证的基本规定》的口径），不是"用同一函数算出来再比一次"的同义反复断言。
 */
import { RmbUpperError, toRmbUpper, toRmbUpperResult } from './rmb-upper';

describe('人民币金额大写（A-12 验收标准③）', () => {
  it('需求书示例：1234.56 → 壹仟贰佰叁拾肆元伍角陆分', () => {
    expect(toRmbUpper(1234.56)).toBe('壹仟贰佰叁拾肆元伍角陆分');
  });

  it('需求书示例：100.00 → 壹佰元整', () => {
    expect(toRmbUpper(100)).toBe('壹佰元整');
    expect(toRmbUpper(100.0)).toBe('壹佰元整');
    expect(toRmbUpper('100.00')).toBe('壹佰元整');
  });

  it('需求书示例：0.05 → 零元零伍分（角位为 0 必须补「零」）', () => {
    expect(toRmbUpper(0.05)).toBe('零元零伍分');
  });

  it('需求书示例：1000000 → 壹佰万元整（亿/万节位为 0 不写多余零）', () => {
    expect(toRmbUpper(1000000)).toBe('壹佰万元整');
  });

  it('整数金额一律以「整」结尾', () => {
    expect(toRmbUpper(0)).toBe('零元整');
    expect(toRmbUpper(1)).toBe('壹元整');
    expect(toRmbUpper(10)).toBe('壹拾元整');
    expect(toRmbUpper(10_0000)).toBe('壹拾万元整');
    expect(toRmbUpper(1_0000_0000)).toBe('壹亿元整');
  });

  it('有角无分：「X元X角整」', () => {
    expect(toRmbUpper(10.5)).toBe('壹拾元伍角整');
    expect(toRmbUpper(0.5)).toBe('零元伍角整');
    expect(toRmbUpper(999.9)).toBe('玖佰玖拾玖元玖角整');
  });

  it('分位存在时不写「整」', () => {
    expect(toRmbUpper(110.05)).toBe('壹佰壹拾元零伍分');
    expect(toRmbUpper(0.01)).toBe('零元零壹分');
    expect(toRmbUpper(1.23)).toBe('壹元贰角叁分');
  });

  it('数字中间连续 0 只写一个「零」', () => {
    expect(toRmbUpper(1005)).toBe('壹仟零伍元整');
    expect(toRmbUpper(10005)).toBe('壹万零伍元整');
    expect(toRmbUpper(1_0001_0001)).toBe('壹亿零壹万零壹元整');
    expect(toRmbUpper(100_0001)).toBe('壹佰万零壹元整');
  });

  it('节权位保留：万/亿/万亿', () => {
    expect(toRmbUpper(12_3456)).toBe('壹拾贰万叁仟肆佰伍拾陆元整');
    expect(toRmbUpper(1_0001_0000)).toBe('壹亿零壹万元整');
    expect(toRmbUpper(1_0000_0000_0000)).toBe('壹万亿元整');
  });

  it('四舍五入到分（补偿 IEEE754 表示误差，与人工算术一致）', () => {
    // 1.005 的双精度值约为 1.00499999999999989，直接 Math.round(x*100) 会得到 1.00
    expect(toRmbUpper(1.005)).toBe('壹元零壹分');
    expect(toRmbUpper(2.675)).toBe('贰元陆角捌分');
    expect(toRmbUpper(1.004)).toBe('壹元整');
    expect(toRmbUpper(0.994)).toBe('零元玖角玖分');
  });

  it('负数表示「负…」', () => {
    expect(toRmbUpper(-1234.56)).toBe('负壹仟贰佰叁拾肆元伍角陆分');
  });

  it('非法入参抛错而不是返回错误大写', () => {
    expect(() => toRmbUpper('abc')).toThrow(RmbUpperError);
    expect(() => toRmbUpper(Number.NaN)).toThrow(RmbUpperError);
    expect(() => toRmbUpper(Number.POSITIVE_INFINITY)).toThrow(RmbUpperError);
    expect(() => toRmbUpper(1e13)).toThrow(RmbUpperError);
  });

  it('toRmbUpperResult 返回契约结构 { amount, text }，非法金额同样抛错', () => {
    expect(toRmbUpperResult('1234.56')).toEqual({
      amount: 1234.56,
      text: '壹仟贰佰叁拾肆元伍角陆分',
    });
    expect(() => toRmbUpperResult('not-a-number')).toThrow(RmbUpperError);
  });
});
