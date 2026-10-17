import { isDepreciableInPeriod } from './asset-depreciation-eligibility';

describe('isDepreciableInPeriod：固定资产起提月份', () => {
  it('当月新增当月不提，次月起提', () => {
    expect(isDepreciableInPeriod('2026-03-15', '2026-03')).toBe(false);
    expect(isDepreciableInPeriod('2026-03-15', '2026-04')).toBe(true);
    expect(isDepreciableInPeriod('2026-03-31', '2026-03')).toBe(false);
  });

  it('补跑购置前期间不得计提', () => {
    expect(isDepreciableInPeriod('2026-03-01', '2026-02')).toBe(false);
    expect(isDepreciableInPeriod('2026-03-01', '2026-01')).toBe(false);
  });

  it('购置年早于期间 → 正常计提', () => {
    expect(isDepreciableInPeriod('2025-12-20', '2026-01')).toBe(true);
  });

  it('缺少购置日期时保持原行为（计提）', () => {
    expect(isDepreciableInPeriod(null, '2026-03')).toBe(true);
    expect(isDepreciableInPeriod(undefined, '2026-03')).toBe(true);
  });
});
