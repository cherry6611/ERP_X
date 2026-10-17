/**
 * `timesheet-form` 的规格：工时登记的数值边界。
 *
 * 这一组断言防的是"**误输被静默接受**"：工时没有上限时，`240` 会被当成合法值
 * 一路走到成本归集（`金额 = 工时 × 日费率`），把 10 倍成本记进项目，
 * 而界面上只显示"工时已登记"—— 没有任何一处报错。
 */
import { timesheetSchema } from './timesheet-form';

const base = {
  projectId: 'p-1',
  employeeId: 'e-1',
  roleName: '开发',
  workDate: '2026-10-01',
  remark: '',
};

const parse = (hours: unknown) => timesheetSchema.safeParse({ ...base, hours });

describe('timesheetSchema', () => {
  it('正常工时（8 小时）通过', () => {
    const r = parse(8);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.hours).toBe(8);
  });

  it('半小时粒度可报（0.5）', () => {
    expect(parse(0.5).success).toBe(true);
  });

  it('⚠️ 上限 24 小时：25 被拒（一天不可能超过 24 小时）', () => {
    expect(parse(25).success).toBe(false);
  });

  it('⚠️ 误输量级（240）必须被拒 —— 否则 10 倍成本静默进项目', () => {
    expect(parse(240).success).toBe(false);
  });

  it('恰好 24 通过（边界包含）', () => {
    expect(parse(24).success).toBe(true);
  });

  it('小于 0.5 被拒（不足半小时不单独立项）', () => {
    expect(parse(0.4).success).toBe(false);
    expect(parse(0).success).toBe(false);
  });

  it('负数被拒', () => {
    expect(parse(-8).success).toBe(false);
  });

  it('⚠️ 字符串数字按 coerce 转换（输入框给的是字符串）', () => {
    const r = parse('8');
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.hours).toBe(8);
      expect(typeof r.data.hours).toBe('number');
    }
  });

  it('非数字字符串被拒（不能变成 NaN 一路带下去）', () => {
    expect(parse('abc').success).toBe(false);
  });

  it('项目/员工/角色/日期四项必填', () => {
    for (const key of ['projectId', 'employeeId', 'roleName', 'workDate'] as const) {
      const r = timesheetSchema.safeParse({ ...base, hours: 8, [key]: '' });
      expect(r.success).toBe(false);
    }
  });
});
