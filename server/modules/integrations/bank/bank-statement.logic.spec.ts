/**
 * C-02 银行流水导入与匹配规则单测（纯逻辑，无数据库）。
 * 断言为真实数值：金额、匹配得分、匹配率。
 */
import {
  MATCH_AMOUNT_SCORE,
  MATCH_DATE_WINDOW_DAYS,
  MATCH_MIN_SCORE,
  MATCH_TEXT_SCORE,
  bestMatch,
  buildDedupeKey,
  computeMatchRate,
  dateDiffDays,
  parseAmount,
  parseDirection,
  parseStatementRows,
  parseTradeDate,
  scoreMatch,
  type MatchCandidate,
  type RawStatementRow,
} from './bank-statement.logic';
import { parseCsv } from './bank-import.parser';

const MAPPING = {
  transactionDate: '交易日期',
  direction: '借贷标志',
  amount: '发生额',
  balance: '余额',
  counterpartyName: '对方户名',
  counterpartyAccount: '对方账号',
  summary: '摘要',
  transactionNo: '交易流水号',
};

function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    bizType: 'receipt',
    bizId: '11111111-1111-1111-1111-111111111111',
    bizCode: 'RCV2026100001',
    amount: 12_345.67,
    date: '2026-10-10',
    texts: ['RCV2026100001', '测试客户甲'],
    ...overrides,
  };
}

describe('C-02 金额/日期/方向解析', () => {
  it('金额解析：千分位、货币符号、括号负数、尾随负号', () => {
    expect(parseAmount('12345.67')).toBe(12345.67);
    expect(parseAmount('￥12,345.67')).toBe(12345.67);
    expect(parseAmount('1，234.50')).toBe(1234.5);
    expect(parseAmount('(1,000.00)')).toBe(-1000);
    expect(parseAmount('1000.00-')).toBe(-1000);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });

  it('日期解析：多种银行格式与 Excel 序列号', () => {
    expect(parseTradeDate('2026-10-15')).toBe('2026-10-15');
    expect(parseTradeDate('2026/10/5')).toBe('2026-10-05');
    expect(parseTradeDate('20261015')).toBe('2026-10-15');
    expect(parseTradeDate('2026年10月15日')).toBe('2026-10-15');
    // Excel 序列号（1900 日期系统）：序列号 2 = 1900-01-01，之后按整数天平移。
    // 这里用公式反推 2026-10-15 的序列号，避免硬编码错误。
    const serial = (Date.UTC(2026, 9, 15) - Date.UTC(1900, 0, 1)) / 86_400_000 + 2;
    expect(serial).toBe(46310);
    expect(parseTradeDate(String(serial))).toBe('2026-10-15');
    // 交叉验证：Excel 序列号 45000 = 2023-03-15
    expect(parseTradeDate('45000')).toBe('2023-03-15');
    expect(parseTradeDate('2')).toBeNull(); // 超出合理区间，按普通数字处理
    expect(parseTradeDate('2026-13-01')).toBeNull();
  });

  it('方向解析：关键词优先，单金额列按正负兜底', () => {
    expect(parseDirection('收入', 100)).toBe('income');
    expect(parseDirection('支出', 100)).toBe('expense');
    expect(parseDirection('贷', 100)).toBe('income');
    expect(parseDirection('借', 100)).toBe('expense');
    expect(parseDirection('', 100)).toBe('income');
    expect(parseDirection('', -100)).toBe('expense');
    expect(parseDirection('', 0)).toBe('income');
    // 自定义关键词
    expect(
      parseDirection('C', 100, { creditKeywords: 'C', debitKeywords: 'D' })
    ).toBe('income');
  });
});

describe('C-02 去重键', () => {
  it('有交易流水号时直接用流水号', () => {
    expect(
      buildDedupeKey({
        transactionNo: 'NO-2026-0001',
        transactionDate: '2026-10-15',
        direction: 'income',
        amount: 100,
        counterpartyName: '甲',
        summary: '收款',
      })
    ).toBe('NO:NO-2026-0001');
  });

  it('无流水号时按业务指纹，且对空白差异不敏感（同一指纹）', () => {
    const left = buildDedupeKey({
      transactionNo: null,
      transactionDate: '2026-10-15',
      direction: 'income',
      amount: 100,
      counterpartyName: '甲 公司',
      summary: '收 款',
    });
    const right = buildDedupeKey({
      transactionNo: '',
      transactionDate: '2026-10-15',
      direction: 'income',
      amount: 100,
      counterpartyName: '甲公司',
      summary: '收款',
    });
    expect(left).toBe(right);
    expect(left.startsWith('FP:')).toBe(true);
  });

  it('金额或日期不同则指纹不同', () => {
    const base = {
      transactionNo: null,
      direction: 'income' as const,
      counterpartyName: '甲',
      summary: '收款',
    };
    expect(
      buildDedupeKey({ ...base, transactionDate: '2026-10-15', amount: 100 })
    ).not.toBe(
      buildDedupeKey({ ...base, transactionDate: '2026-10-16', amount: 100 })
    );
    expect(
      buildDedupeKey({ ...base, transactionDate: '2026-10-15', amount: 100 })
    ).not.toBe(
      buildDedupeKey({ ...base, transactionDate: '2026-10-15', amount: 100.01 })
    );
  });
});

describe('C-02 逐行解析与文件内去重', () => {
  const rows: RawStatementRow[] = [
    {
      row: 1,
      values: {
        交易日期: '2026-10-10',
        借贷标志: '收入',
        发生额: '12,345.67',
        余额: '100,000.00',
        对方户名: '测试客户甲',
        对方账号: '6222000011112222',
        摘要: '合同款 RCV2026100001',
        交易流水号: 'NO-1',
      },
    },
    {
      row: 2,
      // 与第 1 行同一流水号 → 文件内重复
      values: { 交易日期: '2026-10-10', 借贷标志: '收入', 发生额: '12345.67', 交易流水号: 'NO-1' },
    },
    {
      row: 3,
      values: { 交易日期: '非法日期', 借贷标志: '支出', 发生额: '100' },
    },
    {
      row: 4,
      values: { 交易日期: '2026-10-11', 借贷标志: '支出', 发生额: '0' },
    },
    {
      row: 5,
      values: { 交易日期: '2026-10-12', 借贷标志: '支出', 发生额: '-500.00' },
    },
  ];

  it('解析结果与错误清单符合预期', () => {
    const result = parseStatementRows(rows, MAPPING);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      row: 1,
      transactionDate: '2026-10-10',
      direction: 'income',
      amount: 12345.67,
      balance: 100000,
      counterpartyName: '测试客户甲',
      transactionNo: 'NO-1',
      dedupeKey: 'NO:NO-1',
    });
    // 负数额 + 支出标志：方向取支出，金额取绝对值
    expect(result.rows[1]).toMatchObject({
      row: 5,
      direction: 'expense',
      amount: 500,
      balance: null,
    });
    expect(result.errors.map((item) => item.row)).toEqual([2, 3, 4]);
    expect(result.errors[0].reason).toContain('文件内重复行');
    expect(result.errors[1].reason).toContain('交易日期无法识别');
    expect(result.errors[2].reason).toContain('金额为 0');
  });

  it('缺交易流水号列时用业务指纹（列名不配置也不报错）', () => {
    const result = parseStatementRows(
      [
        {
          row: 1,
          values: { 交易日期: '2026-10-10', 发生额: '100', 摘要: '收款' },
        },
      ],
      { transactionDate: '交易日期', amount: '发生额', summary: '摘要' }
    );
    expect(result.rows[0].dedupeKey.startsWith('FP:')).toBe(true);
    expect(result.rows[0].direction).toBe('income');
  });
});

describe('C-02 自动匹配规则', () => {
  it('金额相同 + 日期在 ±3 天内 → 命中且得分 ≥ 60', () => {
    const evaluation = scoreMatch(
      {
        amount: 12_345.67,
        transactionDate: '2026-10-12',
        texts: ['合同款 RCV2026100001'],
      },
      candidate()
    );
    expect(evaluation.amountEqual).toBe(true);
    expect(evaluation.dateDiffDays).toBe(2);
    expect(evaluation.textHit).toBe(true);
    // 50（金额）+ 30-2*6.67=16.66（日期）+ 20（文本）= 86.66
    expect(evaluation.score).toBeCloseTo(86.66, 2);
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.score).toBeGreaterThanOrEqual(MATCH_MIN_SCORE);
  });

  it('金额容差：分位对齐后完全相等才算相同（0.01 元即视为不同）', () => {
    expect(
      scoreMatch(
        { amount: 12_345.67, transactionDate: '2026-10-10', texts: [] },
        candidate()
      ).amountEqual
    ).toBe(true);
    expect(
      scoreMatch(
        { amount: 12_345.668, transactionDate: '2026-10-10', texts: [] },
        candidate()
      ).amountEqual
    ).toBe(true);
    // 差 1 分 → 不允许自动匹配（避免把两笔近似金额错配，需人工确认）
    expect(
      scoreMatch(
        { amount: 12_345.68, transactionDate: '2026-10-10', texts: [] },
        candidate()
      ).amountEqual
    ).toBe(false);
    expect(
      scoreMatch(
        { amount: 12_345.7, transactionDate: '2026-10-10', texts: [] },
        candidate()
      ).amountEqual
    ).toBe(false);
  });

  it('金额相同但日期超出 ±3 天 → 不可自动匹配', () => {
    const evaluation = scoreMatch(
      { amount: 12_345.67, transactionDate: '2026-10-20', texts: ['RCV2026100001'] },
      candidate()
    );
    expect(evaluation.amountEqual).toBe(true);
    expect(evaluation.dateDiffDays).toBe(10);
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.score).toBe(MATCH_AMOUNT_SCORE + MATCH_TEXT_SCORE);
  });

  it('日期边界：恰好 3 天内可匹配，第 4 天不可', () => {
    expect(MATCH_DATE_WINDOW_DAYS).toBe(3);
    expect(dateDiffDays('2026-10-10', '2026-10-13')).toBe(3);
    expect(
      scoreMatch(
        { amount: 12_345.67, transactionDate: '2026-10-13', texts: [] },
        candidate()
      ).eligible
    ).toBe(true);
    expect(
      scoreMatch(
        { amount: 12_345.67, transactionDate: '2026-10-14', texts: [] },
        candidate()
      ).eligible
    ).toBe(false);
  });

  it('bestMatch：文本命中优先，其次日期更近，最后单号字典序', () => {
    const sameScoreFar = candidate({
      bizId: '22222222-2222-2222-2222-222222222222',
      bizCode: 'RCV2026100002',
      date: '2026-10-13',
      texts: ['RCV2026100002'],
    });
    const winner = bestMatch(
      { amount: 12_345.67, transactionDate: '2026-10-10', texts: ['RCV2026100001'] },
      [sameScoreFar, candidate()]
    );
    expect(winner?.candidate.bizCode).toBe('RCV2026100001');
  });

  it('bestMatch：无候选或都不满足硬条件时返回 null', () => {
    expect(
      bestMatch({ amount: 1, transactionDate: '2026-10-10', texts: [] }, [candidate()])
    ).toBeNull();
    expect(
      bestMatch({ amount: 12_345.67, transactionDate: '2026-10-10', texts: [] }, [])
    ).toBeNull();
  });

  it('匹配率 = matched / (total − ignored)，分母为 0 时为 0', () => {
    expect(computeMatchRate(10, 7, 0)).toBe(0.7);
    expect(computeMatchRate(10, 7, 2)).toBe(0.88);
    expect(computeMatchRate(0, 0, 0)).toBe(0);
    expect(computeMatchRate(3, 0, 3)).toBe(0);
  });
});

describe('C-02 CSV 解析（自实现，无新依赖）', () => {
  it('自动嗅探分隔符并处理引号包裹与转义', () => {
    const csv = [
      '交易日期,借贷标志,发生额,摘要',
      '2026-10-10,收入,12345.67,"合同款, 第一期"',
      '2026-10-11,支出,500.00,"备注 ""含引号"""',
    ].join('\n');
    const table = parseCsv(csv);
    expect(table.headers).toEqual(['交易日期', '借贷标志', '发生额', '摘要']);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].values['摘要']).toBe('合同款, 第一期');
    expect(table.rows[1].values['摘要']).toBe('备注 "含引号"');
  });

  it('支持分号分隔与 BOM，空行被忽略', () => {
    const csv = '\uFEFF交易日期;发生额\n2026-10-10;100\n\n';
    const table = parseCsv(csv);
    expect(table.headers).toEqual(['交易日期', '发生额']);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].values['发生额']).toBe('100');
  });

  it('无表头时生成占位列名', () => {
    const table = parseCsv('2026-10-10,100,收款', { hasHeader: false });
    expect(table.headers).toEqual(['列1', '列2', '列3']);
    expect(table.rows[0].values['列1']).toBe('2026-10-10');
  });
});
