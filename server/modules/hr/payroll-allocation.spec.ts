/**
 * `payroll-allocation` 的规格：工资净额按工时分摊。
 *
 * 三组断言对应三种"界面上看不出来"的错法：
 *   ① `Σ分摊额 ≠ 净额`（忘找平）—— 每行数字都看起来对，差几分
 *   ② 找平用了非对称取整 —— 找平行变负，`-x.xx5` 上差 1 分
 *   ③ **红冲不对称** —— 原分摊 + 红冲分摊 ≠ 0，账上留残值而借贷仍平
 */
import { allocateByHours } from './payroll-allocation';

const sum = (items: Array<{ amount: number }>): number =>
  Math.round(items.reduce((a, b) => a + b.amount, 0) * 100) / 100;

describe('allocateByHours：分摊与找平', () => {
  it('按工时占比分摊', () => {
    const r = allocateByHours(1000, [
      { projectId: 'p1', totalHours: 60 },
      { projectId: 'p2', totalHours: 40 },
    ]);
    expect(r).toEqual([
      { projectId: 'p1', amount: 600 },
      { projectId: 'p2', amount: 400 },
    ]);
  });

  it('⚠️ 尾差归最后一行：Σ 必须**恰好等于**净额', () => {
    /* 1000 / 3 => 333.33 + 333.33 + 333.34 */
    const r = allocateByHours(1000, [
      { projectId: 'p1', totalHours: 1 },
      { projectId: 'p2', totalHours: 1 },
      { projectId: 'p3', totalHours: 1 },
    ]);
    expect(sum(r)).toBe(1000);
    expect(r[0].amount).toBe(333.33);
    expect(r[1].amount).toBe(333.33);
    expect(r[2].amount).toBe(333.34);
  });

  it('⚠️ 除不尽的场景：Σ 恒等于净额（多组随机组合）', () => {
    const cases: Array<{ net: number; hours: number[] }> = [
      { net: 12345.67, hours: [7, 13, 29] },
      { net: 0.03, hours: [1, 1, 1] },
      { net: 999.99, hours: [1, 2, 3, 4, 5] },
      { net: 10000, hours: [3, 7] },
      { net: 1.01, hours: [1, 1] },
    ];
    for (const { net, hours } of cases) {
      const rows = hours.map((h, i) => ({ projectId: `p${i}`, totalHours: h }));
      expect({ net, sum: sum(allocateByHours(net, rows)) }).toEqual({ net, sum: net });
    }
  });

  it('单行：直接拿全额', () => {
    expect(allocateByHours(8888.88, [{ projectId: 'p1', totalHours: 5 }])).toEqual([
      { projectId: 'p1', amount: 8888.88 },
    ]);
  });

  it('两行且整除：无需找平', () => {
    const r = allocateByHours(500, [
      { projectId: 'p1', totalHours: 1 },
      { projectId: 'p2', totalHours: 1 },
    ]);
    expect(r).toEqual([
      { projectId: 'p1', amount: 250 },
      { projectId: 'p2', amount: 250 },
    ]);
  });
});

describe('allocateByHours：过滤与边界', () => {
  it('空数组 → 空结果', () => {
    expect(allocateByHours(1000, [])).toEqual([]);
  });

  it('总工时 0 → 空结果（不产生 NaN/Infinity 分摊）', () => {
    expect(allocateByHours(1000, [{ projectId: 'p1', totalHours: 0 }])).toEqual([]);
  });

  it('⚠️ 工时 ≤ 0 或 projectId 为空的行被**过滤**（不占一行、不参与分摊）', () => {
    const r = allocateByHours(1000, [
      { projectId: 'p1', totalHours: 10 },
      { projectId: null, totalHours: 10 },
      { projectId: 'p3', totalHours: 0 },
      { projectId: 'p4', totalHours: -5 },
      { projectId: 'p5', totalHours: 10 },
    ]);
    expect(r.map((x) => x.projectId)).toEqual(['p1', 'p5']);
    expect(sum(r)).toBe(1000);
  });

  it('工时是字符串（pg 驱动 numeric）也参与计算', () => {
    const r = allocateByHours(1000, [
      { projectId: 'p1', totalHours: '60' },
      { projectId: 'p2', totalHours: '40' },
    ]);
    expect(r).toEqual([
      { projectId: 'p1', amount: 600 },
      { projectId: 'p2', amount: 400 },
    ]);
  });

  it('净额为 0 → 每行 0，Σ = 0', () => {
    const r = allocateByHours(0, [
      { projectId: 'p1', totalHours: 3 },
      { projectId: 'p2', totalHours: 7 },
    ]);
    expect(r.every((x) => x.amount === 0)).toBe(true);
    expect(sum(r)).toBe(0);
  });

  it('净额为负（红冲）也按比例分摊且 Σ 等于净额', () => {
    const r = allocateByHours(-1000, [
      { projectId: 'p1', totalHours: 60 },
      { projectId: 'p2', totalHours: 40 },
    ]);
    expect(r).toEqual([
      { projectId: 'p1', amount: -600 },
      { projectId: 'p2', amount: -400 },
    ]);
    expect(sum(r)).toBe(-1000);
  });
});

describe('⚠️ 红冲对称性：分摊(net) 逐项 + 分摊(−net) 逐项 = 0', () => {
  it('整除场景', () => {
    const rows = [
      { projectId: 'p1', totalHours: 60 },
      { projectId: 'p2', totalHours: 40 },
    ];
    const a = allocateByHours(1000, rows);
    const b = allocateByHours(-1000, rows);
    a.forEach((item, i) => expect(item.amount + b[i].amount).toBe(0));
  });

  it('⚠️ 除不尽 / 尾差场景也必须逐项为 0（这是 `round2` 对称性的直接用途）', () => {
    const rows = [
      { projectId: 'p1', totalHours: 1 },
      { projectId: 'p2', totalHours: 1 },
      { projectId: 'p3', totalHours: 1 },
    ];
    const a = allocateByHours(1000, rows);
    const b = allocateByHours(-1000, rows);
    a.forEach((item, i) => {
      expect({ i, sum: item.amount + b[i].amount }).toEqual({ i, sum: 0 });
    });
    /* 尾差行也对称 */
    expect(a[2].amount).toBe(333.34);
    expect(b[2].amount).toBe(-333.34);
  });

  it('⚠️ 差 1 分的边界（-x.xx5）：对称性仍成立', () => {
    /* 让某行恰好落在半分上：net 1000.05、两行 1:1 → 500.025 */
    const rows = [
      { projectId: 'p1', totalHours: 1 },
      { projectId: 'p2', totalHours: 1 },
    ];
    const a = allocateByHours(1000.05, rows);
    const b = allocateByHours(-1000.05, rows);
    a.forEach((item, i) => expect(item.amount + b[i].amount).toBe(0));
    expect(sum(a)).toBe(1000.05);
    expect(sum(b)).toBe(-1000.05);
  });

  it('单行场景同样对称', () => {
    const rows = [{ projectId: 'p1', totalHours: 7 }];
    expect(allocateByHours(123.45, rows)[0].amount + allocateByHours(-123.45, rows)[0].amount).toBe(0);
  });
});
