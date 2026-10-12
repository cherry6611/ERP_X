import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { logger } from '@client/src/platform/logger';
import DateField from '@client/src/components/erp/DateField';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { costsApi, hrApi, masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { todayIso } from '@client/src/utils/format';
import { TIMESHEET_STATUS_LABELS } from '@client/src/utils/biz-labels';
import type {
  CreateTimesheetDto,
  Employee,
  LaborRate,
  Timesheet,
  TimesheetAction,
} from '@shared/api.interface';

const timesheetSchema = z.object({
  employeeId: z.string().min(1, '请选择员工'),
  roleName: z.string().min(1, '请选择角色'),
  workDate: z.string().min(1, '请选择工作日期'),
  hours: z.coerce.number().min(0.5).max(24),
  remark: z.string(),
});

type TimesheetFormData = z.output<typeof timesheetSchema>;
type TimesheetFormInput = z.input<typeof timesheetSchema>;

const FORM_DEFAULTS: TimesheetFormInput = {
  employeeId: '',
  roleName: '',
  workDate: todayIso(),
  hours: 8,
  remark: '',
};

interface TimesheetSectionProps {
  projectId: string;
  onChanged?: () => void;
}

const TimesheetSection: React.FC<TimesheetSectionProps> = ({ projectId, onChanged }) => {
  const [createOpen, setCreateOpen] = useState(false);

  const { data, loading, error, reload } = useAsyncData<Timesheet[]>(
    () => costsApi.listTimesheets(projectId),
    [projectId],
  );
  const { data: rates } = useAsyncData<LaborRate[]>(() => costsApi.listLaborRates(), []);
  const { data: employees } = useAsyncData<Employee[]>(
    () => masterDataApi.listEmployees(),
    [],
  );
  const activeEmployees: Employee[] = (employees ?? []).filter(
    (e: Employee) => e.status !== 'resigned',
  );

  const form = useForm<TimesheetFormInput, unknown, TimesheetFormData>({
    resolver: zodResolver(timesheetSchema),
    defaultValues: FORM_DEFAULTS,
  });

  const selectedEmployeeId: string = form.watch('employeeId');
  const selectedEmployee: Employee | undefined = activeEmployees.find(
    (e: Employee) => e.id === selectedEmployeeId,
  );
  const roleLocked: boolean = Boolean(selectedEmployee?.roleName);

  const onEmployeeChange = (id: string) => {
    const emp = activeEmployees.find((e: Employee) => e.id === id);
    form.setValue('employeeId', id);
    form.setValue('roleName', emp?.roleName ?? '');
  };

  // 打开填报对话框时，若当前登录用户已绑定员工，默认带出该员工
  useEffect(() => {
    if (!createOpen) return undefined;
    let cancelled = false;
    hrApi
      .fetchMyEmployee()
      .then((emp: Employee | null) => {
        if (cancelled || !emp) return;
        form.setValue('employeeId', emp.id, { shouldValidate: true });
        form.setValue('roleName', emp.roleName ?? '');
      })
      .catch((err: unknown) => {
        logger.warn('获取当前用户绑定员工失败，员工字段保持为空', err);
      });
    return () => {
      cancelled = true;
    };
  }, [createOpen, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    const employee = activeEmployees.find(
      (e: Employee) => e.id === values.employeeId,
    );
    const dto: CreateTimesheetDto = {
      projectId,
      employeeId: values.employeeId,
      employeeName: employee?.name ?? '',
      roleName: employee?.roleName || values.roleName,
      workDate: values.workDate,
      hours: values.hours,
      remark: values.remark || undefined,
    };
    try {
      await costsApi.createTimesheet(dto);
      toast.success('工时已登记');
      setCreateOpen(false);
      form.reset(FORM_DEFAULTS);
      await reload();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
    }
  });

  const doAction = async (ts: Timesheet, action: TimesheetAction) => {
    try {
      await costsApi.timesheetAction(ts.id, action);
      toast.success(action === 'confirm' ? '工时已确认并折算成本' : '操作成功');
      await reload();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const timesheets: Timesheet[] = data ?? [];
  const totalHours: number = timesheets.reduce(
    (acc: number, t: Timesheet) => acc + t.hours,
    0,
  );
  const confirmedHours: number = timesheets
    .filter((t: Timesheet) => t.status === 'confirmed')
    .reduce((acc: number, t: Timesheet) => acc + t.hours, 0);

  const columns: TableColumnsType<Timesheet> = [
    { title: '工时编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '员工', dataIndex: 'employeeName', width: 100 },
    { title: '角色', dataIndex: 'roleName', width: 110, render: (v) => v ?? '-' },
    { title: '工作日期', dataIndex: 'workDate', width: 110, render: (v) => v ?? '-' },
    { title: '工时（h）', dataIndex: 'hours', width: 90 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <StatusBadge status={s} labels={TIMESHEET_STATUS_LABELS} />,
    },
    {
      title: '已折算成本',
      dataIndex: 'costGenerated',
      width: 100,
      render: (v: boolean) => (v ? '是' : '否'),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 150,
      render: (_, record) => (
        <div className="flex gap-1">
          {record.status === 'draft' ? (
            <Button variant="ghost" size="sm" onClick={() => void doAction(record, 'submit')}>
              提交
            </Button>
          ) : null}
          {record.status === 'submitted' ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => void doAction(record, 'confirm')}>
                确认
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void doAction(record, 'reject')}>
                退回
              </Button>
            </>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base font-semibold">工时</CardTitle>
          <CardDescription>
            总工时 {totalHours}h，已确认 {confirmedHours}h
          </CardDescription>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          填报工时
        </Button>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-destructive">
            {error}
            <Button
              variant="ghost"
              size="sm"
              className="ml-2"
              onClick={() => void reload()}
            >
              重试
            </Button>
          </p>
        ) : null}
        <Table
          columns={columns}
          dataSource={timesheets}
          loading={loading}
          rowKey="id"
          scroll={{ x: 1000, y: 400 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: '暂无工时记录，点击右上角「填报工时」创建' }}
        />
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>填报工时</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="employeeId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      员工 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(id: string) => onEmployeeChange(id)}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择员工" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {activeEmployees.length === 0 ? (
                          <SelectItem value="empty" disabled>
                            暂无在职员工
                          </SelectItem>
                        ) : (
                          activeEmployees.map((e: Employee) => (
                            <SelectItem key={e.id} value={e.id}>
                              {e.name}（{e.code}）
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="roleName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      角色 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    {roleLocked ? (
                      <FormControl>
                        <Input value={field.value ?? ''} readOnly aria-readonly="true" />
                      </FormControl>
                    ) : (
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择角色" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(rates ?? []).map((r: LaborRate) => (
                            <SelectItem key={r.id} value={r.roleName}>
                              {r.roleName}（{r.rate}/人天）
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="workDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        工作日期{' '}
                        <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <DateField value={field.value} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="hours"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        工时（h）{' '}
                        <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0.5}
                          max={24}
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
              </div>
              <FormField
                control={form.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>工作内容备注</FormLabel>
                    <FormControl>
                      <Textarea placeholder="工作内容" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit">保存</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </Card>
  );
};

export default TimesheetSection;
