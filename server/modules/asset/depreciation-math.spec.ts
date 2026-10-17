/**
 * `depreciation-math` 的规格：直线折旧的尾差吸收与残值下限。
 *
 * 这组断言针对的全是**不抛异常、只是账目慢慢偏掉**的错法（见模块文件头）。
 * 其中"末期吸收尾差"与"净值不跌破残值"是两条硬约束，用**逐月累提**的
 * 端到端断言来钉住 —— 单看某一期的金额看不出问题，跑满全周期才看得出来。
 */
import {
  DEFAULT_USEFUL_MONTHS,
  computeDepreciation,
  type DepreciationInput,
} from './depreciation-math';

const base = (over: Partial<DepreciationInput> = {}): DepreciationInput => ({
  originalValue: 12000,
  residualValue: 0,
  netValue: 12000,
  usefulMonths: 12,
  donePeriods: 0,
  ...over,
});

describe('computeDepreciation 基本形态', () => {
  it('12 个月 / 原值 12000 / 残值 0 → 每月 1000', () => {
    const d = computeDepreciation(base());
    expect(d).toEqual({ kind: 'depreciate', amount: 1000, isLastPeriod: false });
  });

  it('残值参与计算：原值 12000 残值 1200、12 期 → 每月 900', () => {
    const d = computeDepreciation(base({ residualValue: 1200, netValue: 12000 }));
    expect(d.kind).toBe('depreciate');
    if (d.kind === 'depreciate') expect(d.amount).toBe(900);
  });

  it('usefulMonths 为空 → 按默认 36 期', () => {
    const d = computeDepreciation(base({ usefulMonths: null, originalValue: 3600, netValue: 3600 }));
    expect(d.kind).toBe('depreciate');
    if (d.kind === 'depreciate') expect(d.amount).toBe(100);
    expect(DEFAULT_USEFUL_MONTHS).toBe(36);
  });
});

describe('跳过分支', () => {
  it('已提满年限 → life_exhausted（**即使净值仍高于残值**）', () => {
    /* 这条顺序很重要：先判年限再判净值。反过来的话，历史尾差会让已到期资产再提一期 */
    const d = computeDepreciation(base({ donePeriods: 12, netValue: 0.5, residualValue: 0 }));
    expect(d).toEqual({ kind: 'skip', reason: 'life_exhausted' });
  });

  it('净值已到残值 → fully_depreciated', () => {
    const d = computeDepreciation(base({ netValue: 1200, residualValue: 1200 }));
    expect(d).toEqual({ kind: 'skip', reason: 'fully_depreciated' });
  });

  it('剩余额恰好 0.01 → **仍然计提**（阈值是严格小于）', () => {
    const d = computeDepreciation(base({ netValue: 0.01, residualValue: 0, usefulMonths: 12 }));
    expect(d.kind).toBe('depreciate');
    if (d.kind === 'depreciate') expect(d.amount).toBe(0.01);
  });

  it('剩余额 0.005 → 经 round2 进位到 0.01，**仍然计提**（不足 1 分的判断在取整之后）', () => {
    /*
     * ⚠️ 我第一版把这条写成"应跳过"，是**我错了**：
     * `shared/number.ts` 的 `round2` 是「先转十进制字符串、再按十进制位远离零取整」
     * （为了让 `round2(x) + round2(-x) === 0` 恒成立，红冲凭证才平），
     * 所以 `round2(0.005) === 0.01` 而不是 0。
     * 于是"剩余可提额"被判为 1 分钱、可以提 —— 这与 service 的原始实现一致。
     */
    const d = computeDepreciation(base({ netValue: 0.005, residualValue: 0 }));
    expect(d.kind).toBe('depreciate');
    if (d.kind === 'depreciate') expect(d.amount).toBe(0.01);
  });

  it('剩余额 0.004 → 取整后为 0，跳过（不足 1 分）', () => {
    const d = computeDepreciation(base({ netValue: 0.004, residualValue: 0 }));
    expect(d.kind).toBe('skip');
  });

  it('净值低于残值（异常历史数据）→ 不计提，不产生负数', () => {
    const d = computeDepreciation(base({ netValue: 100, residualValue: 1200 }));
    expect(d.kind).toBe('skip');
  });
});

describe('⚠️ 末期与尾差吸收', () => {
  it('末期标记：donePeriods = 年限 − 1', () => {
    const d = computeDepreciation(base({ donePeriods: 11 }));
    expect(d.kind).toBe('depreciate');
    if (d.kind === 'depreciate') expect(d.isLastPeriod).toBe(true);
  });

  it('月额不能超过剩余可提额（钳到剩余额）', () => {
    /* 原值 12000 / 12 期 → 月额 1000，但净值只剩 300（被调低过） */
    const d = computeDepreciation(base({ netValue: 300 }));
    expect(d.kind).toBe('depreciate');
    if (d.kind === 'depreciate') expect(d.amount).toBe(300);
  });

  it('⚠️ 除不尽的年限：末期吸收尾差，净值精确落到残值', () => {
    /* 10000 / 3 期 → 月额 round2(3333.333…) = 3333.33 */
    const first = computeDepreciation({
      originalValue: 10000, residualValue: 0, netValue: 10000, usefulMonths: 3, donePeriods: 0,
    });
    expect(first.kind).toBe('depreciate');
    if (first.kind !== 'depreciate') return;
    expect(first.amount).toBe(3333.33);

    const second = computeDepreciation({
      originalValue: 10000, residualValue: 0,
      netValue: 10000 - first.amount, usefulMonths: 3, donePeriods: 1,
    });
    expect(second.kind).toBe('depreciate');
    if (second.kind !== 'depreciate') return;
    expect(second.amount).toBe(3333.33);

    /* 第三期（末期）应把剩余的 3333.34 补齐 */
    const third = computeDepreciation({
      originalValue: 10000, residualValue: 0,
      netValue: 10000 - first.amount - second.amount, usefulMonths: 3, donePeriods: 2,
    });
    expect(third).toEqual({ kind: 'depreciate', amount: 3333.34, isLastPeriod: true });
  });

  it('⚠️ 端到端：跑满全周期后净值 == 残值（不差一分、不跌破）', () => {
    const originalValue = 9999.99;
    const residualValue = 500;
    const usefulMonths = 7;
    let netValue = originalValue;
    let periods = 0;
    for (let i = 0; i < usefulMonths + 5 && periods < usefulMonths; i += 1) {
      const d = computeDepreciation({
        originalValue, residualValue, netValue, usefulMonths, donePeriods: periods,
      });
      if (d.kind === 'skip') break;
      netValue = Math.round((netValue - d.amount) * 100) / 100;
      periods += 1;
    }
    expect(periods).toBe(usefulMonths);
    expect(netValue).toBe(residualValue);
  });

  it('⚠️ 端到端：任何一期都不让净值跌破残值', () => {
    const originalValue = 5000;
    const residualValue = 700;
    const usefulMonths = 6;
    let netValue = originalValue;
    let periods = 0;
    for (let i = 0; i < usefulMonths; i += 1) {
      const d = computeDepreciation({
        originalValue, residualValue, netValue, usefulMonths, donePeriods: periods,
      });
      if (d.kind === 'skip') break;
      netValue = Math.round((netValue - d.amount) * 100) / 100;
      expect(netValue).toBeGreaterThanOrEqual(residualValue);
      periods += 1;
    }
  });

  it('计提额永远不为 0 或负数', () => {
    for (const netValue of [0.01, 0.5, 1, 99.99, 12000]) {
      const d = computeDepreciation(base({ netValue }));
      if (d.kind === 'depreciate') expect(d.amount).toBeGreaterThan(0);
    }
  });
});
