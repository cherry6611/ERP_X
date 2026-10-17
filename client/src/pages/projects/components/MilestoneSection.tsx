import React, { useCallback, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import { SectionTitle } from '@client/src/components/SectionTitle';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Badge } from '@client/src/components/ui/badge';
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
import { projectsApi } from '@client/src/api';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { ProjectMilestone } from '@shared/api.interface';

const isMilestoneOverdue = (m: ProjectMilestone): boolean =>
  m.status === 'pending' &&
  m.forecastDate != null &&
  m.forecastDate < dayjs().format('YYYY-MM-DD');

const dateStringSchema = z
  .string()
  .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/u.test(v), '请输入 YYYY-MM-DD 格式日期');

const weightPctSchema = z
  .union([
    z.literal(''),
    z.coerce.number().min(0, '权重需在 0-100 之间').max(100, '权重需在 0-100 之间'),
  ])
  .transform((v) => (v === '' ? undefined : v));

const milestoneSchema = z.object({
  name: z.string().min(1, '里程碑名称不能为空'),
  planDate: dateStringSchema,
  weightPct: weightPctSchema,
});

type MilestoneFormData = z.output<typeof milestoneSchema>;
type MilestoneFormInput = z.input<typeof milestoneSchema>;

const milestoneEditSchema = z.object({
  forecastDate: dateStringSchema,
  weightPct: weightPctSchema,
  remark: z.string(),
});

type MilestoneEditFormData = z.output<typeof milestoneEditSchema>;
type MilestoneEditFormInput = z.input<typeof milestoneEditSchema>;

interface MilestoneSectionProps {
  projectId: string;
  onChanged?: () => void;
}

const MilestoneSection: React.FC<MilestoneSectionProps> = ({ projectId, onChanged }) => {
  const [milestones, setMilestones] = useState<ProjectMilestone[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProjectMilestone | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const milestoneForm = useForm<MilestoneFormInput, unknown, MilestoneFormData>({
    resolver: zodResolver(milestoneSchema),
    defaultValues: { name: '', planDate: '', weightPct: '' },
  });

  const editMilestoneForm = useForm<MilestoneEditFormInput, unknown, MilestoneEditFormData>({
    resolver: zodResolver(milestoneEditSchema),
    defaultValues: { forecastDate: '', weightPct: '', remark: '' },
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await projectsApi.getProject(projectId);
      setMilestones(detail.milestones);
    } catch (err) {
      setError(getApiErrorMessage(err, '加载里程碑失败'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    await load();
    onChanged?.();
  };

  const onAddMilestone = milestoneForm.handleSubmit(async (values) => {
    try {
      await projectsApi.addProjectMilestone(projectId, {
        name: values.name,
        planDate: values.planDate || undefined,
        weightPct: values.weightPct,
      });
      toast.success('里程碑已添加');
      setAddOpen(false);
      milestoneForm.reset({ name: '', planDate: '', weightPct: '' });
      await refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '添加失败'));
    }
  });

  const reachMilestone = async (m: ProjectMilestone) => {
    try {
      await projectsApi.updateProjectMilestone(m.id, { status: 'reached' });
      toast.success('里程碑已达成');
      await refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  const openEditMilestone = (m: ProjectMilestone) => {
    setEditTarget(m);
    editMilestoneForm.reset({
      forecastDate: m.forecastDate ?? '',
      weightPct: m.weightPct != null ? String(m.weightPct) : '',
      remark: m.remark ?? '',
    });
    setEditOpen(true);
  };

  const onEditMilestone = editMilestoneForm.handleSubmit(async (values) => {
    if (!editTarget) return;
    try {
      /*
       * ⚠️ 空串必须原样发出（不能 `|| undefined`）。
       *
       * 服务端 `updateMilestone` 以 `!== undefined` 为 patch 判据，
       * 而 `|| undefined` 会让空串在 JSON 序列化时**丢掉整个键** →
       * 服务端判为"未提供" → **清空「预测日期」/「备注」被静默丢弃**，
       * 而界面已提示更新成功。契约里两者都是可选 string，空串合法。
       */
      await projectsApi.updateProjectMilestone(editTarget.id, {
        forecastDate: values.forecastDate,
        weightPct: values.weightPct,
        remark: values.remark,
      });
      toast.success('里程碑已更新');
      setEditOpen(false);
      await refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '更新失败'));
    }
  });

  const milestoneColumns: TableColumnsType<ProjectMilestone> = [
    { title: '名称', dataIndex: 'name', width: 180 },
    { title: '计划日期', dataIndex: 'planDate', width: 110, render: (v) => v ?? '-' },
    { title: '基线日期', dataIndex: 'baselineDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '预测日期',
      dataIndex: 'forecastDate',
      width: 130,
      render: (v: string | null, record) => (
        <span className="flex items-center gap-1">
          {v ?? '-'}
          {isMilestoneOverdue(record) ? <Badge variant="destructive">延期</Badge> : null}
        </span>
      ),
    },
    {
      title: '权重',
      dataIndex: 'weightPct',
      width: 80,
      align: 'right',
      render: (v: number) => `${v}%`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => (
        <StatusBadge status={s} labels={{ pending: '未达成', reached: '已达成' }} />
      ),
    },
    { title: '达成日期', dataIndex: 'actualDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 140,
      render: (_, record) => (
        <CanCapabilityWrite capability="projects_write">
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => openEditMilestone(record)}>
              编辑
            </Button>
            {record.status === 'pending' ? (
              <Button variant="ghost" size="sm" onClick={() => void reachMilestone(record)}>
                达成
              </Button>
            ) : null}
          </div>
        </CanCapabilityWrite>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <SectionTitle>项目里程碑</SectionTitle>
        <CanCapabilityWrite capability="projects_write">
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            添加里程碑
          </Button>
        </CanCapabilityWrite>
      </div>
      <DataState loading={loading} error={error} skeleton="table">
        <Table
          columns={milestoneColumns}
          dataSource={milestones}
          rowKey="id"
          scroll={{ x: 1000, y: 240 }}
          pagination={false}
          size="small"
        />
      </DataState>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>添加项目里程碑</DialogTitle>
          </DialogHeader>
          <Form {...milestoneForm}>
            <form onSubmit={onAddMilestone} className="space-y-4">
              <FormField
                control={milestoneForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      名称 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：需求确认" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={milestoneForm.control}
                name="planDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>计划日期</FormLabel>
                    <FormControl>
                      <Input
                        type="text"
                        placeholder="YYYY-MM-DD"
                        {...field}
                        value={field.value ?? ''}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={milestoneForm.control}
                name="weightPct"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>权重（%）</FormLabel>
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
              <DialogFooter>
                <Button type="submit">保存</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>编辑里程碑</DialogTitle>
          </DialogHeader>
          <Form {...editMilestoneForm}>
            <form onSubmit={onEditMilestone} className="space-y-4">
              <FormField
                control={editMilestoneForm.control}
                name="forecastDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>预测日期</FormLabel>
                    <FormControl>
                      <Input
                        type="text"
                        placeholder="YYYY-MM-DD"
                        {...field}
                        value={field.value ?? ''}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editMilestoneForm.control}
                name="weightPct"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>权重（%）</FormLabel>
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
                control={editMilestoneForm.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Input placeholder="备注" {...field} value={field.value ?? ''} />
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
    </div>
  );
};

export default MilestoneSection;
