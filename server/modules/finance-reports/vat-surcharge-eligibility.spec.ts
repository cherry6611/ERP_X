/**
 * 附加税费「六税两费减半」接线判定 —— 纯逻辑单测。
 *
 * 背景（P0 缺陷修复）：`computeVatSurcharge` 早已支持 `sixTaxTwoFeeHalved`，
 * 但 `vat-declaration.service.ts` 调用时没传，导致小规模纳税人主体附加税**多算一倍**。
 * 本规格把「按 taxpayerType 推导该参数」钉死，防止接线再次丢失。
 */
import { computeVatSurcharge } from '@server/common/tax/vat-surcharge';
import { resolveSixTaxTwoFeeHalved } from './vat-surcharge-eligibility';

describe('resolveSixTaxTwoFeeHalved（六税两费减半接线）', () => {
  it('小规模纳税人适用减半', () => {
    expect(resolveSixTaxTwoFeeHalved('small')).toBe(true);
  });

  it('一般纳税人不适用减半', () => {
    expect(resolveSixTaxTwoFeeHalved('general')).toBe(false);
  });

  it('未指定主体（null / undefined）不减半', () => {
    expect(resolveSixTaxTwoFeeHalved(null)).toBe(false);
    expect(resolveSixTaxTwoFeeHalved(undefined)).toBe(false);
  });

  it('未知取值不减半（偏严，不猜测）', () => {
    expect(resolveSixTaxTwoFeeHalved('SMALL')).toBe(false);
    expect(resolveSixTaxTwoFeeHalved('')).toBe(false);
    expect(resolveSixTaxTwoFeeHalved('micro')).toBe(false);
  });

  it('一般纳税人即使名为「小微」也不得代理判定（两套标准不互相代理）', () => {
    // 企业所得税「小型微利企业」不由 taxpayer_type 表达，
    // 缺三项指标时一律不减半，方向为多计提。
    expect(resolveSixTaxTwoFeeHalved('general')).toBe(false);
  });
});

describe('接线结果：surcharge 金额随 taxpayerType 变化', () => {
  const base = { payableVat: 5000, urbanMaintRate: 7 };

  it('一般纳税人：全额计提 350 / 150 / 100 = 600', () => {
    const r = computeVatSurcharge({
      ...base,
      sixTaxTwoFeeHalved: resolveSixTaxTwoFeeHalved('general'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.urbanMaint).toBe(350);
    expect(r.education).toBe(150);
    expect(r.localEducation).toBe(100);
    expect(r.total).toBe(600);
    expect(r.adjustments).toEqual([]);
  });

  it('小规模纳税人：减半计提 175 / 75 / 50 = 300（修复前会算成 600）', () => {
    const r = computeVatSurcharge({
      ...base,
      sixTaxTwoFeeHalved: resolveSixTaxTwoFeeHalved('small'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.urbanMaint).toBe(175);
    expect(r.education).toBe(75);
    expect(r.localEducation).toBe(50);
    expect(r.total).toBe(300);
    // 减免必须可解释：底稿要能说清「为什么是这个数」
    expect(r.adjustments.join()).toContain('六税两费减半');
  });

  it('未指定主体：不减半，与一般纳税人一致（不猜测）', () => {
    const r = computeVatSurcharge({
      ...base,
      sixTaxTwoFeeHalved: resolveSixTaxTwoFeeHalved(null),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(600);
  });

  it('小规模 + 要件缺失时仍然拒绝出数，不被减半掩盖', () => {
    const r = computeVatSurcharge({
      payableVat: 5000,
      urbanMaintRate: null,
      sixTaxTwoFeeHalved: resolveSixTaxTwoFeeHalved('small'),
    });
    expect(r.ok).toBe(false);
  });
});
