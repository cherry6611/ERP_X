import React, { useCallback, useEffect, useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { Textarea } from '@client/src/components/ui/textarea';
import { projectsApi } from '@client/src/api';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { CreateProjectChangeDto, ProjectChange } from '@shared/api.interface';

const CHANGE_TYPE_LABELS: Record<string, string> = {
  scope: '范围变更',
  budget: '预算变更',
  schedule: '进度变更',
};

const CHANGE_STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
};

const changeSchema = z.object({
  changeType: z.string().min(1, '请选择变更类型'),
  content: z.string().min(1, '请填写变更内容'),
  beforeValue: z.string(),
  afterValue: z.string(),
  remark: z.string(),
});

type ChangeFormData = z.infer<typeof changeSchema>;

interface ChangeSectionProps {
  projectId: string;
  onChanged?: () => void;
}

const ChangeSection: React.FC<ChangeSectionProps> = ({ projectId, onChanged }) => {
  const [changes, setChanges] = useState<ProjectChange[]>([]);
  const [projectClosed, setProjectClosed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);

  const changeForm = useForm<ChangeFormData>({
    resolver: zodResolver(changeSchema),
    defaultValues: { changeType: 'scope', content: '', beforeValue: '', afterValue: '', remark: '' },
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await projectsApi.getProject(projectId);
      setChanges(detail.changes);
      setProjectClosed(detail.status === 'closed');
    } catch (err) {
      setError(getApiErrorMessage(err, '加载项目变更失败'));
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

  const onCreateChange = changeForm.handleSubmit(async (values) => {
    const dto: CreateProjectChangeDto = {
      changeType: values.changeType as CreateProjectChangeDto['changeType'],
      content: values.content,
      beforeValue: values.beforeValue || undefined,
      afterValue: values.afterValue || undefined,
      remark: values.remark || undefined,
    };
    try {
      await projectsApi.createProjectChange(projectId, dto);
      toast.success('变更申请已提交');
      setChangeOpen(false);
      changeForm.reset({
        changeType: 'scope',
        content: '',
        beforeValue: '',
        afterValue: '',
        remark: '',
      });
      await refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '提交失败'));
    }
  });

  const approveChange = async (change: ProjectChange, action: 'approve' | 'reject') => {
    try {
      await projectsApi.approveProjectChange(change.id, action);
      toast.success(action === 'approve' ? '变更已批准' : '变更已驳回');
      await refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  const changeColumns: TableColumnsType<ProjectChange> = [
    { title: '变更编号', dataIndex: 'code', fixed: 'left', width: 140 },
    {
      title: '类型',
      dataIndex: 'changeType',
      width: 100,
      render: (t: string) => <Badge variant="secondary">{CHANGE_TYPE_LABELS[t] ?? t}</Badge>,
    },
    { title: '内容', dataIndex: 'content', width: 200 },
    { title: '变更前', dataIndex: 'beforeValue', width: 120, render: (v) => v ?? '-' },
    { title: '变更后', dataIndex: 'afterValue', width: 120, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <StatusBadge status={s} labels={CHANGE_STATUS_LABELS} />,
    },
    { title: '申请人', dataIndex: 'applicant', width: 100, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 140,
      render: (_, record) =>
        record.status === 'pending' ? (
          <CanCapabilityWrite capability="projects_write">
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => void approveChange(record, 'approve')}>
                批准
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void approveChange(record, 'reject')}>
                驳回
              </Button>
            </div>
          </CanCapabilityWrite>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <SectionTitle>项目变更</SectionTitle>
        {projectClosed ? null : (
          <Button size="sm" variant="outline" onClick={() => setChangeOpen(true)}>
            <Plus className="h-4 w-4" />
            提交变更
          </Button>
        )}
      </div>
      <DataState loading={loading} error={error} skeleton="table">
        <Table
          columns={changeColumns}
          dataSource={changes}
          rowKey="id"
          scroll={{ x: 1000, y: 240 }}
          pagination={false}
          size="small"
        />
      </DataState>

      <Dialog open={changeOpen} onOpenChange={setChangeOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>提交项目变更</DialogTitle>
          </DialogHeader>
          <Form {...changeForm}>
            <form onSubmit={onCreateChange} className="space-y-4">
              <FormField
                control={changeForm.control}
                name="changeType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      变更类型 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(CHANGE_TYPE_LABELS).map(([value, label]) => (
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
                control={changeForm.control}
                name="content"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      变更内容 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Textarea placeholder="请描述变更内容" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={changeForm.control}
                  name="beforeValue"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>变更前</FormLabel>
                      <FormControl>
                        <Input placeholder="如原预算金额" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={changeForm.control}
                  name="afterValue"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>变更后</FormLabel>
                      <FormControl>
                        <Input placeholder="如新预算金额" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <DialogFooter>
                <Button type="submit">提交</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ChangeSection;
