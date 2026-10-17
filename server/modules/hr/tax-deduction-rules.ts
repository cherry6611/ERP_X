import type { TaxDeductionType } from './payroll-engine';
import { round2 } from '@server/common/utils/number';

/**
 * 个税专项附加扣除的**月度法定上限**规则（单一实现）。
 *
 * 为什么独立成纯函数：上限判断原先是 `PayrollTaxService` 的私有方法，只能靠集成测试
 * 覆盖；而这块的错法有两类且方向相反 ——
 *   1. 收得太松：非独生子女赡养老人按独生子女 3000 元登记 → **少缴个税**（稽查可发现）；
 *   2. 收得太紧：子女教育按「每人 2000」设限却只允许一条登记 → **多子女家庭无法累加**，
 *      员工多缴个税。
 * 两类都不会报错、不会不平账。因此把口径抽成纯函数并用单测双向锁定。
 *
 * 法定口径（个人所得税法 + 国发〔2018〕41 号，2023 年提标后）：
 * - 子女教育 / 3 岁以下婴幼儿照护：**每个**子女（婴幼儿）2000 元/月，可累加；
 * - 赡养老人：独生子女 3000 元/月；非独生子女由兄弟姐妹分摊，**每人不超过 1500 元/月**；
 * - 住房贷款利息 1000 元/月、住房租金按城市档 1500/1100/800 元/月，二者**不得同时享受**；
 * - 子女教育 / 婴幼儿照护 / 房贷利息 / 住房租金 可由父母（夫妻）约定分摊比例；
 * - 继续教育 400 元/月、大病医疗按年度据实限额（15000 起付 / 80000 上限）。
 */

/** 月度法定标准：单个子女 / 城市最高档 / 独生子女 */
export const MONTHLY_STANDARD: Record<TaxDeductionType, number> = {
  child_education: 2000,
  continuing_education: 400,
  // 大病医疗无月度定额，以年度上限的 1/12 作为月度登记上限，避免登记出荒诞值
  medical: Math.floor(80000 / 12),
  housing_loan: 1000,
  // 住房租金按城市档 1500/1100/800，取最高档作为上限
  housing_rent: 1500,
  elderly_support: 3000,
  infant_care: 2000,
};

/** 非独生子女赡养老人分摊上限（元/月） */
export const ELDERLY_SHARE_CAP = 1500;

/** 可按人（子女人）数累加的项目：上限 = 标准 × 人数 */
export const COUNTABLE_TYPES: readonly TaxDeductionType[] = [
  'child_education',
  'infant_care',
];

/** 可由父母（夫妻）分摊的项目：上限 = 标准 × 本人比例 */
export const SHAREABLE_TYPES: readonly TaxDeductionType[] = [
  'child_education',
  'infant_care',
  'housing_loan',
  'housing_rent',
];

/** 互斥项目：同一员工同一年度不得同时享受 */
export const MUTUALLY_EXCLUSIVE_TYPES: readonly TaxDeductionType[] = [
  'housing_loan',
  'housing_rent',
];

/** 人数上限仅作输入合理性护栏，非税法口径 */
export const MAX_DEPENDENT_COUNT = 20;

export interface DeductionClaim {
  deductionType: TaxDeductionType;
  monthlyAmount: number;
  /** 赡养老人：是否独生子女。null / undefined = 未声明，按最严格口径拒绝登记 */
  isOnlyChild?: boolean | null;
  /** 赡养老人：非独生子女的本人分摊额（元/月） */
  shareAmount?: number | null;
  /** 子女教育 / 婴幼儿照护：人数 */
  dependentCount?: number;
  /** 本人扣除比例（0~1，如父母各扣 50% 填 0.5） */
  shareRatio?: number;
}

export type DeductionCapResult =
  | { ok: true; cap: number }
  | { ok: false; reason: string };


/**
 * 解析某条登记的上限。`ok: false` 时 `reason` 是可直接展示给 HR 的中文原因。
 */
export function resolveDeductionCap(claim: DeductionClaim): DeductionCapResult {
  const type = claim.deductionType;
  const count = claim.dependentCount ?? 1;
  const ratio = claim.shareRatio ?? 1;

  if (!Number.isInteger(count) || count < 1 || count > MAX_DEPENDENT_COUNT) {
    return {
      ok: false,
      reason: `人数必须为 1~${MAX_DEPENDENT_COUNT} 之间的整数，当前 ${count}`,
    };
  }
  if (!(ratio > 0) || ratio > 1) {
    return {
      ok: false,
      reason: `本人扣除比例必须大于 0 且不超过 1（父母各扣 50% 请填 0.5），当前 ${ratio}`,
    };
  }

  // 赡养老人不按比例分摊，而是按"独生 / 非独生分摊额"
  if (type === 'elderly_support') {
    if (claim.isOnlyChild === true) {
      return { ok: true, cap: MONTHLY_STANDARD.elderly_support };
    }
    if (claim.isOnlyChild === false) {
      const share = claim.shareAmount;
      if (share == null || !(share > 0)) {
        return {
          ok: false,
          reason: `非独生子女赡养老人必须填写本人分摊额（每月不超过 ${ELDERLY_SHARE_CAP} 元）`,
        };
      }
      if (share > ELDERLY_SHARE_CAP + 0.001) {
        return {
          ok: false,
          reason:
            `非独生子女赡养老人分摊额每月不得超过 ${ELDERLY_SHARE_CAP} 元，当前 ${share} 元。` +
            `独生子女方可按 ${MONTHLY_STANDARD.elderly_support} 元/月扣除`,
        };
      }
      return { ok: true, cap: ELDERLY_SHARE_CAP };
    }
    return {
      ok: false,
      reason:
        '赡养老人必须声明是否为独生子女：独生子女 3000 元/月，' +
        '非独生子女由兄弟姐妹分摊且每人不超过 1500 元/月',
    };
  }

  const base = MONTHLY_STANDARD[type];
  const countable = COUNTABLE_TYPES.includes(type) ? count : 1;
  const shareRatio = SHAREABLE_TYPES.includes(type) ? ratio : 1;
  return { ok: true, cap: round2(base * countable * shareRatio) };
}

/**
 * 校验登记金额是否超限。通过返回上限，否则返回中文原因。
 */
export function checkDeductionAmount(claim: DeductionClaim): DeductionCapResult {
  const cap = resolveDeductionCap(claim);
  if (!cap.ok) return cap;
  if (claim.monthlyAmount > cap.cap + 0.001) {
    return {
      ok: false,
      reason:
        `月度扣除标准上限为 ${cap.cap} 元，当前登记 ${claim.monthlyAmount} 元。` +
        `多子女请填写人数（每人 ${MONTHLY_STANDARD.child_education} 元/月），` +
        `父母分摊请填写本人比例，住房租金请按所属城市档位（最高 ${MONTHLY_STANDARD.housing_rent} 元/月）填写`,
    };
  }
  return cap;
}

/** 返回与 `type` 互斥的类型（无则 null） */
export function exclusiveCounterpart(type: TaxDeductionType): TaxDeductionType | null {
  if (type === 'housing_loan') return 'housing_rent';
  if (type === 'housing_rent') return 'housing_loan';
  return null;
}
