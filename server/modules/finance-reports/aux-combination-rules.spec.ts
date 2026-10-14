import {
  MAX_COMBINATION_DIMENSIONS,
  allocateAmount,
  assessCombinationCoverage,
  buildCombinations,
  buildCrossDimensionRows,
  combinationKey,
  netOfTax,
  validateCombinationRequest,
  type AuxLineForCombination,
} from './aux-combination-rules';

function sum(values: number[]): number {
  return Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
}

/**
 * D-03 辅助核算深化的规则单测。
 *
 * 重点不在"能算出数字"，而在两个**财务上不能错**的地方：
 *  1. 分摊结果之和必须严格等于被分摊总额（否则凭证借贷不平）；
 *  2. 组合表未覆盖的部分必须显式暴露（否则使用者拿不完整的表做决策）。
 */
describe('D-03 维度组合键', () => {
  const codes = ['department', 'project'];

  it('维度顺序不同但内容相同 → 同一个 key', () => {
    const a = combinationKey(
      [
        { dimensionCode: 'department', dimensionId: 'd1', dimensionValue: '研发部' },
        { dimensionCode: 'project', dimensionId: 'p1', dimensionValue: 'A 项目' },
      ],
      codes
    );
    const b = combinationKey(
      [
        { dimensionCode: 'project', dimensionId: 'p1', dimensionValue: 'A 项目' },
        { dimensionCode: 'department', dimensionId: 'd1', dimensionValue: '研发部' },
      ],
      codes
    );
    expect(a).toBe(b);
  });

  it('缺少某维度时 key 中标出 <缺>', () => {
    const key = combinationKey(
      [{ dimensionCode: 'department', dimensionId: 'd1', dimensionValue: '研发部' }],
      codes
    );
    expect(key).toBe('department:d1|project:<缺>');
  });

  it('维度值为空时用 <空> 占位（与"缺失"区分）', () => {
    const key = combinationKey(
      [
        { dimensionCode: 'department', dimensionId: null, dimensionValue: null },
        { dimensionCode: 'project', dimensionId: 'p1', dimensionValue: 'A' },
      ],
      codes
    );
    expect(key).toBe('department:<空>|project:p1');
  });
});

describe('D-03 多维度组合汇总', () => {
  const line = (
    lineId: string,
    debit: number,
    credit: number,
    dimensions: AuxLineForCombination['dimensions']
  ): AuxLineForCombination => ({ lineId, accountCode: '6602', debit, credit, dimensions });

  const dim = (code: string, id: string, value: string) => ({
    dimensionCode: code,
    dimensionId: id,
    dimensionValue: value,
  });

  it('同一组合的多行被合并，lineCount 正确', () => {
    const result = buildCombinations(
      [
        line('l1', 100, 0, [dim('department', 'd1', '研发部'), dim('project', 'p1', 'A')]),
        line('l2', 50, 0, [dim('department', 'd1', '研发部'), dim('project', 'p1', 'A')]),
      ],
      ['department', 'project']
    );
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].debit).toBe(150);
    expect(result.cells[0].lineCount).toBe(2);
  });

  it('不同组合分成多个单元格，按余额降序', () => {
    const result = buildCombinations(
      [
        line('l1', 100, 0, [dim('department', 'd1', '研发部'), dim('project', 'p1', 'A')]),
        line('l2', 300, 0, [dim('department', 'd2', '销售部'), dim('project', 'p2', 'B')]),
      ],
      ['department', 'project']
    );
    expect(result.cells).toHaveLength(2);
    expect(result.cells[0].balance).toBe(300);
    expect(result.cells[1].balance).toBe(100);
  });

  it('缺任一维度的行计入 uncovered，而不是塞进带 <缺> 的单元格', () => {
    const result = buildCombinations(
      [
        line('l1', 100, 0, [dim('department', 'd1', '研发部'), dim('project', 'p1', 'A')]),
        // 只挂了部门，没挂项目
        line('l2', 70, 0, [dim('department', 'd1', '研发部')]),
      ],
      ['department', 'project']
    );
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].debit).toBe(100);
    expect(result.uncovered.debit).toBe(70);
    expect(result.uncovered.lineCount).toBe(1);
    // 总额仍然完整
    expect(result.total.debit).toBe(170);
    // covered + uncovered === total
    expect(result.covered.debit + result.uncovered.debit).toBe(result.total.debit);
  });

  it('没有任何行时不产生 NaN，各项为 0', () => {
    const result = buildCombinations([], ['department', 'project']);
    expect(result.cells).toEqual([]);
    expect(result.total.debit).toBe(0);
    expect(result.uncovered.lineCount).toBe(0);
  });

  it('贷方金额产生负余额', () => {
    const result = buildCombinations(
      [line('l1', 0, 200, [dim('department', 'd1', '研发部'), dim('project', 'p1', 'A')])],
      ['department', 'project']
    );
    expect(result.cells[0].balance).toBe(-200);
  });

  it('只查询一个维度时，另一个维度的存在不影响结果', () => {
    const result = buildCombinations(
      [line('l1', 100, 0, [dim('department', 'd1', '研发部'), dim('project', 'p1', 'A')])],
      ['department']
    );
    expect(result.cells).toHaveLength(1);
    expect(result.uncovered.lineCount).toBe(0);
    expect(result.cells[0].values).toHaveLength(1);
  });
});

describe('D-03 组合覆盖度', () => {
  it('全部覆盖 → complete，消息肯定', () => {
    const result = buildCombinations(
      [
        {
          lineId: 'l1',
          accountCode: '6602',
          debit: 100,
          credit: 0,
          dimensions: [
            { dimensionCode: 'department', dimensionId: 'd1', dimensionValue: '研发部' },
            { dimensionCode: 'project', dimensionId: 'p1', dimensionValue: 'A' },
          ],
        },
      ],
      ['department', 'project']
    );
    const coverage = assessCombinationCoverage(result);
    expect(coverage.complete).toBe(true);
    expect(coverage.coverageRate).toBe(100);
    expect(coverage.message).toContain('可直接采信');
  });

  it('部分覆盖 → complete=false，消息含未覆盖金额与行数', () => {
    const result = buildCombinations(
      [
        {
          lineId: 'l1',
          accountCode: '6602',
          debit: 100,
          credit: 0,
          dimensions: [
            { dimensionCode: 'department', dimensionId: 'd1', dimensionValue: '研发部' },
            { dimensionCode: 'project', dimensionId: 'p1', dimensionValue: 'A' },
          ],
        },
        {
          lineId: 'l2',
          accountCode: '6602',
          debit: 300,
          credit: 0,
          dimensions: [
            { dimensionCode: 'department', dimensionId: 'd1', dimensionValue: '研发部' },
          ],
        },
      ],
      ['department', 'project']
    );
    const coverage = assessCombinationCoverage(result);
    expect(coverage.complete).toBe(false);
    expect(coverage.coverageRate).toBe(25);
    expect(coverage.message).toContain('300.00');
    expect(coverage.message).toContain('1 行');
    expect(coverage.message).toContain('不能直接当作科目总额使用');
  });

  it('空账 → 视为 100% 覆盖（没有数据不等于不可信）', () => {
    const coverage = assessCombinationCoverage(
      buildCombinations([], ['department'])
    );
    expect(coverage.coverageRate).toBe(100);
    expect(coverage.complete).toBe(true);
  });
});

describe('D-03 成本分摊（最大余数法）', () => {
  it('100 分 3 份：之和严格等于 100，且逐项差额不超过 1 分', () => {
    const result = allocateAmount({ amount: 100, weights: [1, 1, 1] });
    expect(sum(result.shares)).toBe(100);
    // 33.34 / 33.33 / 33.33
    // 注意：直接用浮点相减比较会得到 0.010000000000005116（二进制浮点表示误差），
    // 因此按"分"比较，与全仓金额比较口径一致
    const cents = result.shares.map((value) => Math.round(value * 100));
    expect(Math.max(...cents) - Math.min(...cents)).toBeLessThanOrEqual(1);
    expect(result.shares[0]).toBe(33.34);
  });

  it('关键回归：不加尾差补齐会少 1 分（证明该算法必要）', () => {
    const naive = [1, 1, 1].map(() => Math.round((100 / 3) * 100) / 100);
    expect(sum(naive)).toBe(99.99); // 朴素 round 丢失 1 分
    expect(sum(allocateAmount({ amount: 100, weights: [1, 1, 1] }).shares)).toBe(100);
  });

  it('按权重分摊：3:2:1 分 600', () => {
    const result = allocateAmount({ amount: 600, weights: [3, 2, 1] });
    expect(result.shares).toEqual([300, 200, 100]);
    expect(sum(result.shares)).toBe(600);
  });

  it('权重含小数时仍严格补齐', () => {
    const result = allocateAmount({
      amount: 1000,
      weights: [0.333, 0.333, 0.334],
    });
    expect(sum(result.shares)).toBe(1000);
  });

  it('大量项时逐项补齐：7 份分 1000', () => {
    const result = allocateAmount({
      amount: 1000,
      weights: [1, 2, 3, 4, 5, 6, 7],
    });
    expect(sum(result.shares)).toBe(1000);
    expect(result.shares).toHaveLength(7);
  });

  it('负数金额（冲回）之和严格等于负数，且逐项与原分摊互为相反数', () => {
    const forward = allocateAmount({ amount: 100, weights: [1, 1, 1] });
    const reverse = allocateAmount({ amount: -100, weights: [1, 1, 1] });
    expect(sum(reverse.shares)).toBe(-100);
    // 逐项相反：否则原分摊与冲回对不平，明细账会残留余额
    expect(reverse.shares).toEqual(forward.shares.map((v) => -v));
  });

  it('负权重按 0 处理（不产生倒扣）', () => {
    const result = allocateAmount({ amount: 100, weights: [1, -1, 1] });
    expect(result.shares[1]).toBe(0);
    expect(sum(result.shares)).toBe(100);
  });

  it('权重全为 0 → 默认平均分摊，并标记 equalFallback', () => {
    const result = allocateAmount({ amount: 90, weights: [0, 0, 0] });
    expect(result.equalFallback).toBe(true);
    expect(sum(result.shares)).toBe(90);
    expect(result.shares).toEqual([30, 30, 30]);
  });

  it('权重全为 0 且 fallback=reject → 抛错（由调用方决定是否允许平均分摊）', () => {
    expect(() =>
      allocateAmount({ amount: 90, weights: [0, 0, 0], fallback: 'reject' })
    ).toThrow(/权重为 0/);
  });

  it('金额为 0 → 全 0，不产生 ±0.01 噪声', () => {
    const result = allocateAmount({ amount: 0, weights: [1, 1, 1] });
    expect(result.shares).toEqual([0, 0, 0]);
  });

  it('空权重 → 空结果，不抛错', () => {
    const result = allocateAmount({ amount: 100, weights: [] });
    expect(result.shares).toEqual([]);
    expect(result.amount).toBe(0);
  });

  it('adjustCount 反映被补齐的项数（可向使用者解释尾差去向）', () => {
    const result = allocateAmount({ amount: 100, weights: [1, 1, 1] });
    // 100/3 → 33.333…，floor 后余 1 分，补 1 项
    expect(result.adjustedCount).toBe(1);
  });

  it('回归：多种权重组合下 sum(shares) 恒等于 amount', () => {
    const cases: Array<[number, number[]]> = [
      [100, [1, 1, 1]],
      [0.01, [1, 1, 1]],
      [0.03, [1, 1, 1]],
      [999.99, [7, 11, 13]],
      [-1234.56, [1, 2, 3, 4]],
      [1, [1, 1, 1, 1, 1, 1, 1]],
      [1000000, [1, 1, 1]],
    ];
    for (const [amount, weights] of cases) {
      const result = allocateAmount({ amount, weights });
      expect(`${amount}:${sum(result.shares)}`).toBe(`${amount}:${amount}`);
    }
  });
});

describe('D-03 组合请求校验', () => {
  const available = [
    { code: 'department', name: '部门', enabled: true },
    { code: 'project', name: '项目', enabled: true },
    { code: 'customer', name: '客户', enabled: true },
    { code: 'employee', name: '员工', enabled: false },
  ];

  it('空请求 → 报错', () => {
    expect(validateCombinationRequest([], available)).toHaveLength(1);
  });

  it('超过最大维度数 → 报错，并说明组合数增长的原因', () => {
    expect(MAX_COMBINATION_DIMENSIONS).toBe(3);
    const errors = validateCombinationRequest(
      ['department', 'project', 'customer', 'employee'],
      available
    );
    expect(errors.some((e) => e.includes('最多同时分析 3 个维度'))).toBe(true);
    expect(errors.some((e) => e.includes('指数增长'))).toBe(true);
  });

  it('不存在的维度 → 报错', () => {
    const errors = validateCombinationRequest(['nope'], available);
    expect(errors.some((e) => e.includes('不存在'))).toBe(true);
  });

  it('已停用的维度 → 报错，并指出是哪个维度', () => {
    const errors = validateCombinationRequest(['employee'], available);
    expect(errors.some((e) => e.includes('员工') && e.includes('已停用'))).toBe(true);
  });

  it('重复维度去重后不判为超限', () => {
    expect(
      validateCombinationRequest(
        ['department', 'department', 'project'],
        available
      )
    ).toEqual([]);
  });

  it('合法请求返回空错误数组', () => {
    expect(
      validateCombinationRequest(['department', 'project'], available)
    ).toEqual([]);
  });
});

describe('D-03 跨维度结构对比', () => {
  it('占比以本维度合计为分母（而非全局合计）', () => {
    const { rows, totalsByDimension } = buildCrossDimensionRows([
      { dimensionCode: 'department', dimensionValue: '研发部', balance: 300 },
      { dimensionCode: 'department', dimensionValue: '销售部', balance: 100 },
      { dimensionCode: 'customer', dimensionValue: '客户甲', balance: 50 },
    ]);
    const rd = rows.find((r) => r.dimensionValue === '研发部');
    // 300 / (300+100) = 75%，而不是 300/450
    expect(rd?.shareOfDimension).toBe(75);
    expect(
      totalsByDimension.find((t) => t.dimensionCode === 'department')?.total
    ).toBe(400);
    expect(
      totalsByDimension.find((t) => t.dimensionCode === 'customer')?.valueCount
    ).toBe(1);
  });

  it('维度合计为 0 时占比记 0，不产生 NaN/Infinity', () => {
    const { rows } = buildCrossDimensionRows([
      { dimensionCode: 'department', dimensionValue: 'A', balance: 100 },
      { dimensionCode: 'department', dimensionValue: 'B', balance: -100 },
    ]);
    for (const row of rows) {
      expect(Number.isFinite(row.shareOfDimension)).toBe(true);
    }
  });

  it('按余额降序排序', () => {
    const { rows } = buildCrossDimensionRows([
      { dimensionCode: 'department', dimensionValue: '小', balance: 10 },
      { dimensionCode: 'department', dimensionValue: '大', balance: 900 },
    ]);
    expect(rows[0].dimensionValue).toBe('大');
  });

  it('空输入返回空数组', () => {
    const { rows, totalsByDimension } = buildCrossDimensionRows([]);
    expect(rows).toEqual([]);
    expect(totalsByDimension).toEqual([]);
  });
});

describe('D-03 价税分离', () => {
  it('含税 1060、税率 6% → 净额 1000', () => {
    expect(netOfTax(1060, 6)).toBe(1000);
  });

  it('税率缺省用全仓兜底税率（6%）', () => {
    expect(netOfTax(1060, null)).toBe(1000);
    expect(netOfTax(1060, undefined)).toBe(1000);
  });

  it('0 税率时净额等于含税额', () => {
    expect(netOfTax(500, 0)).toBe(500);
  });

  it('非法税率不产生 NaN（按兜底处理）', () => {
    expect(Number.isFinite(netOfTax(1060, Number.NaN))).toBe(true);
  });
});
