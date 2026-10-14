import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { BadgeCheck, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { projectsApi, revenuesApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import { REVENUE_METHOD_LABELS } from '@client/src/utils/biz-labels';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { CreateProjectRevenueDto, RevenueItem } from '@shared/api.interface';

const REVENUE_STATUS_LABELS: Record<string, string> = {
  recognized: '已确认',
};

const revenueSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/u, '期间格式须为 YYYY-MM，如 2026-10'),
  amount: z.coerce.number().min(0.01, '确认金额必须大于 0'),
  note: z.string(),
});

type RevenueFormData = z.output<typeof revenueSchema>;
type RevenueFormInput = z.input<typeof revenueSchema>;

const FORM_DEFAULTS: RevenueFormInput = {
  period: '',
  amount: 0,
  note: '',
};

interface RevenueSectionProps {
  projectId: string;
  onChanged?: () => void;
}

const RevenueSection: React.FC<RevenueSectionProps> = ({ projectId, onChanged }) => {
  const [createOpen, setCreateOpen] = useState(false);

  const { data: revenues, loading, error, reload } = useAsyncData<RevenueItem[]>(
    () => revenuesApi.listRevenues(projectId),
    [projectId],
  );
  const { data: accounting, reload: reloadAccounting } = useAsyncData(
    () => projectsApi.getProjectAccounting(projectId),
    [projectId],
  );

  const form = useForm<RevenueFormInput, unknown, RevenueFormData>({
    resolver: zodResolver(revenueSchema),
    defaultValues: FORM_DEFAULTS,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateProjectRevenueDto = {
      period: values.period,
      amount: values.amount,
      note: values.note || undefined,
    };
    try {
      await projectsApi.createProjectRevenue(projectId, dto);
      toast.success('收入已确认');
      setCreateOpen(false);
      form.reset(FORM_DEFAULTS);
      await Promise.all([reload(), reloadAccounting()]);
      onChanged?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '收入确认失败'));
    }
  });

  const columns: TableColumnsType<RevenueItem> = [
    { title: '确认编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '期间', dataIndex: 'period', width: 90 },
    {
      title: '确认方法',
      dataIndex: 'method',
      width: 110,
      render: (m: string) => REVENUE_METHOD_LABELS[m] ?? m,
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <StatusBadge status={s} labels={REVENUE_STATUS_LABELS} />,
    },
    { title: '备注', dataIndex: 'remark', width: 180, render: (v) => v ?? '-' },
    { title: '创建时间', dataIndex: 'createdAt', width: 170 },
  ];

  const recognizedRevenue: number = accounting?.recognizedRevenue ?? 0;
  const grossMargin: number = accounting?.grossMargin ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base font-semibold">收入确认</CardTitle>
          <CardDescription>
            已确认收入 {formatMoney(recognizedRevenue)}，毛利 {formatMoney(grossMargin)}
          </CardDescription>
        </div>
        <CanCapabilityWrite capability="projects_write">
          <Button onClick={() => setCreateOpen(true)}>
            <BadgeCheck className="h-4 w-4" />
            确认收入
          </Button>
        </CanCapabilityWrite>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-destructive">
            {error}
            <Button
              variant="ghost"
              size="sm"
              className="ml-2"
              onClick={() => void reload()}
            >
              重试
            </Button>
          </p>
        ) : null}
        <Table
          columns={columns}
          dataSource={revenues ?? []}
          loading={loading}
          rowKey="id"
          scroll={{ x: 1000, y: 400 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: '暂无收入确认记录，点击右上角「确认收入」创建' }}
        />
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>确认收入</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="period"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      期间（YYYY-MM）{' '}
                      <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如 2026-10" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      确认金额（元）{' '}
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
                name="note"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Textarea placeholder="备注" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit">提交确认</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </Card>
  );
};

export default RevenueSection;
