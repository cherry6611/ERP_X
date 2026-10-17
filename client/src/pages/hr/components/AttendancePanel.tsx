import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table } from 'antd';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { LEAVE_STATUS_LABELS } from './HrStatusBadge';
import { balanceColumns } from './attendance-panel-model';
import { attendanceColumns } from './attendance-columns';
import AmendmentSection from './dialogs/AmendmentSection';
import AttendanceDialog from './dialogs/AttendanceDialog';
import BalanceDialog from './dialogs/BalanceDialog';
import LeaveDialog from './dialogs/LeaveDialog';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { hrApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { currentPeriod, currentBizYear } from '@client/src/utils/format';
import type {
  AttendanceAmendment,
  AttendanceAmendmentAction,
  AttendanceRecord,
  Employee,
  LeaveBalance,
  LeaveRequest,
  LeaveRequestAction,
} from '@shared/api.interface';

/*
 * 本面板的声明式纯逻辑在 `./attendance-panel-model`：补卡状态文案、4 个表单
 * schema（与 `useForm` 用的 input/output 类型别名）、4 份表单默认值、`balanceColumns`。
 * 它们零 React 依赖，因此能被 jest 逐条断言 —— 而这几块恰恰是"看代码看不出错"的地方：
 * schema 的门槛只在提交那一刻以 toast 一闪而过；默认值原先在 `useForm` 与提交后的
 * `reset` 里各写了一遍、会各自漂移；`balanceColumns` 把「已用（天）」与「剩余（天）」
 * 配错字段后两列都还是合理数字。
 *
 * 4 个表单（补卡 / 登记考勤 / 新建请假 / 额度设置）在 `./dialogs/` 下各自成文件：
 * 它们**自持** `useForm`、`operating` 与提交处理函数，本文件只给数据与
 * `onSaved`（即下面的 `reloadAmd` / `reloadAtt` / `reloadLeave` / `reloadBal`）。
 * `attColumns` / `amendmentColumns` / `leaveColumns` 在 `./attendance-columns`：
 * 它们的 render 里是 JSX 且闭包了 `navigate` 与提交处理函数，故由本文件注入。
 * 本文件保留：数据查询、筛选区、三张表、页内区块骨架。
 */

const AttendancePanel: React.FC = () => {
  const navigate = useNavigate();
  const [month, setMonth] = useState<string>(currentPeriod());
  const [attEmpFilter, setAttEmpFilter] = useState<string>('all');
  const [leaveStatus, setLeaveStatus] = useState<string>('all');
  const [leaveEmpFilter, setLeaveEmpFilter] = useState<string>('all');
  // 时区修正：年假余额按年分档，必须取业务时区年份（详见 currentBizYear）
  const [balanceYear, setBalanceYear] = useState<string>(currentBizYear());
  const [attOpen, setAttOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [initingLeave, setInitingLeave] = useState(false);

  const { data: attendance, loading: attLoading, error: attError, reload: reloadAtt } =
    useAsyncData<AttendanceRecord[]>(
      () =>
        hrApi.listAttendance(
          month || undefined,
          attEmpFilter !== 'all' ? attEmpFilter : undefined,
        ),
      [month, attEmpFilter],
    );
  const { data: leaveRequests, loading: leaveLoading, error: leaveError, reload: reloadLeave } =
    useAsyncData<LeaveRequest[]>(
      () =>
        hrApi.listLeaveRequests(
          leaveStatus !== 'all' ? leaveStatus : undefined,
          leaveEmpFilter !== 'all' ? leaveEmpFilter : undefined,
        ),
      [leaveStatus, leaveEmpFilter],
    );
  const { data: balances, loading: balLoading, error: balError, reload: reloadBal } =
    useAsyncData<LeaveBalance[]>(
      () => hrApi.listLeaveBalances(balanceYear || undefined),
      [balanceYear],
    );
  const { data: employees } = useAsyncData<Employee[]>(() => hrApi.listEmployees(), []);
  const { data: amendments, loading: amdLoading, error: amdError, reload: reloadAmd } =
    useAsyncData<AttendanceAmendment[]>(() => hrApi.listAttendanceAmendments(), []);

  const doLeaveAction = async (req: LeaveRequest, action: LeaveRequestAction) => {
    try {
      await hrApi.leaveRequestAction(req.id, action);
      toast.success(action === 'approve' ? '已批准' : '已驳回');
      await reloadLeave();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const doAmendmentAction = async (
    record: AttendanceAmendment,
    action: AttendanceAmendmentAction,
  ) => {
    try {
      await hrApi.attendanceAmendmentAction(record.id, action);
      toast.success(action === 'approve' ? '已通过' : '已驳回');
      await reloadAmd();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const doInitAnnualLeave = async () => {
    /*
     * 时区修正（**这一处后果最具体**）：initLeaveBalances(year) 会往
     * hr_leave_balance 写「按 (员工, 假期类型, 年) 唯一」的一行。
     * 传错年份会**给错的年份建余额**，而正确年份仍为空 ——
     * 员工请年假时 `handleLeaveRequestAction` 因 `balanceRows.length === 0`
     * 直接抛「请假余额记录不存在」，且错误年份那行需要人工清理。
     */
    const year: string = currentBizYear();
    setInitingLeave(true);
    try {
      const result = await hrApi.initLeaveBalances(year);
      toast.success(`已初始化 ${result.initializedCount} 名员工年假，跳过 ${result.skippedCount} 名`);
      await reloadBal();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '初始化失败');
    } finally {
      setInitingLeave(false);
    }
  };

  const employeeOptions = (employees ?? []).map((e: Employee) => (
    <SelectItem key={e.id} value={e.id}>
      {e.name}
    </SelectItem>
  ));

  const { attColumns, amendmentColumns, leaveColumns } = attendanceColumns({
    onOpenLeave: (record: LeaveRequest) =>
      navigate(`/hr/leaves/${record.id}`, { state: { item: record } }),
    onLeaveAction: (record: LeaveRequest, action: LeaveRequestAction) =>
      void doLeaveAction(record, action),
    onAmendmentAction: (record: AttendanceAmendment, action: AttendanceAmendmentAction) =>
      void doAmendmentAction(record, action),
  });

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <SectionTitle>考勤记录</SectionTitle>
            <div className="flex items-center gap-2">
              <Label htmlFor="att-month">月份</Label>
              <Input
                id="att-month"
                className="w-28"
                placeholder="YYYY-MM"
                value={month}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMonth(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="att-employee">员工</Label>
              <Select value={attEmpFilter} onValueChange={setAttEmpFilter}>
                <SelectTrigger id="att-employee" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部员工</SelectItem>
                  {employeeOptions}
                </SelectContent>
              </Select>
            </div>
          </div>
          <CanCapabilityWrite capability="hr_write">
            <Button onClick={() => setAttOpen(true)}>
              <Plus className="h-4 w-4" />
              登记考勤
            </Button>
          </CanCapabilityWrite>
        </div>
        {attError ? (
          <p className="text-sm text-destructive">
            {attError}
            <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reloadAtt()}>
              重试
            </Button>
          </p>
        ) : null}
        <Table
          columns={attColumns}
          dataSource={attendance ?? []}
          loading={attLoading}
          rowKey="id"
          scroll={{ x: 600, y: 320 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: '暂无考勤记录，点击右上角登记考勤' }}
        />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>补卡申请</SectionTitle>
          <p className="text-sm text-muted-foreground">按当前登录账号绑定的员工提交</p>
        </div>
        <AmendmentSection onSaved={reloadAmd} />
        {amdError ? (
          <p className="text-sm text-destructive">
            {amdError}
            <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reloadAmd()}>
              重试
            </Button>
          </p>
        ) : null}
        <Table
          columns={amendmentColumns}
          dataSource={amendments ?? []}
          loading={amdLoading}
          rowKey="id"
          scroll={{ x: 900, y: 320 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: '暂无补卡申请' }}
        />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <SectionTitle>请假申请</SectionTitle>
            <div className="flex items-center gap-2">
              <Label htmlFor="leave-status">状态</Label>
              <Select value={leaveStatus} onValueChange={setLeaveStatus}>
                <SelectTrigger id="leave-status" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  {Object.entries(LEAVE_STATUS_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="leave-employee">员工</Label>
              <Select value={leaveEmpFilter} onValueChange={setLeaveEmpFilter}>
                <SelectTrigger id="leave-employee" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部员工</SelectItem>
                  {employeeOptions}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button onClick={() => setLeaveOpen(true)}>
            <Plus className="h-4 w-4" />
            新建请假
          </Button>
        </div>
        {leaveError ? (
          <p className="text-sm text-destructive">
            {leaveError}
            <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reloadLeave()}>
              重试
            </Button>
          </p>
        ) : null}
        <Table
          columns={leaveColumns}
          dataSource={leaveRequests ?? []}
          loading={leaveLoading}
          rowKey="id"
          scroll={{ x: 1000, y: 320 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: '暂无请假申请，点击右上角新建请假' }}
        />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <SectionTitle>请假余额</SectionTitle>
            <div className="flex items-center gap-2">
              <Label htmlFor="balance-year">年度</Label>
              <Input
                id="balance-year"
                className="w-24"
                placeholder="YYYY"
                value={balanceYear}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBalanceYear(e.target.value)}
              />
            </div>
          </div>
          <CanCapabilityWrite capability="hr_write">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => void doInitAnnualLeave()}
                disabled={initingLeave}
              >
                按规则初始化年假
              </Button>
              <Button onClick={() => setBalanceOpen(true)}>
                <Plus className="h-4 w-4" />
                额度设置
              </Button>
            </div>
          </CanCapabilityWrite>
        </div>
        <CanCapabilityWrite capability="hr_write">
          <p className="text-sm text-muted-foreground">
            年假初始化按司龄：&lt;1年5天、1-3年8天、3-5年10天、5-10年12天、≥10年15天；仅补未设置员工
          </p>
        </CanCapabilityWrite>
        {balError ? (
          <p className="text-sm text-destructive">
            {balError}
            <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reloadBal()}>
              重试
            </Button>
          </p>
        ) : null}
        <Table
          columns={balanceColumns}
          dataSource={balances ?? []}
          loading={balLoading}
          rowKey="id"
          scroll={{ x: 600, y: 320 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: '暂无请假余额，点击右上角设置额度' }}
        />
      </section>

      <AttendanceDialog
        open={attOpen}
        onOpenChange={setAttOpen}
        employees={employees}
        onSaved={reloadAtt}
      />

      <LeaveDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        employees={employees}
        onSaved={reloadLeave}
      />

      <BalanceDialog
        open={balanceOpen}
        onOpenChange={setBalanceOpen}
        employees={employees}
        balanceYear={balanceYear}
        onSaved={reloadBal}
      />
    </div>
  );
};

export default AttendancePanel;
