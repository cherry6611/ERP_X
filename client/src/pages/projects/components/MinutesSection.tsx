import React, { useCallback, useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2, Paperclip, Plus, Trash2 } from 'lucide-react';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import { SectionTitle } from '@client/src/components/SectionTitle';
import DateField from '@client/src/components/erp/DateField';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
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
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type {
  CreateProjectMinutesDto,
  ProjectMinutes,
} from '@shared/api.interface';

const MINUTES_TYPE_META: Record<string, { label: string; variant: 'info' | 'secondary' }> = {
  weekly_report: { label: '周报', variant: 'info' },
  meeting: { label: '例会纪要', variant: 'secondary' },
};

const minutesSchema = z.object({
  minutesType: z.string().min(1, '请选择类型'),
  meetingDate: z
    .string()
    .min(1, '请选择日期')
    .refine((v) => /^\d{4}-\d{2}-\d{2}$/u.test(v), '日期格式须为 YYYY-MM-DD'),
  title: z
    .string()
    .min(1, '请输入标题')
    .max(100, '标题不能超过 100 字'),
  content: z.string(),
});

type MinutesFormData = z.infer<typeof minutesSchema>;

interface MinutesSectionProps {
  projectId: string;
  onChanged?: () => void;
}

const MinutesSection: React.FC<MinutesSectionProps> = ({ projectId, onChanged }) => {
  const [minutes, setMinutes] = useState<ProjectMinutes[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [attachTarget, setAttachTarget] = useState<ProjectMinutes | null>(null);

  const minutesForm = useForm<MinutesFormData>({
    resolver: zodResolver(minutesSchema),
    defaultValues: { minutesType: 'weekly_report', meetingDate: '', title: '', content: '' },
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMinutes(await projectsApi.listMinutes(projectId));
    } catch (err) {
      setError(getApiErrorMessage(err, '加载周报/纪要失败'));
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

  const onCreateMinutes = minutesForm.handleSubmit(async (values) => {
    const dto: CreateProjectMinutesDto = {
      minutesType: values.minutesType as CreateProjectMinutesDto['minutesType'],
      meetingDate: values.meetingDate,
      title: values.title,
      content: values.content || undefined,
    };
    setSubmitting(true);
    try {
      await projectsApi.createMinutes(projectId, dto);
      toast.success('纪要已新增');
      setAddOpen(false);
      minutesForm.reset({
        minutesType: 'weekly_report',
        meetingDate: '',
        title: '',
        content: '',
      });
      await refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '新增失败'));
    } finally {
      setSubmitting(false);
    }
  });

  const onDeleteMinutes = async (item: ProjectMinutes) => {
    const ok = await confirmDanger(
      `确认删除纪要「${item.title}」？此操作不可恢复。`,
      { title: '确认删除' },
    );
    if (!ok) return;
    setDeletingId(item.id);
    try {
      await projectsApi.deleteMinutes(item.id);
      toast.success('纪要已删除');
      await refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '删除失败'));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <SectionTitle>周报/纪要</SectionTitle>
        <CanCapabilityWrite capability="projects_write">
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            新增纪要
          </Button>
        </CanCapabilityWrite>
      </div>
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !error && minutes.length === 0}
        emptyText="暂无周报/纪要记录"
      >
        <ul className="space-y-2" data-ai-section-type="card-list">
          {minutes.map((item: ProjectMinutes) => {
            const meta = MINUTES_TYPE_META[item.minutesType] ?? {
              label: item.minutesType,
              variant: 'secondary' as const,
            };
            return (
              <li
                key={item.id}
                className="flex items-center gap-3 rounded-md border px-3 py-2"
              >
                <Badge variant={meta.variant}>{meta.label}</Badge>
                <span className="shrink-0 text-sm text-muted-foreground">
                  {item.meetingDate}
                </span>
                <span className="shrink-0 text-sm font-medium">{item.title}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {item.content ?? '暂无内容'}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`查看附件 ${item.title}`}
                  onClick={() => setAttachTarget(item)}
                >
                  <Paperclip className="mr-1 h-4 w-4" />
                  附件
                </Button>
                <CanCapabilityWrite capability="projects_write">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`删除纪要 ${item.title}`}
                    disabled={deletingId === item.id}
                    onClick={() => void onDeleteMinutes(item)}
                  >
                    {deletingId === item.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4 text-destructive" />
                    )}
                  </Button>
                </CanCapabilityWrite>
              </li>
            );
          })}
        </ul>
      </DataState>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新增周报/纪要</DialogTitle>
          </DialogHeader>
          <Form {...minutesForm}>
            <form onSubmit={onCreateMinutes} className="space-y-4">
              <FormField
                control={minutesForm.control}
                name="minutesType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      类型 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择类型" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(MINUTES_TYPE_META).map(([value, m]) => (
                          <SelectItem key={value} value={value}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={minutesForm.control}
                name="meetingDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      日期 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={minutesForm.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      标题 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：第 42 周周报" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={minutesForm.control}
                name="content"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>内容</FormLabel>
                    <FormControl>
                      <Textarea placeholder="本周进展、例会结论等" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAddOpen(false)}
                  disabled={submitting}
                >
                  取消
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : null}
                  {submitting ? '提交中...' : '确认新增'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={attachTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setAttachTarget(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>附件 - {attachTarget?.title}</DialogTitle>
          </DialogHeader>
          {attachTarget ? (
            <AttachmentField
              resourceType="erp_project_minutes"
              resourceId={attachTarget.id}
              usageHint="会议纪要、周报相关文件或云文档链接"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default MinutesSection;
