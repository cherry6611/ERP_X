import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import { SectionTitle } from '@client/src/components/SectionTitle';
import DateField from '@client/src/components/erp/DateField';
import HrStatusBadge, {
  ATTENDANCE_STATUS_LABELS,
  LEAVE_STATUS_LABELS,
  LEAVE_TYPE_LABELS,
} from './HrStatusBadge';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@client/src/components/ui/form';
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
import { sendApprovalNotification } from '@client/src/api/notifications';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { currentPeriod } from '@client/src/utils/format';
import type {
  AttendanceAmendment,
  AttendanceAmendmentAction,
  AttendanceRecord,
  AttendanceStatus,
  CreateAttendanceAmendmentDto,
  CreateLeaveRequestDto,
  Employee,
  LeaveBalance,
  LeaveRequest,
  LeaveRequestAction,
  LeaveType,
  SetLeaveBalanceDto,
  UpsertAttendanceDto,
} from '@shared/api.interface';

const AMENDMENT_STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
};

const attendanceSchema = z.object({
  employeeId: z.string().min(1, '请选择员工'),
  workDate: z.string().min(1, '请选择日期'),
  status: z.string().min(1, '请选择状态'),
  remark: z.string(),
});

const leaveSchema = z.object({
  employeeId: z.string().min(1, '请选择员工'),
  leaveType: z.string().min(1, '请选择假别'),
  startDate: z.string().min(1, '请选择开始日期'),
  endDate: z.string().min(1, '请选择结束日期'),
  days: z.coerce.number().positive('请假天数必须大于 0'),
  reason: z.string(),
});

const balanceSchema = z.object({
  employeeId: z.string().min(1, '请选择员工'),
  leaveType: z.string().min(1, '请选择假别'),
  year: z.string().min(1, '请填写年份'),
  totalDays: z.coerce.number().positive('额度天数必须大于 0'),
});

const amendmentSchema = z.object({
  workDate: z.string().min(1, '请选择日期'),
  reason: z.string().min(1, '请填写补卡原因'),
});

const AttendancePanel: React.FC = () => {
  const navigate = useNavigate();
  const [month, setMonth] = useState<string>(currentPeriod());
  const [attEmpFilter, setAttEmpFilter] = useState<string>('all');
  const [leaveStatus, setLeaveStatus] = useState<string>('all');
  const [leaveEmpFilter, setLeaveEmpFilter] = useState<string>('all');
  const [balanceYear, setBalanceYear] = useState<string>(new Date().getFullYear().toString());
  const [attOpen, setAttOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [initingLeave, setInitingLeave] = useState(false);
    const [operating, setOperating] = useState(false);

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

  const attForm = useForm<z.input<typeof attendanceSchema>, unknown, z.output<typeof attendanceSchema>>({
    resolver: zodResolver(attendanceSchema),
    defaultValues: { employeeId: '', workDate: '', status: 'present', remark: '' },
  });

  const amendmentForm = useForm<
    z.input<typeof amendmentSchema>,
    unknown,
    z.output<typeof amendmentSchema>
  >({
    resolver: zodResolver(amendmentSchema),
    defaultValues: { workDate: '', reason: '' },
  });

  const leaveForm = useForm<z.input<typeof leaveSchema>, unknown, z.output<typeof leaveSchema>>({
    resolver: zodResolver(leaveSchema),
    defaultValues: {
      employeeId: '',
      leaveType: 'annual',
      startDate: '',
      endDate: '',
      days: 1,
      reason: '',
    },
  });

  const balanceForm = useForm<z.input<typeof balanceSchema>, unknown, z.output<typeof balanceSchema>>({
    resolver: zodResolver(balanceSchema),
    defaultValues: { employeeId: '', leaveType: 'annual', year: balanceYear, totalDays: 5 },
  });

  const onAttSubmit = attForm.handleSubmit(async (values) => {
    const dto: UpsertAttendanceDto = {
      employeeId: values.employeeId,
      workDate: values.workDate,
      status: values.status as AttendanceStatus,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      await hrApi.createAttendance(dto);
      toast.success('考勤已登记');
      setAttOpen(false);
      attForm.reset({ employeeId: '', workDate: '', status: 'present', remark: '' });
      await reloadAtt();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
    } finally {
      setOperating(false);
    }
  });

  const onLeaveSubmit = leaveForm.handleSubmit(async (values) => {
    const dto: CreateLeaveRequestDto = {
      employeeId: values.employeeId,
      leaveType: values.leaveType as LeaveType,
      startDate: values.startDate,
      endDate: values.endDate,
      days: values.days,
      reason: values.reason || undefined,
    };
    setOperating(true);
    try {
      const req = await hrApi.createLeaveRequest(dto);
      void sendApprovalNotification({
        bizType: 'leave',
        bizCode: req.code,
        title: '请假审批待办',
        content: `${req.employeeName} 提交请假申请 ${req.code}（${LEAVE_TYPE_LABELS[req.leaveType] ?? req.leaveType}，${req.days} 天），请审批`,
      });
      toast.success('请假申请已提交');
      setLeaveOpen(false);
      navigate(`/hr/leaves/${req.id}`, { state: { item: req } });
      leaveForm.reset({
        employeeId: '',
        leaveType: 'annual',
        startDate: '',
        endDate: '',
        days: 1,
        reason: '',
      });
      await reloadLeave();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '提交失败');
    } finally {
      setOperating(false);
    }
  });

  const onBalanceSubmit = balanceForm.handleSubmit(async (values) => {
    const dto: SetLeaveBalanceDto = {
      employeeId: values.employeeId,
      leaveType: values.leaveType as LeaveType,
      year: values.year,
      totalDays: values.totalDays,
    };
    setOperating(true);
    try {
      await hrApi.setLeaveBalance(dto);
      toast.success('额度已设置');
      setBalanceOpen(false);
      balanceForm.reset({ employeeId: '', leaveType: 'annual', year: balanceYear, totalDays: 5 });
      await reloadBal();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '设置失败');
    } finally {
      setOperating(false);
    }
  });

  const doLeaveAction = async (req: LeaveRequest, action: LeaveRequestAction) => {
    try {
      await hrApi.leaveRequestAction(req.id, action);
      toast.success(action === 'approve' ? '已批准' : '已驳回');
      await reloadLeave();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const onAmendmentSubmit = amendmentForm.handleSubmit(async (values) => {
    const dto: CreateAttendanceAmendmentDto = {
      workDate: values.workDate,
      reason: values.reason,
    };
    setOperating(true);
    try {
      await hrApi.createAttendanceAmendment(dto);
      toast.success('补卡申请已提交');
      amendmentForm.reset({ workDate: '', reason: '' });
      await reloadAmd();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '提交失败');
    } finally {
      setOperating(false);
    }
  });

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
    const year: string = String(new Date().getFullYear());
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
          <CanRole roles={['admin']}>
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
          </CanRole>
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
          <Button variant="ghost" size="sm" onClick={() => navigate(`/hr/leaves/${record.id}`, { state: { item: record } })}>
            详情
          </Button>
          {record.status === 'pending' ? (
            <CanRole roles={['admin']}>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void doLeaveAction(record, 'approve')}
                >
                  批准
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => void doLeaveAction(record, 'reject')}
                >
                  驳回
                </Button>
              </div>
            </CanRole>
          ) : null}
        </div>
      ),
    },
  ];

  const balanceColumns: TableColumnsType<LeaveBalance> = [
    { title: '员工', dataIndex: 'employeeName', fixed: 'left', width: 130 },
    {
      title: '类型',
      dataIndex: 'leaveType',
      width: 90,
      render: (v: string) => LEAVE_TYPE_LABELS[v] ?? v,
    },
    { title: '年度', dataIndex: 'year', width: 80 },
    { title: '总额度（天）', dataIndex: 'totalDays', width: 110 },
    { title: '已用（天）', dataIndex: 'usedDays', width: 100 },
    { title: '剩余（天）', dataIndex: 'remainingDays', width: 100 },
  ];

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
          <CanRole roles={['admin']}>
            <Button onClick={() => setAttOpen(true)}>
              <Plus className="h-4 w-4" />
              登记考勤
            </Button>
          </CanRole>
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
        <Form {...amendmentForm}>
          <form
            onSubmit={onAmendmentSubmit}
            className="grid grid-cols-3 items-start gap-4"
          >
            <FormField
              control={amendmentForm.control}
              name="workDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    日期 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <DateField value={field.value || null} onChange={field.onChange} />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={amendmentForm.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    补卡原因 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="如：忘打卡，实际出勤" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex h-full items-end">
              <Button type="submit" disabled={operating}>
                提交补卡
              </Button>
            </div>
          </form>
        </Form>
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
          <CanRole roles={['admin']}>
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
          </CanRole>
        </div>
        <CanRole roles={['admin']}>
          <p className="text-sm text-muted-foreground">
            年假初始化按司龄：&lt;1年5天、1-3年8天、3-5年10天、5-10年12天、≥10年15天；仅补未设置员工
          </p>
        </CanRole>
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

      <Dialog open={attOpen} onOpenChange={setAttOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>登记考勤</DialogTitle>
          </DialogHeader>
          <Form {...attForm}>
            <form onSubmit={onAttSubmit} className="space-y-4">
              <FormField
                control={attForm.control}
                name="employeeId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      员工 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择员工" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>{employeeOptions}</SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={attForm.control}
                  name="workDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        日期 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <DateField value={field.value || null} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={attForm.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        状态 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(ATTENDANCE_STATUS_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={attForm.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Input placeholder="备注" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit" disabled={operating}>
                  保存
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建请假</DialogTitle>
          </DialogHeader>
          <Form {...leaveForm}>
            <form onSubmit={onLeaveSubmit} className="space-y-4">
              <FormField
                control={leaveForm.control}
                name="employeeId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      员工 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择员工" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>{employeeOptions}</SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={leaveForm.control}
                name="leaveType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      假别 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(LEAVE_TYPE_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={leaveForm.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        开始日期 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <DateField value={field.value || null} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={leaveForm.control}
                  name="endDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        结束日期 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <DateField value={field.value || null} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={leaveForm.control}
                name="days"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      天数 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0.5}
                        step={0.5}
                        value={String(field.value ?? '')}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={leaveForm.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>事由</FormLabel>
                    <FormControl>
                      <Input placeholder="请假事由" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <AttachmentHint text="保存后将自动打开详情，可在其中上传病假条、请假证明材料等附件" />
              <DialogFooter>
                <Button type="submit" disabled={operating}>
                  提交
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>


      <Dialog open={balanceOpen} onOpenChange={setBalanceOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>请假额度设置</DialogTitle>
          </DialogHeader>
          <Form {...balanceForm}>
            <form onSubmit={onBalanceSubmit} className="space-y-4">
              <FormField
                control={balanceForm.control}
                name="employeeId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      员工 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择员工" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>{employeeOptions}</SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={balanceForm.control}
                  name="leaveType"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        假别 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(LEAVE_TYPE_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={balanceForm.control}
                  name="year"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        年度 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="如 2026" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={balanceForm.control}
                name="totalDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      总额度（天） <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        value={String(field.value ?? '')}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit" disabled={operating}>
                  保存
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AttendancePanel;
