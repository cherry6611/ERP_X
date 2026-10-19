import React from 'react';
import { Explained } from '@client/src/components/erp/ItemHelp';
import { useNavigate } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import StickyActionBar from '@client/src/components/erp/StickyActionBar';
import DateField from '@client/src/components/erp/DateField';
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
import { crmApi, masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { CreateOpportunityDto, Customer } from '@shared/api.interface';

const oppSchema = z.object({
  customerId: z.string().min(1, '请选择客户'),
  title: z.string().min(1, '商机名称不能为空'),
  amount: z.coerce.number().min(0),
  winRate: z.coerce.number().min(0).max(100),
  owner: z.string(),
  expectedDate: z.string().optional(),
});

type OppFormData = z.output<typeof oppSchema>;
type OppFormInput = z.input<typeof oppSchema>;

const OpportunityCreatePage: React.FC = () => {
  const navigate = useNavigate();
  const { data: customers } = useAsyncData<Customer[]>(
    () => masterDataApi.listCustomers(),
    [],
  );

  const form = useForm<OppFormInput, unknown, OppFormData>({
    resolver: zodResolver(oppSchema),
    defaultValues: {
      customerId: '',
      title: '',
      amount: 0,
      winRate: 30,
      owner: '',
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateOpportunityDto = { ...values };
    try {
      const created = await crmApi.createOpportunity(dto);
      toast.success('商机已创建');
      navigate(`/crm/opportunities/${created.id}`, { replace: true });
    } catch (err) {
      toast.error(getApiErrorMessage(err, '创建失败'));
    }
  });

  return (
    <PageShell
      title="新建商机"
      description="创建后进入商机详情，可维护多轮报价与项目资料"
      actions={
        <Button variant="outline" onClick={() => navigate('/crm?tab=opportunities')}>
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
              name="customerId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    客户 <span className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择客户" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(customers ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
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
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    商机名称 <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="如：数据中台建设" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <Explained
                      title="预计金额"
                      content="预估这单能成交的含税金额，只用于销售预测，不会生成合同或应收。"
                    >
                      <FormLabel>预计金额（元）</FormLabel>
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
                name="winRate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <Explained
                      title="赢单率"
                      content="你估计这单能成交的百分比。只记在商机上，不会生成合同，也不会自动改阶段。"
                    >
                      <FormLabel>赢单率（%）</FormLabel>
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
            <FormField
              control={form.control}
              name="owner"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>负责人</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="expectedDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>预计成交日期</FormLabel>
                  <FormControl>
                    <DateField value={field.value} onChange={field.onChange} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <StickyActionBar variant="card" hint="创建后进入商机详情">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate('/crm?tab=opportunities')}
              >
                取消
              </Button>
              <Button type="submit">创建并进入详情</Button>
            </StickyActionBar>
          </form>
        </Form>
        </div>
      </div>
    </PageShell>
  );
};

export default OpportunityCreatePage;



