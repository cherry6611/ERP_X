import React, { useCallback, useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { CheckCircle2 } from 'lucide-react';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import { SectionTitle } from '@client/src/components/SectionTitle';
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
import type { ProjectDetail } from '@shared/api.interface';

const closeProjectFormSchema = z.object({
  closeSummary: z.string().min(1, '结项总结不能为空'),
  satisfaction: z.string(),
  retrospective: z.string(),
});

type CloseProjectFormData = z.infer<typeof closeProjectFormSchema>;

interface CloseProjectSectionProps {
  projectId: string;
  onChanged?: () => void;
}

const CloseProjectSection: React.FC<CloseProjectSectionProps> = ({ projectId, onChanged }) => {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);

  const closeForm = useForm<CloseProjectFormData>({
    resolver: zodResolver(closeProjectFormSchema),
    defaultValues: { closeSummary: '', satisfaction: '', retrospective: '' },
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await projectsApi.getProject(projectId));
    } catch (err) {
      setError(getApiErrorMessage(err, '加载结项信息失败'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCloseProject = () => {
    closeForm.reset({ closeSummary: '', satisfaction: '', retrospective: '' });
    setCloseOpen(true);
  };

  const onCloseProject = closeForm.handleSubmit(async (values) => {
    try {
      await projectsApi.changeProjectStatus(projectId, 'close', {
        closeSummary: values.closeSummary,
        satisfaction: values.satisfaction ? Number(values.satisfaction) : undefined,
        retrospective: values.retrospective || undefined,
      });
      toast.success('项目已结项');
      setCloseOpen(false);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '结项失败'));
    }
  });

  if ((loading || error) && !detail) {
    return <DataState loading={loading} error={error} />;
  }
  if (!detail) return null;

  if (detail.closedAt) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border p-4 text-sm">
        <SectionTitle>结项信息</SectionTitle>
        <div>
          <p className="text-muted-foreground">结项总结</p>
          <p className="break-words">{detail.closeSummary ?? '-'}</p>
        </div>
        <div>
          <p className="text-muted-foreground">复盘结论</p>
          <p className="break-words">{detail.retrospective ?? '-'}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-muted-foreground">客户满意度</p>
            <p>{detail.satisfaction != null ? `${detail.satisfaction} / 5` : '-'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">结项时间</p>
            <p>{detail.closedAt}</p>
          </div>
        </div>
      </div>
    );
  }

  if (detail.status !== 'accepting') return null;

  return (
    <div className="flex flex-col gap-3">
      <CanCapabilityWrite capability="projects_write">
        <div>
          <Button size="sm" onClick={openCloseProject}>
            <CheckCircle2 className="h-4 w-4" />
            结项
          </Button>
        </div>
      </CanCapabilityWrite>

      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>结项</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            结项要求全部交付物已通过验收；结项后项目进入只读归档状态
          </p>
          <Form {...closeForm}>
            <form onSubmit={onCloseProject} className="space-y-4">
              <FormField
                control={closeForm.control}
                name="closeSummary"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      结项总结 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Textarea placeholder="请总结项目交付与成果" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={closeForm.control}
                name="satisfaction"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>客户满意度</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || undefined}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择（1-5）" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {['1', '2', '3', '4', '5'].map((v: string) => (
                          <SelectItem key={v} value={v}>
                            {v}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={closeForm.control}
                name="retrospective"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>复盘结论</FormLabel>
                    <FormControl>
                      <Textarea placeholder="可空" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit">确认结项</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default CloseProjectSection;
