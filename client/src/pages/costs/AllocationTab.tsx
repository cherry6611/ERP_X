import React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Button } from '@client/src/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@client/src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { costsApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import { COST_TYPE_LABELS } from '@client/src/utils/biz-labels';
import type { CreateAllocationDto, Project } from '@shared/api.interface';

const allocSchema = z.object({
  sourceDesc: z.string().min(1, '来源说明不能为空'),
  period: z.string().regex(/^\d{4}-\d{2}$/, '期间格式为 YYYY-MM'),
  costType: z.string().min(1, '请选择成本类型'),
  amount: z.coerce.number().min(1, '金额必须大于 0'),
  targetProjectId: z.string().min(1, '请选择分摊项目'),
});

type AllocFormData = z.output<typeof allocSchema>;
type AllocFormInput = z.input<typeof allocSchema>;

const AllocationTab: React.FC = () => {
  const { data: allocations, loading, error, reload } = useAsyncData(() =>
    costsApi.listCosts(),
  );
  const { data: projects } = useAsyncData<Project[]>(() => projectsApi.listProjects(), []);

  const form = useForm<AllocFormInput, unknown, AllocFormData>({
    resolver: zodResolver(allocSchema),
    defaultValues: {
      sourceDesc: '',
      period: '',
      costType: 'compute',
      amount: 0,
      targetProjectId: '',
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateAllocationDto = {
      sourceDesc: values.sourceDesc,
      period: values.period,
      costType: values.costType as CreateAllocationDto['costType'],
      amount: values.amount,
      targetProjectId: values.targetProjectId,
      sourceRef: values.sourceDesc,
    };
    try {
      await costsApi.createAllocation(dto);
      toast.success('公共成本已分摊到项目');
      form.reset({ sourceDesc: '', period: '', costType: 'compute', amount: 0, targetProjectId: '' });
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '分摊失败');
    }
  });

  const allocItems = (allocations ?? []).filter((c) => c.sourceRef === 'allocation');

  const columns: TableColumnsType<(typeof allocItems)[number]> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '来源说明', dataIndex: 'sourceRef', width: 220 },
    {
      title: '成本类型',
      dataIndex: 'costType',
      width: 120,
      render: (t: string) => COST_TYPE_LABELS[t] ?? t,
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '分摊项目', dataIndex: 'projectName', width: 180 },
    { title: '期间', dataIndex: 'period', width: 100 },
  ];

  const executingProjects = (projects ?? []).filter(
    (p) => p.status === 'executing' || p.status === 'delivering',
  );
  const totalBudget = executingProjects.reduce((acc: number, p) => acc + p.budget, 0);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        公共成本（如公共云资源、工具订阅）登记后直接分摊到指定项目成本。
      </p>
      <Form {...form}>
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-4">
          <FormField
            control={form.control}
            name="sourceDesc"
            render={({ field }) => (
              <FormItem className="flex-1 min-w-48">
                <FormLabel>
                  来源说明 <span aria-hidden="true" className="text-destructive">*</span>
                </FormLabel>
                <FormControl>
                  <Input placeholder="如：2026-10 公共云资源" {...field} />
                </FormControl>
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
          <FormField
            control={form.control}
            name="amount"
            render={({ field }) => (
              <FormItem className="w-40">
                <FormLabel>
                  金额（含税）{' '}
                  <span aria-hidden="true" className="text-destructive">*</span>
                </FormLabel>
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
            name="targetProjectId"
            render={({ field }) => (
              <FormItem className="w-56">
                <FormLabel>
                  分摊项目 <span aria-hidden="true" className="text-destructive">*</span>
                </FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="请选择项目" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {(projects ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <CanRole roles={['admin']}>
            <Button type="submit">登记分摊</Button>
          </CanRole>
        </form>
      </Form>
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
        dataSource={allocItems}
        loading={loading}
        rowKey="id"
        scroll={{ x: 900, y: 400 }}
        pagination={{
          pageSize: 10,
          showTotal: (total: number) => `共 ${total} 条`,
        }}
        locale={{ emptyText: '暂无分摊记录，点击「登记分摊」创建' }}
      />
      <div className="rounded-lg border bg-card p-4">
        <SectionTitle>当前执行中项目预算占比（分摊依据）</SectionTitle>
        <div className="mt-3 flex flex-col gap-2">
          {executingProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无执行中项目</p>
          ) : (
            executingProjects.map((p) => (
              <div key={p.id} className="flex items-center gap-3 text-sm">
                <span className="w-56 truncate">{p.name}</span>
                <div className="h-2 flex-1 rounded-full bg-muted">
                  <div
                    className="h-2 rounded-full bg-primary"
                    style={{
                      width: totalBudget > 0 ? `${(p.budget / totalBudget) * 100}%` : '0%',
                    }}
                  />
                </div>
                <span className="w-28 text-right">{formatMoney(p.budget)}</span>
                <span className="w-16 text-right text-muted-foreground">
                  {formatPercent(totalBudget > 0 ? (p.budget / totalBudget) * 100 : 0)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default AllocationTab;
