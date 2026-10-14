import {
  evaluateFormula,
  FormulaParseError,
  parseFormula,
  type FormulaContext,
} from './report-formula';

function makeValues(input: {
  openingDebit?: number;
  openingCredit?: number;
  debitOccur?: number;
  creditOccur?: number;
  closingDebit?: number;
  closingCredit?: number;
  name?: string;
}): FormulaContext['accountValues'] extends Map<string, infer V> ? V : never {
  return {
    openingDebit: input.openingDebit ?? 0,
    openingCredit: input.openingCredit ?? 0,
    debitOccur: input.debitOccur ?? 0,
    creditOccur: input.creditOccur ?? 0,
    closingDebit: input.closingDebit ?? 0,
    closingCredit: input.closingCredit ?? 0,
    name: input.name,
  } as never;
}

function context(
  accounts: Record<string, ReturnType<typeof makeValues>>,
  rows: Record<string, number> = {},
  prevRows: Record<string, number> = {}
): FormulaContext {
  return {
    accountValues: new Map(Object.entries(accounts)),
    rowValues: new Map(Object.entries(rows)),
    prevRowValues: new Map(Object.entries(prevRows)),
  };
}

describe('report-formula 取数公式 DSL', () => {
  it('解析科目余额并按方向取数', () => {
    const parsed = parseFormula('科目余额(1122, 借) + 科目余额(2202, 贷)');
    expect(parsed.accountCodes).toEqual(['1122', '2202']);
    const ctx = context({
      '1122': makeValues({ closingDebit: 31800, closingCredit: 0 }),
      '2202': makeValues({ closingDebit: 0, closingCredit: 12000 }),
    });
    expect(evaluateFormula(parsed, ctx)).toBe(43800);
  });

  it('科目余额(净) 保留符号，支持借贷相抵为负', () => {
    const parsed = parseFormula('科目余额(4103)');
    const ctx = context({
      '4103': makeValues({ closingDebit: 0, closingCredit: 5000 }),
    });
    // 净额 = 借 − 贷 = -5000
    expect(evaluateFormula(parsed, ctx)).toBe(-5000);
  });

  it('方向"借"/"贷"按 max(净, 0) 口径，不会互相污染', () => {
    const ctx = context({
      '1122': makeValues({ closingDebit: 1000, closingCredit: 3000 }),
    });
    expect(evaluateFormula(parseFormula('科目余额(1122, 借)'), ctx)).toBe(0);
    expect(evaluateFormula(parseFormula('科目余额(1122, 贷)'), ctx)).toBe(2000);
  });

  it('科目发生取本期发生额', () => {
    const ctx = context({
      '6001': makeValues({ debitOccur: 0, creditOccur: 30000 }),
      '6401': makeValues({ debitOccur: 12000, creditOccur: 0 }),
    });
    expect(
      evaluateFormula(parseFormula('科目发生(6001, 贷) - 科目发生(6401, 借)'), ctx)
    ).toBe(18000);
  });

  it('期初余额取期初；科目变动 = 期末 − 期初', () => {
    const ctx = context({
      '1122': makeValues({
        openingDebit: 10000,
        openingCredit: 0,
        closingDebit: 31800,
        closingCredit: 0,
      }),
    });
    expect(evaluateFormula(parseFormula('期初余额(1122, 借)'), ctx)).toBe(10000);
    expect(evaluateFormula(parseFormula('科目变动(1122)'), ctx)).toBe(21800);
  });

  it('支持行引用与上期引用', () => {
    const ctx = context({}, { '1': 100, '2': 40 }, { '1': 80 });
    expect(evaluateFormula(parseFormula('行(1) - 行(2)'), ctx)).toBe(60);
    expect(evaluateFormula(parseFormula('上期(1) + 行(1)'), ctx)).toBe(180);
  });

  it('支持括号、一元负号与 ABS', () => {
    const ctx = context({ '1122': makeValues({ closingDebit: -300 }) });
    expect(evaluateFormula(parseFormula('-1 * 科目余额(1122)'), ctx)).toBe(300);
    expect(evaluateFormula(parseFormula('ABS(科目余额(1122))'), ctx)).toBe(300);
    expect(evaluateFormula(parseFormula('(1 + 2) * 3'), ctx)).toBe(9);
  });

  it('金额按分四舍五入', () => {
    const ctx = context({
      '1122': makeValues({ closingDebit: 0.005 }),
    });
    expect(evaluateFormula(parseFormula('科目余额(1122)'), ctx)).toBe(0.01);
  });

  it('空公式返回 0（用于纯标题行）', () => {
    expect(evaluateFormula(parseFormula(''), context({}))).toBe(0);
  });

  it('非法公式抛出 FormulaParseError（可定位到具体片段）', () => {
    expect(() => parseFormula('科目余额(abc)')).toThrow(FormulaParseError);
    expect(() => parseFormula('科目余额(1122, 中间)')).toThrow(FormulaParseError);
    expect(() => parseFormula('未知函数(1122)')).toThrow(FormulaParseError);
    expect(() => parseFormula('科目余额(1122) +')).toThrow(FormulaParseError);
    expect(() => parseFormula('科目余额(1122')).toThrow(FormulaParseError);
  });

  it('解析时收集行引用与上期引用标记', () => {
    const parsed = parseFormula('行(5) + 上期(3)');
    expect(parsed.rowRefs.sort()).toEqual(['3', '5']);
    expect(parsed.usesPrevPeriod).toBe(true);
  });
});
