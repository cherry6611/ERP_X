/**
 * 员工列表的 antd 列定义（§5.9 / F8）
 *
 * 从 `EmployeePanel.tsx` 抽出的列定义模块，与同目录的 `attendance-columns.tsx` 同一形态。
 *
 * ## 为什么用工厂函数而不是常量
 *
 * 「操作」列的四个按钮闭包了父组件的四个入口：打开编辑弹窗 / 试用期转正 / 停用启用 /
 * 打开离职弹窗。这些入口随父组件每次渲染而变，常量数组持有不了，因此导出
 * `employeeColumns({ ... })`，由父组件在渲染时调用、拿到列定义。
 *
 * ⚠️ 数组字面量本身是**逐字搬运** —— 列头文案、`fixed`、`width`、`dataIndex`、`render`
 * 全部未动，只有两处"父组件 setter 变 props"的替换：
 *   · `setEditTarget(record)`   → `onEdit(record)`
 *   · `setResignTarget(record)` → `onResign(record)`
 * `doConfirm` / `toggleActive` 以**同名**解构入参，所以那两处 `onClick` 一字未改。
 */
import { TableColumnsType } from 'antd';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import HrStatusBadge, {
  EMPLOYEE_STATUS_LABELS,
  EMPLOYMENT_TYPE_LABELS,
} from './HrStatusBadge';
import { Button } from '@client/src/components/ui/button';
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import type { Employee } from '@shared/api.interface';

interface EmployeeColumnsArgs {
  /** 打开「编辑员工」弹窗 */
  onEdit: (record: Employee) => void;
  /** 试用期转正（`updateEmployee(id, { status: 'active' })`） */
  onConfirm: (record: Employee) => void;
  /** 停用 / 启用（`setEmployeeStatus`） */
  onToggleActive: (record: Employee) => void;
  /** 打开「员工离职」弹窗 */
  onResign: (record: Employee) => void;
}

export function employeeColumns({
  onEdit,
  onConfirm: doConfirm,
  onToggleActive: toggleActive,
  onResign,
}: EmployeeColumnsArgs): TableColumnsType<Employee> {
  const columns: TableColumnsType<Employee> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 130 },
    { title: '姓名', dataIndex: 'name', width: 100 },
    { title: '部门', dataIndex: 'departmentName', width: 130, render: (v) => v ?? '-' },
    { title: '岗位', dataIndex: 'position', width: 130, render: (v) => v ?? '-' },
    { title: '角色', dataIndex: 'roleName', width: 110, render: (v) => v ?? '-' },
    { title: '入职日期', dataIndex: 'hireDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '用工类型',
      dataIndex: 'employmentType',
      width: 100,
      render: (v: string | null) =>
        (v && EMPLOYMENT_TYPE_LABELS[v]) || v || '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => (
        <HrStatusBadge status={s} labels={EMPLOYEE_STATUS_LABELS} />
      ),
    },
    {
      title: '飞书账号',
      dataIndex: 'platformUserId',
      width: 140,
      render: (v: string | null) =>
        v ? <UserDisplay value={[v]} size="small" /> : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_: unknown, record: Employee) => (
        <CanCapabilityWrite capability="hr_write">
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEdit(record)}
            >
              编辑
            </Button>
            {record.status === 'probation' ? (
              <Button variant="ghost" size="sm" onClick={() => void doConfirm(record)}>
                转正
              </Button>
            ) : null}
            {record.status === 'active' || record.status === 'inactive' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void toggleActive(record)}
              >
                {record.status === 'inactive' ? '启用' : '停用'}
              </Button>
            ) : null}
            {record.status !== 'resigned' ? (
              <Button variant="ghost" size="sm" onClick={() => onResign(record)}>
                离职
              </Button>
            ) : null}
          </div>
        </CanCapabilityWrite>
      ),
    },
  ];
  return columns;
}
