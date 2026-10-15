import { computeVatSurcharge } from '@server/common/tax/vat-surcharge';

/**
 * 附加税费计算规则（口径：业务方 2026-10-15 批准）。
 *
 * ## 这些断言为什么值得写
 *
 * 附加税费= 应纳增值税 × (城建税率 + 3% + 2%)，算术上平平无奇，
 * 真正的风险在两处**语义**上：
 *
 * 1. **两类"0"**：留抵/免税导致的 0 是合法的；主体没配城建税率导致的 0 是漏缴。
 *    若两者都返回 0，附加税会静默漏掉且账上无法发现 —— 所以后者必须拒绝出数。
 * 2. **分项取整**：凭证按税种记三行，合计必须等于三行之和，否则借贷不平。
 */
describe('附加税费计算（城建税 + 教育费附加 + 地方教育附加）', () => {
  it('一般纳税人 + 城建税率 7%：10,000 → 700 / 300 / 200，合计 1,200', () => {
    const result = computeVatSurcharge({
      payableVat: 10000,
      urbanMaintRate: 7,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.urbanMaint).toBe(700);
    expect(result.education).toBe(300);
    expect(result.localEducation).toBe(200);
    expect(result.total).toBe(1200);
  });

  it('小规模 + 城建税率 1%：同一基数 → 100 / 300 / 200，附加税随主体分叉', () => {
    const result = computeVatSurcharge({
      payableVat: 10000,
      urbanMaintRate: 1,
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.urbanMaint).toBe(100);
    expect(result.total).toBe(600);
  });

  it('留抵/免税（应纳增值税 ≤ 0）：全 0，但必须带 skippedReason（合法的 0）', () => {
    const result = computeVatSurcharge({ payableVat: -5000, urbanMaintRate: 7 });
    if (!result.ok) throw new Error('unreachable');
    expect(result.total).toBe(0);
    expect(result.skippedReason).toBeTruthy();
  });

  it('城建税率未配置：拒绝出数，而不是静默按 0 通过', () => {
    const result = computeVatSurcharge({ payableVat: 10000, urbanMaintRate: null });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.blockedReason).toContain('城建税率');
  });

  it('城建税率未配置 + 留抵：仍要拒绝（配置缺失不能被留抵月份掩盖）', () => {
    const result = computeVatSurcharge({ payableVat: 0, urbanMaintRate: undefined });
    expect(result.ok).toBe(false);
  });

  it('分项取整：基数 333.33 → 合计严格等于分项之和（无 1 分差导致借贷不平）', () => {
    const result = computeVatSurcharge({ payableVat: 333.33, urbanMaintRate: 7 });
    if (!result.ok) throw new Error('unreachable');
    expect(result.total).toBe(
      Math.round((result.urbanMaint + result.education + result.localEducation) * 100) / 100
    );
  });

  it('费率可覆盖：教育费附加 / 地方教育附加非默认值时按传入值计算', () => {
    const result = computeVatSurcharge({
      payableVat: 10000,
      urbanMaintRate: 5,
      educationRate: 3,
      localEducationRate: 2,
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.urbanMaint).toBe(500);
    expect(result.education).toBe(300);
    expect(result.localEducation).toBe(200);
    expect(result.total).toBe(1000);
  });

  it('两个主体同期各自计算：结果互不影响（按主体独立）', () => {
    const general = computeVatSurcharge({ payableVat: 10000, urbanMaintRate: 7 });
    const small = computeVatSurcharge({ payableVat: 10000, urbanMaintRate: 1 });
    if (!general.ok || !small.ok) throw new Error('unreachable');
    expect(general.total).toBe(1200);
    expect(small.total).toBe(600);
  });

  /* ============ 真实政策：六税两费减半 / 小规模免征额度（2026-10-15 核实） ============ */

  it('六税两费减半（小规模）：城建 1% + 附加 5% 各减半 → 50 / 150 / 100', () => {
    // 依据：财政部 税务总局公告 2023 年第 12 号，2023-01-01 至 2027-12-31 减征 50%
    const result = computeVatSurcharge({
      payableVat: 10000,
      urbanMaintRate: 1,
      sixTaxTwoFeeHalved: true,
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.urbanMaint).toBe(50);
    expect(result.education).toBe(150);
    expect(result.localEducation).toBe(100);
    expect(result.total).toBe(300);
    expect(result.adjustments.join()).toContain('六税两费减半');
  });

  it('一般纳税人但是小型微利企业：同样享受减半（减半看小微指标，不看纳税人资格）', () => {
    const result = computeVatSurcharge({
      payableVat: 10000,
      urbanMaintRate: 7,
      sixTaxTwoFeeHalved: true,
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.urbanMaint).toBe(350);
    expect(result.total).toBe(600);
  });

  it('小规模在免征额度内：教育费附加与地方教育附加免、**城建税仍征**', () => {
    // 依据：财税〔2016〕12 号（免征范围不含城建税）
    const result = computeVatSurcharge({
      payableVat: 10000,
      urbanMaintRate: 1,
      withinSmallScaleExemption: true,
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.education).toBe(0);
    expect(result.localEducation).toBe(0);
    expect(result.urbanMaint).toBe(100);
    expect(result.total).toBe(100);
  });

  it('免征额度内 + 六税两费减半同时适用：先免后减半，不是叠加减 75%', () => {
    // 两项附加免征后已为 0，减半只作用于城建税 → 城建 1% 再减半 = 50
    const result = computeVatSurcharge({
      payableVat: 10000,
      urbanMaintRate: 1,
      withinSmallScaleExemption: true,
      sixTaxTwoFeeHalved: true,
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.urbanMaint).toBe(50);
    expect(result.education).toBe(0);
    expect(result.localEducation).toBe(0);
    expect(result.total).toBe(50);
  });

  it('一般纳税人不适用减半：保持全额，不被减半参数误伤', () => {
    const result = computeVatSurcharge({ payableVat: 10000, urbanMaintRate: 7 });
    if (!result.ok) throw new Error('unreachable');
    expect(result.total).toBe(1200);
    expect(result.adjustments).toHaveLength(0);
  });
});
