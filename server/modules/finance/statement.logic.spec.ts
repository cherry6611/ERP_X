/**
 * C-11 对账单纯逻辑单测（无 DB）。
 *
 * 重点钉住的是**最容易算错又最贵**的四件事：
 *   ① 期初 = 期间开始日之前的发生额净额（不是全部历史的合计）；
 *   ② 期间边界：期间开始日当天算本期，次月 1 日算下期；
 *   ③ 作废单据整单剔除（期初、本期都不计）；
 *   ④ `closing = opening + periodDebit − periodCredit` 在 2 位小数口径下**精确**成立。
 */
import { toRmbUpper } from '@server/common/utils/rmb-upper';
import {
  compareTxn,
  computeStatement,
  resolveStatementPeriod,
  roundAmount,
  sameAmount,
  statementAmountInWords,
  statementReconStatus,
  statementSortKey,
  toStatementDocAmount,
  type StatementTxn,
} from './statement.logic';

/** 构造一条发生额（默认参与余额、未核销） */
function txn(overrides: Partial<StatementTxn> = {}): StatementTxn {
  const docType = overrides.docType ?? 'ar';
  return {
    date: '2026-10-10',
    docType,
    docCode: 'ARR2026100001',
    debit: 0,
    credit: 0,
    affectsBalance: true,
    status: 'open',
    voided: false,
    relatedDocCode: null,
    remark: null,
    sortKey: statementSortKey(docType),
    ...overrides,
  };
}

describe('C-11 期间解析', () => {
  it('YYYY-MM → 左闭右开区间与月末', () => {
    expect(resolveStatementPeriod('2026-10')).toEqual({
      start: '2026-10-01',
      end: '2026-11-01',
      monthEnd: '2026-10-31',
    });
    expect(resolveStatementPeriod('2026-02')).toEqual({
      start: '2026-02-01',
      end: '2026-03-01',
      monthEnd: '2026-02-28',
    });
    // 闰年 2 月
    expect(resolveStatementPeriod('2028-02').monthEnd).toBe('2028-02-29');
    // 12 月跨年
    expect(resolveStatementPeriod('2026-12')).toEqual({
      start: '2026-12-01',
      end: '2027-01-01',
      monthEnd: '2026-12-31',
    });
  });

  it('非法期间抛错', () => {
    expect(() => resolveStatementPeriod('2026-13')).toThrow(RangeError);
    expect(() => resolveStatementPeriod('202610')).toThrow(RangeError);
    expect(() => resolveStatementPeriod('')).toThrow(RangeError);
  });
});

describe('C-11 期初余额口径', () => {
  it('期初 = 期间开始日之前的发生额净额，不含本期', () => {
    const result = computeStatement('customer', '2026-10', [
      // 9 月：应收 1000，回款 400 → 期初 600
      txn({ date: '2026-09-05', debit: 1000, docCode: 'ARR2026090001' }),
      txn({
        date: '2026-09-20',
        docType: 'receipt',
        docCode: 'RCV2026090001',
        credit: 400,
      }),
      // 10 月：应收 300 → 期末 900，绝不能被算进期初
      txn({ date: '2026-10-08', debit: 300, docCode: 'ARR2026100002' }),
    ]);

    expect(result.openingBalance).toBe(600);
    expect(result.periodDebit).toBe(300);
    expect(result.periodCredit).toBe(0);
    expect(result.closingBalance).toBe(900);
    expect(result.openingLines).toHaveLength(2);
    expect(result.lines).toHaveLength(1);
    // 期初构成行的运行余额为空（它们不属于本期序列）
    expect(result.openingLines[0].runningBalance).toBeNull();
  });

  it('期初不是"全部历史合计"：本期发生额必须从期初里排除', () => {
    const all = [
      txn({ date: '2026-08-01', debit: 500, docCode: 'ARR2026080001' }),
      txn({ date: '2026-10-01', debit: 700, docCode: 'ARR2026100003' }),
    ];
    const result = computeStatement('customer', '2026-10', all);
    const historyTotal = 500 + 700;
    expect(result.openingBalance).toBe(500);
    expect(result.openingBalance).not.toBe(historyTotal);
    expect(result.closingBalance).toBe(historyTotal);
  });

  it('供应商方向：应付为借（增加），付款为贷（减少）', () => {
    const result = computeStatement('supplier', '2026-10', [
      txn({
        date: '2026-09-15',
        docType: 'ap',
        docCode: 'APB2026090001',
        debit: 2000,
      }),
      txn({
        date: '2026-10-12',
        docType: 'payment',
        docCode: 'PAY2026100001',
        credit: 500,
      }),
    ]);
    expect(result.openingBalance).toBe(2000);
    expect(result.periodCredit).toBe(500);
    expect(result.closingBalance).toBe(1500);
  });
});

describe('C-11 运行余额序列', () => {
  it('按日期滚动，逐行等于累计借贷差', () => {
    const result = computeStatement('customer', '2026-10', [
      txn({ date: '2026-09-30', debit: 1000, docCode: 'ARR2026090009' }),
      txn({ date: '2026-10-05', debit: 200, docCode: 'ARR2026100010' }),
      txn({
        date: '2026-10-15',
        docType: 'receipt',
        docCode: 'RCV2026100010',
        credit: 300,
      }),
      txn({ date: '2026-10-20', debit: 50, docCode: 'ARR2026100011' }),
    ]);

    expect(result.lines.map((line) => line.runningBalance)).toEqual([
      1200, 900, 950,
    ]);
    expect(result.closingBalance).toBe(950);
  });

  it('同日按 应收 → 回款 → 发票 排序，余额序列可复现', () => {
    const result = computeStatement('customer', '2026-10', [
      txn({
        date: '2026-10-10',
        docType: 'invoice',
        docCode: 'INV2026100003',
        affectsBalance: false,
        status: 'informational',
        debit: 660,
      }),
      txn({
        date: '2026-10-10',
        docType: 'receipt',
        docCode: 'RCV2026100011',
        credit: 100,
      }),
      txn({ date: '2026-10-10', docCode: 'ARR2026100012', debit: 500 }),
    ]);

    expect(result.lines.map((line) => line.docType)).toEqual([
      'ar',
      'receipt',
      'invoice',
    ]);
    // 备查行不滚余额
    expect(result.lines[2].runningBalance).toBeNull();
    expect(result.closingBalance).toBe(400);
  });

  it('compareTxn 对同日期同类型的单号做稳定排序', () => {
    const rows = [
      txn({ docCode: 'ARR2026100003' }),
      txn({ docCode: 'ARR2026100001' }),
      txn({ docCode: 'ARR2026100002' }),
    ];
    expect([...rows].sort(compareTxn).map((row) => row.docCode)).toEqual([
      'ARR2026100001',
      'ARR2026100002',
      'ARR2026100003',
    ]);
  });
});

describe('C-11 期间边界（左闭右开）', () => {
  it('期间开始日当天的单据算本期，不重不漏', () => {
    const result = computeStatement('customer', '2026-10', [
      // 9 月最后一天 → 期初
      txn({ date: '2026-09-30', debit: 111, docCode: 'ARR2026090100' }),
      // 10 月 1 日 00:00 = 期间开始 → 本期
      txn({ date: '2026-10-01', debit: 222, docCode: 'ARR2026100100' }),
    ]);
    expect(result.openingBalance).toBe(111);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].date).toBe('2026-10-01');
    expect(result.lines[0].runningBalance).toBe(333);
  });

  it('期间最后一天算本期，次月 1 日算下期', () => {
    const result = computeStatement('customer', '2026-10', [
      txn({ date: '2026-10-31', debit: 100, docCode: 'ARR2026103100' }),
      // 11-01 属于下期：本期既不进期初也不进本期
      txn({ date: '2026-11-01', debit: 999, docCode: 'ARR2026110100' }),
    ]);
    expect(result.periodDebit).toBe(100);
    expect(result.closingBalance).toBe(100);
    expect(result.openingBalance).toBe(0);
    expect(result.lines).toHaveLength(1);
  });

  it('连续两个月对账单首尾相接：上月期末 = 下月期初', () => {
    const all = [
      txn({ date: '2026-09-10', debit: 800, docCode: 'ARR2026091000' }),
      txn({
        date: '2026-10-20',
        docType: 'receipt',
        docCode: 'RCV2026102000',
        credit: 300,
      }),
    ];
    const october = computeStatement('customer', '2026-10', all);
    const november = computeStatement('customer', '2026-11', all);
    expect(october.openingBalance).toBe(800);
    expect(october.closingBalance).toBe(500);
    expect(november.openingBalance).toBe(500);
    expect(november.closingBalance).toBe(500);
  });
});

describe('C-11 作废单据与备查行', () => {
  it('本期作废单整单剔除，金额与核对进度都不计', () => {
    const result = computeStatement('customer', '2026-10', [
      txn({ date: '2026-10-05', debit: 1000, docCode: 'ARR2026100500' }),
      txn({
        date: '2026-10-06',
        docType: 'receipt',
        docCode: 'RCV2026100600',
        credit: 250,
        voided: true,
        status: 'voided',
      }),
    ]);
    expect(result.periodCredit).toBe(0);
    expect(result.closingBalance).toBe(1000);
    expect(result.lines).toHaveLength(1);
    expect(result.excludedLines.map((row) => row.docCode)).toEqual([
      'RCV2026100600',
    ]);
    expect(result.reconSummary.voidedExcluded).toBe(1);
  });

  it('期初之前的作废单不进期初，也不出现在"已剔除"里', () => {
    const result = computeStatement('customer', '2026-10', [
      txn({ date: '2026-09-01', debit: 500, docCode: 'ARR2026090100' }),
      txn({
        date: '2026-09-02',
        docType: 'receipt',
        docCode: 'RCV2026090200',
        credit: 500,
        voided: true,
        status: 'voided',
      }),
    ]);
    expect(result.openingBalance).toBe(500);
    expect(result.excludedLines).toHaveLength(0);
    expect(result.reconSummary.voidedExcluded).toBe(0);
  });

  it('发票为备查行：展示但不参与期初/期末与核对进度', () => {
    const result = computeStatement('customer', '2026-10', [
      txn({ date: '2026-09-01', debit: 1000, docCode: 'ARR2026090100' }),
      txn({
        date: '2026-10-08',
        docType: 'invoice',
        docCode: 'INV2026100800',
        affectsBalance: false,
        status: 'informational',
        debit: 1060,
      }),
    ]);
    expect(result.openingBalance).toBe(1000);
    expect(result.periodDebit).toBe(0);
    expect(result.closingBalance).toBe(1000);
    expect(result.lines).toHaveLength(1);
    expect(result.reconSummary.reconciled).toBe(0);
    expect(result.reconSummary.open).toBe(0);
  });
});

describe('C-11 恒等式与取整', () => {
  it('closing = opening + periodDebit − periodCredit（含分位小数）', () => {
    const result = computeStatement('customer', '2026-10', [
      txn({ date: '2026-09-11', debit: 1234.56, docCode: 'ARR2026091100' }),
      txn({ date: '2026-10-11', debit: 0.07, docCode: 'ARR2026101100' }),
      txn({
        date: '2026-10-12',
        docType: 'receipt',
        docCode: 'RCV2026101200',
        credit: 333.33,
      }),
    ]);
    expect(result.openingBalance).toBe(1234.56);
    expect(result.periodDebit).toBe(0.07);
    expect(result.periodCredit).toBe(333.33);
    expect(
      roundAmount(
        result.openingBalance + result.periodDebit - result.periodCredit
      )
    ).toBe(result.closingBalance);
    expect(result.closingBalance).toBe(901.3);
    // 最后一行运行余额必须等于期末
    expect(result.lines[result.lines.length - 1].runningBalance).toBe(
      result.closingBalance
    );
  });

  it('逐行运行余额的差分等于该行借贷净额', () => {
    const result = computeStatement('supplier', '2026-10', [
      txn({
        date: '2026-09-01',
        docType: 'ap',
        docCode: 'APB2026090100',
        debit: 10000.01,
      }),
      txn({
        date: '2026-10-02',
        docType: 'ap',
        docCode: 'APB2026100200',
        debit: 0.02,
      }),
      txn({
        date: '2026-10-03',
        docType: 'payment',
        docCode: 'PAY2026100300',
        credit: 0.01,
      }),
      txn({
        date: '2026-10-04',
        docType: 'payment',
        docCode: 'PAY2026100400',
        credit: 5000,
      }),
    ]);
    let previous = result.openingBalance;
    for (const line of result.lines) {
      const expected = roundAmount(
        previous + line.debit - line.credit
      );
      expect(line.runningBalance).toBe(expected);
      previous = expected;
    }
    expect(previous).toBe(result.closingBalance);
  });

  it('roundAmount / sameAmount 走分比较，规避浮点误差', () => {
    expect(roundAmount(0.1 + 0.2)).toBe(0.3);
    // 仓库口径是裸 `Math.round(x * 100) / 100`（不做 EPSILON 补偿），
    // 因此 IEEE754 恰好略小于半分的值会向下取整：1.005→1、1.015→1.01。
    // 这两个断言把该口径**写死**，避免有人"顺手"改成其他舍入方式而悄悄改变对账单金额。
    expect(roundAmount(1.005)).toBe(1);
    expect(roundAmount(1.015)).toBe(1.01);
    // 正常半分（如 2.675、1.025）仍按四舍五入进位
    expect(roundAmount(2.675)).toBe(2.68);
    expect(roundAmount(1.025)).toBe(1.02);
    expect(sameAmount(0.1 + 0.2, 0.3)).toBe(true);
    // 经典反例：0.1+0.2 === 0.3 为 false，分比较必须为 true
    expect(0.1 + 0.2 === 0.3).toBe(false);
  });

  it('借贷方向换算与排序位', () => {
    expect(toStatementDocAmount('customer', 'increase', -100)).toEqual({
      debit: 100,
      credit: 0,
    });
    expect(toStatementDocAmount('supplier', 'decrease', 100)).toEqual({
      debit: 0,
      credit: 100,
    });
    expect(statementSortKey('ar')).toBeLessThan(statementSortKey('receipt'));
    expect(statementSortKey('receipt')).toBeLessThan(
      statementSortKey('invoice')
    );
  });
});

describe('C-11 零发生额与核对状态', () => {
  it('对手方本期与历史都无单据：全零且不抛错', () => {
    const result = computeStatement('customer', '2026-10', []);
    expect(result.openingBalance).toBe(0);
    expect(result.periodDebit).toBe(0);
    expect(result.periodCredit).toBe(0);
    expect(result.closingBalance).toBe(0);
    expect(result.lines).toEqual([]);
    expect(result.openingLines).toEqual([]);
    expect(result.reconSummary).toEqual({
      reconciled: 0,
      partial: 0,
      open: 0,
      voidedExcluded: 0,
    });
  });

  it('只有备查行时余额仍为 0（不能因为发票金额而虚增）', () => {
    const result = computeStatement('customer', '2026-10', [
      txn({
        date: '2026-10-09',
        docType: 'invoice',
        docCode: 'INV2026100900',
        affectsBalance: false,
        status: 'informational',
        debit: 9999,
      }),
    ]);
    expect(result.closingBalance).toBe(0);
    expect(result.lines).toHaveLength(1);
  });

  it('核对状态：结清/部分/未核销/作废/备查', () => {
    expect(statementReconStatus({ amount: 100, settled: 100 })).toBe(
      'reconciled'
    );
    expect(statementReconStatus({ amount: 100, settled: 40 })).toBe('partial');
    expect(statementReconStatus({ amount: 100, settled: 0 })).toBe('open');
    expect(statementReconStatus({ amount: 100, voided: true })).toBe('voided');
    expect(statementReconStatus({ amount: 100, informational: true })).toBe(
      'informational'
    );
    // 分位误差不应把"已结清"误判成"部分核销"
    expect(statementReconStatus({ amount: 100, settled: 99.999 })).toBe(
      'reconciled'
    );
    expect(statementReconStatus({ amount: 100, settled: 99.99 })).toBe(
      'partial'
    );
    // 脏数据兜底
    expect(statementReconStatus({ amount: 0, settled: 0 })).toBe('open');
    expect(statementReconStatus({ amount: 0, settled: 5 })).toBe('partial');
  });

  it('核对进度按本期参与余额的单据计数', () => {
    const result = computeStatement('customer', '2026-10', [
      txn({ date: '2026-10-01', debit: 100, status: 'open' }),
      txn({
        date: '2026-10-02',
        debit: 200,
        docCode: 'ARR2026100002',
        status: 'partial',
      }),
      txn({
        date: '2026-10-03',
        debit: 300,
        docCode: 'ARR2026100003',
        status: 'reconciled',
      }),
      txn({
        date: '2026-10-04',
        docType: 'receipt',
        docCode: 'RCV2026100004',
        credit: 100,
        status: 'reconciled',
      }),
      // 期初的未核销单不计入本期进度
      txn({ date: '2026-09-01', debit: 900, docCode: 'ARR2026090001' }),
    ]);
    expect(result.reconSummary).toEqual({
      reconciled: 2,
      partial: 1,
      open: 1,
      voidedExcluded: 0,
    });
  });
});

describe('C-11 打印金额大写', () => {
  it('期末余额转人民币大写（复用 toRmbUpper）', () => {
    expect(statementAmountInWords(901.3, toRmbUpper)).toBe(
      '玖佰零壹元叁角整'
    );
    expect(statementAmountInWords(0, toRmbUpper)).toBe('零元整');
    expect(statementAmountInWords(1234.56, toRmbUpper)).toBe(
      '壹仟贰佰叁拾肆元伍角陆分'
    );
  });
});
