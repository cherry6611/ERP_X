/**
 * B-02 数据级权限：`applyScope` 生成的 SQL 条件语义。
 *
 * 断言方式：用真实的 Drizzle 列（`erp_project` / `md_employee` / `erp_ar`）
 * 构造条件，再用 `PgDialect.sqlToQuery()` 编译成**带占位符的真实 SQL 文本 + 参数数组**，
 * 因此断言的是"数据库实际会执行什么"，不是对条件对象的同义反复快照。
 *
 * 覆盖需求书 B-02 要求的三条硬性口径：
 *   - `all` 不加条件（返回 undefined，不产生任何 WHERE 片段）
 *   - `self` 绑定本人
 *   - `dept` 绑定本部门
 * 并额外覆盖 dept_and_child / custom / fail-closed / bypass。
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import { erpAr, erpProject, mdEmployee } from '@server/database/schema';
import {
  SCOPE_FAIL_CLOSED,
  applyScope,
  pickScopeColumn,
  type DataScopeContext,
  type ResolvedScope,
} from './data-scope.service';

const dialect = new PgDialect();

function compile(condition: ReturnType<typeof applyScope>): {
  sql: string;
  params: unknown[];
} {
  if (!condition) throw new Error('期望生成 SQL 条件，实际为 undefined');
  const query = dialect.sqlToQuery(condition);
  return { sql: query.sql, params: query.params };
}

function resolved(
  scope: ResolvedScope['scope'],
  customIds: string[] = [],
  from: ResolvedScope['from'] = 'config'
): ResolvedScope {
  return { roleCode: 'hr_manager', resourceType: 'employee', scope, customIds, from };
}

const ctx: DataScopeContext = {
  userId: 'user-1',
  departmentIds: ['dept-A', 'dept-A-1'],
  departmentNames: ['研发部', '研发一组'],
};

describe('B-02 applyScope：SQL 层行级过滤条件', () => {
  it('all：不加任何条件（undefined，不污染 WHERE）', () => {
    expect(applyScope(mdEmployee.id, resolved('all'), ctx)).toBeUndefined();
  });

  it('bypass：管理员显式绕过，同样不加条件', () => {
    expect(
      applyScope(mdEmployee.id, resolved('all'), { ...ctx, bypass: true })
    ).toBeUndefined();
    // 即使配置要求收窄，bypass 也直接放行
    expect(
      applyScope(mdEmployee.id, resolved('dept_and_child'), {
        ...ctx,
        bypass: true,
      })
    ).toBeUndefined();
  });

  it('self：绑定本人（比较值为 ctx.userId）', () => {
    const { sql: text, params } = compile(
      applyScope(erpProject.pmUserId, resolved('self'), ctx)
    );
    expect(text).toBe('"erp_project"."pm_user_id" = $1');
    expect(params).toEqual(['user-1']);
  });

  it('self：资源以员工为主键时用 selfValue（考勤按 employee_id 过滤）', () => {
    const { sql: text, params } = compile(
      applyScope(erpAr.ownerUserId, resolved('self'), {
        ...ctx,
        selfValue: 'emp-9',
      })
    );
    expect(text).toBe('"erp_ar"."owner_user_id" = $1');
    expect(params).toEqual(['emp-9']);
  });

  it('dept：绑定本部门（IN 本部门集合）', () => {
    const { sql: text, params } = compile(
      applyScope(mdEmployee.departmentId, resolved('dept'), {
        ...ctx,
        departmentIds: ['dept-A'],
      })
    );
    expect(text).toBe('"md_employee"."department_id" in ($1)');
    expect(params).toEqual(['dept-A']);
  });

  it('dept_and_child：绑定本部门及下级（多个 id 全部进参数）', () => {
    const { sql: text, params } = compile(
      applyScope(mdEmployee.departmentId, resolved('dept_and_child'), ctx)
    );
    expect(text).toBe('"md_employee"."department_id" in ($1, $2)');
    expect(params).toEqual(['dept-A', 'dept-A-1']);
  });

  it('dept_and_child：部门名称口径（erp_project.dept_name 按名称存归属）', () => {
    const { sql: text, params } = compile(
      applyScope(erpProject.deptName, resolved('dept_and_child'), {
        ...ctx,
        departmentValueKind: 'name',
      })
    );
    expect(text).toBe('"erp_project"."dept_name" in ($1, $2)');
    expect(params).toEqual(['研发部', '研发一组']);
  });

  it('custom：绑定显式 id 列表', () => {
    const { sql: text, params } = compile(
      applyScope(mdEmployee.id, resolved('custom', ['e-1', 'e-2', 'e-1']), ctx)
    );
    expect(text).toBe('"md_employee"."id" in ($1, $2)');
    // 去重且保持顺序
    expect(params).toEqual(['e-1', 'e-2']);
  });

  it('fail-closed：custom 但列表为空 → 永假条件（返回空集而非全量）', () => {
    const condition = applyScope(mdEmployee.id, resolved('custom', []), ctx);
    expect(condition).toBe(SCOPE_FAIL_CLOSED);
    expect(compile(condition).sql).toBe('1 = 0');
  });

  it('fail-closed：dept 但拿不到部门 → 永假条件', () => {
    const condition = applyScope(mdEmployee.departmentId, resolved('dept'), {
      userId: 'user-1',
      departmentIds: [],
    });
    expect(condition).toBe(SCOPE_FAIL_CLOSED);
    expect(compile(condition).sql).toBe('1 = 0');
  });

  it('fail-closed：self 但 userId 为空 → 永假条件', () => {
    const condition = applyScope(erpProject.pmUserId, resolved('self'), {
      userId: '   ',
    });
    expect(condition).toBe(SCOPE_FAIL_CLOSED);
  });

  it('fail-closed：scope=none（未配置即拒绝）即使 ctx 完整也返回永假条件', () => {
    // P1-7 的核心断言：ctx 越完整越容易让人以为"有归属就能看到"，
    // 但 none 的语义是"没有配置行就不给数据"，与 actor 归属性无关。
    const condition = applyScope(
      mdEmployee.departmentId,
      resolved('none'),
      ctx
    );
    expect(condition).toBe(SCOPE_FAIL_CLOSED);
    expect(compile(condition).sql).toBe('1 = 0');
  });

  it('none：bypass（管理员/系统任务）仍优先放行，避免后台任务被权限误伤', () => {
    expect(
      applyScope(mdEmployee.id, resolved('none'), { userId: 'u', bypass: true })
    ).toBeUndefined();
  });

  it('空白/重复值被清洗，不会生成 IN () 这种语法错误', () => {
    const { sql: text, params } = compile(
      applyScope(mdEmployee.departmentId, resolved('dept_and_child'), {
        ...ctx,
        departmentIds: [' dept-A ', 'dept-A', '', 'dept-B'],
      })
    );
    expect(text).toBe('"md_employee"."department_id" in ($1, $2)');
    expect(params).toEqual(['dept-A', 'dept-B']);
  });

  it('pickScopeColumn：按 scope 选择正确的比较列', () => {
    const columns = {
      primary: mdEmployee.id,
      self: mdEmployee.platformUserId,
      dept: mdEmployee.departmentId,
    };
    expect(pickScopeColumn(columns, 'self')).toBe(mdEmployee.platformUserId);
    expect(pickScopeColumn(columns, 'dept')).toBe(mdEmployee.departmentId);
    expect(pickScopeColumn(columns, 'dept_and_child')).toBe(
      mdEmployee.departmentId
    );
    expect(pickScopeColumn(columns, 'custom')).toBe(mdEmployee.id);
    expect(pickScopeColumn(columns, 'all')).toBe(mdEmployee.id);
    // 未提供对应列时回退到 primary（避免拼出 undefined 列）
    expect(pickScopeColumn({ primary: mdEmployee.id }, 'self')).toBe(mdEmployee.id);
  });
});
