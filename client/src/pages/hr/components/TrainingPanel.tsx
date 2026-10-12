import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus, UserPlus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import DateField from '@client/src/components/erp/DateField';
import HrStatusBadge, { TRAINING_STATUS_LABELS } from './HrStatusBadge';
import { Button } from '@client/src/components/ui/button';
import { Checkbox } from '@client/src/components/ui/checkbox';
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
import { hrApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import type { CreateTrainingDto, Employee, Training } from '@shared/api.interface';

const trainingSchema = z.object({
  name: z.string().min(1, '请填写课程名称'),
  trainer: z.string(),
  hours: z.coerce.number().min(0.5, '学时必须大于 0'),
  startDate: z.string(),
  endDate: z.string(),
  remark: z.string(),
});

const EMPTY_FORM = {
  name: '',
  trainer: '',
  hours: 4,
  startDate: '',
  endDate: '',
  remark: '',
};

const TrainingPanel: React.FC = () => {
  const [createOpen, setCreateOpen] = useState(false);
  const [attendeesTarget, setAttendeesTarget] = useState<Training | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData<Training[]>(
    () => hrApi.listTrainings(),
    [],
  );
  const { data: employees } = useAsyncData<Employee[]>(() => hrApi.listEmployees(), []);

  const form = useForm<
    z.input<typeof trainingSchema>,
    unknown,
    z.output<typeof trainingSchema>
  >({
    resolver: zodResolver(trainingSchema),
    defaultValues: EMPTY_FORM,
  });

  useEffect(() => {
    if (attendeesTarget) {
      setSelectedIds([]);
    }
  }, [attendeesTarget]);

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateTrainingDto = {
      name: values.name,
      trainer: values.trainer || undefined,
      hours: values.hours,
      startDate: values.startDate || undefined,
      endDate: values.endDate || undefined,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      await hrApi.createTraining(dto);
      toast.success('培训课程已创建');
      setCreateOpen(false);
      form.reset(EMPTY_FORM);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setOperating(false);
    }
  });

  const toggleAttendee = (id: string, checked: boolean) => {
    setSelectedIds((prev: string[]) =>
      checked ? [...prev, id] : prev.filter((v: string) => v !== id),
    );
  };

  const doAddAttendees = async () => {
    if (!attendeesTarget) return;
    if (selectedIds.length === 0) {
      toast.error('请至少勾选一名参训人员');
      return;
    }
    setOperating(true);
    try {
      await hrApi.addTrainingAttendees(attendeesTarget.id, selectedIds);
      toast.success('参训人员已添加');
      setAttendeesTarget(null);
      setSelectedIds([]);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加失败');
    } finally {
      setOperating(false);
    }
  };

  const doFinish = async (item: Training) => {
    try {
      await hrApi.trainingAction(item.id, 'finish');
      toast.success('课程已结课');
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const columns: TableColumnsType<Training> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '课程名称', dataIndex: 'name', width: 200 },
    { title: '讲师', dataIndex: 'trainer', width: 120, render: (v) => v ?? '-' },
    { title: '学时', dataIndex: 'hours', width: 70 },
    { title: '开始日期', dataIndex: 'startDate', width: 110, render: (v) => v ?? '-' },
    { title: '结束日期', dataIndex: 'endDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <HrStatusBadge status={s} labels={TRAINING_STATUS_LABELS} />,
    },
    { title: '参训人数', dataIndex: 'attendeeCount', width: 90 },
    {
      title: '操作',
      key: 'action',
      width: 190,
      render: (_: unknown, record: Training) =>
        record.status === 'planned' ? (
          <div className="flex gap-1">
            <CanRole roles={['admin']}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAttendeesTarget(record)}
              >
                <UserPlus className="h-4 w-4" />
                参训人员
              </Button>
            </CanRole>
            <CanRole roles={['admin']}>
              <Button variant="ghost" size="sm" onClick={() => void doFinish(record)}>
                结课
              </Button>
            </CanRole>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">-</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold">培训课程</h3>
        <CanRole roles={['admin']}>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            新建培训
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
        scroll={{ x: 1200, y: 480 }}
        pagination={{
          pageSize: 10,
          showTotal: (t: number) => `共 ${t} 条`,
        }}
        locale={{ emptyText: '暂无培训课程，点击右上角新建培训' }}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建培训</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      课程名称 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="课程名称" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="trainer"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>讲师</FormLabel>
                      <FormControl>
                        <Input placeholder="讲师姓名" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="hours"
                  render={({ field }) => (
                    <FormItem className="w-28">
                      <FormLabel>学时</FormLabel>
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
              </div>
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>开始日期</FormLabel>
                      <DateField value={field.value || null} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="endDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>结束日期</FormLabel>
                      <DateField value={field.value || null} onChange={field.onChange} />
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

      <Dialog
        open={attendeesTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) {
            setAttendeesTarget(null);
            setSelectedIds([]);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>添加参训人员</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            课程：{attendeesTarget?.name}，已选 {selectedIds.length} 人
          </p>
          <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
            {(employees ?? []).map((e: Employee) => (
              <label
                key={e.id}
                className="flex cursor-pointer items-center gap-2 text-sm"
                htmlFor={`attendee-${e.id}`}
              >
                <Checkbox
                  id={`attendee-${e.id}`}
                  checked={selectedIds.includes(e.id)}
                  onCheckedChange={(checked: boolean) => toggleAttendee(e.id, checked === true)}
                />
                <span>
                  {e.name}
                  {e.departmentName ? `（${e.departmentName}）` : ''}
                </span>
              </label>
            ))}
            {(employees ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无员工可选</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button onClick={() => void doAddAttendees()} disabled={operating}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TrainingPanel;
