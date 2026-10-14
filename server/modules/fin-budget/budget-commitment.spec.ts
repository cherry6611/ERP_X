import { budgetMatchesDoc, sumMatchedRecords } from './fin-budget.service';

/**
 * C-09 三算对比的**口径语义**单测。
 *
 * 这里只测纯函数（不连库），因为最容易出错、也最难在页面上发现的问题
 * 恰恰是维度匹配语义：
 * - 预算行的 `departmentId` 为 NULL 表示"不限部门"，而不是"没有部门"；
 * - 同一条单据匹配多条预算时只能计一次（否则三算表的占用额会翻倍）。
 */
describe('C-09 预算维度匹配', () => {
  const doc = {
    departmentId: 'dept-1',
    projectId: 'proj-1',
    expenseCategory: 'travel',
    period: '2026-10',
  };

  it('期间不同则不匹配', () => {
    expect(
      budgetMatchesDoc(
        {
          departmentId: null,
          projectId: null,
          expenseCategory: 'travel',
          period: '2026-09',
        },
        doc,
      ),
    ).toBe(false);
  });

  it('费用类别不同则不匹配', () => {
    expect(
      budgetMatchesDoc(
        {
          departmentId: null,
          projectId: null,
          expenseCategory: 'office',
          period: '2026-10',
        },
        doc,
      ),
    ).toBe(false);
  });

  it('预算行部门为 NULL 表示「不限部门」，应匹配任意部门', () => {
    expect(
      budgetMatchesDoc(
        {
          departmentId: null,
          projectId: null,
          expenseCategory: 'travel',
          period: '2026-10',
        },
        doc,
      ),
    ).toBe(true);
  });

  it('预算行部门为具体值时不匹配其它部门', () => {
    expect(
      budgetMatchesDoc(
        {
          departmentId: 'dept-2',
          projectId: null,
          expenseCategory: 'travel',
          period: '2026-10',
        },
        doc,
      ),
    ).toBe(false);
  });

  it('预算行项目为 NULL 表示「不限项目」，应匹配任意项目', () => {
    expect(
      budgetMatchesDoc(
        {
          departmentId: 'dept-1',
          projectId: null,
          expenseCategory: 'travel',
          period: '2026-10',
        },
        doc,
      ),
    ).toBe(true);
  });

  it('预算行项目为具体值时不匹配其它项目', () => {
    expect(
      budgetMatchesDoc(
        {
          departmentId: null,
          projectId: 'proj-2',
          expenseCategory: 'travel',
          period: '2026-10',
        },
        doc,
      ),
    ).toBe(false);
  });

  it('费用类别为空字符串的预算只匹配类别为空的单据', () => {
    expect(
      budgetMatchesDoc(
        {
          departmentId: null,
          projectId: null,
          expenseCategory: '',
          period: '2026-10',
        },
        doc,
      ),
    ).toBe(false);
  });
});

describe('C-09 占用额汇总', () => {
  const records = [
    {
      id: 'r1',
      departmentId: 'dept-1',
      projectId: 'proj-1',
      expenseCategory: 'travel',
      amount: '1000',
      period: '2026-10',
    },
    {
      id: 'r2',
      departmentId: 'dept-1',
      projectId: 'proj-1',
      expenseCategory: 'travel',
      amount: '500',
      period: '2026-10',
    },
    {
      id: 'r3',
      departmentId: 'dept-2',
      projectId: null,
      expenseCategory: 'office',
      amount: '300',
      period: '2026-10',
    },
  ];

  it('只累计与预算集合匹配的单据', () => {
    const total = sumMatchedRecords(records, [
      {
        departmentId: 'dept-1',
        projectId: null,
        expenseCategory: 'travel',
        period: '2026-10',
      },
    ]);
    expect(total).toBe(1500);
  });

  it('同一单据匹配多条预算时只计一次（避免占用额翻倍）', () => {
    const total = sumMatchedRecords(records, [
      {
        departmentId: 'dept-1',
        projectId: null,
        expenseCategory: 'travel',
        period: '2026-10',
      },
      {
        // 第二条预算也会命中 r1/r2（项目+类别+期间相同，部门不限）
        departmentId: null,
        projectId: 'proj-1',
        expenseCategory: 'travel',
        period: '2026-10',
      },
    ]);
    expect(total).toBe(1500);
  });

  it('无预算时占用为 0', () => {
    expect(sumMatchedRecords(records, [])).toBe(0);
  });

  it('金额为空/null 按 0 处理，不产生 NaN', () => {
    const total = sumMatchedRecords(
      [
        {
          id: 'rx',
          departmentId: 'dept-1',
          projectId: null,
          expenseCategory: 'travel',
          amount: null,
          period: '2026-10',
        },
      ],
      [
        {
          departmentId: 'dept-1',
          projectId: null,
          expenseCategory: 'travel',
          period: '2026-10',
        },
      ],
    );
    expect(total).toBe(0);
  });
});
