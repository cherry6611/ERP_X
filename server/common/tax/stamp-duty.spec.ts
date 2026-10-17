import {
  STAMP_DUTY_ITEM_LABELS,
  STAMP_DUTY_ITEMS,
  STAMP_DUTY_RATES,
  computeStampDuty,
  resolveStampDutyHalved,
} from './stamp-duty';
import { stampDutyAccrualLines } from './stamp-duty-posting';
import {
  ACCOUNT_TAX_PAYABLE_STAMP_DUTY,
  ACCOUNT_TAX_SURCHARGE_STAMP_DUTY,
} from './account-codes';

/**
 * 印花税规格（《印花税法》2022-07-01 施行）。
 *
 * ## 为什么这个税种值得单独写规格
 *
 * 审计报告 §4.7(f) 的结论是"**完全未实现**"——全仓 grep「印花税」零命中。
 * 补实现时最容易犯的三类错都在这里被钉死：
 *
 * 1. **计税依据取含税还是不含税**。印花税法 + 2022 年第 22 号公告：
 *    合同**分别列明**增值税的按不含税计税。本仓合同三列齐备
 *    （amount / net_amount / tax_amount），必须取不含税。
 *    取错方向是**多缴**（3% 的税率差在 0.3‰ 上放大成 3% 的税额差），
 *    金额小但性质是"长期多缴"。
 *
 * 2. **税率档位写错一位**。0.3‰ 写成 0.03‰ 或 3‰ 都是 10 倍误差。
 *    本模块用**千分比**表达（0.3 而不是 0.0003），并枚举全部法定档位。
 *
 * 3. **不足 1 角按 0 计**这条法定规则被当成"四舍五入"。
 *    它是《印花税法》第十一条的明文规定，不是取整习惯。
 *
 * ## 金额断言用精确值
 *
 * 与 `vat-declaration.service.spec.ts` 同一约定：税错了就是真金白银错，
 * 不允许容差。文案只做宽松匹配。
 */
describe('印花税计算（computeStampDuty）', () => {
  it('技术合同 0.3‰：100 万不含税 ⇒ 300 元（审计点名的档位已实现）', () => {
    const result = computeStampDuty({
      amount: 1_060_000,
      netAmount: 1_000_000,
      item: 'technology',
    });
    expect(result.tax).toBe(300);
    expect(result.rate).toBe(0.3);
    expect(result.base).toBe(1_000_000);
    expect(result.baseIsNet).toBe(true);
    expect(result.notes.join()).toContain('技术合同');
    expect(result.notes.join()).toContain('不含税');
  });

  it('计税依据取不含税而不是含税：500 万含税 / 4,716,981.13 不含税', () => {
    // 6% 税率：含税 5,000,000 → 不含税 4,716,981.13
    const net = 4_716_981.13;
    const result = computeStampDuty({
      amount: 5_000_000,
      netAmount: net,
      item: 'technology',
    });
    // 4,716,981.13 × 0.3‰ = 1,415.094339 → 1,415.09
    expect(result.tax).toBe(1415.09);
    // 反例：若错用含税额，会多缴 84.91 元（差 6%）
    expect(result.tax).not.toBe(1500);
  });

  it('未单独列明增值税（netAmount 缺失）时退化为含税金额，且说明这是偏严方向', () => {
    const result = computeStampDuty({ amount: 1_000_000, item: 'technology' });
    expect(result.base).toBe(1_000_000);
    expect(result.baseIsNet).toBe(false);
    expect(result.tax).toBe(300);
    // 必须显式说明方向，否则使用者会以为这是"正确口径"而不是"保守估计"
    expect(result.notes.join()).toContain('未单独列明');
    expect(result.notes.join()).toContain('多缴');
  });

  it('未知税目**抛错**，不静默回退默认档位', () => {
    // 反例防线：静默回退会让拼错的税目按 0.3‰ 计税，
    // 而正确档位可能是租赁合同 1‰ —— 少缴 70%。
    expect(() =>
      computeStampDuty({
        amount: 1000,
        // 故意绕过类型检查，模拟"从外部传入的字符串"
        item: 'lease_contract' as never,
      })
    ).toThrow(/未知的印花税税目/u);
  });

  it('全部法定档位都在表内，且与《印花税税目税率表》一致', () => {
    // 档位是硬事实，逐条断言（改动必须同步改这里，不允许"顺手调一下"）
    expect(STAMP_DUTY_RATES).toEqual({
      loan: 0.05,
      finance_lease: 0.05,
      sales: 0.3,
      work: 0.3,
      construction: 0.3,
      transport: 0.3,
      technology: 0.3,
      lease: 1,
      custody: 1,
      warehouse: 1,
      property_insurance: 1,
      property_transfer: 0.5,
      capital_book: 0.25,
    });
    // 每个档位都得有中文名，否则界面上会出现英文 key
    for (const item of STAMP_DUTY_ITEMS) {
      expect(STAMP_DUTY_ITEM_LABELS[item]).toBeTruthy();
      expect(STAMP_DUTY_ITEM_LABELS[item]).not.toBe(item);
    }
  });

  it('六税两费减半：小规模主体减 50%，且说明里给出政策依据', () => {
    const full = computeStampDuty({
      amount: 1_000_000,
      netAmount: 1_000_000,
      item: 'technology',
      halved: false,
    });
    const halved = computeStampDuty({
      amount: 1_000_000,
      netAmount: 1_000_000,
      item: 'technology',
      halved: true,
    });
    expect(full.tax).toBe(300);
    expect(halved.tax).toBe(150);
    expect(halved.tax * 2).toBe(full.tax);
    expect(halved.notes.join()).toContain('六税两费减半');
    expect(halved.notes.join()).toContain('2027');
  });

  it('不足 1 角按 0 计（《印花税法》第十一条），不是四舍五入', () => {
    // 借款合同 0.05‰：1,000 元合同 → 0.05 元 < 0.1 → 不计
    const result = computeStampDuty({ amount: 1_000, item: 'loan' });
    expect(result.grossTax).toBe(0.05);
    expect(result.tax).toBe(0);
    expect(result.notes.join()).toContain('不足 1 角');
    expect(result.notes.join()).toContain('第十一条');

    // 边界：刚好 0.1 元要计（借款合同 2,000 × 0.05‰ = 0.1）
    expect(computeStampDuty({ amount: 2_000, item: 'loan' }).tax).toBe(0.1);
  });

  it('金额 ≤ 0 返回 0 税额并说明原因，不抛错（0 元合同是合法业务事实）', () => {
    for (const amount of [0, -100]) {
      const result = computeStampDuty({ amount, item: 'technology' });
      expect(result.tax).toBe(0);
      expect(result.grossTax).toBe(0);
      expect(result.notes.join()).toContain('合同金额为 0');
    }
  });

  it('租赁合同 1‰ 与借款合同 0.05‰ 各自生效（防止"所有档位都取技术合同"）', () => {
    const base = { amount: 1_000_000, netAmount: 1_000_000 };
    expect(computeStampDuty({ ...base, item: 'lease' }).tax).toBe(1000);
    expect(computeStampDuty({ ...base, item: 'loan' }).tax).toBe(50);
    expect(computeStampDuty({ ...base, item: 'property_transfer' }).tax).toBe(500);
    expect(computeStampDuty({ ...base, item: 'capital_book' }).tax).toBe(250);
  });
});

describe('印花税减半适用性（resolveStampDutyHalved）', () => {
  it('小规模纳税人适用减半；一般纳税人/未指定/未知值一律不减半（偏严）', () => {
    expect(resolveStampDutyHalved('small')).toBe(true);
    expect(resolveStampDutyHalved('general')).toBe(false);
    expect(resolveStampDutyHalved(null)).toBe(false);
    expect(resolveStampDutyHalved(undefined)).toBe(false);
    // 大小写不匹配不属于合法取值 → 不减半（多缴方向）
    expect(resolveStampDutyHalved('SMALL')).toBe(false);
    expect(resolveStampDutyHalved('')).toBe(false);
  });
});

describe('印花税计提分录（stampDutyAccrualLines）', () => {
  it('借 640304 税金及附加-印花税 / 贷 222113 应交税费-印花税，借贷相等', () => {
    const result = computeStampDuty({
      amount: 1_000_000,
      netAmount: 1_000_000,
      item: 'technology',
    });
    const lines = stampDutyAccrualLines(result);
    expect(lines).toEqual([
      { accountCode: ACCOUNT_TAX_SURCHARGE_STAMP_DUTY, debit: 300 },
      { accountCode: ACCOUNT_TAX_PAYABLE_STAMP_DUTY, credit: 300 },
    ]);
    // 科目编码是硬事实：印花税计入"税金及附加"（财会〔2016〕22 号），
    // 不是管理费用。改这一条会改变利润表结构，必须是有意识的决定。
    expect(ACCOUNT_TAX_SURCHARGE_STAMP_DUTY).toBe('640304');
    expect(ACCOUNT_TAX_PAYABLE_STAMP_DUTY).toBe('222113');
  });

  it('税额为 0（不足 1 角 / 0 元合同）时**不出分录**', () => {
    const tiny = computeStampDuty({ amount: 1_000, item: 'loan' });
    expect(tiny.tax).toBe(0);
    expect(stampDutyAccrualLines(tiny)).toEqual([]);

    const zero = computeStampDuty({ amount: 0, item: 'technology' });
    expect(stampDutyAccrualLines(zero)).toEqual([]);
  });

  it('分录借贷合计恒等（含减半与小数基数）', () => {
    for (const net of [1_000_000, 4_716_981.13, 333_333.33, 12_345.67]) {
      for (const halved of [false, true]) {
        const result = computeStampDuty({
          amount: net,
          netAmount: net,
          item: 'technology',
          halved,
        });
        const lines = stampDutyAccrualLines(result);
        const debit = lines.reduce((sum, line) => sum + (line.debit ?? 0), 0);
        const credit = lines.reduce((sum, line) => sum + (line.credit ?? 0), 0);
        expect(debit).toBe(credit);
        expect(debit).toBe(result.tax);
      }
    }
  });
});
