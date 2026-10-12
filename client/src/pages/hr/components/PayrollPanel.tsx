import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import HrStatusBadge, { PAYROLL_STATUS_LABELS } from './HrStatusBadge';
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
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { currentPeriod, formatMoney } from '@client/src/utils/format';
import type {
  CreatePayrollDto,
  Employee,
  PayrollAction,
  PayrollItem,
} from '@shared/api.interface';

const payrollSchema = z.object({
  employeeId: z.string().min(1, '请选择员工'),
  period: z.string().min(1, '请填写期间（YYYY-MM）'),
  baseSalary: z.coerce.number().min(0, '基本工资不能为负'),
  perfSalary: z.coerce.number().min(0),
  allowance: z.coerce.number().min(0),
  socialInsurance: z.coerce.number().min(0),
  housingFund: z.coerce.number().min(0),
  tax: z.coerce.number().min(0),
  remark: z.string(),
});

const EMPTY_FORM = {
  employeeId: '',
  period: currentPeriod(),
  baseSalary: 0,
  perfSalary: 0,
  allowance: 0,
  socialInsurance: 0,
  housingFund: 0,
  tax: 0,
  remark: '',
};

const PayrollPanel: React.FC = () => {
  const [period, setPeriod] = useState<string>(currentPeriod());
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData<PayrollItem[]>(
    () =>
      hrApi.listPayrolls(
        period || undefined,
        statusFilter !== 'all' ? statusFilter : undefined,
      ),
    [period, statusFilter],
  );
  const { data: employees } = useAsyncData<Employee[]>(() => hrApi.listEmployees(), []);

  const form = useForm<
    z.input<typeof payrollSchema>,
    unknown,
    z.output<typeof payrollSchema>
  >({
    resolver: zodResolver(payrollSchema),
    defaultValues: EMPTY_FORM,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreatePayrollDto = {
      employeeId: values.employeeId,
      period: values.period,
      baseSalary: values.baseSalary,
      perfSalary: values.perfSalary,
      allowance: values.allowance,
      socialInsurance: values.socialInsurance,
      housingFund: values.housingFund,
      tax: values.tax,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      await hrApi.createPayroll(dto);
      toast.success('工资单已创建');
      setCreateOpen(false);
      form.reset(EMPTY_FORM);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setOperating(false);
    }
  });

  const doAction = async (item: PayrollItem, action: PayrollAction) => {
    try {
      const updated = await hrApi.payrollAction(item.id, action);
      if (action === 'submit') {
        void sendApprovalNotification({
          bizType: 'payroll',
          bizCode: updated.code,
          title: '工资单审批待办',
          content: `工资单 ${updated.code}（${updated.employeeName} ${updated.period}）已提交审批，实发 ${formatMoney(updated.netSalary)}`,
        });
      }
      const label: Record<PayrollAction, string> = {
        submit: '已提交审批',
        approve: '已审批通过',
        reject: '已驳回',
      };
      toast.success(label[action]);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const columns: TableColumnsType<PayrollItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '员工', dataIndex: 'employeeName', width: 110 },
    { title: '期间', dataIndex: 'period', width: 90 },
    {
      title: '基本工资',
      dataIndex: 'baseSalary',
      width: 110,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '绩效工资',
      dataIndex: 'perfSalary',
      width: 110,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '补贴',
      dataIndex: 'allowance',
      width: 100,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '社保',
      dataIndex: 'socialInsurance',
      width: 100,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '公积金',
      dataIndex: 'housingFund',
      width: 100,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '个税',
      dataIndex: 'tax',
      width: 100,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '实发',
      dataIndex: 'netSalary',
      width: 120,
      align: 'right',
      render: (v: number) => <span className="font-medium">{formatMoney(v)}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <HrStatusBadge status={s} labels={PAYROLL_STATUS_LABELS} />,
    },
    {
      title: '操作',
      key: 'action',
      width: 220,
      render: (_: unknown, record: PayrollItem) => (
        <CanRole roles={['admin']}>
          <div className="flex gap-1">
            {record.status === 'draft' ? (
              <Button variant="ghost" size="sm" onClick={() => void doAction(record, 'submit')}>
                提交审批
              </Button>
            ) : null}
            {record.status === 'submitted' ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => void doAction(record, 'approve')}>
                  审批通过
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => void doAction(record, 'reject')}
                >
                  驳回
                </Button>
              </>
            ) : null}
          </div>
        </CanRole>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="payroll-period">期间</Label>
            <Input
              id="payroll-period"
              className="w-28"
              placeholder="YYYY-MM"
              value={period}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPeriod(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="payroll-status">状态</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger id="payroll-status" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {Object.entries(PAYROLL_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <CanRole roles={['admin']}>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            新建工资单
          </Button>
        </CanRole>
      </div>
      {error ? (
        <p className="text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reload()}>
            重试
          </Button>
        </p>
      ) : null}
      <Table
        columns={columns}
        dataSource={data ?? []}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1300, y: 480 }}
        pagination={{
          pageSize: 10,
          showTotal: (t: number) => `共 ${t} 条`,
        }}
        locale={{ emptyText: '暂无工资单记录，点击右上角新建工资单' }}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>新建工资单</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="employeeId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        员工 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择员工" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(employees ?? []).map((e: Employee) => (
                            <SelectItem key={e.id} value={e.id}>
                              {e.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="period"
                  render={({ field }) => (
                    <FormItem className="w-36">
                      <FormLabel>
                        期间 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="YYYY-MM" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <FormField
                  control={form.control}
                  name="baseSalary"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        基本工资 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
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
                  control={form.control}
                  name="perfSalary"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>绩效工资</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
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
                  control={form.control}
                  name="allowance"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>补贴</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
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
                  control={form.control}
                  name="socialInsurance"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>社保</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
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
                  control={form.control}
                  name="housingFund"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>公积金</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
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
                  control={form.control}
                  name="tax"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>个税</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
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
    </div>
  );
};

export default PayrollPanel;
