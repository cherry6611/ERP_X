import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { DataState } from '@client/src/components/DataState';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { projectsApi, revenuesApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { formatMoney } from '@client/src/utils/format';
import { REVENUE_METHOD_LABELS } from '@client/src/utils/biz-labels';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  CreateRevenueDto,
  Project,
  RevenueItem,
  RevenueMethod,
} from '@shared/api.interface';

const revenueSchema = z.object({
  projectId: z.string().min(1, '请选择项目'),
  period: z.string().regex(/^\d{4}-\d{2}$/, '期间格式为 YYYY-MM'),
  method: z.string().min(1, '请选择确认方式'),
  amount: z.coerce.number().min(1, '确认金额必须大于 0'),
  basis: z.string(),
});

type RevenueFormData = z.output<typeof revenueSchema>;
type RevenueFormInput = z.input<typeof revenueSchema>;

const RevenuesTab: React.FC = () => {
  const [projectFilter, setProjectFilter] = useState('all');
  const [createOpen, setCreateOpen] = useState(false);

  const { data, loading, error, reload } = useAsyncData<RevenueItem[]>(
    () => revenuesApi.listRevenues(projectFilter !== 'all' ? projectFilter : undefined),
    [projectFilter],
  );
  const { data: projects } = useAsyncData<Project[]>(() => projectsApi.listProjects(), []);

  const form = useForm<RevenueFormInput, unknown, RevenueFormData>({
    resolver: zodResolver(revenueSchema),
    defaultValues: { projectId: '', period: '', method: 'milestone', amount: 0, basis: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateRevenueDto = {
      projectId: values.projectId,
      period: values.period,
      method: values.method as RevenueMethod,
      amount: values.amount,
      basis: values.basis || undefined,
    };
    try {
      await revenuesApi.createRevenue(dto);
      toast.success('收入已确认');
      setCreateOpen(false);
      form.reset({ projectId: '', period: '', method: 'milestone', amount: 0, basis: '' });
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '确认失败'));
    }
  });

  const columns: TableColumnsType<RevenueItem> = [
    { title: '确认编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '项目', dataIndex: 'projectName', width: 180 },
    {
      title: '确认方式',
      dataIndex: 'method',
      width: 110,
      render: (m: string) => (
        <Badge variant="secondary">{REVENUE_METHOD_LABELS[m] ?? m}</Badge>
      ),
    },
    { title: '期间', dataIndex: 'period', width: 90 },
    {
      title: '确认金额（含税）',
      dataIndex: 'amount',
      width: 140,
      render: (v: number) => formatMoney(v),
    },
    { title: '依据', dataIndex: 'basis', width: 180, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) =>
        s === 'reversed' ? (
          <Badge variant="outline">已红冲</Badge>
        ) : (
          <Badge variant="secondary">已确认</Badge>
        ),
    },
    { title: '确认日期', dataIndex: 'createdAt', width: 170, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      fixed: 'right',
      render: (_: unknown, row: RevenueItem) =>
        row.status === 'reversed' ? (
          '-'
        ) : (
          <CanCapabilityWrite capability="finance_write">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleReverse(row)}
            >
              红冲
            </Button>
          </CanCapabilityWrite>
        ),
    },
  ];

  async function handleReverse(row: RevenueItem) {
    const ok = await confirmDanger(
      `确认红冲收入 ${row.code}？将冲回应收并生成冲销凭证。`,
    );
    if (!ok) {
      return;
    }
    try {
      await revenuesApi.reverseRevenue(row.id, { reason: `手工红冲 ${row.code}` });
      toast.success('收入已红冲');
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '红冲失败'));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="rev-project-filter">项目</Label>
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger id="rev-project-filter" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部项目</SelectItem>
              {(projects ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* 修复 P0-4：后端 POST /api/revenues 是 @CanRole(['admin'])，
            未包裹时普通用户（如 finance_viewer）看得见、点得动，提交后 403 */}
        <CanCapabilityWrite capability="finance_write">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            确认收入
          </Button>
        </CanCapabilityWrite>
      </div>
      <DataState
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          columns={columns}
          dataSource={data ?? []}
          rowKey="id"
          scroll={{ x: 1200, y: 500 }}
          pagination={false}
          locale={{ emptyText: '暂无收入确认记录' }}
        />
      </DataState>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>确认收入</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="projectId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      项目 <span aria-hidden="true" className="text-destructive">*</span>
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
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="method"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        确认方式 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(REVENUE_METHOD_LABELS).map(([value, label]) => (
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
                  control={form.control}
                  name="period"
                  render={({ field }) => (
                    <FormItem className="flex-1">
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
              </div>
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
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
                name="basis"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>确认依据</FormLabel>
                    <FormControl>
                      <Textarea placeholder="如：里程碑「一期交付」达成" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit">确认</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default RevenuesTab;
