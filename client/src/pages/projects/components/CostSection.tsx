import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Paperclip, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import DateField from '@client/src/components/erp/DateField';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { costsApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { formatMoney } from '@client/src/utils/format';
import { COST_TYPE_LABELS } from '@client/src/utils/biz-labels';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { CostItem, CostType, CreateCostDto, CostTypeSummary } from '@shared/api.interface';

const costSchema = z.object({
  costType: z.string().min(1, '请选择成本类型'),
  amount: z.coerce.number().min(1, '金额必须大于 0'),
  occurredDate: z.string().optional(),
  sourceRef: z.string().min(1, '请填写来源摘要'),
  remark: z.string(),
});

type CostFormData = z.output<typeof costSchema>;
type CostFormInput = z.input<typeof costSchema>;

const FORM_DEFAULTS: CostFormInput = {
  costType: 'compute',
  amount: 0,
  sourceRef: '',
  remark: '',
};

interface CostSectionProps {
  projectId: string;
  onChanged?: () => void;
}

const CostSection: React.FC<CostSectionProps> = ({ projectId, onChanged }) => {
  const [createOpen, setCreateOpen] = useState(false);
  const [attachmentTarget, setAttachmentTarget] = useState<CostItem | null>(null);

  const { data: costs, loading, error, reload } = useAsyncData<CostItem[]>(
    () => costsApi.listCosts(projectId),
    [projectId],
  );
  const { data: summary, reload: reloadSummary } = useAsyncData<CostTypeSummary[]>(
    () => costsApi.getCostSummary(projectId),
    [projectId],
  );
  const { data: accounting, reload: reloadAccounting } = useAsyncData(
    () => projectsApi.getProjectAccounting(projectId),
    [projectId],
  );

  const form = useForm<CostFormInput, unknown, CostFormData>({
    resolver: zodResolver(costSchema),
    defaultValues: FORM_DEFAULTS,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateCostDto = {
      projectId,
      costType: values.costType as CostType,
      amount: values.amount,
      occurredDate: values.occurredDate,
      sourceRef: values.sourceRef,
      remark: values.remark || undefined,
    };
    try {
      await costsApi.createCost(dto);
      toast.success('成本已归集');
      setCreateOpen(false);
      form.reset(FORM_DEFAULTS);
      await Promise.all([reload(), reloadSummary(), reloadAccounting()]);
      onChanged?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '归集失败'));
    }
  });

  const columns: TableColumnsType<CostItem> = [
    { title: '成本编号', dataIndex: 'code', fixed: 'left', width: 140 },
    {
      title: '成本类型',
      dataIndex: 'costType',
      width: 100,
      render: (t: string) => COST_TYPE_LABELS[t] ?? t,
    },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '期间', dataIndex: 'period', width: 90 },
    { title: '发生日期', dataIndex: 'occurredDate', width: 110, render: (v) => v ?? '-' },
    { title: '来源摘要', dataIndex: 'sourceRef', width: 200 },
    { title: '备注', dataIndex: 'remark', width: 160, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 160,
      render: (_, record) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setAttachmentTarget(record)}>
            <Paperclip className="h-4 w-4" />
            凭证
          </Button>
          {Number(record.amount) > 0 ? (
            <CanCapabilityWrite capability="projects_write">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const ok = await confirmDanger(
                      `确认红冲成本 ${record.code}？将生成冲销记录，此操作不可恢复。`,
                    );
                    if (!ok) return;
                    try {
                      await costsApi.redFlushCost(record.id);
                      toast.success('已红冲');
                      await Promise.all([
                        reload(),
                        reloadSummary(),
                        reloadAccounting(),
                      ]);
                      onChanged?.();
                    } catch (err: unknown) {
                      toast.error(getApiErrorMessage(err, '红冲失败'));
                    }
                  })();
                }}
              >
                红冲
              </Button>
            </CanCapabilityWrite>
          ) : null}
        </div>
      ),
    },
  ];

  const totalCost: number = accounting?.totalCost ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base font-semibold">成本</CardTitle>
          <CardDescription>成本合计 {formatMoney(totalCost)}</CardDescription>
        </div>
        <CanCapabilityWrite capability="projects_write">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            登记成本
          </Button>
        </CanCapabilityWrite>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          {(summary ?? []).map((item: CostTypeSummary) => (
            <span
              key={item.costType}
              className="rounded-md border bg-muted/40 px-2.5 py-1 text-sm"
            >
              {COST_TYPE_LABELS[item.costType] ?? item.costType}：
              <span className="font-medium tabular-nums">{formatMoney(item.amount)}</span>
            </span>
          ))}
          {(summary ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无成本汇总</p>
          ) : null}
        </div>
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
          dataSource={costs ?? []}
          loading={loading}
          rowKey="id"
          scroll={{ x: 1100, y: 400 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: '暂无成本，点击右上角「登记成本」创建' }}
        />
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>登记成本</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="costType"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        成本类型{' '}
                        <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择成本类型" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(COST_TYPE_LABELS).map(([value, label]) => (
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
                        金额（元）{' '}
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
                name="occurredDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>发生日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="sourceRef"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      来源摘要{' '}
                      <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：GPU 训练资源采购" {...field} />
                    </FormControl>
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
                      <Textarea placeholder="备注" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit">提交登记</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={attachmentTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setAttachmentTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              成本凭证 -{' '}
              {attachmentTarget
                ? `${formatMoney(attachmentTarget.amount)} · ${
                    COST_TYPE_LABELS[attachmentTarget.costType] ?? attachmentTarget.costType
                  }`
                : ''}
            </DialogTitle>
          </DialogHeader>
          {attachmentTarget ? (
            <AttachmentField
              resourceType="erp_project_cost"
              resourceId={attachmentTarget.id}
              usageHint="发票、结算单、成本明细表格等凭证"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
};

export default CostSection;
