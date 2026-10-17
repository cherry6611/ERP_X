/**
 * `timesheet-employee.ts` 的单测。
 *
 * 这些断言全部对应**真实缺陷**（不是形式化覆盖）：
 *   · 「本人已绑定时员工必须锁定为本人」——否则界面选了 A、服务端按绑定记 B；
 *   · 「岗位角色优先于手选角色」——否则"无费率角色"用例会静默用上有费率的角色，
 *     确认时不再被拦，等于把费率闸门的验收测没了。
 */
import {
  activeEmployeesOf,
  effectiveRoleName,
  isRoleLocked,
  pickableEmployees,
  roleNameForEmployee,
} from './timesheet-employee';
import type { Employee } from '@shared/api.interface';

const emp = (over: Partial<Employee>): Employee =>
  ({
    id: 'e1',
    code: 'EMP1',
    name: '张三',
    status: 'active',
    roleName: null,
    ...over,
  }) as Employee;

const A = emp({ id: 'a', name: '甲', roleName: '数据工程师' });
const B = emp({ id: 'b', name: '乙', roleName: null });
const C = emp({ id: 'c', name: '丙', roleName: '外包', status: 'resigned' });
const ALL = [A, B, C];

describe('activeEmployeesOf', () => {
  it('过滤掉离职员工，保留在职（含 probation）', () => {
    expect(activeEmployeesOf(ALL).map((e) => e.id)).toEqual(['a', 'b']);
  });
  it('undefined 视为空列表（加载中）', () => {
    expect(activeEmployeesOf(undefined)).toEqual([]);
  });
  it('probation 不算离职', () => {
    expect(activeEmployeesOf([emp({ id: 'p', status: 'probation' })])).toHaveLength(1);
  });
});

describe('pickableEmployees（本缺陷的核心判据）', () => {
  it('本人已绑定员工 → 只有本人可选（服务端会忽略 employeeId）', () => {
    expect(pickableEmployees(activeEmployeesOf(ALL), 'b').map((e) => e.id)).toEqual(['b']);
  });
  it('本人未绑定（管理员代登）→ 全部在职员工可选', () => {
    expect(pickableEmployees(activeEmployeesOf(ALL), null).map((e) => e.id)).toEqual(['a', 'b']);
  });
  it('本人已绑定但该员工已离职 → 候选为空（不让界面假装能选）', () => {
    expect(pickableEmployees(activeEmployeesOf(ALL), 'c')).toEqual([]);
  });
  it('不得返回离职员工', () => {
    expect(pickableEmployees(activeEmployeesOf(ALL), null).some((e) => e.status === 'resigned')).toBe(false);
  });
});

describe('roleNameForEmployee / isRoleLocked', () => {
  it('岗位有角色 → 回填且锁定', () => {
    expect(roleNameForEmployee(ALL, 'a')).toBe('数据工程师');
    expect(isRoleLocked(ALL, 'a')).toBe(true);
  });
  it('岗位无角色 → 空串且不锁定（允许手选）', () => {
    expect(roleNameForEmployee(ALL, 'b')).toBe('');
    expect(isRoleLocked(ALL, 'b')).toBe(false);
  });
  it('找不到员工 → 空串且不锁定', () => {
    expect(roleNameForEmployee(ALL, 'nope')).toBe('');
    expect(isRoleLocked(ALL, 'nope')).toBe(false);
  });
});

describe('effectiveRoleName（岗位角色优先，与服务端口径一致）', () => {
  it('岗位有角色时，手选角色不得覆盖它', () => {
    expect(effectiveRoleName(ALL, 'a', '别的角色')).toBe('数据工程师');
  });
  it('岗位无角色时才采用手选角色', () => {
    expect(effectiveRoleName(ALL, 'b', '手选角色')).toBe('手选角色');
  });
  it('两者都没有 → 空串（调用方据此提示"缺少角色"）', () => {
    expect(effectiveRoleName(ALL, 'b', '')).toBe('');
    expect(effectiveRoleName(ALL, 'b', null)).toBe('');
  });
});
