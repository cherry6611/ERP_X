import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import DateField from '@client/src/components/erp/DateField';
import PageShell from '@client/src/components/PageShell';
import StickyActionBar from '@client/src/components/erp/StickyActionBar';
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
import { contractsApi, crmApi, identityApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { Contract, CreateProjectDto, Quotation } from '@shared/api.interface';

const projectSchema = z.object({
  name: z.string().min(1, '项目名称不能为空'),
  contractId: z.string().min(1, '请选择关联合同'),
  wonQuotationId: z.string().optional(),
  pm: z.string(),
  pmUserId: z.string().optional(),
  deptName: z.string(),
  budget: z.coerce.number().min(0),
  estimatedTotalCost: z
    .union([z.literal(''), z.coerce.number().min(0, '预计总成本不能为负数')])
    .transform((v) => (v === '' ? undefined : v)),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  remark: z.string(),
});

type ProjectFormData = z.output<typeof projectSchema>;
type ProjectFormInput = z.input<typeof projectSchema>;

const ProjectCreatePage: React.FC = () => {
  const navigate = useNavigate();
  const { data: contracts } = useAsyncData<Contract[]>(
    () => contractsApi.listContracts(),
    [],
  );
  const { data: quotations } = useAsyncData<Quotation[]>(
    () => crmApi.listQuotations(),
    [],
  );
  const { data: users } = useAsyncData(
    () => identityApi.listUsers({ status: 'active' }).catch(() => []),
    [],
  );

  const form = useForm<ProjectFormInput, unknown, ProjectFormData>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      name: '',
      contractId: '',
      wonQuotationId: '',
      pm: '',
      pmUserId: '',
      deptName: '',
      budget: 0,
      estimatedTotalCost: '',
      remark: '',
    },
  });

  const contractId = useWatch({ control: form.control, name: 'contractId' });
  const quoteOptions = useMemo(() => {
    const list = quotations ?? [];
    if (!contractId) {
      return list.filter((q) => q.status !== 'void' && q.isWon);
    }
    return list.filter(
      (q) =>
        q.status !== 'void' &&
        (q.contractId === contractId ||
          q.isWon ||
          (q.status === 'converted' && q.contractId === contractId)),
    );
  }, [quotations, contractId]);

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateProjectDto = {
      name: values.name,
      contractId: values.contractId,
      wonQuotationId: values.wonQuotationId || undefined,
      pm: values.pm || undefined,
      pmUserId: values.pmUserId || undefined,
      deptName: values.deptName || undefined,
      budget: values.budget || undefined,
      estimatedTotalCost: values.estimatedTotalCost,
      startDate: values.startDate,
      endDate: values.endDate,
      remark: values.remark || undefined,
    };
    try {
      const created = await projectsApi.createProject(dto);
      toast.success('项目已立项');
      navigate(`/projects/${created.id}`, { replace: true });
    } catch (err) {
      toast.error(getApiErrorMessage(err, '立项失败'));
    }
  });

  return (
    <PageShell
      title="项目立项"
      description="关联合同与最终成交报价单后创建项目"
      actions={
        <Button variant="outline" onClick={() => navigate('/projects')}>
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-xl border border-border/80 bg-card p-6">
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    项目名称 <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="请输入项目名称" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="contractId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    关联合同 <span className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择关联合同" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(contracts ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.code} - {c.name}
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
              name="wonQuotationId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>最终成交报价单</FormLabel>
                  <Select
                    onValueChange={(v) => field.onChange(v === '__none__' ? '' : v)}
                    value={field.value || '__none__'}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="可选：关联商机成交报价" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="__none__">不指定（系统自动匹配）</SelectItem>
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
                name="pmUserId"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>项目经理（系统用户）</FormLabel>
                    <Select
                      value={field.value || '__none__'}
                      onValueChange={(v) => {
                        if (v === '__none__') {
                          field.onChange('');
                          form.setValue('pm', '');
                          return;
                        }
                        field.onChange(v);
                        const u = (users ?? []).find((x) => x.id === v);
                        form.setValue('pm', u?.displayName ?? u?.username ?? '');
                      }}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="选择项目经理账号" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">不指定</SelectItem>
                        {(users ?? []).map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.displayName || u.username}
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
                name="deptName"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>所属部门</FormLabel>
                    <FormControl>
                      <Input {...field} />
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
                        placeholder="选填"
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
                    <DateField value={field.value} onChange={field.onChange} />
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
                    <DateField value={field.value} onChange={field.onChange} />
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
                    <Textarea {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <StickyActionBar
              variant="card"
              hint="保存后进入项目详情，可继续上传立项文档"
            >
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate('/projects')}
              >
                取消
              </Button>
              <Button type="submit">立项</Button>
            </StickyActionBar>
          </form>
        </Form>
        </div>
      </div>
    </PageShell>
  );
};

export default ProjectCreatePage;





