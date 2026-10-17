/**
 * `contract-item-consistency` 的规格：合同明细与合同头的三项校验。
 *
 * 重点在**容差**：太紧会把"逐行取整的正常差 1 分"判成错误（假失败 → 使用者忽略校验），
 * 太松会掩盖真实的税率错配（项目预算凭空多出净额、且无对账能发现）。
 */
import {
  ITEM_TOTAL_TOLERANCE,
  checkItemSumConsistency,
  itemSumTolerance,
} from './contract-item-consistency';

describe('itemSumTolerance：逐行取整容差', () => {
  it('0 行 → 0.01（只有 1 分余量）', () => {
    expect(itemSumTolerance(0)).toBe(0.01);
  });

  it('随行数线性放大：每行最多 1 分 + 1 分余量', () => {
    expect(itemSumTolerance(1)).toBe(0.02);
    expect(itemSumTolerance(3)).toBe(0.04);
    expect(itemSumTolerance(100)).toBe(1.01);
  });

  it('⚠️ 负数/NaN 按 0 处理（不产生负容差——负容差会让任何差异都"通过"或都"失败"）', () => {
    expect(itemSumTolerance(-5)).toBe(0.01);
    expect(itemSumTolerance(Number.NaN)).toBe(0.01);
    expect(itemSumTolerance(Number.POSITIVE_INFINITY)).toBe(0.01);
  });

  it('保留 2 位（避免浮点尾巴）', () => {
    expect(itemSumTolerance(7)).toBe(0.08);
  });

  it('含税合计容差常量是 0.01', () => {
    expect(ITEM_TOTAL_TOLERANCE).toBe(0.01);
  });
});

describe('checkItemSumConsistency：0 明细保护', () => {
  it('⚠️ 金额非 0 且无明细 → 拦（否则会有"合同 100 万、明细为空"的生效合同）', () => {
    const p = checkItemSumConsistency({ headerAmount: 1_000_000, itemCount: 0, totalAmount: 0 });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('至少需要一条明细');
  });

  it('金额为 0 的空合同 → 放行（占位/待填）', () => {
    expect(checkItemSumConsistency({ headerAmount: 0, itemCount: 0, totalAmount: 0 })).toEqual([]);
  });

  it('金额在 0.01 以内（四舍五入噪声）→ 放行', () => {
    expect(checkItemSumConsistency({ headerAmount: 0.004, itemCount: 0, totalAmount: 0 })).toEqual([]);
  });
});

describe('checkItemSumConsistency：含税金额合计', () => {
  const base = { itemCount: 2, headerTaxAmount: null, headerNetAmount: null };

  it('完全相等 → 通过', () => {
    expect(checkItemSumConsistency({ ...base, headerAmount: 1000, totalAmount: 1000 })).toEqual([]);
  });

  it('差 1 分 → 通过（容差内）', () => {
    expect(checkItemSumConsistency({ ...base, headerAmount: 1000, totalAmount: 1000.01 })).toEqual([]);
  });

  it('⚠️ 差 2 分 → 拦（含税合计用的是固定 0.01，不随行数放大）', () => {
    const p = checkItemSumConsistency({ ...base, headerAmount: 1000, totalAmount: 1000.02 });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('合同明细合计 1000.02 与合同金额 1000');
  });

  it('入参为字符串（numeric 经 pg 驱动）同样可用', () => {
    expect(checkItemSumConsistency({ ...base, headerAmount: '1000.00', totalAmount: '1000.00' })).toEqual([]);
  });
});

describe('checkItemSumConsistency：税额 / 不含税（逐行取整容差）', () => {
  it('税率一致、只差逐行取整的 1 分 → 通过', () => {
    /* 3 × 29.997 @6%：Σ行税额 5.10，头 splitTax(89.99,6) = 5.09，差 1 分 */
    expect(
      checkItemSumConsistency({
        headerAmount: 89.99,
        headerTaxAmount: 5.09,
        headerNetAmount: 84.9,
        itemCount: 3,
        totalAmount: 89.99,
        totalTaxAmount: 5.1,
        totalNetAmount: 84.9,
      }),
    ).toEqual([]);
  });

  it('⚠️ 真实缺陷形态：含税额相同、税率不同（13% vs 6%）→ 必须拦', () => {
    const p = checkItemSumConsistency({
      headerAmount: 113_000,
      headerTaxAmount: 13_000,
      headerNetAmount: 100_000,
      itemCount: 1,
      totalAmount: 113_000,
      totalTaxAmount: 6_396.23,
      totalNetAmount: 106_603.77,
    });
    /* 税额与不含税两条都该报 */
    expect(p).toHaveLength(2);
    expect(p[0]).toContain('明细行使用了与合同头不同的税率');
    expect(p[1]).toContain('会让同一份合同出现两个净额');
  });

  it('税额差恰好等于容差 → 通过（判据是严格大于）', () => {
    /* itemCount 1 → 容差 0.02 */
    expect(
      checkItemSumConsistency({
        headerAmount: 1000,
        headerTaxAmount: 60,
        headerNetAmount: 940,
        itemCount: 1,
        totalAmount: 1000,
        totalTaxAmount: 60.02,
        totalNetAmount: 940,
      }),
    ).toEqual([]);
  });

  it('税额差超过容差 1 分 → 拦', () => {
    const p = checkItemSumConsistency({
      headerAmount: 1000,
      headerTaxAmount: 60,
      headerNetAmount: 940,
      itemCount: 1,
      totalAmount: 1000,
      totalTaxAmount: 60.03,
      totalNetAmount: 940,
    });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('合同明细税额合计');
    expect(p[0]).toContain('容差 0.02');
  });

  it('⚠️ 容差随行数放大：5 行时 5 分的税额差应通过（固定容差会误报）', () => {
    expect(
      checkItemSumConsistency({
        headerAmount: 1000,
        headerTaxAmount: 60,
        headerNetAmount: null,
        itemCount: 5,
        totalAmount: 1000,
        totalTaxAmount: 60.05,
        totalNetAmount: null,
      }),
    ).toEqual([]);
  });

  it('未提供头税额/头不含税 → 跳过对应校验（不回退成 0 去误报）', () => {
    expect(
      checkItemSumConsistency({
        headerAmount: 1000,
        itemCount: 2,
        totalAmount: 1000,
        totalTaxAmount: 999,
        totalNetAmount: 999,
      }),
    ).toEqual([]);
  });

  it('头税额为 null 也跳过（与 undefined 同义）', () => {
    expect(
      checkItemSumConsistency({
        headerAmount: 1000,
        headerTaxAmount: null,
        headerNetAmount: null,
        itemCount: 2,
        totalAmount: 1000,
        totalTaxAmount: 999,
        totalNetAmount: 999,
      }),
    ).toEqual([]);
  });

  it('不含税额不一致（税额一致）→ 只报不含税那条', () => {
    const p = checkItemSumConsistency({
      headerAmount: 1000,
      headerTaxAmount: 60,
      headerNetAmount: 900,
      itemCount: 2,
      totalAmount: 1000,
      totalTaxAmount: 60,
      totalNetAmount: 940,
    });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('合同明细不含税合计');
  });

  it('差额消息里带出**绝对值**（不是负数）', () => {
    const p = checkItemSumConsistency({
      headerAmount: 1000,
      headerTaxAmount: 60,
      headerNetAmount: null,
      itemCount: 1,
      totalAmount: 1000,
      totalTaxAmount: 55,
      totalNetAmount: null,
    });
    expect(p[0]).toContain('相差 5');
    expect(p[0]).not.toContain('相差 -5');
  });
});
