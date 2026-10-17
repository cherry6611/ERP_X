/**
 * `bank-statement.service.ts` 的**纯函数面**规格（银行流水）。
 *
 * ## 为什么只测导出的纯函数，不测 service 方法
 *
 * 该文件 815 行，主体 `BankStatementService` 是编排（导入/去重/匹配/分页），
 * 需要 DB 与 DI 才能测；而它导出的 4 个纯函数里藏着**三处静默出错**的地方：
 *
 * | 函数 | 写错的后果 |
 * |---|---|
 * | `periodRange` | 月末日算错（闰年 2 月 / 30 天月）→ 期末当天流水被**静默漏在对账区间外** |
 * | `matchStatusLabel` | 未知状态落到默认值「未匹配」→ 界面把已匹配的显示成未匹配 |
 * | `toExportRecord` | 金额/余额/匹配度未过 `round2` → 导出 Excel 出现 `100.00000000001` |
 *
 * 三者的共同点：**不抛异常**。对账少一天、状态显示错、导出数字脏，全靠断言。
 */
import {
  matchStatusLabel,
  periodRange,
  statementItemToRow,
  toExportRecord,
  type BankStatementRowRaw,
} from './bank-statement.service';
import type { BankStatementItem } from '@shared/api.interface';

describe('periodRange：期间起止日（业务时区口径）', () => {
  it('普通 31 天月', () => {
    expect(periodRange('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodRange('2026-01')).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('30 天月', () => {
    expect(periodRange('2026-04')).toEqual({ from: '2026-04-01', to: '2026-04-30' });
    expect(periodRange('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('⚠️ 平年 2 月 = 28 天', () => {
    expect(periodRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('2025-02')).toEqual({ from: '2025-02-01', to: '2025-02-28' });
  });

  it('⚠️ 闰年 2 月 = 29 天（整百年需能被 400 整除才算闰年）', () => {
    expect(periodRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(periodRange('2000-02')).toEqual({ from: '2000-02-01', to: '2000-02-29' });
    /* 1900 不是闰年（能被 100 整除但不能被 400 整除） */
    expect(periodRange('1900-02')).toEqual({ from: '1900-02-01', to: '1900-02-28' });
  });

  it('12 月不会被"进位"到次年 1 月', () => {
    expect(periodRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('⚠️ 期间格式非法 → 中文报错（拒绝 `2026-13` / `2026-00` / 空）', () => {
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-01', '', '2026-01-01', 'abc']) {
      expect(() => periodRange(bad)).toThrow(/期间格式必须为 YYYY-MM/);
    }
  });

  it('日期补零：单数字月也输出两位', () => {
    expect(periodRange('2026-01').from).toBe('2026-01-01');
    expect(periodRange('2026-09').to).toBe('2026-09-30');
  });

  it('⚠️ 起止日都是合法 ISO 日期（年月日三段各两位）', () => {
    for (const period of ['2026-02', '2024-02', '2026-11']) {
      const { from, to } = periodRange(period);
      expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(from <= to).toBe(true);
    }
  });
});

describe('matchStatusLabel：状态中文标签', () => {
  it('四个已知状态', () => {
    expect(matchStatusLabel('matched')).toBe('已自动匹配');
    expect(matchStatusLabel('manual')).toBe('已人工关联');
    expect(matchStatusLabel('ignored')).toBe('已忽略');
    expect(matchStatusLabel('unmatched')).toBe('未匹配');
  });

  it('⚠️ 未知状态落到「未匹配」（不是原样输出英文码）', () => {
    expect(matchStatusLabel('weird_status')).toBe('未匹配');
    expect(matchStatusLabel('')).toBe('未匹配');
  });
});

describe('toExportRecord：导出扁平记录', () => {
  const base: BankStatementRowRaw = {
    transactionDate: '2026-10-15',
    bankAccountName: '招商银行-基本户',
    direction: 'income',
    amount: '1234.5678',
    balance: '9999.999',
    counterpartyName: '某客户',
    counterpartyAccount: '6222000000000000',
    summary: '货款',
    transactionNo: 'TX001',
    matchStatus: 'matched',
    bizCode: 'RCV2026100001',
    matchScore: '0.98765',
  } as unknown as BankStatementRowRaw;

  it('方向转中文', () => {
    expect(toExportRecord(base).direction).toBe('收入');
    expect(toExportRecord({ ...base, direction: 'expense' } as BankStatementRowRaw).direction).toBe('支出');
  });

  it('⚠️ 金额/余额/匹配度过 round2（导出不能出现 100.00000000001）', () => {
    const r = toExportRecord(base);
    expect(r.amount).toBe(1234.57);
    expect(r.balance).toBe(10000);
    expect(r.matchScore).toBe(0.99);
  });

  it('匹配状态转中文', () => {
    expect(toExportRecord(base).matchStatus).toBe('已自动匹配');
  });

  it('账户名为空时输出空串（不是 null，避免 Excel 里显示 "null"）', () => {
    const r = toExportRecord({ ...base, bankAccountName: null } as BankStatementRowRaw);
    expect(r.account).toBe('');
  });

  it('余额/匹配度为 null 时保持 null（不是 0 —— 0 会被误读为"余额为零"）', () => {
    const r = toExportRecord({ ...base, balance: null, matchScore: null } as BankStatementRowRaw);
    expect(r.balance).toBeNull();
    expect(r.matchScore).toBeNull();
  });

  it('交易日期原样透传（不改格式、不转时区）', () => {
    expect(toExportRecord(base).tradeDate).toBe('2026-10-15');
  });
});

describe('statementItemToRow：接口项 → 原始行', () => {
  /*
   * ⚠️ 本函数**不做 round2** —— 它只是把接口项转成落表结构
   * （`BankStatementRowRaw.amount` 是 **string**，取的是 `String(item.amount)`）。
   * 取整发生在下游的 `toExportRecord`。
   *
   * 我第一版凭印象写成"应被 round2 成 1234.57"，测试失败才发现是**我猜错了契约**，
   * 代码本身没错（本会话第 3 次因没先读实现而写错断言）。
   */
  const item = {
    id: 'i1',
    bankAccountId: 'b1',
    transactionDate: '2026-10-15',
    bankAccountName: 'A',
    direction: 'income',
    amount: 1234.5678,
    balance: 9999.999,
    counterpartyName: 'C',
    counterpartyAccount: null,
    summary: 'S',
    transactionNo: 'T',
    dedupeKey: 'd1',
    matchStatus: 'manual',
    bizType: null,
    bizId: null,
    bizCode: null,
    matchScore: 0.5,
    remark: null,
    createdAt: '2026-10-15T00:00:00.000Z',
  } as unknown as BankStatementItem;

  it('数值字段被转成字符串（落表结构要求 string）', () => {
    const row = statementItemToRow(item);
    expect(row.amount).toBe('1234.5678');
    expect(row.balance).toBe('9999.999');
    expect(row.matchScore).toBe('0.5');
    expect(typeof row.amount).toBe('string');
  });

  it('余额/匹配度为 null 时保持 null（不能写成字符串 "null"）', () => {
    const row = statementItemToRow({ ...item, balance: null, matchScore: null } as unknown as BankStatementItem);
    expect(row.balance).toBeNull();
    expect(row.matchScore).toBeNull();
  });

  it('createdAt 字符串转为 Date', () => {
    const row = statementItemToRow(item);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('其余字段原样透传', () => {
    const row = statementItemToRow(item);
    expect(row.id).toBe('i1');
    expect(row.transactionDate).toBe('2026-10-15');
    expect(row.matchStatus).toBe('manual');
    expect(row.bankAccountName).toBe('A');
  });

  it('⚠️ 与 toExportRecord 串联时，取整发生在后者', () => {
    const row = statementItemToRow(item);
    expect(row.amount).toBe('1234.5678');
    /* 下游导出才 round2 */
    expect(toExportRecord(row as BankStatementRowRaw).amount).toBe(1234.57);
  });
});
