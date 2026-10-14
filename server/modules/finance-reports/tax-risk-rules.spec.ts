import {
  DEFAULT_BURDEN_RATE_FLUCTUATION,
  DEFAULT_BURDEN_RATE_MAX,
  DEFAULT_BURDEN_RATE_MIN,
  DEFAULT_MISMATCH_TOLERANCE,
  DEFAULT_VOID_RATE_THRESHOLD,
  assessBurdenRate,
  assessInvoiceLedgerMismatch,
  scanInvoiceAnomalies,
  summarizeTaxRisks,
  type InvoiceRowForRisk,
} from './tax-risk-rules';

/**
 * D-06 税务风险扫描单测。
 *
 * 这组测试要钉住的核心不是"能算出数字"，而是**不该报的别报**：
 * 零收入月份、分位取整差异、作废率低位、正常留抵，都不应产生告警 ——
 * 否则风险清单会被噪音淹没，真问题反而被忽略。
 */
describe('D-06 税负率评估', () => {
  const base = {
    period: '2026-10',
    revenue: 1_000_000,
    outputTax: 60_000,
    inputTax: 30_000,
  };

  it('税负率 = 应交增值税 / 不含税收入 × 100', () => {
    const result = assessBurdenRate(base);
    expect(result.payableTax).toBe(30_000);
    expect(result.burdenRate).toBe(3); // 30000 / 1000000 = 3%
    expect(result.withinRange).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('默认参考区间为 1%~6%（需财务/税务确认）', () => {
    expect(DEFAULT_BURDEN_RATE_MIN).toBe(1);
    expect(DEFAULT_BURDEN_RATE_MAX).toBe(6);
  });

  it('税负率低于区间下限 → high，并给出三类排查方向', () => {
    const result = assessBurdenRate({
      ...base,
      outputTax: 20_000,
      inputTax: 10_000,
    });
    expect(result.burdenRate).toBe(1);
    const finding = result.findings.find((f) => f.code === 'burden.below_range');
    // 恰好等于下限不算低于
    expect(finding).toBeUndefined();

    const lower = assessBurdenRate({
      ...base,
      outputTax: 15_000,
      inputTax: 10_000,
    });
    expect(lower.burdenRate).toBe(0.5);
    const hit = lower.findings.find((f) => f.code === 'burden.below_range');
    expect(hit?.severity).toBe('high');
    expect(hit?.evidence).toContain('0.50%');
    expect(hit?.evidence).toContain('1%~6%');
    expect(hit?.suggestion).toContain('收入跨期');
  });

  it('税负率高于区间上限 → medium', () => {
    const result = assessBurdenRate({
      ...base,
      outputTax: 90_000,
      inputTax: 10_000,
    });
    expect(result.burdenRate).toBe(8);
    expect(result.withinRange).toBe(false);
    const hit = result.findings.find((f) => f.code === 'burden.above_range');
    expect(hit?.severity).toBe('medium');
    expect(hit?.suggestion).toContain('未取得合规发票');
  });

  it('留抵（进项 > 销项）单独归因，不与"税负率偏低"混为一谈', () => {
    const result = assessBurdenRate({
      ...base,
      outputTax: 10_000,
      inputTax: 50_000,
    });
    expect(result.payableTax).toBe(-40_000);
    expect(result.burdenRate).toBe(-4);
    const hit = result.findings.find((f) => f.code === 'burden.negative');
    expect(hit?.severity).toBe('medium');
    expect(hit?.evidence).toContain('-40000.00');
    // 不应同时报"低于区间"，否则同一件事被报两次
    expect(
      result.findings.find((f) => f.code === 'burden.below_range')
    ).toBeUndefined();
  });

  it('收入为 0 时不报"税负率偏低"（否则每月刷噪音）', () => {
    const result = assessBurdenRate({
      period: '2026-10',
      revenue: 0,
      outputTax: 0,
      inputTax: 0,
    });
    expect(result.burdenRate).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.withinRange).toBe(true);
  });

  it('收入为 0 但有进项 → low，提示确认抵扣时点', () => {
    const result = assessBurdenRate({
      period: '2026-10',
      revenue: 0,
      outputTax: 0,
      inputTax: 5_000,
    });
    const hit = result.findings.find(
      (f) => f.code === 'burden.no_revenue_with_input'
    );
    expect(hit?.severity).toBe('low');
    expect(hit?.amount).toBe(5_000);
  });

  it('环比波动超过阈值 → medium，边界内不报', () => {
    const within = assessBurdenRate({ ...base, previousBurdenRate: 2 });
    // 本期 3%，上期 2%，差 1 个百分点 < 默认阈值 3
    expect(
      within.findings.find((f) => f.code === 'burden.fluctuation')
    ).toBeUndefined();

    const jump = assessBurdenRate({ ...base, previousBurdenRate: 8 });
    const hit = jump.findings.find((f) => f.code === 'burden.fluctuation');
    expect(hit?.severity).toBe('medium');
    expect(hit?.evidence).toContain('-5.00 个百分点');
  });

  it('默认波动阈值为 3 个百分点，可覆盖', () => {
    expect(DEFAULT_BURDEN_RATE_FLUCTUATION).toBe(3);
    const result = assessBurdenRate({
      ...base,
      previousBurdenRate: 4,
      fluctuationThreshold: 0.5,
    });
    expect(
      result.findings.find((f) => f.code === 'burden.fluctuation')
    ).toBeDefined();
  });

  it('可覆盖参考区间（小规模纳税人适用更低区间）', () => {
    const result = assessBurdenRate({
      ...base,
      outputTax: 20_000,
      inputTax: 17_000,
      minRate: 0.1,
      maxRate: 1,
    });
    // 税负率 0.3%，落在 0.1%~1% 内
    expect(result.burdenRate).toBe(0.3);
    expect(result.withinRange).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('负数收入被夹到 0（不产生负税负率）', () => {
    const result = assessBurdenRate({ ...base, revenue: -100 });
    expect(result.revenue).toBe(0);
    expect(result.burdenRate).toBe(0);
  });
});

describe('D-06 进销项匹配', () => {
  const matched = {
    period: '2026-10',
    outputTaxFromInvoices: 60_000,
    inputTaxFromInvoices: 30_000,
    outputTaxFromLedger: 60_000,
    inputTaxFromLedger: 30_000,
    differences: [],
  };

  it('完全一致时不报任何风险', () => {
    const result = assessInvoiceLedgerMismatch(matched);
    expect(result.findings).toEqual([]);
    expect(result.maxDifference).toBe(0);
  });

  it('默认容差 1 元：分位取整差异不报（避免噪音）', () => {
    expect(DEFAULT_MISMATCH_TOLERANCE).toBe(1);
    const result = assessInvoiceLedgerMismatch({
      ...matched,
      outputTaxFromInvoices: 60_000.5,
      outputTaxFromLedger: 60_000,
    });
    expect(result.findings).toEqual([]);
  });

  it('销项差异超过 1 万 → high；小于 1 万 → medium', () => {
    const small = assessInvoiceLedgerMismatch({
      ...matched,
      outputTaxFromInvoices: 60_500,
    });
    expect(
      small.findings.find((f) => f.code === 'mismatch.output_tax')?.severity
    ).toBe('medium');

    const big = assessInvoiceLedgerMismatch({
      ...matched,
      outputTaxFromInvoices: 80_000,
    });
    const hit = big.findings.find((f) => f.code === 'mismatch.output_tax');
    expect(hit?.severity).toBe('high');
    expect(hit?.evidence).toContain('20000.00');
  });

  it('进项差异单独报，并提示"未认证的进项不得在本期申报"', () => {
    const result = assessInvoiceLedgerMismatch({
      ...matched,
      inputTaxFromInvoices: 25_000,
    });
    const hit = result.findings.find((f) => f.code === 'mismatch.input_tax');
    expect(hit).toBeDefined();
    expect(hit?.suggestion).toContain('未认证');
  });

  it('有销项无进项 → medium', () => {
    const result = assessInvoiceLedgerMismatch({
      ...matched,
      inputTaxFromInvoices: 0,
      inputTaxFromLedger: 0,
    });
    expect(
      result.findings.find((f) => f.code === 'mismatch.no_input')?.severity
    ).toBe('medium');
  });

  it('进项超过销项 3 倍以上 → low（集中采购期属正常，故不升级）', () => {
    const result = assessInvoiceLedgerMismatch({
      ...matched,
      outputTaxFromInvoices: 10_000,
      outputTaxFromLedger: 10_000,
      inputTaxFromInvoices: 50_000,
      inputTaxFromLedger: 50_000,
    });
    const hit = result.findings.find(
      (f) => f.code === 'mismatch.input_far_exceeds_output'
    );
    expect(hit?.severity).toBe('low');
    expect(hit?.evidence).toContain('5.00');
  });

  it('底稿差异项逐条转为风险项', () => {
    const result = assessInvoiceLedgerMismatch({
      ...matched,
      differences: [
        { code: 'D1', label: '已开票未确认收入', amount: 500 },
        { code: 'D2', label: '小额尾差', amount: 0.5 },
      ],
    });
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain('mismatch.detail.D1');
    // 容差内的差异项不报
    expect(codes).not.toContain('mismatch.detail.D2');
  });

  it('maxDifference 取销项与进项差异的较大值', () => {
    const result = assessInvoiceLedgerMismatch({
      ...matched,
      outputTaxFromInvoices: 60_100,
      inputTaxFromInvoices: 25_000,
    });
    expect(result.maxDifference).toBe(round2(5_000));
  });

  function round2(v: number): number {
    return Math.round(v * 100) / 100;
  }
});

describe('D-06 发票异常扫描', () => {
  const rows: InvoiceRowForRisk[] = [
    {
      id: '1',
      code: 'INV0001',
      invoiceNo: '00000001',
      direction: 'sales',
      amount: 10_600,
      status: 'issued',
      linkedId: 'ar-1',
      invoiceDate: '2026-10-05',
    },
    {
      id: '2',
      code: 'INV0002',
      invoiceNo: '00000002',
      direction: 'sales',
      amount: 21_200,
      status: 'issued',
      linkedId: 'ar-2',
      invoiceDate: '2026-10-12',
    },
    {
      id: '3',
      code: 'INV0003',
      invoiceNo: '00000003',
      direction: 'sales',
      amount: 5_300,
      status: 'issued',
      linkedId: 'ar-3',
      invoiceDate: '2026-10-20',
    },
  ];

  it('正常发票不报任何风险', () => {
    expect(scanInvoiceAnomalies(rows, { period: '2026-10' })).toEqual([]);
  });

  it('空集合不报错也不报风险', () => {
    expect(scanInvoiceAnomalies([], { period: '2026-10' })).toEqual([]);
  });

  it('发票号重复 → high（同一张票不能抵扣两次）', () => {
    const withDup = [
      ...rows,
      {
        id: '4',
        code: 'INV0004',
        invoiceNo: '00000002',
        direction: 'sales',
        amount: 1_000,
        status: 'issued',
        linkedId: 'ar-4',
        invoiceDate: '2026-10-25',
      },
    ];
    const findings = scanInvoiceAnomalies(withDup, { period: '2026-10' });
    const hit = findings.find((f) => f.category === 'invoice_anomaly' && f.severity === 'high');
    expect(hit?.title).toContain('00000002');
    expect(hit?.evidence).toContain('INV0002');
    expect(hit?.evidence).toContain('INV0004');
  });

  it('票号跳号 → low，且每次只报第一处（不刷屏）', () => {
    const gapped = [
      { ...rows[0], invoiceNo: '00000001' },
      { ...rows[1], invoiceNo: '00000005' },
      { ...rows[2], invoiceNo: '00000009' },
    ];
    const findings = scanInvoiceAnomalies(gapped, { period: '2026-10' });
    const gaps = findings.filter((f) => f.code.startsWith('anomaly.number_gap'));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].severity).toBe('low');
    expect(gaps[0].evidence).toContain('00000001');
    expect(gaps[0].evidence).toContain('00000005');
  });

  it('票号无数字（如纯字母）不参与跳号检测，也不报错', () => {
    const noDigits = rows.map((row, index) => ({
      ...row,
      invoiceNo: `NO-DIGITS-${index}`,
    }));
    const findings = scanInvoiceAnomalies(noDigits, { period: '2026-10' });
    expect(findings.filter((f) => f.code.startsWith('anomaly.number_gap'))).toEqual([]);
  });

  it('作废率超过阈值 → 报；阈值内不报', () => {
    expect(DEFAULT_VOID_RATE_THRESHOLD).toBe(10);
    const lowVoid = [
      ...rows,
      { ...rows[0], id: 'v', invoiceNo: '00000004', status: 'voided' },
    ];
    // 1/4 = 25% > 10% → 报
    const findings = scanInvoiceAnomalies(lowVoid, { period: '2026-10' });
    const hit = findings.find((f) => f.code === 'anomaly.high_void_rate');
    expect(hit).toBeDefined();
    expect(hit?.evidence).toContain('25%');

    // 提高阈值到 30% 后不再报
    expect(
      scanInvoiceAnomalies(lowVoid, {
        period: '2026-10',
        voidRateThreshold: 30,
      }).find((f) => f.code === 'anomaly.high_void_rate')
    ).toBeUndefined();
  });

  it('作废率超过阈值 2 倍 → high', () => {
    const mostlyVoided = [
      { ...rows[0], status: 'voided' },
      { ...rows[1], status: 'voided' },
      { ...rows[2], status: 'voided' },
      { ...rows[0], id: 'x', invoiceNo: '00000009', status: 'issued' },
    ];
    const hit = scanInvoiceAnomalies(mostlyVoided, {
      period: '2026-10',
    }).find((f) => f.code === 'anomaly.high_void_rate');
    expect(hit?.severity).toBe('high');
  });

  it('已开票未关联单据：≤5 张 low，>5 张 medium', () => {
    const few = [
      { ...rows[0], linkedId: null },
      { ...rows[1], linkedId: null },
      { ...rows[2], linkedId: 'ar-3' },
    ];
    expect(
      scanInvoiceAnomalies(few, { period: '2026-10' }).find(
        (f) => f.code === 'anomaly.unlinked'
      )?.severity
    ).toBe('low');

    const many = Array.from({ length: 7 }, (_, index) => ({
      ...rows[0],
      id: `m${index}`,
      code: `INV100${index}`,
      invoiceNo: `0001000${index}`,
      linkedId: null,
    }));
    expect(
      scanInvoiceAnomalies(many, { period: '2026-10' }).find(
        (f) => f.code === 'anomaly.unlinked'
      )?.severity
    ).toBe('medium');
  });

  it('已作废发票不计入"未关联单据"（作废单不需要关联）', () => {
    const voidedUnlinked = [
      { ...rows[0], linkedId: null, status: 'voided' },
      { ...rows[1], linkedId: 'ar-2' },
      { ...rows[2], linkedId: 'ar-3' },
    ];
    expect(
      scanInvoiceAnomalies(voidedUnlinked, { period: '2026-10' }).find(
        (f) => f.code === 'anomaly.unlinked'
      )
    ).toBeUndefined();
  });

  it('跨期开票 → low，并提示按开票日期所属期申报', () => {
    const crossPeriod = [
      ...rows,
      {
        ...rows[0],
        id: 'c1',
        code: 'INV0009',
        invoiceNo: '00009000',
        invoiceDate: '2026-09-30',
      },
    ];
    const hit = scanInvoiceAnomalies(crossPeriod, { period: '2026-10' }).find(
      (f) => f.code === 'anomaly.cross_period'
    );
    expect(hit?.severity).toBe('low');
    expect(hit?.suggestion).toContain('开票日期所属期');
  });

  it('开票日期为空不参与跨期判定', () => {
    const noDate = rows.map((row) => ({ ...row, invoiceDate: null }));
    expect(
      scanInvoiceAnomalies(noDate, { period: '2026-10' }).find(
        (f) => f.code === 'anomaly.cross_period'
      )
    ).toBeUndefined();
  });
});

describe('D-06 风险汇总', () => {
  it('按严重程度排序，同级按金额从大到小', () => {
    const summary = summarizeTaxRisks(
      [
        { code: 'a', category: 'invoice_anomaly', severity: 'low', title: 'L', evidence: '', suggestion: '', amount: 100 },
        { code: 'b', category: 'burden_rate', severity: 'high', title: 'H1', evidence: '', suggestion: '', amount: 10 },
        { code: 'c', category: 'burden_rate', severity: 'high', title: 'H2', evidence: '', suggestion: '', amount: 999 },
      ],
      '2026-10'
    );
    expect(summary.findings.map((f) => f.code)).toEqual(['c', 'b', 'a']);
  });

  it('统计各级别与各类别数量，并给出最高级别', () => {
    const summary = summarizeTaxRisks(
      [
        { code: 'a', category: 'burden_rate', severity: 'high', title: '', evidence: '', suggestion: '', amount: 1 },
        { code: 'b', category: 'invoice_anomaly', severity: 'low', title: '', evidence: '', suggestion: '', amount: 2 },
        { code: 'c', category: 'invoice_anomaly', severity: 'low', title: '', evidence: '', suggestion: '', amount: 3 },
      ],
      '2026-10'
    );
    expect(summary.bySeverity).toEqual({ high: 1, medium: 0, low: 2 });
    expect(summary.highestSeverity).toBe('high');
    expect(summary.totalFindings).toBe(3);
    expect(
      summary.byCategory.find((c) => c.category === 'invoice_anomaly')?.count
    ).toBe(2);
  });

  it('无风险时各级别为 0，highestSeverity 为 null', () => {
    const summary = summarizeTaxRisks([], '2026-10');
    expect(summary.totalFindings).toBe(0);
    expect(summary.highestSeverity).toBeNull();
    expect(summary.totalAmountInvolved).toBe(0);
  });

  it('涉及金额按 code 去重（同一笔差异被多个检查命中时只计一次）', () => {
    const summary = summarizeTaxRisks(
      [
        { code: 'same', category: 'burden_rate', severity: 'high', title: '', evidence: '', suggestion: '', amount: 100 },
        { code: 'same', category: 'invoice_anomaly', severity: 'high', title: '', evidence: '', suggestion: '', amount: 100 },
        { code: 'other', category: 'invoice_anomaly', severity: 'low', title: '', evidence: '', suggestion: '', amount: 50 },
      ],
      '2026-10'
    );
    expect(summary.totalAmountInvolved).toBe(150);
  });

  it('amount 为 null 的项不参与金额合计', () => {
    const summary = summarizeTaxRisks(
      [
        { code: 'a', category: 'burden_rate', severity: 'medium', title: '', evidence: '', suggestion: '', amount: null },
        { code: 'b', category: 'burden_rate', severity: 'medium', title: '', evidence: '', suggestion: '', amount: 20 },
      ],
      '2026-10'
    );
    expect(summary.totalAmountInvolved).toBe(20);
  });
});
