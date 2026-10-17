/**
 * `quotation-totals` 的规格：**把用户确认的取整口径钉死**。
 *
 * 用户已确认「保留现行逐行取整口径」（111.42 而非逐字公式的 111.44）。
 * 在此之前该结论只写在走查脚本的注释里 —— **注释不会失败，断言会**。
 * 这里把三件事变成可执行契约：
 *   ① 报价总额 = Σ round2(行金额 × 整单折扣)
 *   ② **报价总额与 Σ 合同明细行金额必须逐分相等**（这是整件事的目的）
 *   ③ 若有人改回"先累加再取整"，② 会立刻失败
 */
import {
  contractLineAmount,
  marginPct,
  quotationTotals,
  rawLineAmount,
} from './quotation-totals';

/** 用户确认的实例：3 行（含行折扣）在整单 9 折下 */
const USER_CASE = [
  { quantity: 3, unitPrice: 10.05, discountPct: 10, estUnitCost: 3 },
  { quantity: 2, unitPrice: 33.33, discountPct: 5, estUnitCost: 12 },
  { quantity: 3, unitPrice: 12.35, discountPct: 10, estUnitCost: 4 },
];
const HEADER_DISCOUNT = 10;

describe('rawLineAmount：行金额不取整', () => {
  it('数量 × 单价 × (1 − 行折扣%)', () => {
    expect(rawLineAmount({ quantity: 3, unitPrice: 10.05, discountPct: 10 })).toBeCloseTo(27.135, 6);
  });

  it('无行折扣', () => {
    expect(rawLineAmount({ quantity: 2, unitPrice: 33.33 })).toBeCloseTo(66.66, 6);
  });

  it('折扣 100% → 0', () => {
    expect(rawLineAmount({ quantity: 5, unitPrice: 100, discountPct: 100 })).toBe(0);
  });

  it('null / undefined 折扣按 0', () => {
    expect(rawLineAmount({ quantity: 1, unitPrice: 10, discountPct: null })).toBe(10);
    expect(rawLineAmount({ quantity: 1, unitPrice: 10, discountPct: undefined })).toBe(10);
  });

  it('⚠️ 返回**未取整**值（取整时机由口径决定，见文件头）', () => {
    const v = rawLineAmount({ quantity: 3, unitPrice: 33.33, discountPct: 0 });
    expect(v).toBeCloseTo(99.99, 6);
    /* 不是 99.99 的两位取整结果 —— 它本身就是精确值，但刻意不在这里 round */
    expect(Number.isFinite(v)).toBe(true);
  });
});

describe('quotationTotals：**用户确认口径 111.42**', () => {
  it('⚠️ 总额 = 111.42（Σ round2(行金额 × 0.9)）', () => {
    const r = quotationTotals(USER_CASE, HEADER_DISCOUNT);
    expect(r.totalAmount).toBe(111.42);
  });

  it('⚠️ 行金额合计 = 123.82（Σ round2(行金额)，未乘整单折扣）', () => {
    const r = quotationTotals(USER_CASE, HEADER_DISCOUNT);
    expect(r.grossAmount).toBe(123.82);
  });

  it('⚠️ 若改成"先累加再乘折扣再取整"会得 111.44 —— 本实现刻意不是那个数', () => {
    const literal = Math.round(123.82 * 0.9 * 100) / 100;
    expect(literal).toBe(111.44);
    const r = quotationTotals(USER_CASE, HEADER_DISCOUNT);
    expect(r.totalAmount).toBe(111.42);
    expect(r.totalAmount).not.toBe(literal);
  });

  it('预估成本 = Σ 数量 × 预估单价（不乘折扣）', () => {
    const r = quotationTotals(USER_CASE, HEADER_DISCOUNT);
    /* 3×3 + 2×12 + 3×4 = 9 + 24 + 12 = 45 */
    expect(r.estimatedCost).toBe(45);
  });

  it('单行、无折扣：三金额与直觉一致', () => {
    const r = quotationTotals([{ quantity: 2, unitPrice: 50, estUnitCost: 30 }], 0);
    expect(r).toEqual({ grossAmount: 100, totalAmount: 100, estimatedCost: 60 });
  });

  it('空明细 → 全部为 0（不产生 NaN）', () => {
    expect(quotationTotals([], 10)).toEqual({ grossAmount: 0, totalAmount: 0, estimatedCost: 0 });
  });

  it('整单折扣 100% → 总额 0、行金额合计不变', () => {
    const r = quotationTotals(USER_CASE, 100);
    expect(r.totalAmount).toBe(0);
    expect(r.grossAmount).toBe(123.82);
  });

  it('整单折扣为 null / undefined 按 0', () => {
    expect(quotationTotals(USER_CASE, null).totalAmount).toBe(quotationTotals(USER_CASE, 0).totalAmount);
    expect(quotationTotals(USER_CASE, undefined).totalAmount).toBe(quotationTotals(USER_CASE, 0).totalAmount);
  });
});

describe('⚠️ 核心不变量：报价总额 == Σ 合同明细行金额（逐分相等）', () => {
  it('用户确认的那 3 行：两边都是 111.42', () => {
    const { totalAmount } = quotationTotals(USER_CASE, HEADER_DISCOUNT);
    const itemSum = USER_CASE.reduce(
      (s, item) => s + contractLineAmount(item, HEADER_DISCOUNT),
      0,
    );
    expect(Math.round(itemSum * 100) / 100).toBe(totalAmount);
  });

  it('⚠️ 原缺陷形态（3 行 × 33.33、9 折）：旧口径差 1 分，新口径必须相等', () => {
    const items = [
      { quantity: 1, unitPrice: 33.33 },
      { quantity: 1, unitPrice: 33.33 },
      { quantity: 1, unitPrice: 33.33 },
    ];
    const { totalAmount, grossAmount } = quotationTotals(items, 10);
    /* 旧口径：round2(99.99 × 0.9) = 89.99 */
    const oldLiteral = Math.round(99.99 * 0.9 * 100) / 100;
    expect(oldLiteral).toBe(89.99);
    /* 新口径：Σ round2(33.33 × 0.9) = 30.00 × 3 = 90.00 */
    expect(totalAmount).toBe(90);
    expect(totalAmount).not.toBe(oldLiteral);
    /* 行金额合计仍是 99.99 */
    expect(grossAmount).toBe(99.99);
  });

  it('多组混合场景下两边**恒等**（含小数、含行折扣、含整单折扣）', () => {
    const cases: Array<{ items: Array<{ quantity: number; unitPrice: number; discountPct?: number }>; pct: number }> = [
      { items: [{ quantity: 3, unitPrice: 10.05, discountPct: 10 }], pct: 10 },
      { items: [{ quantity: 7, unitPrice: 1.11 }, { quantity: 3, unitPrice: 9.99, discountPct: 5 }], pct: 15 },
      { items: [{ quantity: 1, unitPrice: 0.01 }], pct: 0 },
      { items: [{ quantity: 13, unitPrice: 7.77, discountPct: 33 }], pct: 7 },
      { items: [{ quantity: 2, unitPrice: 1234.56 }, { quantity: 5, unitPrice: 0.99 }], pct: 3 },
      { items: [{ quantity: 1, unitPrice: 100 }, { quantity: 1, unitPrice: 100 }, { quantity: 1, unitPrice: 100 }], pct: 33.33 },
    ];
    for (const { items, pct } of cases) {
      const { totalAmount } = quotationTotals(items, pct);
      const itemSum = items.reduce((s, it) => s + contractLineAmount(it, pct), 0);
      expect({ pct, total: totalAmount, sum: Math.round(itemSum * 100) / 100 }).toEqual({
        pct,
        total: totalAmount,
        sum: totalAmount,
      });
    }
  });
});

describe('contractLineAmount：转合同的单行金额', () => {
  it('与 quotationTotals 的逐行项同口径', () => {
    const item = { quantity: 3, unitPrice: 10.05, discountPct: 10 };
    /* rawLineAmount = 27.135，× 0.9 = 24.4215 → 24.42 */
    expect(contractLineAmount(item, 10)).toBe(24.42);
  });

  it('整单折扣为 null 按 0', () => {
    expect(contractLineAmount({ quantity: 1, unitPrice: 100 }, null)).toBe(100);
  });
});

describe('marginPct：毛利', () => {
  it('常规：总额 100、成本 80 → 20%', () => {
    expect(marginPct(100, 80)).toBe(20);
  });

  it('⚠️ 总额为 0 → 返回 0（不是 NaN/Infinity —— 界面会渲染成 "NaN%"）', () => {
    expect(marginPct(0, 10)).toBe(0);
    expect(marginPct(0, 0)).toBe(0);
  });

  it('成本高于总额 → 负毛利', () => {
    expect(marginPct(100, 150)).toBe(-50);
  });

  it('保留 2 位', () => {
    expect(marginPct(111.42, 101)).toBeCloseTo(9.35, 2);
  });
});
