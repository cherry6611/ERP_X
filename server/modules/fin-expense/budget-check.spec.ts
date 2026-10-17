/**
 * `budget-check` 的规格：费用申请/报销的预算闸门。
 *
 * 这组断言针对两类"不报错但后果很实"的错法（见模块文件头）：
 *   · 多算占用 → 有预算也驳回，业务被卡；
 *   · 少算占用 → 超预算也放行，**预算控制形同虚设**。
 */
import {
  budgetExceededMessage,
  computeBudgetCheck,
  sumMatchedRecords,
  type ExpenseRecordDims,
  type MatchedBudgetRow,
} from './budget-check';

const budget = (over: Partial<MatchedBudgetRow> = {}): MatchedBudgetRow => ({
  departmentId: 'dept-1',
  projectId: null,
  expenseCategory: 'travel',
  period: '2026-10',
  budgetAmount: '10000',
  ...over,
});

const rec = (over: Partial<ExpenseRecordDims> = {}): ExpenseRecordDims => ({
  id: 'r-1',
  departmentId: 'dept-1',
  projectId: 'proj-1',
  expenseCategory: 'travel',
  amount: '1000',
  period: '2026-10',
  ...over,
});

describe('computeBudgetCheck：无预算口径', () => {
  it('⚠️ 无匹配预算 → hasBudget=false 且 exceeded=false（"没编预算就不管"，不是"拒绝"）', () => {
    const r = computeBudgetCheck({ matchedBudgets: [], applies: [], claims: [], docAmount: 999 });
    expect(r).toEqual({ hasBudget: false, budgetAmount: 0, executed: 0, occupied: 0, exceeded: false });
    /* 写反会让所有无预算部门无法报销 —— 这是业务中断级后果 */
    expect(r.exceeded).toBe(false);
  });
});

describe('computeBudgetCheck：占用与已执行的口径', () => {
  it('申请侧 pending 与 approved **都**计入在途占用', () => {
    const r = computeBudgetCheck({
      matchedBudgets: [budget()],
      applies: [rec({ id: 'a1', amount: '100' }), rec({ id: 'a2', amount: '200' })],
      claims: [],
      docAmount: 0,
    });
    expect(r.occupied).toBe(300);
    expect(r.executed).toBe(0);
  });

  it('⚠️ 报销 approved 计入**已执行**，不计入在途（否则重复计数）', () => {
    const r = computeBudgetCheck({
      matchedBudgets: [budget()],
      applies: [],
      claims: [{ ...rec({ id: 'c1', amount: '500' }), status: 'approved' }],
      docAmount: 0,
    });
    expect(r.executed).toBe(500);
    expect(r.occupied).toBe(0);
  });

  it('报销 pending / escalated 计入在途', () => {
    const r = computeBudgetCheck({
      matchedBudgets: [budget()],
      applies: [],
      claims: [
        { ...rec({ id: 'c1', amount: '100' }), status: 'pending' },
        { ...rec({ id: 'c2', amount: '200' }), status: 'escalated' },
      ],
      docAmount: 0,
    });
    expect(r.occupied).toBe(300);
    expect(r.executed).toBe(0);
  });

  it('三类混在一起：在途 = 申请(全部) + 报销(未批)，已执行 = 报销(已批)', () => {
    const r = computeBudgetCheck({
      matchedBudgets: [budget()],
      applies: [rec({ id: 'a1', amount: '100' })],
      claims: [
        { ...rec({ id: 'c1', amount: '200' }), status: 'pending' },
        { ...rec({ id: 'c2', amount: '400' }), status: 'approved' },
      ],
      docAmount: 0,
    });
    expect(r.occupied).toBe(300); // 100 + 200
    expect(r.executed).toBe(400);
  });
});

describe('computeBudgetCheck：超额判据', () => {
  it('已执行 + 在途 + 本次 > 预算 → exceeded', () => {
    const r = computeBudgetCheck({
      matchedBudgets: [budget({ budgetAmount: '1000' })],
      applies: [rec({ id: 'a1', amount: '400' })],
      claims: [{ ...rec({ id: 'c1', amount: '400' }), status: 'approved' }],
      docAmount: 300,
    });
    /* 400 + 400 + 300 = 1100 > 1000 */
    expect(r.exceeded).toBe(true);
  });

  it('恰好等于预算 → 不超额（判据是严格大于）', () => {
    const r = computeBudgetCheck({
      matchedBudgets: [budget({ budgetAmount: '1000' })],
      applies: [rec({ id: 'a1', amount: '700' })],
      claims: [],
      docAmount: 300,
    });
    expect(r.exceeded).toBe(false);
  });

  it('⚠️ 金额是字符串时按数字相加（不被拼成 100200）', () => {
    const r = computeBudgetCheck({
      matchedBudgets: [budget({ budgetAmount: '300' })],
      applies: [rec({ id: 'a1', amount: '100' }), rec({ id: 'a2', amount: '200' })],
      claims: [],
      docAmount: 10,
    });
    /* 若写成字符串相加会得到 '100200' → 恒超额；这里是 300+10=310 > 300 */
    expect(r.occupied).toBe(300);
    expect(r.exceeded).toBe(true);
  });

  it('多条预算命中 → 预算额相加', () => {
    const r = computeBudgetCheck({
      matchedBudgets: [
        budget({ budgetAmount: '1000', projectId: null }),
        budget({ budgetAmount: '2000', projectId: 'proj-1' }),
      ],
      applies: [],
      claims: [],
      docAmount: 100,
    });
    expect(r.budgetAmount).toBe(3000);
  });
});

describe('sumMatchedRecords：去重与维度匹配', () => {
  it('⚠️ 同一 id 被多条预算命中时只算一次（否则占用被放大若干倍）', () => {
    const budgets: MatchedBudgetRow[] = [
      budget({ departmentId: 'dept-1', projectId: null, expenseCategory: 'travel' }),
      budget({ departmentId: null, projectId: 'proj-1', expenseCategory: 'travel' }),
    ];
    const total = sumMatchedRecords([rec({ id: 'x1', amount: '500' })], budgets);
    expect(total).toBe(500);
  });

  it('departmentId / projectId 为 null 的预算行 = 通配该维度', () => {
    const wildcard: MatchedBudgetRow[] = [budget({ departmentId: null, projectId: null })];
    expect(sumMatchedRecords([rec({ departmentId: 'any', projectId: 'any' })], wildcard)).toBe(1000);
  });

  it('非 null 的维度必须相等才算命中', () => {
    const strict: MatchedBudgetRow[] = [budget({ departmentId: 'dept-OTHER' })];
    expect(sumMatchedRecords([rec()], strict)).toBe(0);
  });

  it('期间不同 → 不命中', () => {
    const other: MatchedBudgetRow[] = [budget({ period: '2026-09' })];
    expect(sumMatchedRecords([rec()], other)).toBe(0);
  });

  it('费用类别不同 → 不命中（null 类别按空串比较）', () => {
    const other: MatchedBudgetRow[] = [budget({ expenseCategory: 'office' })];
    expect(sumMatchedRecords([rec()], other)).toBe(0);
  });

  it('金额为 null 按 0', () => {
    expect(sumMatchedRecords([rec({ amount: null })], [budget()])).toBe(0);
  });
});

describe('budgetExceededMessage', () => {
  it('⚠️ 提示里的"超出金额"必须与拦截口径同源（三项相加减预算）', () => {
    const check = computeBudgetCheck({
      matchedBudgets: [budget({ budgetAmount: '1000' })],
      applies: [rec({ id: 'a1', amount: '400' })],
      claims: [{ ...rec({ id: 'c1', amount: '400' }), status: 'approved' }],
      docAmount: 300,
    });
    const msg = budgetExceededMessage(check, 300);
    expect(msg).toContain('预算总额 1000 元');
    expect(msg).toContain('已执行 400 元');
    expect(msg).toContain('在途占用 400 元');
    expect(msg).toContain('本次申请 300 元');
    /* 400 + 400 + 300 − 1000 = 100 */
    expect(msg).toContain('超出 100 元');
  });
});
