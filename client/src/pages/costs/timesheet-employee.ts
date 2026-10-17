/**
 * 「工时登记」表单的**纯规则**：员工可选集合、选中员工的角色回填、锁定判定。
 *
 * ## 为什么单独成模块
 *
 * 这三条规则原先内联在 `TimesheetsTab.tsx` 里，而它们恰好对应一条**只查库才能发现**
 * 的缺陷（详见下方 `pickableEmployees` 的注释）：界面允许在员工下拉里选任意人，
 * 而服务端只会按"当前账号绑定的员工"落库 —— 用户选了 A、库里记了 B，界面毫无提示。
 * 内联在组件里时这段判据**无法单测**；搬到本模块后即可逐条断言
 * （`timesheet-employee.spec.ts`）。
 *
 * 判据（与服务端 `CostsService.createTimesheet` 的员工解析顺序一致）：
 *   ① 先按 `feishu_union_id / platform_user_id` 找**当前账号绑定的员工**；
 *   ② 只有①没找到（本人未绑定员工）时才采用请求体里的 `employeeId` 代登。
 * 因此「本人已绑定」时，员工选择必须锁死为本人。
 */
import type { Employee } from '@shared/api.interface';

/** 在职（未离职）员工。离职员工不能登记工时，服务端也会拒。 */
export function activeEmployeesOf(employees: Employee[] | undefined): Employee[] {
  return (employees ?? []).filter((e: Employee) => e.status !== 'resigned');
}

/**
 * 员工下拉里**允许被选**的候选人。
 *
 * - `boundEmployeeId` 有值 → 只可能是本人（服务端会忽略 `employeeId`）；
 * - 为 `null`/`undefined`（本人未绑定员工，典型是管理员代登）→ 全部在职员工。
 *
 * ⚠️ 已绑定时返回的是**只含本人**的数组；调用方据此把字段渲染成只读，
 * 不要渲染成只有一个选项的下拉 —— 后者仍会让用户以为"可以选"。
 */
export function pickableEmployees(
  activeEmployees: Employee[],
  boundEmployeeId: string | null | undefined,
): Employee[] {
  if (!boundEmployeeId) return activeEmployees;
  return activeEmployees.filter((e: Employee) => e.id === boundEmployeeId);
}

/** 选中某员工时应当回填的角色名（无岗位角色时为 `''`，由用户自行选择） */
export function roleNameForEmployee(
  activeEmployees: Employee[],
  employeeId: string,
): string {
  return (
    activeEmployees.find((e: Employee) => e.id === employeeId)?.roleName ?? ''
  );
}

/**
 * 提交时真正会生效的角色名。
 *
 * 口径与服务端 `const roleName = employee.roleName || dto.roleName || null` 一致：
 * **岗位角色优先**，只有岗位没配角色时才用表单里手选的角色。
 * （早期版本传了员工却让手选角色覆盖岗位角色，于是"无费率角色"用例静默变成有费率。）
 */
export function effectiveRoleName(
  activeEmployees: Employee[],
  employeeId: string,
  formRoleName: string | null | undefined,
): string {
  return roleNameForEmployee(activeEmployees, employeeId) || formRoleName || '';
}

/** 角色字段是否应锁定为只读（岗位已配角色 → 不允许手改，避免与费率口径分叉） */
export function isRoleLocked(
  activeEmployees: Employee[],
  employeeId: string,
): boolean {
  return Boolean(roleNameForEmployee(activeEmployees, employeeId));
}
