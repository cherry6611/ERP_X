import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import HrStatusBadge, { APPRAISAL_STATUS_LABELS } from './HrStatusBadge';
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
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { currentPeriod } from '@client/src/utils/format';
import type { AppraisalItem, CreateAppraisalDto, Employee } from '@shared/api.interface';

const appraisalSchema = z.object({
  employeeId: z.string().min(1, '请选择员工'),
  period: z.string().min(1, '请填写考核期间（YYYY-MM）'),
  score: z.coerce.number().min(0, '得分不能为负').max(100, '得分不能超过 100'),
  grade: z.string(),
  remark: z.string(),
});

const EMPTY_FORM = {
  employeeId: '',
  period: currentPeriod(),
  score: 0,
  grade: '',
  remark: '',
};

const AppraisalPanel: React.FC = () => {
  const [period, setPeriod] = useState<string>(currentPeriod());
  const [createOpen, setCreateOpen] = useState(false);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData<AppraisalItem[]>(
    () => hrApi.listAppraisals(period || undefined),
    [period],
  );
  const { data: employees } = useAsyncData<Employee[]>(() => hrApi.listEmployees(), []);

  const form = useForm<
    z.input<typeof appraisalSchema>,
    unknown,
    z.output<typeof appraisalSchema>
  >({
    resolver: zodResolver(appraisalSchema),
    defaultValues: EMPTY_FORM,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateAppraisalDto = {
      employeeId: values.employeeId,
      period: values.period,
      score: values.score,
      grade: values.grade || undefined,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      await hrApi.createAppraisal(dto);
      toast.success('考核记录已创建');
      setCreateOpen(false);
      form.reset(EMPTY_FORM);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setOperating(false);
    }
  });

  const doConfirm = async (item: AppraisalItem) => {
    try {
      await hrApi.appraisalAction(item.id, 'confirm');
      toast.success('考核已确认');
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const columns: TableColumnsType<AppraisalItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '员工', dataIndex: 'employeeName', width: 110 },
    { title: '期间', dataIndex: 'period', width: 90 },
    { title: '得分', dataIndex: 'score', width: 80 },
    { title: '等级', dataIndex: 'grade', width: 90, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <HrStatusBadge status={s} labels={APPRAISAL_STATUS_LABELS} />,
    },
    { title: '备注', dataIndex: 'remark', width: 180, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_: unknown, record: AppraisalItem) =>
        record.status === 'draft' ? (
          <CanRole roles={['admin']}>
            <Button variant="ghost" size="sm" onClick={() => void doConfirm(record)}>
              确认
            </Button>
          </CanRole>
        ) : (
          <span className="text-sm text-muted-foreground">-</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="appraisal-period">期间</Label>
          <Input
            id="appraisal-period"
            className="w-28"
            placeholder="YYYY-MM"
            value={period}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPeriod(e.target.value)}
          />
        </div>
        <CanRole roles={['admin']}>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            新建考核
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
        scroll={{ x: 900, y: 480 }}
        pagination={{
          pageSize: 10,
          showTotal: (t: number) => `共 ${t} 条`,
        }}
        locale={{ emptyText: '暂无绩效考核记录，点击右上角新建考核' }}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建考核</DialogTitle>
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
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="score"
                  render={({ field }) => (
                    <FormItem className="w-32">
                      <FormLabel>
                        得分 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          max={100}
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
                  name="grade"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>等级</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value || undefined}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择等级" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="A">A</SelectItem>
                          <SelectItem value="B">B</SelectItem>
                          <SelectItem value="C">C</SelectItem>
                          <SelectItem value="D">D</SelectItem>
                        </SelectContent>
                      </Select>
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

export default AppraisalPanel;
