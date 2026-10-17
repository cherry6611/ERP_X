import {
  checkDeductionAmount,
  ELDERLY_SHARE_CAP,
  MAX_DEPENDENT_COUNT,
  MONTHLY_STANDARD,
  resolveDeductionCap,
} from './tax-deduction-rules';

/**
 * 专项附加扣除上限的双向锁定。
 *
 * 这批用例按"错法的方向"分组，而不是按函数分组 —— 因为本模块的价值就在于
 * **两个方向都别错**：既要拦住超额（少缴个税），也要拦住误拦（多缴个税）。
 */
describe('专项附加扣除上限（N-4 / N-5 / N-6）', () => {
  describe('赡养老人：区分独生 / 非独生（防超额扣除）', () => {
    it('独生子女按 3000 元/月', () => {
      const result = resolveDeductionCap({
        deductionType: 'elderly_support',
        monthlyAmount: 3000,
        isOnlyChild: true,
      });
      expect(result).toEqual({ ok: true, cap: 3000 });
    });

    it('独生子女超过 3000 仍被拒绝', () => {
      const result = checkDeductionAmount({
        deductionType: 'elderly_support',
        monthlyAmount: 3001,
        isOnlyChild: true,
      });
      expect(result.ok).toBe(false);
    });

    it('非独生子女分摊额不得超过 1500（原实现按 3000 放行 → 少缴个税）', () => {
      const exceeded = checkDeductionAmount({
        deductionType: 'elderly_support',
        monthlyAmount: 3000,
        isOnlyChild: false,
        shareAmount: 3000,
      });
      expect(exceeded.ok).toBe(false);
      if (!exceeded.ok) expect(exceeded.reason).toContain('1500');
    });

    it('非独生子女按 1500 上限放行', () => {
      const result = checkDeductionAmount({
        deductionType: 'elderly_support',
        monthlyAmount: 1500,
        isOnlyChild: false,
        shareAmount: 1500,
      });
      expect(result).toEqual({ ok: true, cap: ELDERLY_SHARE_CAP });
    });

    it('非独生子女未填分摊额时拒绝登记', () => {
      const result = resolveDeductionCap({
        deductionType: 'elderly_support',
        monthlyAmount: 1000,
        isOnlyChild: false,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('分摊额');
    });

    it('未声明是否独生时拒绝登记，不猜测', () => {
      const result = resolveDeductionCap({
        deductionType: 'elderly_support',
        monthlyAmount: 1500,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('独生子女');
    });
  });

  describe('子女教育 / 婴幼儿照护：按人数累加（防少扣除）', () => {
    it('两个子女可按 4000 元/月（原实现封顶 2000 → 员工多缴税）', () => {
      const result = checkDeductionAmount({
        deductionType: 'child_education',
        monthlyAmount: 4000,
        dependentCount: 2,
      });
      expect(result).toEqual({ ok: true, cap: 4000 });
    });

    it('三个婴幼儿按 6000 元/月', () => {
      const result = resolveDeductionCap({
        deductionType: 'infant_care',
        monthlyAmount: 6000,
        dependentCount: 3,
      });
      expect(result).toEqual({ ok: true, cap: 6000 });
    });

    it('人数为 1 时仍按 2000 封顶', () => {
      const result = checkDeductionAmount({
        deductionType: 'child_education',
        monthlyAmount: 2001,
        dependentCount: 1,
      });
      expect(result.ok).toBe(false);
    });

    it('人数与本人比例同时生效：两个子女各扣一半 → 2000', () => {
      const result = resolveDeductionCap({
        deductionType: 'child_education',
        monthlyAmount: 2000,
        dependentCount: 2,
        shareRatio: 0.5,
      });
      expect(result).toEqual({ ok: true, cap: 2000 });
    });
  });

  describe('父母（夫妻）分摊比例', () => {
    it('房贷利息按 50% 分摊 → 500', () => {
      expect(
        resolveDeductionCap({
          deductionType: 'housing_loan',
          monthlyAmount: 500,
          shareRatio: 0.5,
        })
      ).toEqual({ ok: true, cap: 500 });
    });

    it('住房租金按 50% 分摊 → 750', () => {
      expect(
        resolveDeductionCap({
          deductionType: 'housing_rent',
          monthlyAmount: 750,
          shareRatio: 0.5,
        })
      ).toEqual({ ok: true, cap: 750 });
    });

    it('继续教育不允许分摊，比例不缩放上限', () => {
      expect(
        resolveDeductionCap({
          deductionType: 'continuing_education',
          monthlyAmount: MAX_DEPENDENT_COUNT,
          shareRatio: 0.5,
        })
      ).toEqual({ ok: true, cap: MONTHLY_STANDARD.continuing_education });
    });

    it('比例超出 (0, 1] 拒绝', () => {
      expect(
        resolveDeductionCap({
          deductionType: 'housing_loan',
          monthlyAmount: 1000,
          shareRatio: 1.5,
        }).ok
      ).toBe(false);
      expect(
        resolveDeductionCap({
          deductionType: 'housing_loan',
          monthlyAmount: 1000,
          shareRatio: 0,
        }).ok
      ).toBe(false);
    });
  });

  describe('输入护栏', () => {
    it('人数必须是 1~20 的整数', () => {
      for (const count of [0, -1, 21, 1.5]) {
        expect(
          resolveDeductionCap({
            deductionType: 'child_education',
            monthlyAmount: 2000,
            dependentCount: count,
          }).ok
        ).toBe(false);
      }
    });

    it('大病医疗按年度上限 1/12 作为月度护栏', () => {
      const result = resolveDeductionCap({
        deductionType: 'medical',
        monthlyAmount: MONTHLY_STANDARD.medical,
      });
      expect(result).toEqual({ ok: true, cap: MONTHLY_STANDARD.medical });
    });
  });
});
