import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import DateField from '@client/src/components/erp/DateField';
import { Explained } from '@client/src/components/erp/ItemHelp';
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
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Textarea } from '@client/src/components/ui/textarea';
import { projectsApi } from '@client/src/api';
import type {
  ProjectDetail,
  UpdateProjectDto,
} from '@shared/api.interface';

const editProjectSchema = z.object({
  pm: z.string(),
  budget: z.coerce.number().min(0),
  estimatedTotalCost: z
    .union([z.literal(''), z.coerce.number().min(0, '预计总成本不能为负数')])
    .transform((v) => (v === '' ? undefined : v)),
  progress: z.coerce.number().min(0).max(100),
  endDate: z.string().optional(),
  remark: z.string(),
});

type EditProjectFormData = z.output<typeof editProjectSchema>;
type EditProjectFormInput = z.input<typeof editProjectSchema>;

interface ProjectEditDialogProps {
  project: ProjectDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

const ProjectEditDialog: React.FC<ProjectEditDialogProps> = ({
  project,
  open,
  onOpenChange,
  onSaved,
}) => {
  const [saving, setSaving] = useState(false);
  const form = useForm<EditProjectFormInput, unknown, EditProjectFormData>({
    resolver: zodResolver(editProjectSchema),
    defaultValues: {
      pm: project.pm ?? '',
      budget: project.budget,
      estimatedTotalCost: project.estimatedTotalCost ?? '',
      progress: project.progress,
      endDate: project.endDate ?? undefined,
      remark: project.remark ?? '',
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        pm: project.pm ?? '',
        budget: project.budget,
        estimatedTotalCost: project.estimatedTotalCost ?? '',
        progress: project.progress,
        endDate: project.endDate ?? undefined,
        remark: project.remark ?? '',
      });
    }
  }, [open, project, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: UpdateProjectDto = {
      pm: values.pm || undefined,
      budget: values.budget || undefined,
      estimatedTotalCost: values.estimatedTotalCost,
      progress: values.progress,
      endDate: values.endDate,
      remark: values.remark || undefined,
    };
    setSaving(true);
    try {
      await projectsApi.updateProject(project.id, dto);
      toast.success('项目信息已更新');
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败');
    } finally {
      setSaving(false);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>编辑项目</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="pm"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>项目经理</FormLabel>
                    <FormControl>
                      <Input placeholder="请输入项目经理" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="progress"
                render={({ field }) => (
                  <FormItem className="flex-1">
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
            </div>
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="budget"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <Explained
                      title="预算基线"
                      content="费用能不能提交，看的是这个数。留空时使用合同净额。它不是预计总成本。"
                    >
                      <FormLabel>预算基线（元）</FormLabel>
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
                control={form.control}
                name="estimatedTotalCost"
                render={({ field }) => (
                  <FormItem className="flex-1">
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
            </div>
            <FormField
              control={form.control}
              name="endDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>结束日期</FormLabel>
                  <DateField value={field.value} onChange={field.onChange} />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="remark"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>备注</FormLabel>
                  <FormControl>
                    <Textarea placeholder="备注信息" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={saving}>
                保存
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default ProjectEditDialog;
