/**
 * `asset-book-value` 的规格：固定资产账面净值与处置税额口径。
 *
 * ## 最重要的一条：三处调用必须得到**同一个**净值
 *
 * 抽出前这条公式在 `asset-lifecycle.service.ts` 里写了三遍（减值测试基准 /
 * 处置预览 / 生命周期时间线）。三份副本一旦分叉，同一张资产卡片会在两个页面上
 * 显示两个净值，而**两边都不报错**。所以这里既断言公式本身，
 * 也断言"同一个入参必然得到同一个结果"。
 */
import {
  impairmentLossOf,
  netBookValueOf,
  outputTaxOfDisposal,
  toNumber,
} from './asset-book-value';

describe('toNumber（numeric 经 pg 驱动是字符串）', () => {
  it('字符串数字按数字解析', () => {
    expect(toNumber('123.45')).toBe(123.45);
    expect(toNumber(0)).toBe(0);
    expect(toNumber('0')).toBe(0);
  });

  it('null / undefined → 0', () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
  });

  it('⚠️ 非数字字符串 → 0（而不是 NaN 一路传下去）', () => {
    expect(toNumber('abc')).toBe(0);
    expect(toNumber('')).toBe(0);
  });

  it('⚠️ NaN / Infinity → 0（避免净值变 NaN 写进凭证金额）', () => {
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber(Number.POSITIVE_INFINITY)).toBe(0);
    expect(toNumber(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('netBookValueOf（账面净值 = 原值 − 累计折旧 − 减值准备）', () => {
  it('基本计算', () => {
    expect(
      netBookValueOf({ originalValue: 10000, accumulatedDepreciation: 3000, accumulatedImpairment: 500 }),
    ).toBe(6500);
  });

  it('折旧为 0 时为原值', () => {
    expect(
      netBookValueOf({ originalValue: 10000, accumulatedDepreciation: 0, accumulatedImpairment: 0 }),
    ).toBe(10000);
  });

  it('⚠️ 折旧+减值超过原值 → clamp 到 0（有意的容错，不是漏校验）', () => {
    expect(
      netBookValueOf({ originalValue: 10000, accumulatedDepreciation: 8000, accumulatedImpairment: 5000 }),
    ).toBe(0);
  });

  it('恰好折完 → 0', () => {
    expect(
      netBookValueOf({ originalValue: 10000, accumulatedDepreciation: 10000, accumulatedImpairment: 0 }),
    ).toBe(0);
  });

  it('⚠️ 入参是字符串（numeric 经驱动）也得到同样的数', () => {
    expect(
      netBookValueOf({ originalValue: '10000.00', accumulatedDepreciation: '3000.00', accumulatedImpairment: '500.00' }),
    ).toBe(6500);
  });

  it('⚠️ 漏了 Number() 会得到 NaN —— 这里断言不会', () => {
    const v = netBookValueOf({ originalValue: '10000', accumulatedDepreciation: '3000', accumulatedImpairment: '500' });
    expect(Number.isFinite(v)).toBe(true);
    expect(v).not.toBeNaN();
  });

  it('保留 2 位（除不尽的折旧）', () => {
    expect(
      netBookValueOf({ originalValue: 10000, accumulatedDepreciation: 3333.333, accumulatedImpairment: 0 }),
    ).toBe(6666.67);
  });

  it('⚠️ 三处调用必须同源：同一入参在任何调用形态下结果一致', () => {
    const args = { originalValue: '9999.99', accumulatedDepreciation: '1234.56', accumulatedImpairment: '78.9' };
    const results = [netBookValueOf(args), netBookValueOf({ ...args }), netBookValueOf(args)];
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(8686.53);
  });

  it('减值准备为 null 按 0（未计提过减值）', () => {
    expect(
      netBookValueOf({ originalValue: 10000, accumulatedDepreciation: 1000, accumulatedImpairment: null }),
    ).toBe(9000);
  });
});

describe('outputTaxOfDisposal（销项税按不含税净额正算）', () => {
  it('净额 10000 × 13% → 1300', () => {
    expect(outputTaxOfDisposal({ netDisposalIncome: 10000, taxRate: 13 })).toBe(1300);
  });

  it('13% 不是"价内倒算"：净额 10000 的税是 1300 而不是 10000/1.13×0.13', () => {
    const tax = outputTaxOfDisposal({ netDisposalIncome: 10000, taxRate: 13 });
    expect(tax).toBe(1300);
    /* 价内倒算会得到约 1150.44，少提约 150 元 */
    expect(tax).not.toBeCloseTo(1150.44, 2);
  });

  it('收入为 0（报废/捐赠）→ 无税额', () => {
    expect(outputTaxOfDisposal({ netDisposalIncome: 0, taxRate: 13 })).toBe(0);
  });

  it('税率为 0（免税）→ 无税额', () => {
    expect(outputTaxOfDisposal({ netDisposalIncome: 10000, taxRate: 0 })).toBe(0);
  });

  it('负收入按 0 处理（不产生负税额）', () => {
    expect(outputTaxOfDisposal({ netDisposalIncome: -500, taxRate: 13 })).toBe(0);
  });

  it('小数税率（1%）与尾差', () => {
    expect(outputTaxOfDisposal({ netDisposalIncome: 3333.33, taxRate: 1 })).toBe(33.33);
  });

  it('入参为字符串同样可用', () => {
    expect(outputTaxOfDisposal({ netDisposalIncome: '10000', taxRate: '13' })).toBe(1300);
  });
});

describe('impairmentLossOf（减值损失）', () => {
  it('账面 10000、可收回 8000 → 损失 2000', () => {
    expect(impairmentLossOf({ bookValue: 10000, recoverableAmount: 8000 })).toBe(2000);
  });

  it('⚠️ 可收回金额高于账面 → 损失 0（不确认"负损失"）', () => {
    expect(impairmentLossOf({ bookValue: 8000, recoverableAmount: 10000 })).toBe(0);
  });

  it('恰好相等 → 0', () => {
    expect(impairmentLossOf({ bookValue: 8000, recoverableAmount: 8000 })).toBe(0);
  });

  it('可收回金额为 0 → 全额减值', () => {
    expect(impairmentLossOf({ bookValue: 8000, recoverableAmount: 0 })).toBe(8000);
  });

  it('入参为字符串同样可用', () => {
    expect(impairmentLossOf({ bookValue: '10000', recoverableAmount: '8000' })).toBe(2000);
  });
});
