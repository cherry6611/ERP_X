import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import DateField from '@client/src/components/erp/DateField';
import { DataState } from '@client/src/components/DataState';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
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
import { crmApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { submitProjectEdit } from './project-edit-model';
import type { ProjectDetail, Quotation } from '@shared/api.interface';

const editProjectSchema = z.object({
  pm: z.string(),
  budget: z.coerce.number().min(0),
  estimatedTotalCost: z
    .union([z.literal(''), z.coerce.number().min(0, '预计总成本不能为负数')])
    .transform((v) => (v === '' ? undefined : v)),
  progress: z.coerce.number().min(0).max(100),
  endDate: z.string().optional(),
  remark: z.string(),
  wonQuotationId: z.string().optional(),
});

type EditProjectFormData = z.output<typeof editProjectSchema>;
type EditProjectFormInput = z.input<typeof editProjectSchema>;

const ProjectEditPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);

  const { data: project, loading, error, reload } = useAsyncData<ProjectDetail>(
    () => projectsApi.getProject(id ?? ''),
    [id],
  );
  const { data: quotations } = useAsyncData<Quotation[]>(
    () => crmApi.listQuotations(),
    [],
  );

  const form = useForm<EditProjectFormInput, unknown, EditProjectFormData>({
    resolver: zodResolver(editProjectSchema),
    defaultValues: {
      pm: '',
      budget: 0,
      estimatedTotalCost: '',
      progress: 0,
      remark: '',
      wonQuotationId: '',
    },
  });

  useEffect(() => {
    if (!project) return;
    form.reset({
      pm: project.pm ?? '',
      budget: project.budget,
      estimatedTotalCost: project.estimatedTotalCost ?? '',
      progress: project.progress,
      endDate: project.endDate ?? undefined,
      remark: project.remark ?? '',
      wonQuotationId: project.wonQuotationId ?? '',
    });
  }, [project, form]);

  const quoteOptions = useMemo(() => {
    const list = quotations ?? [];
    const contractId = project?.contractId;
    return list.filter(
      (q) =>
        q.status !== 'void' &&
        (!contractId ||
          q.contractId === contractId ||
          q.isWon ||
          q.opportunityId === project?.opportunityId),
    );
  }, [quotations, project]);

  const onSubmit = form.handleSubmit(async (values) => {
    if (!project) return;
    /*
     * DTO 构造移到 `./project-edit-model`（纯逻辑 + 规格）。
     *
     * 原实现是内联的 `pm: values.pm || undefined` / `budget: … || undefined` /
     * `remark: … || undefined` —— 在 PATCH 语义下，`|| undefined` 会把"清空"
     * 变成"字段缺失"，服务端于是跳过它：界面报成功、**库里一个字符没变**。
     * 判据与逐字段规则见该模块文件头。
     */
    setSaving(true);
    try {
      await submitProjectEdit(projectsApi, project.id, values, project);
      toast.success('项目信息已更新');
      navigate(`/projects/${project.id}`, { replace: true });
    } catch (err) {
      toast.error(getApiErrorMessage(err, '更新失败'));
    } finally {
      setSaving(false);
    }
  });

  return (
    <PageShell
      title={project ? `编辑项目 · ${project.code}` : '编辑项目'}
      description={project?.name}
      actions={
        <Button
          variant="outline"
          onClick={() => navigate(id ? `/projects/${id}` : '/projects')}
        >
          <ArrowLeft className="h-4 w-4" />
          返回详情
        </Button>
      }
    >
      <DataState loading={loading} error={error} onRetry={() => void reload()}>
        {project ? (
          <div className="mx-auto w-full max-w-3xl">
            <div className="rounded-xl border border-border/80 bg-card p-6">
            <Form {...form}>
              <form onSubmit={onSubmit} className="space-y-4">
                <FormField
                  control={form.control}
                  name="wonQuotationId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>最终成交报价单</FormLabel>
                      <Select
                        onValueChange={(v) =>
                          field.onChange(v === '__none__' ? '' : v)
                        }
                        value={field.value || '__none__'}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="关联成交报价" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">未关联</SelectItem>
                          {quoteOptions.map((q) => (
                            <SelectItem key={q.id} value={q.id}>
                              {q.code}
                              {q.roundNo ? ` · 第${q.roundNo}轮` : ''} · {q.title}（
                              {formatMoney(q.totalAmount)}）
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex gap-4">
                  <FormField
                    control={form.control}
                    name="pm"
                    render={({ field }) => (
                      <FormItem className="flex-1">
                        <FormLabel>项目经理</FormLabel>
                        <FormControl>
                          <Input {...field} />
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
                        <FormLabel>进度（%）</FormLabel>
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
                        <FormLabel>预算基线（元）</FormLabel>
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
                        <FormLabel>预计总成本（元）</FormLabel>
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
                        <Textarea {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => navigate(`/projects/${project.id}`)}
                  >
                    取消
                  </Button>
                  <Button type="submit" disabled={saving}>
                    保存
                  </Button>
                </div>
              </form>
            </Form>
            </div>
          </div>
        ) : null}
      </DataState>
    </PageShell>
  );
};

export default ProjectEditPage;

