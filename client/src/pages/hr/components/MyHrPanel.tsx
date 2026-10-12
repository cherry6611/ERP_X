import React from 'react';
import { CalendarCheck, Sun, User, Wallet } from 'lucide-react';
import HrStatusBadge, {
  ATTENDANCE_STATUS_LABELS,
  EMPLOYEE_STATUS_LABELS,
  LEAVE_TYPE_LABELS,
} from './HrStatusBadge';
import { Button } from '@client/src/components/ui/button';
import { hrApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import type {
  AttendanceRecord,
  LeaveBalance,
  MyHrSummary,
  PayrollItem,
} from '@shared/api.interface';

const MyHrPanel: React.FC = () => {
  const { data, loading, error, reload } = useAsyncData<MyHrSummary>(
    () => hrApi.getMyHrSummary(),
    [],
  );

  if (loading) {
    return <p className="text-sm text-muted-foreground">自助中心加载中...</p>;
  }
  if (error) {
    return (
      <p className="text-sm text-destructive">
        {error}
        <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reload()}>
          重试
        </Button>
      </p>
    );
  }
  if (!data) {
    return <p className="text-sm text-muted-foreground">暂无自助中心数据</p>;
  }
  if (!data.employee) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          当前账号未绑定员工档案，请联系管理员在员工档案中绑定飞书账号
        </p>
      </div>
    );
  }

  const employee = data.employee;
  const attendance: AttendanceRecord[] = data.attendance ?? [];
  const balances: LeaveBalance[] = data.leaveBalances ?? [];
  const payrolls: PayrollItem[] = data.payrolls ?? [];

  return (
    <div className="flex flex-col gap-6">
      <h3 className="text-base font-semibold">员工自助中心</h3>
      <div className="grid grid-cols-2 gap-4">
        <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <User className="size-4" />
            我的档案
          </h4>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <p>
              <span className="text-muted-foreground">姓名：</span>
              {employee.name}
            </p>
            <p>
              <span className="text-muted-foreground">工号：</span>
              {employee.code}
            </p>
            <p>
              <span className="text-muted-foreground">部门：</span>
              {employee.departmentName ?? '-'}
            </p>
            <p>
              <span className="text-muted-foreground">岗位：</span>
              {employee.position ?? '-'}
            </p>
            <p className="flex items-center gap-1">
              <span className="text-muted-foreground">状态：</span>
              <HrStatusBadge status={employee.status} labels={EMPLOYEE_STATUS_LABELS} />
            </p>
            <p>
              <span className="text-muted-foreground">入职日期：</span>
              {employee.hireDate ?? '-'}
            </p>
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <CalendarCheck className="size-4" />
            本月考勤
          </h4>
          {attendance.length > 0 ? (
            <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto pr-1">
              {attendance.map((record: AttendanceRecord) => (
                <li
                  key={record.id}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span>{record.workDate}</span>
                  <HrStatusBadge
                    status={record.status}
                    labels={ATTENDANCE_STATUS_LABELS}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">本月暂无考勤记录</p>
          )}
        </section>

        <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <Sun className="size-4" />
            我的假期余额
          </h4>
          {balances.length > 0 ? (
            <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto pr-1">
              {balances.map((balance: LeaveBalance) => (
                <li
                  key={balance.id}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span>{LEAVE_TYPE_LABELS[balance.leaveType] ?? balance.leaveType}</span>
                  <span className="tabular-nums text-muted-foreground">
                    总 {balance.totalDays} 天 / 已用 {balance.usedDays} 天 / 剩余{' '}
                    {balance.remainingDays} 天
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">本年暂无假期余额</p>
          )}
        </section>

        <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <Wallet className="size-4" />
            我的工资条
          </h4>
          {payrolls.length > 0 ? (
            <div className="flex max-h-80 flex-col gap-3 overflow-y-auto pr-1">
              {payrolls.map((payroll: PayrollItem) => (
                <div key={payroll.id} className="flex flex-col gap-2 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{payroll.period}</span>
                    <span className="text-sm font-semibold tabular-nums">
                      实发 {formatMoney(payroll.netSalary)}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <p>基本 {formatMoney(payroll.baseSalary)}</p>
                    <p>绩效 {formatMoney(payroll.perfSalary)}</p>
                    <p>津贴 {formatMoney(payroll.allowance)}</p>
                    <p>社保 {formatMoney(payroll.socialInsurance)}</p>
                    <p>公积金 {formatMoney(payroll.housingFund)}</p>
                    <p>个税 {formatMoney(payroll.tax)}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">暂无已审批工资单</p>
          )}
        </section>
      </div>
    </div>
  );
};

export default MyHrPanel;
