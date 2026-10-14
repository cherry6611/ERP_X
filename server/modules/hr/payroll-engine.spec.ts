import {
  BASIC_DEDUCTION_PER_MONTH,
  calcCumulativeTax,
  calcEmployeeSocialInsurance,
  cumulativeAdditionalDeduction,
  monthlyAdditionalDeduction,
  previewPayroll,
  resolveTaxBracket,
  type CitySsRule,
  type TaxDeductionEntry,
} from './payroll-engine';

const rule: CitySsRule = {
  pensionEmp: 8,
  medicalEmp: 2,
  unemploymentEmp: 0.5,
  housingEmp: 12,
  baseMin: 5000,
  baseMax: 30000,
};

/** 无社保的纯个税场景，便于与税局算例逐项对照 */
const noSocial: CitySsRule = {
  pensionEmp: 0,
  medicalEmp: 0,
  unemploymentEmp: 0,
  housingEmp: 0,
  baseMin: 0,
  baseMax: 999999,
};

describe('累计预扣预缴税率表（A-07）', () => {
  it('七级预扣率与速算扣除数与国税总局公告一致', () => {
    const table = [
      [36000, 0.03, 0],
      [144000, 0.1, 2520],
      [300000, 0.2, 16920],
      [420000, 0.25, 31920],
      [660000, 0.3, 52920],
      [960000, 0.35, 85920],
      [Number.POSITIVE_INFINITY, 0.45, 181920],
    ] as const;
    for (const [upTo, rate, quick] of table) {
      expect(resolveTaxBracket(upTo === Infinity ? 2_000_000 : upTo)).toEqual({
        upTo,
        rate,
        quickDeduction: quick,
      });
    }
  });

  it('跨档位边界取数正确（36000.01 进入 10% 档）', () => {
    expect(calcCumulativeTax(36000)).toBe(1080); // 36000 × 3%
    // 36000.01 × 10% − 2520 = 1080.001 → 1080
    expect(calcCumulativeTax(36000.01)).toBe(1080);
    // 40000 × 10% − 2520 = 1480
    expect(calcCumulativeTax(40000)).toBe(1480);
    // 144000 × 10% − 2520 = 11880
    expect(calcCumulativeTax(144000)).toBe(11880);
    // 200000 × 20% − 16920 = 23080
    expect(calcCumulativeTax(200000)).toBe(23080);
    // 应纳所得额为负或 0 时税额为 0
    expect(calcCumulativeTax(0)).toBe(0);
    expect(calcCumulativeTax(-100)).toBe(0);
  });
});

describe('专项附加扣除按月登记（A-07）', () => {
  const entries: TaxDeductionEntry[] = [
    {
      deductionType: 'child_education',
      monthlyAmount: 1000,
      startMonth: 1,
      endMonth: null,
    },
    {
      deductionType: 'housing_loan',
      monthlyAmount: 1000,
      startMonth: 3,
      endMonth: 12,
    },
    {
      deductionType: 'elderly_support',
      monthlyAmount: 2000,
      startMonth: 1,
      endMonth: 6,
    },
  ];

  it('按月过滤生效期间', () => {
    expect(monthlyAdditionalDeduction(entries, 1)).toBe(3000); // 子女教育 1000 + 赡养老人 2000
    expect(monthlyAdditionalDeduction(entries, 2)).toBe(3000);
    expect(monthlyAdditionalDeduction(entries, 3)).toBe(4000); // 增加住房贷款 1000
    expect(monthlyAdditionalDeduction(entries, 6)).toBe(4000);
    expect(monthlyAdditionalDeduction(entries, 7)).toBe(2000); // 赡养老人 6 月后失效
    expect(monthlyAdditionalDeduction(entries, 12)).toBe(2000);
  });

  it('累计扣除 = 逐月求和（非简单乘法）', () => {
    // 1-2 月各 3000；3-6 月各 4000；7-12 月各 2000
    expect(cumulativeAdditionalDeduction(entries, 1)).toBe(3000);
    expect(cumulativeAdditionalDeduction(entries, 2)).toBe(6000);
    expect(cumulativeAdditionalDeduction(entries, 3)).toBe(10000);
    expect(cumulativeAdditionalDeduction(entries, 6)).toBe(22000);
    expect(cumulativeAdditionalDeduction(entries, 7)).toBe(24000);
    expect(cumulativeAdditionalDeduction(entries, 12)).toBe(34000);
  });
});

describe('社保基数上下限（A-08）', () => {
  it('按基数上下限夹取，个人部分按比例计算', () => {
    const low = calcEmployeeSocialInsurance(3000, undefined, rule);
    expect(low.ssBase).toBe(5000); // 低于 baseMin → 取 5000
    expect(low.socialInsurance).toBe(525); // 5000 × (8+2+0.5)% = 525
    expect(low.housingFund).toBe(600); // 5000 × 12%

    const high = calcEmployeeSocialInsurance(50000, undefined, rule);
    expect(high.ssBase).toBe(30000); // 高于 baseMax → 取 30000
    expect(high.socialInsurance).toBe(3150); // 30000 × 10.5%
    expect(high.housingFund).toBe(3600); // 30000 × 12%

    const explicit = calcEmployeeSocialInsurance(20000, 8000, rule);
    expect(explicit.ssBase).toBe(8000); // 显式基数优先
    expect(explicit.socialInsurance).toBe(840); // 8000 × 10.5%
  });
});

describe('previewPayroll（A-07 累计预扣预缴）', () => {
  it('首月：社保 + 公积金 + 个税数值逐项断言', () => {
    const result = previewPayroll({
      baseSalary: 15000,
      perfSalary: 2000,
      allowance: 0,
      monthIndex: 1,
      rule,
    });
    expect(result.gross).toBe(17000);
    expect(result.ssBase).toBe(17000);
    expect(result.socialInsurance).toBe(1785); // 17000 × 10.5% = 1360 + 340 + 85
    expect(result.housingFund).toBe(2040); // 17000 × 12%
    expect(result.breakdown.pensionEmp).toBe(1360);
    expect(result.breakdown.medicalEmp).toBe(340);
    expect(result.breakdown.unemploymentEmp).toBe(85);
    // 累计应纳税所得额 = 17000 − 5000 − 1785 − 2040 = 8175 → 3%
    expect(result.taxable).toBe(8175);
    expect(result.tax).toBe(245.25);
    expect(result.cumulative.ytdBasicDeduction).toBe(BASIC_DEDUCTION_PER_MONTH);
    expect(result.cumulative.taxRate).toBe(0.03);
    expect(result.cumulative.ytdTaxWithheld).toBe(245.25);
    // 实发 = 17000 − 1785 − 2040 − 245.25
    expect(result.netSalary).toBe(12929.75);
  });

  it('连续 12 个月：累计已预扣税额 = 全年应纳税额（逐月递推）', () => {
    const monthlyGross = 20000;
    let ytdGross = 0;
    let ytdSpecial = 0;
    let ytdTaxPaid = 0;
    const taxes: number[] = [];
    for (let month = 1; month <= 12; month += 1) {
      const result = previewPayroll({
        baseSalary: monthlyGross,
        perfSalary: 0,
        allowance: 0,
        monthIndex: month,
        ytdGross,
        ytdSpecialDeduction: ytdSpecial,
        ytdTaxPaid,
        rule,
      });
      taxes.push(result.tax);
      ytdGross = result.cumulative.ytdIncome;
      ytdSpecial = result.cumulative.ytdDeduction;
      ytdTaxPaid = result.cumulative.ytdTaxWithheld;
      expect(result.cumulative.monthIndex).toBe(month);
    }
    // 每月社保+公积金 = 20000 × 22.5% = 4500
    expect(ytdSpecial).toBe(4500 * 12);
    // 全年应纳税所得额 = 240000 − 60000 − 54000 = 126000 → 10% 档
    const expectedAnnual = Math.round((126000 * 0.1 - 2520) * 100) / 100;
    expect(expectedAnnual).toBe(10080);
    // 累计已预扣 = 全年应纳税额
    expect(ytdTaxPaid).toBe(expectedAnnual);
    // 逐月税额之和 = 全年税额
    expect(Math.round(taxes.reduce((a, b) => a + b, 0) * 100) / 100).toBe(expectedAnnual);
    // 前 3 个月处在 3% 档（累计应纳税所得额 ≤ 36000）：1 月 10500、2 月 21000、3 月 31500
    expect(taxes[0]).toBe(315); // 10500 × 3%
    expect(taxes[1]).toBe(315); // 21000 × 3% − 315
    expect(taxes[2]).toBe(315); // 31500 × 3% − 630
    // 4 月进入 10% 档：42000 × 10% − 2520 = 1680，减去已缴 945 → 735
    expect(taxes[3]).toBe(735);
  });

  it('专项附加扣除登记后税额正确下降（子女教育 1000/月 + 赡养老人 2000/月）', () => {
    const entries: TaxDeductionEntry[] = [
      {
        deductionType: 'child_education',
        monthlyAmount: 1000,
        startMonth: 1,
        endMonth: null,
      },
      {
        deductionType: 'elderly_support',
        monthlyAmount: 2000,
        startMonth: 1,
        endMonth: null,
      },
    ];
    const without = previewPayroll({
      baseSalary: 30000,
      perfSalary: 0,
      allowance: 0,
      monthIndex: 1,
      rule: noSocial,
    });
    const withDeduction = previewPayroll({
      baseSalary: 30000,
      perfSalary: 0,
      allowance: 0,
      monthIndex: 1,
      additionalDeduction: monthlyAdditionalDeduction(entries, 1),
      rule: noSocial,
    });
    // 无附加扣除：30000 − 5000 = 25000 → 3% = 750
    expect(without.taxable).toBe(25000);
    expect(without.tax).toBe(750);
    // 有附加扣除 3000：25000 − 3000 = 22000 → 3% = 660
    expect(withDeduction.taxable).toBe(22000);
    expect(withDeduction.tax).toBe(660);
    expect(without.tax - withDeduction.tax).toBe(90);
  });

  it('年中入职（累计月数按实际发放月份）：减除费用按 5000 × 月序', () => {
    const result = previewPayroll({
      baseSalary: 10000,
      perfSalary: 0,
      allowance: 0,
      monthIndex: 7, // 7 月首次发放，减除费用仍按 5000 × 7
      rule: noSocial,
    });
    expect(result.cumulative.ytdBasicDeduction).toBe(35000);
    // 10000 − 35000 < 0 → 累计应纳税所得额为 0，本期不预扣
    expect(result.taxable).toBe(0);
    expect(result.tax).toBe(0);
  });

  it('免税收入与其他扣除（企业年金）参与累计计算', () => {
    const result = previewPayroll({
      baseSalary: 30000,
      perfSalary: 0,
      allowance: 0,
      monthIndex: 1,
      taxFreeIncome: 1000,
      otherDeduction: 500,
      rule: noSocial,
    });
    // 30000 − 1000 − 5000 − 500 = 23500 → 3% = 705
    expect(result.taxable).toBe(23500);
    expect(result.tax).toBe(705);
  });

  it('累计多扣时本期税额为 0 并给出可退金额（不产生负税）', () => {
    const result = previewPayroll({
      baseSalary: 8000,
      perfSalary: 0,
      allowance: 0,
      monthIndex: 2,
      ytdGross: 30000,
      ytdTaxPaid: 2000,
      rule: noSocial,
    });
    // 累计应纳税所得额 = 38000 − 10000 = 28000 → 3% = 840 < 已缴 2000
    expect(result.cumulative.cumulativeTax).toBe(840);
    expect(result.tax).toBe(0);
    expect(result.refundable).toBe(1160);
  });

  it('社保基数显式给定（员工 ssBase）优先于应发', () => {
    const result = previewPayroll({
      baseSalary: 40000,
      perfSalary: 0,
      allowance: 0,
      ssBase: 10000,
      monthIndex: 1,
      rule,
    });
    expect(result.ssBase).toBe(10000);
    expect(result.breakdown.pensionEmp).toBe(800);
    expect(result.breakdown.housingEmp).toBe(1200);
  });

  it('月份序号越界时夹取到 1~12', () => {
    expect(
      previewPayroll({
        baseSalary: 10000,
        perfSalary: 0,
        allowance: 0,
        monthIndex: 0,
        rule: noSocial,
      }).cumulative.monthIndex
    ).toBe(1);
    expect(
      previewPayroll({
        baseSalary: 10000,
        perfSalary: 0,
        allowance: 0,
        monthIndex: 99,
        rule: noSocial,
      }).cumulative.monthIndex
    ).toBe(12);
  });
});
