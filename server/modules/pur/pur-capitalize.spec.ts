/**
 * 设备类采购验收「分批资本化」的回归断言。
 *
 * 缺陷背景（实测，见 `scripts/browser-walkthrough/out/assets-pur-report.json`）：
 * 设备类订单第 1 次验收建卡成功，第 2 次验收撞
 * `uq_ast_asset_purchase_order` → 409「该采购订单已生成固定资产卡片」，
 * 订单**永远收不完**。修法是累计已有卡片的原值/净值，本文件钉住累计口径。
 */
import {
  accumulateCapitalizedValue,
  type ExistingCapitalizedAsset,
} from './pur-capitalize';

describe('采购验收资本化金额累计', () => {
  it('订单还没有卡片时，用本次验收金额建卡（原值 = 净值 = 本次金额）', () => {
    expect(accumulateCapitalizedValue(null, 333.33)).toEqual({
      originalValue: 333.33,
      netValue: 333.33,
    });
  });

  it('已有卡片时累加，而不是覆盖', () => {
    const existing: ExistingCapitalizedAsset = {
      originalValue: '333.33',
      netValue: '333.33',
    };
    expect(accumulateCapitalizedValue(existing, 666.66)).toEqual({
      originalValue: 999.99,
      netValue: 999.99,
    });
  });

  it('三次各 0.33 的累计结果为 0.99（逐笔 round2 后相加，不按总额取整）', () => {
    let card: ExistingCapitalizedAsset | null = null;
    for (let i = 0; i < 3; i += 1) {
      const next = accumulateCapitalizedValue(card, 0.33);
      card = { originalValue: next.originalValue, netValue: next.netValue };
    }
    expect(card).toEqual({ originalValue: 0.99, netValue: 0.99 });
  });

  it('浮点中间态被 round2 抹平（0.1 + 0.2 = 0.3 而不是 0.30000000000000004）', () => {
    const existing: ExistingCapitalizedAsset = {
      originalValue: '0.1',
      netValue: '0.1',
    };
    expect(accumulateCapitalizedValue(existing, 0.2)).toEqual({
      originalValue: 0.3,
      netValue: 0.3,
    });
  });

  it('已有卡片金额为 null（历史数据）时按 0 处理，不产生 NaN', () => {
    const existing: ExistingCapitalizedAsset = {
      originalValue: null,
      netValue: null,
    };
    expect(accumulateCapitalizedValue(existing, 100)).toEqual({
      originalValue: 100,
      netValue: 100,
    });
  });

  it('本次验收金额为 0 时不改变已有卡片（保留原值）', () => {
    const existing: ExistingCapitalizedAsset = {
      originalValue: '12000.50',
      netValue: '11000.00',
    };
    expect(accumulateCapitalizedValue(existing, 0)).toEqual({
      originalValue: 12000.5,
      netValue: 11000,
    });
  });
});
