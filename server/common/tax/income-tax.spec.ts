import {
  CIT_RATES,
  CIT_SMALL_MICRO_EFFECTIVE_RATE,
  CIT_SMALL_MICRO_INCOME_CAP,
  computeIncomeTax,
  resolveCitSmallMicro,
} from './income-tax';
import { incomeTaxAccrualLines } from './income-tax-posting';
import {
  ACCOUNT_INCOME_TAX,
  ACCOUNT_TAX_PAYABLE_INCOME_TAX,
} from './account-codes';

/**
 * 企业所得税规格（§4.7(e)：原实现"全仓无引用、利润表第 11 行恒为 0"）。
 *
 * ## 这条规格优先钉死的三件事
 *
 * 1. **小微门槛是"全额适用/全额不适用"，不是超额累进。**
 *    应纳税所得额 3,000,001 元时按 **25% 全额** 计税（75 万），
 *    而不是"300 万 × 5% + 1 元 × 25%"。写错这一点的后果是差 60 万量级。
 *
 * 2. **小微实际税负是 5%**（减按 25% 计入 × 20% 税率），
 *    不是 20%、更不是 4%。用一个独立常量把它钉住。
 *
 * 3. **不从增值税资格推导企业所得税资格。** 两套标准的判定要件完全不同，
 *    互相代理会在人数/资产超标时错误享受 5%。
 *
 * ## 金额断言用精确值
 *
 * 税错了就是真金白银错，不允许容差（与 `vat-declaration.service.spec.ts` 同一约定）。
 */
describe('企业所得税计算（computeIncomeTax）', () => {
  it('一般企业：利润总额 100 万、无调整 ⇒ 应纳税所得额 100 万、税额 25 万', () => {
    const result = computeIncomeTax({ accountingProfit: 1_000_000 });
    expect(result.adjustedIncome).toBe(1_000_000);
    expect(result.taxableIncome).toBe(1_000_000);
    expect(result.rateKind).toBe('general');
    expect(result.statutoryRate).toBe(25);
    expect(result.effectiveRate).toBe(25);
    expect(result.taxPayable).toBe(250_000);
    expect(result.notes.join()).toContain('适用税率 25%');
  });

  it('小型微利企业：实际税负 5%（减按 25% 计入 × 20% 税率）', () => {
    const result = computeIncomeTax({
      accountingProfit: 1_000_000,
      smallMicro: true,
    });
    expect(result.rateKind).toBe('smallMicro');
    // 法定税率 20%，但**实际税负**是 5% —— 计税用 5%
    expect(result.statutoryRate).toBe(20);
    expect(result.effectiveRate).toBe(5);
    expect(result.taxPayable).toBe(50_000);
    expect(CIT_SMALL_MICRO_EFFECTIVE_RATE).toBe(5);
    // 说明里必须写清政策依据，底稿要能自证
    expect(result.notes.join()).toContain('2023 年第 12 号');
    expect(result.notes.join()).toContain('减按 25%');
  });

  it('**小微门槛是全额适用/全额不适用**：3,000,001 元按 25% 全额计，不是超额累进', () => {
    // 恰好 300 万 → 享受 5%
    const atCap = computeIncomeTax({
      accountingProfit: CIT_SMALL_MICRO_INCOME_CAP,
      smallMicro: true,
    });
    expect(atCap.rateKind).toBe('smallMicro');
    expect(atCap.taxPayable).toBe(150_000); // 3,000,000 × 5%

    // 超过门槛 1 元 → **不再享受**，全额按 25%
    const overCap = computeIncomeTax({
      accountingProfit: CIT_SMALL_MICRO_INCOME_CAP + 1,
      smallMicro: true,
    });
    expect(overCap.rateKind).toBe('general');
    expect(overCap.effectiveRate).toBe(25);
    // 3,000,001 × 25% = 750,000.25
    expect(overCap.taxPayable).toBe(750_000.25);
    // 反例防线：若误按超额累进会得到 150,000.25（差 60 万）
    expect(overCap.taxPayable).not.toBe(150_000.25);
    // 必须显式说明"不是超额累进"
    expect(overCap.notes.join()).toContain('不是超额累进');
  });

  it('高新技术企业 15%；与小微同时具备时取税负更低者（5%）', () => {
    expect(
      computeIncomeTax({ accountingProfit: 1_000_000, highTech: true }).taxPayable
    ).toBe(150_000);

    const both = computeIncomeTax({
      accountingProfit: 1_000_000,
      highTech: true,
      smallMicro: true,
    });
    expect(both.rateKind).toBe('smallMicro');
    expect(both.taxPayable).toBe(50_000);
  });

  it('纳税调整：调增加、调减减，并逐条记入说明', () => {
    const result = computeIncomeTax({
      accountingProfit: 1_000_000,
      adjustments: [
        { name: '业务招待费超支', direction: 'add', amount: 20_000, note: '超税法限额' },
        { name: '研发费用加计扣除', direction: 'less', amount: 80_000, note: '加计 100%' },
        { name: '零金额项', direction: 'add', amount: 0 },
      ],
    });
    expect(result.addedTotal).toBe(20_000);
    expect(result.lessTotal).toBe(80_000);
    expect(result.adjustedIncome).toBe(940_000);
    expect(result.taxPayable).toBe(235_000); // 940,000 × 25%
    const notes = result.notes.join('\n');
    expect(notes).toContain('调增「业务招待费超支」20000');
    expect(notes).toContain('调减「研发费用加计扣除」80000');
    // 0 金额项不进说明（避免底稿里塞满无意义的行）
    expect(notes).not.toContain('零金额项');
  });

  it('弥补以前年度亏损：以调整后所得为限，余额继续结转', () => {
    const result = computeIncomeTax({
      accountingProfit: 500_000,
      lossCarryForward: 800_000,
    });
    expect(result.lossUsed).toBe(500_000);
    expect(result.taxableIncome).toBe(0);
    expect(result.taxPayable).toBe(0);
    expect(result.notes.join()).toContain('以调整后所得');
  });

  it('亏损年度：应纳税所得额与税额均为 0，并给出可结转亏损（不抛错）', () => {
    const result = computeIncomeTax({
      accountingProfit: -300_000,
      smallMicro: true,
    });
    expect(result.adjustedIncome).toBe(-300_000);
    expect(result.taxableIncome).toBe(0);
    expect(result.taxPayable).toBe(0);
    expect(result.lossCarryForward).toBe(300_000);
    expect(result.notes.join()).toContain('第十八条');
    expect(result.notes.join()).toContain('5 年');
  });

  it('调整后"转亏"也走亏损分支（不产生负税额）', () => {
    const result = computeIncomeTax({
      accountingProfit: 100_000,
      adjustments: [{ name: '大额调减', direction: 'less', amount: 400_000 }],
    });
    expect(result.adjustedIncome).toBe(-300_000);
    expect(result.taxPayable).toBe(0);
    expect(result.lossCarryForward).toBe(300_000);
  });

  it('已预缴：应补为正、应退为负', () => {
    const underpaid = computeIncomeTax({
      accountingProfit: 1_000_000,
      prepaidTax: 200_000,
    });
    expect(underpaid.taxPayable).toBe(250_000);
    expect(underpaid.balanceDue).toBe(50_000);

    const overpaid = computeIncomeTax({
      accountingProfit: 1_000_000,
      prepaidTax: 300_000,
    });
    expect(overpaid.balanceDue).toBe(-50_000);
    expect(overpaid.notes.join()).toContain('应退');
  });

  it('未确认小微资格（null/undefined）一律按 25% 处理 —— 偏严方向', () => {
    for (const smallMicro of [null, undefined, false]) {
      const result = computeIncomeTax({ accountingProfit: 1_000_000, smallMicro });
      expect(result.rateKind).toBe('general');
      expect(result.taxPayable).toBe(250_000);
    }
  });

  it('税率常量与《企业所得税法》一致', () => {
    expect(CIT_RATES).toEqual({ general: 25, highTech: 15, smallMicro: 20 });
    // 门槛是 300 万元（财政部 税务总局公告 2023 年第 12 号）
    expect(CIT_SMALL_MICRO_INCOME_CAP).toBe(3_000_000);
  });
});

describe('小微资格推导（resolveCitSmallMicro）', () => {
  it('只认 1；0 与 NULL 都不享受（NULL = 未确认 → 偏严）', () => {
    expect(resolveCitSmallMicro(1)).toBe(true);
    expect(resolveCitSmallMicro(0)).toBe(false);
    // 关键：NULL 不能当"默认享受"——那等于无人确认时静默少缴
    expect(resolveCitSmallMicro(null)).toBe(false);
    expect(resolveCitSmallMicro(undefined)).toBe(false);
  });

  it('不从增值税纳税人资格推导（两套标准）', () => {
    // 这个断言的实质是"接口不接受 taxpayerType"——
    // 若将来有人加了这个参数，本规格会因参数形状变化而需要显式修改，
    // 从而强制一次有意识的决定，而不是悄悄引入错误代理。
    expect(resolveCitSmallMicro.length).toBe(1);
  });
});

describe('企业所得税计提分录（incomeTaxAccrualLines）', () => {
  it('借 6801 所得税费用 / 贷 222114 应交企业所得税，借贷相等', () => {
    const result = computeIncomeTax({ accountingProfit: 1_000_000 });
    const lines = incomeTaxAccrualLines(result);
    expect(lines).toEqual([
      { accountCode: ACCOUNT_INCOME_TAX, debit: 250_000 },
      { accountCode: ACCOUNT_TAX_PAYABLE_INCOME_TAX, credit: 250_000 },
    ]);
    // 科目归属是硬事实：所得税费用在**营业利润之外**（利润表第 11 行），
    // 记进 6403 税金及附加会让"营业利润"虚减、且第 11/12 行仍为 0。
    expect(ACCOUNT_INCOME_TAX).toBe('6801');
    expect(ACCOUNT_TAX_PAYABLE_INCOME_TAX).toBe('222114');
  });

  it('亏损年度（税额 0）**不出分录**', () => {
    expect(
      incomeTaxAccrualLines(computeIncomeTax({ accountingProfit: -100_000 }))
    ).toEqual([]);
    expect(
      incomeTaxAccrualLines(computeIncomeTax({ accountingProfit: 0 }))
    ).toEqual([]);
  });

  it('弥补亏损后税额为 0 时也不出分录', () => {
    const result = computeIncomeTax({
      accountingProfit: 100_000,
      lossCarryForward: 500_000,
    });
    expect(result.taxPayable).toBe(0);
    expect(incomeTaxAccrualLines(result)).toEqual([]);
  });

  it('借贷合计恒等（含小数基数）', () => {
    for (const profit of [1_000_000, 333_333.33, 12_345.67, 999_999.99]) {
      for (const smallMicro of [false, true]) {
        const result = computeIncomeTax({ accountingProfit: profit, smallMicro });
        const lines = incomeTaxAccrualLines(result);
        const debit = lines.reduce((sum, l) => sum + (l.debit ?? 0), 0);
        const credit = lines.reduce((sum, l) => sum + (l.credit ?? 0), 0);
        expect(debit).toBe(credit);
        expect(debit).toBe(result.taxPayable);
      }
    }
  });
});
