import {
  DERIVED_RATE_SOURCES,
  explicitRateForRecalc,
  rateSourceMatchesExplicit,
} from './contract-tax-recalc';

/**
 * 合同税额重算的"旧税率还算不算显式选定"规格。
 *
 * ## 这些用例为什么值得单独存在
 *
 * 缺陷的表征**只在库里**：`tax_rate` 与 `rate_source` 两列的组合。
 * 界面上永远显示一个看起来正常的税率，提交也不报错 ——
 * 只有"改客户 → 税率没跟着变"这一步会被人发现，而那时已经过去了很久。
 * 因此把判据钉在纯函数上，逐组合断言，比任何界面走查都更早发现问题。
 */
describe('explicitRateForRecalc', () => {
  it('用户显式选定的税率必须原样保留（改客户不该动它）', () => {
    expect(explicitRateForRecalc(13, 'explicit')).toBe(13);
    expect(explicitRateForRecalc('9.00', 'explicit')).toBe(9);
  });

  it('上游单据带入的税率同样保留', () => {
    expect(explicitRateForRecalc(6, 'upstream')).toBe(6);
  });

  it('rate_source 为 NULL（历史行）按权威值处理，避免"只改金额就把历史税率也改了"', () => {
    expect(explicitRateForRecalc(13, null)).toBe(13);
    expect(explicitRateForRecalc(13, undefined)).toBe(13);
  });

  it('由客户默认税率推导出来的税率必须重新推导（改客户要跟着走）', () => {
    expect(explicitRateForRecalc(13, 'counterparty')).toBeNull();
  });

  it('由纳税主体默认税率推导出来的税率必须重新推导（改主体要跟着走）', () => {
    expect(explicitRateForRecalc(6, 'entity')).toBeNull();
  });

  it('兜底 6% 同样重新推导（一旦客户/主体有配置就应采用配置值）', () => {
    expect(explicitRateForRecalc(6, 'fallback')).toBeNull();
  });

  it('空值与非法值一律返回 null（交给解析器按优先级推导）', () => {
    expect(explicitRateForRecalc(null, 'explicit')).toBeNull();
    expect(explicitRateForRecalc(undefined, 'counterparty')).toBeNull();
    expect(explicitRateForRecalc('abc', 'explicit')).toBeNull();
  });

  it('0% 是合法档位，不能被当成"空值"', () => {
    expect(explicitRateForRecalc(0, 'explicit')).toBe(0);
    expect(explicitRateForRecalc('0.00', 'explicit')).toBe(0);
  });

  it('推导来源清单与实现一致（新增来源时必须一并登记，否则会静默固化）', () => {
    expect([...DERIVED_RATE_SOURCES].sort()).toEqual(['counterparty', 'entity', 'fallback']);
    for (const source of DERIVED_RATE_SOURCES) {
      expect(explicitRateForRecalc(13, source)).toBeNull();
    }
  });

  it('规格即缺陷复现：三步走完之后不能出现「税率 13 / 来源 explicit」这种自相矛盾的行', () => {
    // ① 建合同：没显式选税率，落到客户默认 13%
    const created = { rate: 13, source: 'counterparty' };
    // ② 改客户 → 应当重新推导（而不是把 13 当显式）
    expect(explicitRateForRecalc(created.rate, created.source)).toBeNull();
    // ③ 若第 ② 步返回了 13，解析器会给出 source='explicit' —— 这正是被修掉的行为
    expect(rateSourceMatchesExplicit(13, 'explicit')).toBe(true);
    expect(rateSourceMatchesExplicit(null, 'counterparty')).toBe(true);
  });
});

describe('rateSourceMatchesExplicit', () => {
  it('传了显式税率时来源必须是 explicit', () => {
    expect(rateSourceMatchesExplicit(6, 'explicit')).toBe(true);
    expect(rateSourceMatchesExplicit(6, 'counterparty')).toBe(false);
  });

  it('没传显式税率时来源不能是 explicit（这正是"被洗成 explicit"的检测点）', () => {
    expect(rateSourceMatchesExplicit(null, 'counterparty')).toBe(true);
    expect(rateSourceMatchesExplicit(undefined, 'entity')).toBe(true);
    expect(rateSourceMatchesExplicit(null, 'explicit')).toBe(false);
  });
});
