import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
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
import { Textarea } from '@/components/ui/textarea';
import { revenuesApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  AdjustType,
  CreateRevenueAdjustDto,
  RevenueAdjust,
  RevenueItem,
} from '@shared/api.interface';

const ADJUSTMENT_TYPE_LABELS: Record<string, string> = {
  discount: '折让',
  return: '退回',
  other: '其他',
};

const adjustmentSchema = z.object({
  revenueId: z.string().min(1, '请选择收入记录'),
  adjustmentType: z.string().min(1, '请选择调整类型'),
  amount: z.coerce.number().min(0.01, '调整金额必须大于 0'),
  reason: z.string().min(1, '请填写调整原因'),
});

type AdjustmentFormData = z.output<typeof adjustmentSchema>;
type AdjustmentFormInput = z.input<typeof adjustmentSchema>;

const AdjustmentsTab: React.FC = () => {
  const [createOpen, setCreateOpen] = useState(false);

  const { data, loading, error, reload } = useAsyncData<RevenueAdjust[]>(
    () => revenuesApi.listAdjusts(),
    [],
  );
  const { data: revenues } = useAsyncData<RevenueItem[]>(
    () => revenuesApi.listRevenues(),
    [],
  );

  const form = useForm<AdjustmentFormInput, unknown, AdjustmentFormData>({
    resolver: zodResolver(adjustmentSchema),
    defaultValues: { revenueId: '', adjustmentType: 'discount', amount: 0, reason: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateRevenueAdjustDto = {
      revenueId: values.revenueId,
      adjustType: values.adjustmentType as AdjustType,
      amount: values.amount,
      reason: values.reason,
    };
    try {
      await revenuesApi.createAdjust(dto);
      toast.success('收入调整已登记');
      setCreateOpen(false);
      form.reset({ revenueId: '', adjustmentType: 'discount', amount: 0, reason: '' });
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '登记失败'));
    }
  });

  const columns: TableColumnsType<RevenueAdjust> = [
    { title: '调整编号', dataIndex: 'code', fixed: 'left', width: 150 },
    {
      title: '类型',
      dataIndex: 'adjustType',
      width: 90,
      render: (t: string) => <Badge variant="secondary">{ADJUSTMENT_TYPE_LABELS[t] ?? t}</Badge>,
    },
    {
      title: '调整金额（含税）',
      dataIndex: 'amount',
      width: 140,
      render: (v: number) => formatMoney(v),
    },
    { title: '原因', dataIndex: 'reason', width: 220 },
    {
      title: '调整日期',
      dataIndex: 'createdAt',
      width: 170,
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">折让、冲销、补提等收入调整记录</p>
        <CanRole roles={['admin']}>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            登记调整
          </Button>
        </CanRole>
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
          scroll={{ x: 1000, y: 500 }}
          pagination={false}
          locale={{ emptyText: '暂无收入调整记录' }}
        />
      </DataState>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>登记收入调整</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="revenueId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      原收入记录 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择收入记录" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(revenues ?? []).map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.code} - {r.projectName}（{formatMoney(r.amount)}）
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
                  name="adjustmentType"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        调整类型 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(ADJUSTMENT_TYPE_LABELS).map(([value, label]) => (
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
                  name="amount"
                  render={({ field }) => (
                    <FormItem className="flex-1">
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
              </div>
              <FormField
                control={form.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      调整原因 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Textarea placeholder="如：客户协商折让 5%" {...field} />
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
    </div>
  );
};

export default AdjustmentsTab;
