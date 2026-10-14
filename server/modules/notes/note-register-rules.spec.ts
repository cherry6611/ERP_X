import {
  NOTE_DUE_BUCKETS,
  analyzeDiscountCost,
  bucketOfDaysLeft,
  buildDueStructure,
  buildNoteRegister,
  checkNoteNumbering,
  type NoteRegisterInput,
} from './note-register-rules';

/**
 * D-02 票据备查簿深化单测。
 *
 * 备查簿的价值在于**主动发现问题**（缺号、重号、贴现成本异常），
 * 因此测试重点在"能不能检出问题"，以及"不该报的别报"。
 */
describe('D-02 票号连续性检查', () => {
  const row = (
    noteNo: string,
    extra: Partial<{ code: string; noteType: string; status: string; amount: number }> = {}
  ) => ({
    code: extra.code ?? `C-${noteNo}`,
    noteNo,
    noteType: extra.noteType ?? 'bank',
    status: extra.status ?? 'held',
    amount: extra.amount ?? 100_000,
  });

  it('连续票号 → 通过', () => {
    const result = checkNoteNumbering([
      row('00000001'),
      row('00000002'),
      row('00000003'),
    ]);
    expect(result.continuous).toBe(true);
    expect(result.hasIssues).toBe(false);
    expect(result.gaps).toEqual([]);
    expect(result.message).toContain('连续性检查通过');
  });

  it('缺号 → 检出缺口与缺失数量', () => {
    const result = checkNoteNumbering([
      row('00000001'),
      row('00000005'),
      row('00000006'),
    ]);
    expect(result.continuous).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].before).toBe('00000001');
    expect(result.gaps[0].after).toBe('00000005');
    expect(result.gaps[0].missing).toBe(3);
    expect(result.message).toContain('共缺 3 个票号');
  });

  it('重号（含未作废）→ 标出高风险', () => {
    const result = checkNoteNumbering([
      row('00000001', { code: 'A' }),
      row('00000001', { code: 'B' }),
    ]);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].codes).toEqual(['A', 'B']);
    expect(result.duplicates[0].allVoided).toBe(false);
    expect(result.message).toContain('需立即核查是否重复入账');
  });

  it('重号但全部已作废 → 降级为可能的重开，不报高风险', () => {
    const result = checkNoteNumbering([
      row('00000001', { code: 'A', status: 'voided' }),
      row('00000001', { code: 'B', status: 'voided' }),
    ]);
    expect(result.duplicates[0].allVoided).toBe(true);
    expect(result.message).toContain('可能是作废后重开');
    expect(result.message).not.toContain('立即核查');
  });

  it('银行承兑与商业承兑号段独立，分别检查（不产生跨类型假缺口）', () => {
    // 银行承兑 00000001/00000002；商业承兑 90000001 —— 若混在一起会报巨大缺口
    const result = checkNoteNumbering([
      row('00000001', { noteType: 'bank' }),
      row('00000002', { noteType: 'bank' }),
      row('90000001', { noteType: 'commercial' }),
    ]);
    expect(result.gaps).toEqual([]);
    expect(result.continuous).toBe(true);
  });

  it('缺口过大（>1000）视为号段不同，不报缺口', () => {
    const result = checkNoteNumbering([row('00000001'), row('00009999')]);
    expect(result.gaps).toEqual([]);
  });

  it('票号无数字 → 不参与连续性检查，也不报错', () => {
    const result = checkNoteNumbering([row('NO-DIGITS-A'), row('NO-DIGITS-B')]);
    expect(result.gaps).toEqual([]);
    expect(result.numberedNotes).toBe(2);
  });

  it('缺票号的票被单独统计（票号必填，非 0 说明数据有缺口）', () => {
    const result = checkNoteNumbering([
      row('00000001'),
      { code: 'X', noteNo: '', noteType: 'bank', status: 'held', amount: 1 },
    ]);
    expect(result.missingNoteNoCount).toBe(1);
    expect(result.numberedNotes).toBe(1);
    expect(result.message).toContain('1 张票据缺票号');
  });

  it('每个类型最多报 5 处缺口（避免刷屏）', () => {
    const notes = Array.from({ length: 20 }, (_, index) =>
      row(String(1 + index * 3).padStart(8, '0'))
    );
    const result = checkNoteNumbering(notes);
    expect(result.gaps.length).toBeLessThanOrEqual(5);
  });

  it('空集合 → 通过，不抛错', () => {
    const result = checkNoteNumbering([]);
    expect(result.hasIssues).toBe(false);
    expect(result.totalNotes).toBe(0);
  });
});

describe('D-02 到期结构分桶', () => {
  it('分桶边界正确', () => {
    expect(bucketOfDaysLeft(-1)).toBe('overdue');
    expect(bucketOfDaysLeft(0)).toBe('within7');
    expect(bucketOfDaysLeft(7)).toBe('within7');
    expect(bucketOfDaysLeft(8)).toBe('within30');
    expect(bucketOfDaysLeft(30)).toBe('within30');
    expect(bucketOfDaysLeft(31)).toBe('within90');
    expect(bucketOfDaysLeft(90)).toBe('within90');
    expect(bucketOfDaysLeft(91)).toBe('beyond90');
  });

  it('五档齐全，金额与占比正确', () => {
    const result = buildDueStructure([
      { status: 'held', amount: 100, daysLeft: -1 },
      { status: 'held', amount: 200, daysLeft: 3 },
      { status: 'held', amount: 300, daysLeft: 20 },
      { status: 'held', amount: 400, daysLeft: 60 },
      { status: 'held', amount: 500, daysLeft: 200 },
    ]);
    expect(result.buckets).toHaveLength(NOTE_DUE_BUCKETS.length);
    expect(result.outstandingAmount).toBe(1500);
    expect(result.overdueAmount).toBe(100);
    expect(result.buckets.find((b) => b.bucket === 'within7')?.share).toBe(
      Math.round((200 / 1500) * 100 * 100) / 100
    );
  });

  it('已结清与已拒付不参与（不再产生未来现金流）', () => {
    const result = buildDueStructure([
      { status: 'settled', amount: 999, daysLeft: 5 },
      { status: 'dishonored', amount: 888, daysLeft: 5 },
      { status: 'held', amount: 100, daysLeft: 5 },
    ]);
    expect(result.outstandingAmount).toBe(100);
    expect(result.outstandingCount).toBe(1);
  });

  it('空集合 → 全 0，占比不产生 NaN', () => {
    const result = buildDueStructure([]);
    expect(result.outstandingAmount).toBe(0);
    for (const bucket of result.buckets) {
      expect(bucket.share).toBe(0);
      expect(Number.isFinite(bucket.share)).toBe(true);
    }
  });
});

describe('D-02 贴现成本分析', () => {
  const note = (
    code: string,
    amount: number,
    interest: number | null,
    days: number | null,
    noteType = 'bank'
  ) => ({
    code,
    noteNo: code,
    noteType,
    amount,
    discountInterest: interest,
    discountRate: null,
    days,
  });

  it('综合成本率 = 息合计 / 金额合计 × 100（加权，不是算术平均）', () => {
    const result = analyzeDiscountCost([
      // 小额高息票：若用算术平均会被严重放大
      note('A', 10_000, 1_000, 30),
      note('B', 1_000_000, 5_000, 30),
    ]);
    expect(result.amount).toBe(1_010_000);
    expect(result.interest).toBe(6_000);
    // 加权：6000 / 1010000 ≈ 0.59%
    expect(result.weightedRate).toBe(Math.round((6000 / 1_010_000) * 100 * 100) / 100);
    // 算术平均会是 (10% + 0.5%)/2 = 5.25%，远高于真实成本
    expect(result.weightedRate).toBeLessThan(1);
  });

  it('到账合计 = 票面 − 贴现息', () => {
    const result = analyzeDiscountCost([note('A', 1_000_000, 3_000, 30)]);
    expect(result.netProceeds).toBe(997_000);
  });

  it('按票据类型分组（银行承兑通常成本更低，便于对比议价空间）', () => {
    const result = analyzeDiscountCost([
      note('A', 1_000_000, 3_000, 30, 'bank'),
      note('B', 500_000, 5_000, 30, 'commercial'),
    ]);
    const bank = result.byType.find((item) => item.noteType === 'bank');
    const commercial = result.byType.find((item) => item.noteType === 'commercial');
    expect(bank?.weightedRate).toBe(0.3);
    expect(commercial?.weightedRate).toBe(1);
    // 按金额降序
    expect(result.byType[0].noteType).toBe('bank');
  });

  it('年化成本率按实际计息天数折算', () => {
    // 100 万、30 天、3000 元 → 年化 = 3000×360/30 / 1,000,000 = 3.6%
    const result = analyzeDiscountCost([note('A', 1_000_000, 3_000, 30)]);
    expect(result.annualizedRate).toBe(3.6);
  });

  it('缺天数或息的票不参与年化，但计入金额与息合计，并列在待补录清单', () => {
    const result = analyzeDiscountCost([
      note('A', 1_000_000, 3_000, 30),
      note('B', 200_000, 500, null),
      note('C', 300_000, null, 60),
    ]);
    expect(result.amount).toBe(1_500_000);
    expect(result.interest).toBe(3_500);
    expect(result.incompleteCodes).toEqual(['B', 'C']);
    // 年化只用 A：3.6%
    expect(result.annualizedRate).toBe(3.6);
  });

  it('天数为 0 不参与年化（避免除零产生 Infinity）', () => {
    const result = analyzeDiscountCost([note('A', 100_000, 100, 0)]);
    expect(Number.isFinite(result.annualizedRate)).toBe(true);
    expect(result.annualizedRate).toBe(0);
    expect(result.incompleteCodes).toEqual(['A']);
  });

  it('金额为 0 的票被排除（不产生除零）', () => {
    const result = analyzeDiscountCost([note('A', 0, 100, 30)]);
    expect(result.count).toBe(0);
    expect(result.weightedRate).toBe(0);
    expect(Number.isFinite(result.annualizedRate)).toBe(true);
  });

  it('空集合 → 全 0，不抛错', () => {
    const result = analyzeDiscountCost([]);
    expect(result.count).toBe(0);
    expect(result.weightedRate).toBe(0);
    expect(result.annualizedRate).toBe(0);
  });
});

describe('D-02 备查簿汇总', () => {
  const input = (
    code: string,
    noteNo: string,
    extra: Partial<NoteRegisterInput> = {}
  ): NoteRegisterInput => ({
    id: code,
    code,
    noteNo,
    noteType: 'bank',
    status: 'held',
    amount: 100_000,
    drawer: null,
    dueDate: '2026-11-01',
    daysLeft: 20,
    discountInterest: null,
    discountRate: null,
    discountDays: null,
    ...extra,
  });

  it('汇总四块：状态分布 / 到期结构 / 连续性 / 贴现成本', () => {
    const result = buildNoteRegister(
      [
        input('N1', '00000001', { status: 'held', daysLeft: 5 }),
        input('N2', '00000002', {
          status: 'discounted',
          daysLeft: 40,
          discountInterest: 3000,
          discountDays: 30,
          amount: 1_000_000,
        }),
        input('N3', '00000010', { status: 'settled', daysLeft: -5 }),
      ],
      '2026-10-12'
    );
    expect(result.total.count).toBe(3);
    expect(result.total.amount).toBe(1_200_000);
    expect(result.byStatus.find((s) => s.status === 'held')?.count).toBe(1);
    expect(result.discountCost.count).toBe(1);
    expect(result.discountCost.annualizedRate).toBe(3.6);
    // N1/N2 连续？00000002 与 00000001 连续，但 00000010 与 00000002 有缺口
    expect(result.numbering.gaps.length).toBeGreaterThan(0);
  });

  it('关注清单只含未结清且 15 天内到期的票，按紧迫度排序', () => {
    const result = buildNoteRegister(
      [
        input('N1', '00000001', { daysLeft: 10 }),
        input('N2', '00000002', { daysLeft: -3 }),
        input('N3', '00000003', { daysLeft: 60 }),
        input('N4', '00000004', { daysLeft: 1, status: 'settled' }),
      ],
      '2026-10-12'
    );
    expect(result.attention.map((item) => item.code)).toEqual(['N2', 'N1']);
  });

  it('空备查簿 → 各块均为空/零，不抛错', () => {
    const result = buildNoteRegister([], '2026-10-12');
    expect(result.total.count).toBe(0);
    expect(result.attention).toEqual([]);
    expect(result.numbering.hasIssues).toBe(false);
  });
});
