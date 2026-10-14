import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateFormula, parseFormula, type FormulaContext } from './report-formula';

/**
 * 报表模板冒烟测试：
 * 直接解析迁移文件里的模板行，验证"模板可加载 + 公式可解析 + 会计恒等式成立"，
 * 避免模板 SQL 与 DSL 语法漂移（CI 中无需数据库即可运行）。
 */

interface TemplateRow {
  reportCode: string;
  rowNo: string;
  rowName: string;
  formula: string;
}

const MIGRATION = join(
  __dirname,
  '..',
  '..',
  'database',
  'migrations',
  '2026-10-15-upgrade-batch1-report-templates.sql'
);

/** 极简 SQL VALUES 行解析（只处理本迁移里 `('code','row','name','formula',...)` 的形状） */
function loadTemplates(): TemplateRow[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const rows: TemplateRow[] = [];
  const linePattern =
    /\(\s*'(balance_sheet|income_statement|cash_flow)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(sql)) !== null) {
    rows.push({
      reportCode: match[1],
      rowNo: match[2],
      rowName: match[3],
      formula: match[4],
    });
  }
  return rows;
}

type AccountValues = FormulaContext['accountValues'] extends Map<string, infer V>
  ? V
  : never;

function context(
  accounts: Record<string, Partial<AccountValues>>,
  rowValues: Record<string, number> = {}
): FormulaContext {
  const accountValues = new Map<string, AccountValues>();
  for (const [code, value] of Object.entries(accounts)) {
    accountValues.set(code, {
      openingDebit: value.openingDebit ?? 0,
      openingCredit: value.openingCredit ?? 0,
      debitOccur: value.debitOccur ?? 0,
      creditOccur: value.creditOccur ?? 0,
      closingDebit: value.closingDebit ?? 0,
      closingCredit: value.closingCredit ?? 0,
      name: value.name,
    });
  }
  return {
    accountValues,
    rowValues: new Map(Object.entries(rowValues)),
    prevRowValues: new Map(),
  };
}

/** 按模板顺序逐行求值（与 ReportsService.evaluateRows 同序） */
function evaluateTemplate(
  rows: TemplateRow[],
  baseCtx: Omit<FormulaContext, 'rowValues' | 'prevRowValues'>
): Map<string, number> {
  const rowValues = new Map<string, number>();
  for (const row of rows) {
    const parsed = parseFormula(row.formula);
    const value = evaluateFormula(parsed, {
      ...baseCtx,
      rowValues,
      prevRowValues: new Map(),
    });
    rowValues.set(row.rowNo, value);
  }
  return rowValues;
}

describe('法定报表模板（迁移文件）', () => {
  const templates = loadTemplates();

  it('三类报表模板行齐全', () => {
    const byCode = new Map<string, number>();
    for (const row of templates) {
      byCode.set(row.reportCode, (byCode.get(row.reportCode) ?? 0) + 1);
    }
    expect(byCode.get('balance_sheet')).toBe(22);
    expect(byCode.get('income_statement')).toBe(13);
    expect(byCode.get('cash_flow')).toBe(14);
  });

  it('所有模板公式均可解析，且行引用已定义', () => {
    const rowNosByCode = new Map<string, Set<string>>();
    for (const row of templates) {
      const set = rowNosByCode.get(row.reportCode) ?? new Set<string>();
      set.add(row.rowNo);
      rowNosByCode.set(row.reportCode, set);
    }
    for (const row of templates) {
      const parsed = parseFormula(row.formula);
      for (const ref of parsed.rowRefs) {
        expect(rowNosByCode.get(row.reportCode)?.has(ref)).toBe(true);
      }
    }
  });

  it('资产负债表在借方=贷方构造下左右恒等', () => {
    const rows = templates.filter((row) => row.reportCode === 'balance_sheet');
    const ctx = context({
      '1001': { closingDebit: 5000, name: '库存现金' },
      '1002': { closingDebit: 95000, name: '银行存款' },
      '1122': { closingDebit: 31800, name: '应收账款' },
      '1123': { closingDebit: 2000, name: '预付账款' },
      '1403': { closingDebit: 0, name: '原材料' },
      '1601': { closingDebit: 60000, name: '固定资产' },
      '1602': { closingCredit: 10000, name: '累计折旧' },
      '2202': { closingCredit: 12000, name: '应付账款' },
      '2203': { closingCredit: 0, name: '预收账款' },
      '2211': { closingCredit: 0, name: '应付职工薪酬' },
      '2221': { closingCredit: 1800, name: '应交税费' },
      '4001': { closingCredit: 100000, name: '实收资本' },
      '410415': { closingCredit: 0, name: '盈余公积' },
      '410401': { closingCredit: 70000, name: '未分配利润' },
      '4103': { closingCredit: 0, name: '本年利润' },
    });
    const values = evaluateTemplate(rows, ctx);
    const assetsTotal = values.get('10') ?? 0;
    const total = values.get('22') ?? 0;
    expect(assetsTotal).toBe(5000 + 95000 + 31800 + 2000 + 60000 - 10000);
    expect(total).toBe(assetsTotal);
    expect(values.get('5')).toBe(5000 + 95000 + 31800 + 2000);
    expect(values.get('8')).toBe(50000);
    expect(values.get('15')).toBe(12000 + 1800);
    expect(values.get('21')).toBe(100000 + 70000);
  });

  it('利润表：营业利润 = 收入 − 成本费用；净利润 = 利润总额 − 所得税', () => {
    const rows = templates.filter((row) => row.reportCode === 'income_statement');
    const ctx = context({
      '6001': { creditOccur: 30000, name: '主营业务收入' },
      '6051': { creditOccur: 0 },
      '6401': { debitOccur: 12000, name: '主营业务成本' },
      '6402': { debitOccur: 0 },
      '6403': { debitOccur: 180, name: '税金及附加' },
      '6601': { debitOccur: 0 },
      '6602': { debitOccur: 5000, name: '管理费用' },
      '6603': { debitOccur: 200, name: '财务费用' },
      '6701': { debitOccur: 0 },
      '6301': { creditOccur: 1000 },
      '6711': { debitOccur: 300 },
      '6801': { debitOccur: 800, name: '所得税费用' },
    });
    const values = evaluateTemplate(rows, ctx);
    expect(values.get('1')).toBe(30000);
    expect(values.get('2')).toBe(12000);
    expect(values.get('8')).toBe(30000 - 12000 - 180 - 0 - 5000 - 200 - 0);
    expect(values.get('10')).toBe((values.get('8') ?? 0) + 1000 - 300);
    expect(values.get('12')).toBe((values.get('10') ?? 0) - 800);
  });

  it('现金流量表：期初现金 + 净增加额 = 期末现金（且与资产负债表货币资金一致）', () => {
    const rows = templates.filter((row) => row.reportCode === 'cash_flow');
    // 一套内部自洽的数据（每个科目都满足 期末 = 期初 + 发生额）：
    //   期初：现金 20000、固定资产 60000、实收资本 80000
    //   本期：股东增资 40000 → 现金 +40000
    //         确认收入 30000（含税应收 31800 已于本期收回）→ 现金 +31800
    //         计提工资成本 12000（贷 2211）→ 随即支付 → 现金 −12000
    //         管理费用 2000（现金支付，不含折旧 1000）+ 折旧 1000（非付现，借 660204）
    //         赊购设备 12000（借 1601 / 贷 2202）→ 随即付清 → 现金 −12000
    //   期末现金 = 20000 + 40000 + 31800 - 12000 - 2000 - 2800 = 65000
    const ctx = context({
      '6001': { creditOccur: 30000 },
      '6051': { creditOccur: 0 },
      '6301': { creditOccur: 0 },
      '6401': { debitOccur: 12000 },
      '6402': { debitOccur: 0 },
      '6403': { debitOccur: 0 },
      '6601': { debitOccur: 0 },
      '6602': { debitOccur: 2000 },
      '6603': { debitOccur: 0 },
      '6701': { debitOccur: 0 },
      '6711': { debitOccur: 0 },
      '6801': { debitOccur: 0 },
      '660204': { debitOccur: 1000 },
      '1602': { openingCredit: 0, creditOccur: 1000, closingCredit: 1000 },
      '1122': {
        openingDebit: 0,
        debitOccur: 31800,
        creditOccur: 31800,
        closingDebit: 0,
      },
      '1403': { openingDebit: 0, closingDebit: 0 },
      // 应付账款：贷 12000（赊购设备）后借 12000（付清）→ 期末 0
      '2202': {
        openingCredit: 0,
        debitOccur: 12000,
        creditOccur: 12000,
        closingCredit: 0,
      },
      '2203': { openingCredit: 0, closingCredit: 0 },
      // 应付职工薪酬：贷 12000 计提后借 12000 支付 → 期末 0
      '2211': {
        openingCredit: 0,
        debitOccur: 12000,
        creditOccur: 12000,
        closingCredit: 0,
      },
      // 固定资产：期初 60000 + 本期购建 12000 = 72000
      '1601': { openingDebit: 60000, debitOccur: 12000, closingDebit: 72000 },
      // 实收资本：期初 80000 + 本期增资 40000 = 120000
      '4001': { openingCredit: 80000, creditOccur: 40000, closingCredit: 120000 },
      // 本年利润：净利润 17000 = 收入 30000 − 成本 12000 − 管理费用 2000 + 折旧 1000（660204）
      '4103': { openingCredit: 0, creditOccur: 17000, closingCredit: 17000 },
      '1001': { openingDebit: 20000, closingDebit: 66000 },
      '1002': { openingDebit: 0, closingDebit: 0 },
    });
    const values = evaluateTemplate(rows, ctx);
    // 净利润 = 30000 - 12000 - 2000 = 16000（6602 余额 2000）
    expect(values.get('01')).toBe(16000);
    // 折旧行 = 660204(1000) + 1602 贷方发生额(1000) = 2000
    expect(values.get('02')).toBe(2000);
    // 经营净额 = 16000 + 2000 + 0 + 0 + 0 = 18000（应收/应付/薪酬期末均无净变动）
    expect(values.get('07')).toBe(18000);
    // 投资活动 = −12000（购建固定资产）；筹资活动 = 实收资本增加 40000
    expect(values.get('09')).toBe(-12000);
    expect(values.get('11')).toBe(40000);
    const netIncrease = values.get('12') ?? 0;
    expect(netIncrease).toBe(46000);
    expect(values.get('13')).toBe(20000);
    expect(values.get('14')).toBe(66000);
    // 会计恒等式：期初 + 净增加 = 期末
    expect((values.get('13') ?? 0) + netIncrease).toBe(values.get('14'));

    // 同一套数据下的资产负债表也必须左右恒等，且货币资金与现金流量表期末一致
    const bsRows = templates.filter((row) => row.reportCode === 'balance_sheet');
    const bsValues = evaluateTemplate(bsRows, ctx);
    expect(bsValues.get('10')).toBe(bsValues.get('22'));
    expect(bsValues.get('1')).toBe(values.get('14'));
  });
});
