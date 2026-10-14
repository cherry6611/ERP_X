import {
  DISCOUNT_DAY_BASIS,
  NOTE_ACTION_TARGET,
  NOTE_STATUSES,
  NOTE_TRANSITIONS,
  computeDiscount,
  discountDays,
  dueAlerts,
  noteActionLines,
  noteDiscountLines,
  noteEndorseLines,
  noteRegisterSummary,
  noteSettleLines,
  validateNoteAction,
  type NoteStatus,
} from './note-rules';

function debitTotal(lines: { debit?: number }[]): number {
  return Math.round(lines.reduce((sum, l) => sum + (l.debit ?? 0), 0) * 100) / 100;
}
function creditTotal(lines: { credit?: number }[]): number {
  return Math.round(lines.reduce((sum, l) => sum + (l.credit ?? 0), 0) * 100) / 100;
}

/**
 * C-04 / D-02 票据规则单测。
 *
 * 票据是"算错钱不会当场报错"的典型场景：贴现息差 1 天、基准用错 360/365，
 * 都要到月末对账才发现。这组测试把口径钉死在代码里。
 */
describe('C-04 票据状态机', () => {
  it('终态不可再流转（settled / dishonored）', () => {
    for (const status of ['settled', 'dishonored'] as NoteStatus[]) {
      for (const action of ['hold', 'endorse', 'discount', 'settle', 'dishonor'] as const) {
        const errors = validateNoteAction(status, action);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]).toContain('终态');
      }
    }
  });

  it('received 可以直接 hold / endorse / discount（实务常见）', () => {
    expect(validateNoteAction('received', 'hold')).toEqual([]);
    expect(validateNoteAction('received', 'endorse')).toEqual([]);
    expect(validateNoteAction('received', 'discount')).toEqual([]);
  });

  it('held 可以 endorse / discount / settle / dishonor', () => {
    for (const action of ['endorse', 'discount', 'settle', 'dishonor'] as const) {
      expect(validateNoteAction('held', action)).toEqual([]);
    }
  });

  it('endorsed / discounted 仍可 settle（被追索后又收到款）与 dishonor', () => {
    for (const status of ['endorsed', 'discounted'] as NoteStatus[]) {
      expect(validateNoteAction(status, 'settle')).toEqual([]);
      expect(validateNoteAction(status, 'dishonor')).toEqual([]);
      // 但不能再背书或重复贴现
      expect(validateNoteAction(status, 'endorse').length).toBeGreaterThan(0);
      expect(validateNoteAction(status, 'discount').length).toBeGreaterThan(0);
    }
  });

  it('非法流转的错误消息是可读中文且列出了允许的前置状态', () => {
    const errors = validateNoteAction('endorsed', 'discount');
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('贴现');
    expect(errors[0]).toContain('允许的前置状态');
  });

  it('每个动作都有目标状态，且目标状态都是合法枚举值', () => {
    for (const action of Object.keys(NOTE_ACTION_TARGET)) {
      const target = NOTE_ACTION_TARGET[action as keyof typeof NOTE_ACTION_TARGET];
      expect(NOTE_STATUSES).toContain(target);
    }
  });

  it('NOTE_TRANSITIONS 里出现的状态都是合法枚举值', () => {
    for (const allowed of Object.values(NOTE_TRANSITIONS)) {
      for (const status of allowed) {
        expect(NOTE_STATUSES).toContain(status);
      }
    }
  });
});

describe('C-04 贴现息计算', () => {
  it('贴现天数算头不算尾：10-01 贴现、10-31 到期 = 30 天', () => {
    expect(discountDays('2026-10-01', '2026-10-31')).toBe(30);
  });

  it('跨月天数正确（闰年 2 月也正确）', () => {
    // 2028 是闰年，2 月 29 天
    expect(discountDays('2028-02-01', '2028-03-01')).toBe(29);
    expect(discountDays('2027-02-01', '2027-03-01')).toBe(28);
  });

  it('到期日等于或早于贴现日 → 0 天（不产生负息）', () => {
    expect(discountDays('2026-10-31', '2026-10-31')).toBe(0);
    expect(discountDays('2026-11-01', '2026-10-31')).toBe(0);
  });

  it('贴现息 = 票面 × 费率/100 × 天数/360', () => {
    // 100 万、3.6%、30 天 → 1,000,000 × 0.036 × 30/360 = 3,000
    const result = computeDiscount({
      amount: 1_000_000,
      rate: 3.6,
      discountDate: '2026-10-01',
      dueDate: '2026-10-31',
    });
    expect(result.days).toBe(30);
    expect(result.interest).toBe(3_000);
    expect(result.netProceeds).toBe(997_000);
  });

  it('到账金额 + 贴现息 == 票面金额（恒等式）', () => {
    for (const [amount, rate, days] of [
      [1_000_000, 3.6, 30],
      [500_000, 2.5, 90],
      [123_456.78, 4.15, 47],
      [99_999_999.99, 1.05, 179],
    ] as const) {
      const dueDate = addDays('2026-01-01', days);
      const result = computeDiscount({
        amount,
        rate,
        discountDate: '2026-01-01',
        dueDate,
      });
      expect(
        Math.round((result.netProceeds + result.interest) * 100) / 100
      ).toBe(Math.round(amount * 100) / 100);
    }
  });

  it('贴现息为 0 不会产生负到账', () => {
    const result = computeDiscount({
      amount: 10_000,
      rate: 0,
      discountDate: '2026-10-01',
      dueDate: '2026-10-31',
    });
    expect(result.interest).toBe(0);
    expect(result.netProceeds).toBe(10_000);
  });

  it('负费率按 0 处理（不产生"倒贴息"）', () => {
    const result = computeDiscount({
      amount: 10_000,
      rate: -5,
      discountDate: '2026-10-01',
      dueDate: '2026-10-31',
    });
    expect(result.interest).toBe(0);
  });

  it('计息基准是 360（需财务确认；若改 365 本用例会失败并提醒）', () => {
    expect(DISCOUNT_DAY_BASIS).toBe(360);
  });
});

describe('C-04 票据分录', () => {
  it('收到票据：借贷同科目轧平（不新增资产科目，待在 1122 下）', () => {
    const lines = noteActionLines('hold', 500_000);
    expect(debitTotal(lines)).toBe(500_000);
    expect(creditTotal(lines)).toBe(500_000);
  });

  it('背书转让：借 2202 应付账款 / 贷 1122 应收账款', () => {
    const lines = noteEndorseLines(500_000);
    expect(debitTotal(lines)).toBe(creditTotal(lines));
    expect(lines.find((l) => l.accountCode === '2202')?.debit).toBe(500_000);
    expect(lines.find((l) => l.accountCode === '1122')?.credit).toBe(500_000);
  });

  it('贴现：银行存款净额 + 财务费用贴现息 = 贷记票面，且借贷平衡', () => {
    const lines = noteDiscountLines(1_000_000, 3_000);
    expect(debitTotal(lines)).toBe(1_000_000);
    expect(creditTotal(lines)).toBe(1_000_000);
    expect(lines.find((l) => l.accountCode === '100201')?.debit).toBe(997_000);
    expect(lines.find((l) => l.accountCode === '6603')?.debit).toBe(3_000);
    expect(lines.find((l) => l.accountCode === '1122')?.credit).toBe(1_000_000);
  });

  it('贴现息为 0 时不产生财务费用行（避免 0 元分录行）', () => {
    const lines = noteDiscountLines(100_000, 0);
    expect(lines.find((l) => l.accountCode === '6603')).toBeUndefined();
    expect(debitTotal(lines)).toBe(100_000);
  });

  it('到期收款：借 100201 银行存款 / 贷 1122 应收账款', () => {
    const lines = noteSettleLines(200_000);
    expect(debitTotal(lines)).toBe(creditTotal(lines));
    expect(lines.find((l) => l.accountCode === '100201')?.debit).toBe(200_000);
  });

  it('每个动作的分录都借贷平衡', () => {
    for (const action of ['hold', 'endorse', 'discount', 'settle', 'dishonor'] as const) {
      const lines = noteActionLines(action, 777_777.77, 1234.56);
      expect(
        `${action}:${debitTotal(lines) === creditTotal(lines)}`
      ).toBe(`${action}:true`);
    }
  });
});

describe('C-04 / D-02 票据备查簿与到期预警', () => {
  const notes = [
    { code: 'N1', noteNo: 'A1', status: 'held', amount: 100_000, dueDate: '2026-10-05' },
    { code: 'N2', noteNo: 'A2', status: 'held', amount: 200_000, dueDate: '2026-10-20' },
    { code: 'N3', noteNo: 'A3', status: 'held', amount: 50_000, dueDate: '2026-09-25' },
    { code: 'N4', noteNo: 'A4', status: 'settled', amount: 300_000, dueDate: '2026-10-01' },
  ];

  it('排除终态票据的到期提醒', () => {
    const alerts = dueAlerts(notes, '2026-10-01');
    expect(alerts.find((a) => a.code === 'N4')).toBeUndefined();
  });

  it('逾期排在前面，且 daysLeft 为负', () => {
    const alerts = dueAlerts(notes, '2026-10-01');
    expect(alerts[0].code).toBe('N3');
    expect(alerts[0].daysLeft).toBe(-6);
    expect(alerts[0].level).toBe('overdue');
  });

  it('3 天内到期标 urgent，15 天内标 upcoming，超出窗口不提醒', () => {
    const alerts = dueAlerts(
      [
        { code: 'U', noteNo: 'U', status: 'held', amount: 1, dueDate: '2026-10-03' },
        { code: 'P', noteNo: 'P', status: 'held', amount: 1, dueDate: '2026-10-10' },
        { code: 'F', noteNo: 'F', status: 'held', amount: 1, dueDate: '2026-11-30' },
      ],
      '2026-10-01'
    );
    expect(alerts.find((a) => a.code === 'U')?.level).toBe('urgent');
    expect(alerts.find((a) => a.code === 'P')?.level).toBe('upcoming');
    expect(alerts.find((a) => a.code === 'F')).toBeUndefined();
  });

  it('备查簿按状态与类型分组，金额合计正确', () => {
    const summary = noteRegisterSummary([
      { status: 'held', amount: 100, noteType: 'bank' },
      { status: 'held', amount: 200, noteType: 'bank' },
      { status: 'settled', amount: 300, noteType: 'commercial' },
      { status: 'endorsed', amount: 400, noteType: 'commercial' },
    ]);
    expect(summary.totalAmount).toBe(1000);
    expect(summary.byStatus.find((s) => s.status === 'held')?.amount).toBe(300);
    expect(summary.byStatus.find((s) => s.status === 'settled')?.amount).toBe(300);
    expect(summary.byType.find((t) => t.noteType === 'bank')?.count).toBe(2);
    expect(summary.byType.find((t) => t.noteType === 'commercial')?.amount).toBe(700);
  });

  it('未结清金额排除 settled 与 dishonored', () => {
    const summary = noteRegisterSummary([
      { status: 'held', amount: 100, noteType: 'bank' },
      { status: 'settled', amount: 500, noteType: 'bank' },
      { status: 'dishonored', amount: 900, noteType: 'bank' },
      { status: 'endorsed', amount: 50, noteType: 'bank' },
    ]);
    expect(summary.outstandingAmount).toBe(150);
  });

  it('空票据集合不产生 NaN', () => {
    const summary = noteRegisterSummary([]);
    expect(summary.totalAmount).toBe(0);
    expect(summary.outstandingAmount).toBe(0);
    expect(summary.byStatus.every((s) => s.amount === 0)).toBe(true);
  });
});

/** 测试辅助：在 YYYY-MM-DD 上加天数 */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  const next = new Date(base + days * 86_400_000);
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
