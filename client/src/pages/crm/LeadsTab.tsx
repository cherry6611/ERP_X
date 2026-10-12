import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Download, Inbox, Plus } from 'lucide-react';
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
import { Textarea } from '@client/src/components/ui/textarea';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@client/src/components/ui/empty';
import { crmApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { LEAD_STATUS_LABELS } from '@client/src/utils/biz-labels';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import type {
  CreateLeadDto,
  Lead,
  LeadStatus,
  UpdateLeadDto,
} from '@shared/api.interface';

const LEAD_SOURCES = ['官网咨询', '展会', '转介绍', '主动开发', '其他'];

const LEAD_EXPORT_COLUMNS: ExcelSheetColumn<Lead>[] = [
  { header: '编号', value: (row: Lead) => row.code },
  { header: '客户名称', value: (row: Lead) => row.customerName },
  { header: '来源', value: (row: Lead) => row.source ?? '' },
  { header: '联系人', value: (row: Lead) => row.contactName ?? '' },
  { header: '电话', value: (row: Lead) => row.contactPhone ?? '' },
  {
    header: '状态',
    value: (row: Lead) => LEAD_STATUS_LABELS[row.status] ?? row.status,
  },
  { header: '负责人', value: (row: Lead) => row.owner ?? '' },
  { header: '下次跟进', value: (row: Lead) => row.nextDate ?? '' },
  { header: '跟进记录', value: (row: Lead) => row.followNote ?? '' },
];

const leadSchema = z.object({
  customerName: z.string().min(1, '客户名称不能为空'),
  source: z.string(),
  contactName: z.string(),
  contactPhone: z.string(),
  owner: z.string(),
  nextDate: z.string().optional(),
  remark: z.string(),
});

type LeadFormData = z.infer<typeof leadSchema>;

const followSchema = z.object({
  status: z.string().min(1, '请选择状态'),
  followNote: z.string(),
  nextDate: z.string().optional(),
  remark: z.string(),
});

type FollowFormData = z.infer<typeof followSchema>;

const LeadsTab: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [followTarget, setFollowTarget] = useState<Lead | null>(null);
  const [detailTarget, setDetailTarget] = useState<Lead | null>(null);

  const { data, loading, error, reload } = useAsyncData<Lead[]>(
    () => crmApi.listLeads(statusFilter !== 'all' ? statusFilter : undefined),
    [statusFilter],
  );

  const createForm = useForm<LeadFormData>({
    resolver: zodResolver(leadSchema),
    defaultValues: {
      customerName: '',
      source: '官网咨询',
      contactName: '',
      contactPhone: '',
      owner: '',
      remark: '',
    },
  });

  const followForm = useForm<FollowFormData>({
    resolver: zodResolver(followSchema),
    defaultValues: { status: 'following', followNote: '', remark: '' },
  });

  const openCreate = () => {
    createForm.reset({
      customerName: '',
      source: '官网咨询',
      contactName: '',
      contactPhone: '',
      owner: '',
      remark: '',
    });
    setCreateOpen(true);
  };

  const openFollow = (lead: Lead) => {
    followForm.reset({
      status: lead.status,
      followNote: lead.followNote ?? '',
      nextDate: lead.nextDate ?? undefined,
      remark: lead.remark ?? '',
    });
    setFollowTarget(lead);
  };

  const onCreate = createForm.handleSubmit(async (values) => {
    const dto: CreateLeadDto = { ...values };
    try {
      const created = await crmApi.createLead(dto);
      toast.success('线索已登记');
      setCreateOpen(false);
      await reload();
      setDetailTarget(created);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
    }
  });

  const onFollow = followForm.handleSubmit(async (values) => {
    if (!followTarget) return;
    const dto: UpdateLeadDto = {
      status: values.status as LeadStatus,
      followNote: values.followNote,
      nextDate: values.nextDate,
      remark: values.remark,
    };
    try {
      await crmApi.updateLead(followTarget.id, dto);
      toast.success('线索已更新');
      setFollowTarget(null);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败');
    }
  });

  const handleExport = () => {
    const rows: Lead[] = data ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('线索列表.xlsx', '线索', LEAD_EXPORT_COLUMNS, rows);
  };

  const columns: TableColumnsType<Lead> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '客户名称', dataIndex: 'customerName', width: 180 },
    { title: '来源', dataIndex: 'source', width: 110, render: (v) => v ?? '-' },
    { title: '联系人', dataIndex: 'contactName', width: 110, render: (v) => v ?? '-' },
    { title: '电话', dataIndex: 'contactPhone', width: 130, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={LEAD_STATUS_LABELS} />,
    },
    { title: '负责人', dataIndex: 'owner', width: 100, render: (v) => v ?? '-' },
    { title: '下次跟进', dataIndex: 'nextDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '跟进记录',
      dataIndex: 'followNote',
      width: 180,
      render: (v) => v ?? '-',
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 140,
      render: (_, record) => (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setDetailTarget(record)}>
            详情
          </Button>
          <CanRole roles={['admin']}>
            <Button variant="ghost" size="sm" onClick={() => openFollow(record)}>
              跟进
            </Button>
          </CanRole>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <FilterBar title="筛选">
        <div className="flex items-center gap-2">
          <Label htmlFor="lead-status-filter">状态</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger id="lead-status-filter" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {Object.entries(LEAD_STATUS_LABELS).map(([value, label]) => (
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
            登记线索
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
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle>暂无线索</EmptyTitle>
                <EmptyDescription>点击右上角「登记线索」创建</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ),
        }}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>登记线索</DialogTitle>
          </DialogHeader>
          <Form {...createForm}>
            <form onSubmit={onCreate} className="space-y-4">
              <div className="flex gap-4">
                <FormField
                  control={createForm.control}
                  name="customerName"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        客户名称 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="请输入客户名称" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="source"
                  render={({ field }) => (
                    <FormItem className="w-40">
                      <FormLabel>来源</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {LEAD_SOURCES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex gap-4">
                <FormField
                  control={createForm.control}
                  name="contactName"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>联系人</FormLabel>
                      <FormControl>
                        <Input placeholder="请输入联系人" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="contactPhone"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>联系电话</FormLabel>
                      <FormControl>
                        <Input placeholder="请输入联系电话" {...field} />
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
                  name="nextDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>下次跟进日期</FormLabel>
                      <DateField value={field.value} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={createForm.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Textarea placeholder="备注信息" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <AttachmentHint text="保存后将自动打开详情，可在其中上传客户需求文档、沟通记录等附件" />
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
            <DialogTitle>线索详情 - {detailTarget?.code}</DialogTitle>
          </DialogHeader>
          {detailTarget ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div>
                  <span className="text-muted-foreground">客户名称：</span>
                  {detailTarget.customerName}
                </div>
                <div>
                  <span className="text-muted-foreground">来源：</span>
                  {detailTarget.source ?? '-'}
                </div>
                <div>
                  <span className="text-muted-foreground">联系人：</span>
                  {detailTarget.contactName ?? '-'}
                </div>
                <div>
                  <span className="text-muted-foreground">联系电话：</span>
                  {detailTarget.contactPhone ?? '-'}
                </div>
                <div>
                  <span className="text-muted-foreground">状态：</span>
                  <StatusBadge status={detailTarget.status} labels={LEAD_STATUS_LABELS} />
                </div>
                <div>
                  <span className="text-muted-foreground">负责人：</span>
                  {detailTarget.owner ?? '-'}
                </div>
                <div>
                  <span className="text-muted-foreground">下次跟进：</span>
                  {detailTarget.nextDate ?? '-'}
                </div>
                <div className="col-span-2">
                  <span className="text-muted-foreground">跟进记录：</span>
                  {detailTarget.followNote ?? '-'}
                </div>
                <div className="col-span-2">
                  <span className="text-muted-foreground">备注：</span>
                  {detailTarget.remark || '-'}
                </div>
              </div>
              <div className="border-t pt-4">
                <AttachmentField
                  resourceType="crm_lead"
                  resourceId={detailTarget.id}
                  usageHint="客户需求文档、沟通记录等"
                />
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={followTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFollowTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>线索跟进 - {followTarget?.code}</DialogTitle>
          </DialogHeader>
          <Form {...followForm}>
            <form onSubmit={onFollow} className="space-y-4">
              <FormField
                control={followForm.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>状态</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(LEAD_STATUS_LABELS).map(([value, label]) => (
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
                control={followForm.control}
                name="followNote"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>跟进记录</FormLabel>
                    <FormControl>
                      <Textarea placeholder="本次跟进情况" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={followForm.control}
                name="nextDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>下次跟进日期</FormLabel>
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

export default LeadsTab;
