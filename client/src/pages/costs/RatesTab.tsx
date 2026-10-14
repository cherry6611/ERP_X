import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability } from '@client/src/platform/auth';
import DateField from '@client/src/components/erp/DateField';
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
import { costsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import type { LaborRate } from '@shared/api.interface';

const rateSchema = z.object({
  roleName: z.string().min(1, '角色名称不能为空'),
  rate: z.coerce.number().min(1, '费率必须大于 0'),
  effectiveFrom: z.string().optional(),
});

type RateFormData = z.output<typeof rateSchema>;
type RateFormInput = z.input<typeof rateSchema>;

const RatesTab: React.FC = () => {
  const [createOpen, setCreateOpen] = useState(false);
  const { data, loading, error, reload } = useAsyncData<LaborRate[]>(
    () => costsApi.listLaborRates(),
    [],
  );

  const form = useForm<RateFormInput, unknown, RateFormData>({
    resolver: zodResolver(rateSchema),
    defaultValues: { roleName: '', rate: 0 },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await costsApi.createLaborRate({
        roleName: values.roleName,
        rate: values.rate,
        effectiveFrom: values.effectiveFrom,
      });
      toast.success('角色费率已设置');
      setCreateOpen(false);
      form.reset({ roleName: '', rate: 0 });
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '设置失败');
    }
  });

  const columns: TableColumnsType<LaborRate> = [
    { title: '角色', dataIndex: 'roleName', width: 200 },
    {
      title: '费率（元/人天）',
      dataIndex: 'rate',
      width: 160,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '生效日期', dataIndex: 'effectiveFrom', width: 140, render: (v) => v ?? '-' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          工时确认时按角色费率折算人力成本（金额 = 工时/8 × 角色费率）
        </p>
        <CanCapability capability="projects_write">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            设置费率
          </Button>
        </CanCapability>
      </div>
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
        dataSource={data ?? []}
        loading={loading}
        rowKey="id"
        scroll={{ x: 600, y: 500 }}
        pagination={{
          pageSize: 10,
          showTotal: (total: number) => `共 ${total} 条`,
        }}
        locale={{ emptyText: '暂无角色费率，点击右上角「设置费率」创建' }}
      />
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>设置角色费率</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="roleName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      角色名称 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：数据工程师" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="rate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      费率（元/人天）{' '}
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
                name="effectiveFrom"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>生效日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
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

export default RatesTab;
