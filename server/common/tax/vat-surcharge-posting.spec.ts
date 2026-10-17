import { vatSurchargeAccrualLines } from './vat-surcharge-posting';
import { computeVatSurcharge, type VatSurchargeComputed } from './vat-surcharge';

/**
 * 附加税费计提分录锁定。
 *
 * 重点不是"金额算得对"（那是 `vat-surcharge.spec.ts` 的职责），而是：
 * 1. **借贷必须平** —— 分录按税种分行，若合计与分项取整方式不一致就会不平；
 * 2. **三税种各自对上底稿分项** —— 否则底稿与凭证无法逐项对账。
 */
describe('附加税费计提分录（vatSurchargeAccrualLines）', () => {
  const sum = (lines: ReturnType<typeof vatSurchargeAccrualLines>, side: 'debit' | 'credit') =>
    Math.round(lines.reduce((acc, line) => acc + (line[side] ?? 0), 0) * 100) / 100;

  function computed(overrides: Partial<VatSurchargeComputed>): VatSurchargeComputed {
    return {
      ok: true,
      urbanMaint: 700,
      education: 300,
      localEducation: 200,
      total: 1200,
      adjustments: [],
      ...overrides,
    };
  }

  it('三税种齐全时出 6 行，借贷相等，且逐税种 借 6403xx / 贷 2221xx', () => {
    const lines = vatSurchargeAccrualLines(computed({}));

    expect(lines).toHaveLength(6);
    expect(sum(lines, 'debit')).toBe(1200);
    expect(sum(lines, 'credit')).toBe(1200);

    expect(lines).toContainEqual(
      expect.objectContaining({ accountCode: '640301', debit: 700 })
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ accountCode: '222106', credit: 700 })
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ accountCode: '640302', debit: 300 })
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ accountCode: '222110', credit: 300 })
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ accountCode: '640303', debit: 200 })
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ accountCode: '222111', credit: 200 })
    );
  });

  it('分项为 0 的税种不出行（小规模免征两项附加时只出城建税 2 行）', () => {
    const lines = vatSurchargeAccrualLines(
      computed({ education: 0, localEducation: 0, total: 700 })
    );

    expect(lines).toHaveLength(2);
    expect(lines).toEqual([
      { accountCode: '640301', debit: 700 },
      { accountCode: '222106', credit: 700 },
    ]);
  });

  it('合计为 0（期末留抵 / 免税）时不出任何分录', () => {
    expect(
      vatSurchargeAccrualLines(
        computed({ urbanMaint: 0, education: 0, localEducation: 0, total: 0 })
      )
    ).toEqual([]);
  });

  it('基数带小数时借贷仍严格相等（合计取分项之和，不平就是记账事故）', () => {
    const result = computeVatSurcharge({
      payableVat: 333.33,
      urbanMaintRate: 7,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lines = vatSurchargeAccrualLines(result);
    expect(sum(lines, 'debit')).toBe(result.total);
    expect(sum(lines, 'credit')).toBe(result.total);
  });

  it('非法计提结果不产生分录（负金额不出行）', () => {
    const lines = vatSurchargeAccrualLines(
      computed({ urbanMaint: -100, education: 0, localEducation: 0, total: -100 })
    );
    expect(lines).toEqual([]);
  });
});
