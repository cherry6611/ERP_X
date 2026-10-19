import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Explained } from '@client/src/components/erp/ItemHelp';
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
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import { PROJECT_STATUS_LABELS } from '@client/src/utils/biz-labels';
import MilestoneSection from '@client/src/pages/projects/components/MilestoneSection';
import DeliverableSection from '@client/src/pages/projects/components/DeliverableSection';
import ChangeSection from '@client/src/pages/projects/components/ChangeSection';
import CloseProjectSection from '@client/src/pages/projects/components/CloseProjectSection';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { ProjectDetail, ProjectStatusAction } from '@shared/api.interface';

// close 动作入口由 CloseProjectSection 提供，这里只保留其余状态动作
const STATUS_ACTIONS: Partial<Record<string, { action: ProjectStatusAction; label: string }[]>> = {
  initiating: [{ action: 'approve', label: '批准立项' }],
  executing: [{ action: 'deliver', label: '进入交付' }],
  delivering: [{ action: 'accept', label: '进入验收' }],
  accepting: [{ action: 'close', label: '结项' }],
};

const progressSchema = z.object({
  progress: z.coerce.number().min(0).max(100),
  estimatedTotalCost: z
    .union([z.literal(''), z.coerce.number().min(0, '预计总成本不能为负数')])
    .transform((v) => (v === '' ? undefined : v)),
  endDate: z.string().optional(),
});

type ProgressFormData = z.output<typeof progressSchema>;
type ProgressFormInput = z.input<typeof progressSchema>;

interface ProjectDetailDialogProps {
  projectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ProjectDetailDialog: React.FC<ProjectDetailDialogProps> = ({
  projectId,
  open,
  onOpenChange,
}) => {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressOpen, setProgressOpen] = useState(false);

  const progressForm = useForm<ProgressFormInput, unknown, ProgressFormData>({
    resolver: zodResolver(progressSchema),
    defaultValues: { progress: 0 },
  });

  const load = async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await projectsApi.getProject(projectId));
    } catch (err) {
      setError(getApiErrorMessage(err, '加载项目详情失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open, projectId]);

  const doAction = async (action: ProjectStatusAction) => {
    if (!projectId) return;
    try {
      await projectsApi.changeProjectStatus(projectId, action);
      toast.success('状态已更新');
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  const openProgress = () => {
    if (!detail) return;
    progressForm.reset({
      progress: detail.progress,
      estimatedTotalCost: detail.estimatedTotalCost ?? '',
      endDate: detail.endDate ?? undefined,
    });
    setProgressOpen(true);
  };

  const onProgress = progressForm.handleSubmit(async (values) => {
    if (!projectId) return;
    try {
      await projectsApi.updateProject(projectId, {
        progress: values.progress,
        estimatedTotalCost: values.estimatedTotalCost,
        endDate: values.endDate,
      });
      toast.success('进度已更新');
      setProgressOpen(false);
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '更新失败'));
    }
  });

  const actions = detail
    ? (STATUS_ACTIONS[detail.status] ?? []).filter(({ action }) => action !== 'close')
    : [];
  const accounting = detail?.accounting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            项目详情 - {detail?.code ?? ''}{' '}
            {detail ? (
              <StatusBadge status={detail.status} labels={PROJECT_STATUS_LABELS} />
            ) : null}
          </DialogTitle>
        </DialogHeader>
        <DataState loading={loading} error={error}>
        {detail && accounting ? (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground">关联合同</p>
                <p>{detail.contractName}</p>
              </div>
              <div>
                <p className="text-muted-foreground">项目经理</p>
                <p>{detail.pm ?? '-'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">所属部门</p>
                <p>{detail.deptName ?? '-'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">预算基线</p>
                <p>{formatMoney(detail.budget)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">预计总成本</p>
                <p>{formatMoney(detail.estimatedTotalCost)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">项目周期</p>
                <p>
                  {detail.startDate ?? '-'} ~ {detail.endDate ?? '-'}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">当前进度</p>
                <p>{formatPercent(detail.progress)}</p>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
              <div>
                <p className="text-muted-foreground text-xs">已确认收入</p>
                <p className="font-semibold">{formatMoney(accounting.recognizedRevenue)}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">已归集成本</p>
                <p className="font-semibold">{formatMoney(accounting.totalCost)}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">项目毛利</p>
                <p
                  className={`font-semibold ${accounting.grossMargin >= 0 ? '' : 'text-destructive'}`}
                >
                  {formatMoney(accounting.grossMargin)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">毛利率</p>
                <p className="font-semibold">{formatPercent(accounting.marginRate)}</p>
              </div>
            </div>

            {projectId ? (
              <CloseProjectSection projectId={projectId} onChanged={load} />
            ) : null}

            {detail.status !== 'closed' ? (
              <div className="flex flex-wrap gap-2">
                <CanCapabilityWrite capability="projects_write">
                  {actions.map(({ action, label }) => (
                    <Button key={action} size="sm" onClick={() => void doAction(action)}>
                      {label}
                    </Button>
                  ))}
                  <Button size="sm" variant="outline" onClick={openProgress}>
                    更新进度
                  </Button>
                </CanCapabilityWrite>
              </div>
            ) : null}

            {projectId ? (
              <MilestoneSection projectId={projectId} onChanged={load} />
            ) : null}

            {projectId ? (
              <DeliverableSection projectId={projectId} onChanged={load} />
            ) : null}

            {projectId ? <ChangeSection projectId={projectId} onChanged={load} /> : null}

            {projectId ? (
              <div className="border-t pt-4">
                <AttachmentField
                  resourceType="erp_project"
                  resourceId={projectId}
                  usageHint="立项文档、方案文件、验收材料等"
                />
              </div>
            ) : null}
          </div>
        ) : null}
        </DataState>

        <Dialog open={progressOpen} onOpenChange={setProgressOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>更新项目进度与成本</DialogTitle>
            </DialogHeader>
            <Form {...progressForm}>
              <form onSubmit={onProgress} className="space-y-4">
                <FormField
                  control={progressForm.control}
                  name="progress"
                  render={({ field }) => (
                    <FormItem>
                      <Explained
                        title="进度"
                        content="有里程碑权重时，进度按已达成的权重自动重算。没有里程碑时可以手工填。进度不会自动确认收入或开票。"
                      >
                        <FormLabel>进度（%）</FormLabel>
                      </Explained>
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
                  control={progressForm.control}
                  name="estimatedTotalCost"
                  render={({ field }) => (
                    <FormItem>
                      <Explained
                        title="预计总成本"
                        content="用来提前看项目会不会超支，不参与费用能否提交的判断。费用控制看的是预算基线。"
                      >
                        <FormLabel>预计总成本（元）</FormLabel>
                      </Explained>
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
                  control={progressForm.control}
                  name="endDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>结束日期（YYYY-MM-DD）</FormLabel>
                      <FormControl>
                        <Input placeholder="YYYY-MM-DD" {...field} value={field.value ?? ''} />
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
      </DialogContent>
    </Dialog>
  );
};

export default ProjectDetailDialog;
