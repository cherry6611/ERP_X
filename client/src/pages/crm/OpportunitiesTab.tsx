import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Download, Plus, Target } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import FilterBar from '@client/src/components/erp/FilterBar';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import DateField from '@client/src/components/erp/DateField';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
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
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@client/src/components/ui/empty';
import { crmApi, masterDataApi } from '@client/src/api';
import QuotationFormDialog from './QuotationFormDialog';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { OPP_STAGE_LABELS } from '@client/src/utils/biz-labels';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import type {
  CreateOpportunityDto,
  Customer,
  Opportunity,
  OpportunityStage,
  UpdateOpportunityDto,
} from '@shared/api.interface';

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

const advanceSchema = z.object({
  stage: z.string().min(1, '请选择阶段'),
  amount: z.coerce.number().min(0),
  winRate: z.coerce.number().min(0).max(100),
});

type AdvanceFormData = z.output<typeof advanceSchema>;
type AdvanceFormInput = z.input<typeof advanceSchema>;

const STAGE_ORDER = Object.keys(OPP_STAGE_LABELS);

const OPP_EXPORT_COLUMNS: ExcelSheetColumn<Opportunity>[] = [
  { header: '编号', value: (row: Opportunity) => row.code },
  { header: '客户', value: (row: Opportunity) => row.customerName },
  { header: '商机名称', value: (row: Opportunity) => row.title },
  {
    header: '阶段',
    value: (row: Opportunity) => OPP_STAGE_LABELS[row.stage] ?? row.stage,
  },
  { header: '预计金额', value: (row: Opportunity) => row.amount },
  { header: '赢单率（%）', value: (row: Opportunity) => row.winRate },
  { header: '负责人', value: (row: Opportunity) => row.owner ?? '' },
  { header: '预计成交', value: (row: Opportunity) => row.expectedDate ?? '' },
];

const OpportunitiesTab: React.FC = () => {
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [advanceTarget, setAdvanceTarget] = useState<Opportunity | null>(null);
  const [detailTarget, setDetailTarget] = useState<Opportunity | null>(null);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [quotePreset, setQuotePreset] = useState<
    { customerId?: string; opportunityId?: string; title?: string } | undefined
  >(undefined);

  const { data, loading, error, reload } = useAsyncData<Opportunity[]>(
    () => crmApi.listOpportunities(stageFilter !== 'all' ? stageFilter : undefined),
    [stageFilter],
  );
  const { data: customers } = useAsyncData<Customer[]>(() => masterDataApi.listCustomers(), []);

  const createForm = useForm<OppFormInput, unknown, OppFormData>({
    resolver: zodResolver(oppSchema),
    defaultValues: {
      customerId: '',
      title: '',
      amount: 0,
      winRate: 30,
      owner: '',
    },
  });

  const advanceForm = useForm<AdvanceFormInput, unknown, AdvanceFormData>({
    resolver: zodResolver(advanceSchema),
    defaultValues: { stage: 'following', amount: 0, winRate: 30 },
  });

  const openCreate = () => {
    createForm.reset({ customerId: '', title: '', amount: 0, winRate: 30, owner: '' });
    setCreateOpen(true);
  };

  const openAdvance = (opp: Opportunity) => {
    advanceForm.reset({
      stage: opp.stage,
      amount: opp.amount,
      winRate: opp.winRate,
    });
    setAdvanceTarget(opp);
  };

  const openQuotation = (opp: Opportunity) => {
    setQuotePreset({
      customerId: opp.customerId,
      opportunityId: opp.id,
      title: opp.title,
    });
    setQuoteOpen(true);
  };

  const onCreate = createForm.handleSubmit(async (values) => {
    const dto: CreateOpportunityDto = { ...values };
    try {
      const created = await crmApi.createOpportunity(dto);
      toast.success('商机已创建');
      setCreateOpen(false);
      await reload();
      setDetailTarget(created);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    }
  });

  const onAdvance = advanceForm.handleSubmit(async (values) => {
    if (!advanceTarget) return;
    const dto: UpdateOpportunityDto = {
      stage: values.stage as OpportunityStage,
      amount: values.amount,
      winRate: values.winRate,
    };
    try {
      await crmApi.updateOpportunity(advanceTarget.id, dto);
      toast.success('商机已更新');
      setAdvanceTarget(null);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败');
    }
  });

  const convert = async (opp: Opportunity) => {
    try {
      const contract = await crmApi.convertOpportunity(opp.id);
      toast.success(`已生成合同草稿 ${contract.code}`);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '转合同失败');
    }
  };

  const handleExport = () => {
    const rows: Opportunity[] = data ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('商机列表.xlsx', '商机', OPP_EXPORT_COLUMNS, rows);
  };

  const columns: TableColumnsType<Opportunity> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '客户', dataIndex: 'customerName', width: 160 },
    { title: '商机名称', dataIndex: 'title', width: 200 },
    {
      title: '阶段',
      dataIndex: 'stage',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={OPP_STAGE_LABELS} />,
    },
    {
      title: '预计金额',
      dataIndex: 'amount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '赢单率',
      dataIndex: 'winRate',
      width: 90,
      render: (v: number) => formatPercent(v),
    },
    { title: '负责人', dataIndex: 'owner', width: 100, render: (v) => v ?? '-' },
    { title: '预计成交', dataIndex: 'expectedDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 200,
      render: (_, record) => (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setDetailTarget(record)}>
            详情
          </Button>
          <CanRole roles={['admin']}>
            <Button variant="ghost" size="sm" onClick={() => openAdvance(record)}>
              推进
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openQuotation(record)}
            >
              报价
            </Button>
            {record.stage === 'won' ? (
              <Button variant="ghost" size="sm" onClick={() => void convert(record)}>
                转合同
              </Button>
            ) : null}
          </CanRole>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <FilterBar title="筛选">
        <div className="flex items-center gap-2">
          <Label htmlFor="opp-stage-filter">阶段</Label>
          <Select value={stageFilter} onValueChange={setStageFilter}>
            <SelectTrigger id="opp-stage-filter" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {Object.entries(OPP_STAGE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CanRole roles={['admin']}>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            新建商机
          </Button>
        </CanRole>
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
        </Button>
      </FilterBar>
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
        scroll={{ x: 1200, y: 500 }}
        pagination={{
          pageSize: 10,
          showTotal: (t: number) => `共 ${t} 条`,
        }}
        locale={{
          emptyText: (
            <Empty className="py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Target />
                </EmptyMedia>
                <EmptyTitle>暂无商机</EmptyTitle>
                <EmptyDescription>点击右上角「新建商机」创建</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ),
        }}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>新建商机</DialogTitle>
          </DialogHeader>
          <Form {...createForm}>
            <form onSubmit={onCreate} className="space-y-4">
              <FormField
                control={createForm.control}
                name="customerId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      客户 <span aria-hidden="true" className="text-destructive">*</span>
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
                control={createForm.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      商机名称 <span aria-hidden="true" className="text-destructive">*</span>
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
                  control={createForm.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>预计金额（元）</FormLabel>
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
                  control={createForm.control}
                  name="winRate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>赢单率（%）</FormLabel>
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
                  control={createForm.control}
                  name="owner"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>负责人</FormLabel>
                      <FormControl>
                        <Input placeholder="请输入负责人" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="expectedDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>预计成交日期</FormLabel>
                      <DateField value={field.value} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <AttachmentHint text="保存后将自动打开详情，可在其中上传方案文档、报价单等附件" />
              <DialogFooter>
                <Button type="submit">保存</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={detailTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDetailTarget(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>商机详情 - {detailTarget?.code}</DialogTitle>
          </DialogHeader>
          {detailTarget ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div>
                  <span className="text-muted-foreground">客户：</span>
                  {detailTarget.customerName}
                </div>
                <div>
                  <span className="text-muted-foreground">商机名称：</span>
                  {detailTarget.title}
                </div>
                <div>
                  <span className="text-muted-foreground">阶段：</span>
                  <StatusBadge status={detailTarget.stage} labels={OPP_STAGE_LABELS} />
                </div>
                <div>
                  <span className="text-muted-foreground">预计金额：</span>
                  {formatMoney(detailTarget.amount)}
                </div>
                <div>
                  <span className="text-muted-foreground">赢单率：</span>
                  {formatPercent(detailTarget.winRate)}
                </div>
                <div>
                  <span className="text-muted-foreground">负责人：</span>
                  {detailTarget.owner ?? '-'}
                </div>
                <div className="col-span-2">
                  <span className="text-muted-foreground">预计成交：</span>
                  {detailTarget.expectedDate ?? '-'}
                </div>
              </div>
              <div className="border-t pt-4">
                <AttachmentField
                  resourceType="crm_opportunity"
                  resourceId={detailTarget.id}
                  usageHint="方案文档、报价单等"
                />
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={advanceTarget !== null}
        onOpenChange={(open) => {
          if (!open) setAdvanceTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>商机推进 - {advanceTarget?.code}</DialogTitle>
          </DialogHeader>
          <Form {...advanceForm}>
            <form onSubmit={onAdvance} className="space-y-4">
              <FormField
                control={advanceForm.control}
                name="stage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>阶段</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {STAGE_ORDER.map((stage) => (
                          <SelectItem key={stage} value={stage}>
                            {OPP_STAGE_LABELS[stage]}
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
                  control={advanceForm.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>预计金额（元）</FormLabel>
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
                  control={advanceForm.control}
                  name="winRate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>赢单率（%）</FormLabel>
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
              <DialogFooter>
                <Button type="submit">保存</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <QuotationFormDialog
        open={quoteOpen}
        onOpenChange={setQuoteOpen}
        preset={quotePreset}
        onSaved={() => setQuoteOpen(false)}
      />
    </div>
  );
};

export default OpportunitiesTab;
