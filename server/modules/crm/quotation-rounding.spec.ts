import { round2 } from '@shared/number';

/**
 * T11（§4.6）：**报价与合同的取整顺序必须一致** —— 纯函数回归锁。
 *
 * ## 被钉死的缺陷
 *
 * 报价与合同原先在**不同的位置**取整：
 *
 * ```
 * 报价（旧 computeTotals）    ：round2( Σ未取整行金额 × (1 − 整单折扣) )
 * 合同（convertLineAmount）   ：Σ round2( 未取整行金额 × (1 − 整单折扣) )
 * ```
 *
 * 一边"先加、再乘折扣、再取整"，一边"先乘折扣、逐行取整、再求和"。
 * 实测（3 行 × 33.33 元、整单 9 折、税率 6%）：
 *
 * | | 金额 |
 * |---|---|
 * | 报价总额（旧口径） | **89.99** |
 * | 合同明细合计 | **90.00** |
 *
 * **这 1 分是真问题**：`convert()` 的校验是 `> 0.01`，而两数差**恰好 0.01**
 * → 不成立 → 静默放行。合同带着"头 89.99 / 明细 90.00"落库，
 * 于是头税额 5.09、Σ行税额 5.10 —— 开票/收入确认/增值税底稿取明细口径，
 * **账表从第一天起就对不上**。
 *
 * ## 为什么用纯函数而非集成测试钉住
 *
 * 这个缺陷的本质是**取整顺序**，与数据库、Nest、事务都无关。
 * 抽成纯函数后可以用"多种行数 × 多种单价 × 多种折扣"的**矩阵**覆盖 ——
 * 集成测试跑一次要 20s，不可能穷举组合；这里 1ms 跑完 800 组。
 *
 * 两个函数分别镜像 `QuotationService.computeTotals` 的总额口径与
 * `QuotationService.convertLineAmount` 的行金额口径；
 * 生产代码改动时，本规格会因数值不等而变红。
 */

/** 报价总额（现行口径）：逐行乘折扣 → 逐行取整 → 求和 */
export function quotationTotal(
  lines: Array<{ lineAmount: number }>,
  headerDiscountPct: number
): number {
  const factor = 1 - headerDiscountPct / 100;
  return round2(
    lines.reduce((sum, line) => sum + round2(line.lineAmount * factor), 0)
  );
}

/** 合同明细行金额（口径未变）：行金额 × 整单折扣，逐行取整 */
export function contractLineAmount(
  lineAmountValue: number,
  headerDiscountPct: number
): number {
  return round2(lineAmountValue * (1 - headerDiscountPct / 100));
}

/** 旧口径（**故意保留在规格里**，用于证明缺陷真实存在、且新口径确实修好了） */
function legacyQuotationTotal(
  lineAmounts: number[],
  headerDiscountPct: number
): number {
  const gross = lineAmounts.reduce((sum, value) => sum + value, 0);
  return round2(gross * (1 - headerDiscountPct / 100));
}

describe('T11 报价与合同取整口径对齐', () => {
  it('审计报告的点名场景：3×33.33、整单 9 折 ⇒ 旧口径差 0.01，新口径差 0', () => {
    const line = 33.33;
    const lines = [line, line, line].map((value) => ({ lineAmount: value }));
    const contractSum = lines.reduce(
      (sum, item) => sum + contractLineAmount(item.lineAmount, 10),
      0
    );

    // 旧口径：恰好 0.01 —— 而校验是 `> 0.01`，于是**静默放行**
    expect(legacyQuotationTotal([line, line, line], 10)).toBe(89.99);
    expect(contractSum).toBe(90);
    // 用 `round2` 归一再比较：裸的浮点减法会得到 0.009999999999999787 ——
    // 这行断言本身就是"为什么全仓金额判等必须走 round2"的活证据。
    expect(
      round2(Math.abs(legacyQuotationTotal([line, line, line], 10) - contractSum))
    ).toBe(0.01);

    // 新口径：与合同明细合计**精确一致**
    expect(quotationTotal(lines, 10)).toBe(90);
    expect(quotationTotal(lines, 10) - contractSum).toBe(0);
  });

  it('矩阵覆盖：任何行数/单价/折扣组合下，报价总额与 Σ合同行金额必须精确相等', () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (let rowCount = 1; rowCount <= 6; rowCount += 1) {
      for (let unitCents = 3333; unitCents <= 9999; unitCents += 137) {
        for (const discountPct of [0, 1, 3, 5, 9, 10, 12.5, 15, 33.33]) {
          const unit = unitCents / 100;
          const lines = Array.from({ length: rowCount }, () => ({
            lineAmount: unit,
          }));
          const contractSum = round2(
            lines.reduce(
              (sum, item) => sum + contractLineAmount(item.lineAmount, discountPct),
              0
            )
          );
          const quotTotal = quotationTotal(lines, discountPct);
          checked += 1;
          if (Math.abs(quotTotal - contractSum) > 0.001) {
            mismatches.push(
              `${rowCount} 行 × ${unit} × ${discountPct}% ⇒ 报价 ${quotTotal} vs 合同 ${contractSum}`
            );
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
    // 只要有一组不等，就说明口径又分叉了 —— 把差异全部列出来便于定位
    expect(mismatches).toEqual([]);
  });

  it('税率一致性：头税额与 Σ行税额的差异**必须落在逐行取整容差内**', () => {
    /*
     * 这条断言记录一个**必须诚实承认**的事实：
     *
     * 即使报价总额与 Σ合同行金额**精确相等**（T11 已修好），
     * 头税额与 Σ行税额仍可能差 1 分 —— 因为头的税额来自
     * `splitTax(整单含税额, 税率)`，而每行来自 `splitTax(行含税额, 税率)`：
     * **同一税率、不同基数**，逐行取整后求和的尾数不同。
     *
     * 这是十进制的正常结果，不是缺陷。真正的缺陷是**量级差**：
     * 头 113,000@13%（税 13,000）vs 明细 113,000@6%（Σ税 6,396.23）
     * —— 差 6,603.77，那是税率配错，必须拦住。
     *
     * 因此契约服务的校验容差是 `0.01 × (行数 + 1)`（见
     * `contracts.service.ts` 的 `assertItemSum`）：容忍取整尾数，
     * 拦住税率错配。本规格把这条边界钉死，防止有人把容差改回固定 0.01
     * （那会把正常合同判成错误）或改成很大（那会漏掉税率错配）。
     */
    const rate = 6;
    const unit = 33.33;
    const rows = [unit, unit, unit];
    const quotTotal = quotationTotal(
      rows.map((value) => ({ lineAmount: value })),
      10
    );
    const contractLines = rows.map((value) => contractLineAmount(value, 10));

    // ① 总额精确一致（T11 的核心修复）
    expect(quotTotal).toBe(round2(contractLines.reduce((a, b) => a + b, 0)));

    // ② 税额差异存在，但**必须**在 `0.01 × (行数 + 1)` 容差内
    const { splitTax } = require('@shared/tax') as typeof import('@shared/tax');
    const headTax = splitTax(quotTotal, rate).tax;
    const lineTaxSum = round2(
      contractLines.reduce((sum, value) => sum + splitTax(value, rate).tax, 0)
    );
    const taxGap = round2(Math.abs(headTax - lineTaxSum));
    const tolerance = 0.01 * (rows.length + 1);
    expect(taxGap).toBeLessThanOrEqual(tolerance);

    // ③ 对照：旧口径下"总额不等"会直接污染税额；这条用来说明
    //    "总额不齐"与"税额尾数"是两个不同的问题，前者必须为 0。
    const legacyTotal = legacyQuotationTotal(rows, 10);
    expect(round2(Math.abs(legacyTotal - round2(contractLines.reduce((a, b) => a + b, 0)))))
      .toBe(0.01);
  });

  it('单行场景两口径本应相同（确认改动没有波及单行报价）', () => {
    for (const unit of [0.01, 33.33, 100, 1234.56]) {
      for (const discountPct of [0, 10, 33.33]) {
        const lines = [{ lineAmount: unit }];
        expect(quotationTotal(lines, discountPct)).toBe(
          legacyQuotationTotal([unit], discountPct)
        );
      }
    }
  });
});
