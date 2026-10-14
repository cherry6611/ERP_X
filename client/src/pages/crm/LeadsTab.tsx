import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Download, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CanRole } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import FilterBar from '@client/src/components/erp/FilterBar';
import StatusBadge from '@client/src/components/erp/StatusBadge';
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
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { Textarea } from '@client/src/components/ui/textarea';
import { crmApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { LEAD_STATUS_LABELS } from '@client/src/utils/biz-labels';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type { Lead, LeadStatus, UpdateLeadDto } from '@shared/api.interface';

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

const followSchema = z.object({
  status: z.string().min(1, '请选择状态'),
  followNote: z.string(),
  nextDate: z.string().optional(),
  remark: z.string(),
});

type FollowFormData = z.infer<typeof followSchema>;

const LeadsTab: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const statusFilter = params.get('status') ?? 'all';
  const setStatusFilter = (v: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === 'all') next.delete('status');
        else next.set('status', v);
        return next;
      },
      { replace: true },
    );
  };
  const navigate = useNavigate();
  const [followTarget, setFollowTarget] = useState<Lead | null>(null);

  const { data, loading, error, reload } = useAsyncData<Lead[]>(
    () => crmApi.listLeads(statusFilter !== 'all' ? statusFilter : undefined),
    [statusFilter],
  );

  const followForm = useForm<FollowFormData>({
    resolver: zodResolver(followSchema),
    defaultValues: { status: 'following', followNote: '', remark: '' },
  });

  const openFollow = (lead: Lead) => {
    followForm.reset({
      status: lead.status,
      followNote: lead.followNote ?? '',
      nextDate: lead.nextDate ?? undefined,
      remark: lead.remark ?? '',
    });
    setFollowTarget(lead);
  };

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
      toast.error(getApiErrorMessage(err, '更新失败'));
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
      width: 200,
      render: (_, record) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/crm/leads/${record.id}`)}
          >
            详情
          </Button>
          <CanRole roles={['admin']}>
            <Button variant="ghost" size="sm" onClick={() => openFollow(record)}>
              跟进
            </Button>
            {record.status !== 'converted' && record.status !== 'lost' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const ok = await confirmDanger(
                      `确认将线索 ${record.code} 转为商机？`,
                      { title: '确认转商机', confirmLabel: '确认转换' },
                    );
                    if (!ok) return;
                    try {
                      await crmApi.convertLead(record.id);
                      toast.success('已转为商机');
                      await reload();
                    } catch (err: unknown) {
                      toast.error(getApiErrorMessage(err, '转商机失败'));
                    }
                  })();
                }}
              >
                转商机
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
        <Button onClick={() => navigate('/crm/leads/new')}>
          <Plus className="h-4 w-4" />
          新建线索
        </Button>
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
        </Button>
      </FilterBar>
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !error && (data?.length ?? 0) === 0}
        emptyTitle="暂无线索"
        emptyText="点击上方「新建线索」按钮创建"
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          columns={columns}
          dataSource={data ?? []}
          rowKey="id"
          scroll={{ x: 1200, y: 500 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: ' ' }}
        />
      </DataState>

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
