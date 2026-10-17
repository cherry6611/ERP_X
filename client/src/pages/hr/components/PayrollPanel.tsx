import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { PAYROLL_STATUS_LABELS } from './HrStatusBadge';
import { payrollColumns } from './payroll-columns';
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
  /** 留空则走后端社保/个税引擎（F4X-5） */
  socialInsurance: z.union([z.literal(''), z.coerce.number().min(0)]).optional(),
  housingFund: z.union([z.literal(''), z.coerce.number().min(0)]).optional(),
  tax: z.union([z.literal(''), z.coerce.number().min(0)]).optional(),
  remark: z.string(),
});

const EMPTY_FORM = {
  employeeId: '',
  period: currentPeriod(),
  baseSalary: 0,
  perfSalary: 0,
  allowance: 0,
  socialInsurance: '' as const,
  housingFund: '' as const,
  tax: '' as const,
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
    const manual =
      values.socialInsurance !== '' &&
      values.socialInsurance != null &&
      values.housingFund !== '' &&
      values.housingFund != null &&
      values.tax !== '' &&
      values.tax != null;
    const dto: CreatePayrollDto = {
      employeeId: values.employeeId,
      period: values.period,
      baseSalary: values.baseSalary,
      perfSalary: values.perfSalary,
      allowance: values.allowance,
      useEngine: !manual,
      ...(manual
        ? {
            socialInsurance: Number(values.socialInsurance),
            housingFund: Number(values.housingFund),
            tax: Number(values.tax),
          }
        : {}),
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
        // B12：`Record<PayrollAction, string>` 是穷尽映射 ——
        // 新增动作时漏了这里，TypeScript 会直接报错而不是静默显示 undefined。
        // 这正是"动作枚举 + 穷尽 Record"这个组合值得保留的原因。
        pay: '已标记发放',
        void: '工资单已作废',
      };
      toast.success(label[action]);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const columns = payrollColumns({ doAction });

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
        <CanCapabilityWrite capability="hr_write">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            新建工资单
          </Button>
        </CanCapabilityWrite>
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
