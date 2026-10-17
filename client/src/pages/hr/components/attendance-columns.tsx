/**
 * 考勤 / 补卡 / 请假三张表的列定义
 *
 * §5.9（F8）：从 `AttendancePanel.tsx` 抽出的列定义模块。
 *
 * ## 与 `attendance-panel-model.balanceColumns` 的分工
 *
 * `balanceColumns`（请假余额表）在 `attendance-panel-model.ts` 里：它**纯** ——
 * 无 JSX、无闭包，能被 jest 逐列断言。本文件的三个列定义做不到：它们的 `render`
 * 里是 `<HrStatusBadge>` / `<Button>` / `<CanCapabilityWrite>`，并闭包了
 * "批准/驳回"的提交处理函数，因此**不能**放进零 React 依赖的模型模块（那会把
 * React 拉进单测的纯逻辑层）。
 *
 * 但"不能单测"不等于"应该留在 1000 行的页面主文件里"——
 * 三个列定义共 90 余行，且**改错看不出来**（通过/驳回挂错处理函数时按钮照样能点，
 * 只是打到了错误的接口）。因此它们被搬到本模块，由页面组件注入处理函数。
 *
 * ## 为什么用工厂函数而不是常量
 *
 * 三个 `render` 都闭包了组件层的东西：跳详情页的路由函数与两个提交处理函数。
 * 常量数组无法持有这些（它们随父组件每次渲染而变），所以导出 `attendanceColumns({...})`
 * 由父组件在渲染时调用、拿到列定义。⚠️ 数组字面量本身是**逐字搬运**，只加了外层
 * `return` 与三个入参 —— 列头文案、宽度、`fixed`、`dataIndex`、`render` 全未动。
 */
import { TableColumnsType } from 'antd';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import HrStatusBadge, {
  ATTENDANCE_STATUS_LABELS,
  LEAVE_STATUS_LABELS,
  LEAVE_TYPE_LABELS,
} from './HrStatusBadge';
import { AMENDMENT_STATUS_LABELS } from './attendance-panel-model';
import { Button } from '@client/src/components/ui/button';
import type {
  AttendanceAmendment,
  AttendanceAmendmentAction,
  AttendanceRecord,
  LeaveRequest,
  LeaveRequestAction,
} from '@shared/api.interface';

interface AttendanceColumnsArgs {
  /** 打开请假单详情（`navigate('/hr/leaves/:id')`） */
  onOpenLeave: (record: LeaveRequest) => void;
  onLeaveAction: (record: LeaveRequest, action: LeaveRequestAction) => void;
  onAmendmentAction: (
    record: AttendanceAmendment,
    action: AttendanceAmendmentAction,
  ) => void;
}

export function attendanceColumns({
  onOpenLeave,
  onLeaveAction,
  onAmendmentAction: doAmendmentAction,
}: AttendanceColumnsArgs): {
  attColumns: TableColumnsType<AttendanceRecord>;
  amendmentColumns: TableColumnsType<AttendanceAmendment>;
  leaveColumns: TableColumnsType<LeaveRequest>;
} {
  const attColumns: TableColumnsType<AttendanceRecord> = [
    { title: '日期', dataIndex: 'workDate', fixed: 'left', width: 120 },
    { title: '员工', dataIndex: 'employeeName', width: 120 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (s: string) => (
        <HrStatusBadge status={s} labels={ATTENDANCE_STATUS_LABELS} />
      ),
    },
    { title: '备注', dataIndex: 'remark', width: 220, render: (v) => v ?? '-' },
  ];

  const amendmentColumns: TableColumnsType<AttendanceAmendment> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '员工', dataIndex: 'employeeName', width: 110 },
    { title: '日期', dataIndex: 'workDate', width: 110 },
    { title: '原因', dataIndex: 'reason', width: 220 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <HrStatusBadge status={s} labels={AMENDMENT_STATUS_LABELS} />,
    },
    { title: '创建时间', dataIndex: 'createdAt', width: 170 },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_: unknown, record: AttendanceAmendment) =>
        record.status === 'pending' ? (
          <CanCapabilityWrite capability="hr_write">
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void doAmendmentAction(record, 'approve')}
              >
                通过
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => void doAmendmentAction(record, 'reject')}
              >
                驳回
              </Button>
            </div>
          </CanCapabilityWrite>
        ) : null,
    },
  ];

  const leaveColumns: TableColumnsType<LeaveRequest> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '员工', dataIndex: 'employeeName', width: 110 },
    {
      title: '类型',
      dataIndex: 'leaveType',
      width: 80,
      render: (v: string) => LEAVE_TYPE_LABELS[v] ?? v,
    },
    { title: '开始日期', dataIndex: 'startDate', width: 110 },
    { title: '结束日期', dataIndex: 'endDate', width: 110 },
    { title: '天数', dataIndex: 'days', width: 70 },
    { title: '事由', dataIndex: 'reason', width: 180, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <HrStatusBadge status={s} labels={LEAVE_STATUS_LABELS} />,
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_: unknown, record: LeaveRequest) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => onOpenLeave(record)}>
            详情
          </Button>

          {record.status === 'pending' ? (
            <CanCapabilityWrite capability="hr_write">
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void onLeaveAction(record, 'approve')}
                >
                  批准
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => void onLeaveAction(record, 'reject')}
                >
                  驳回
                </Button>
              </div>
            </CanCapabilityWrite>
          ) : null}
        </div>
      ),
    },
  ];

  return { attColumns, amendmentColumns, leaveColumns };
}
