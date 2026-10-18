import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Download, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
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
import { crmApi, masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { LEAD_STATUS_LABELS } from '@client/src/utils/biz-labels';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type { Customer, Lead, LeadStatus, UpdateLeadDto } from '@shared/api.interface';

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
  /**
   * 关联客户（可空）。
   *
   * ⚠️ 这个字段是**「线索 → 商机」唯一可用的关联入口**（浏览器走查实测）：
   * `POST /api/crm/leads` 不采集 `customerId`，而 `convertLead` 的第一道校验就是
   * `if (!lead.customerId) 线索未关联客户，不能转换` —— 于是界面上「转商机」按钮
   * 对任何**在界面上建出来的**线索都必然失败，线索转商机这条链路整条不可达。
   * 补在这里而不是新建表单里：线索登记时通常还没有客户档案，
   * 而在跟进阶段确认"这就是某客户的项目"才是自然的时机。
   */
  customerId: z.string(),
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
    defaultValues: { status: 'following', followNote: '', remark: '', customerId: '' },
  });

  /*
   * 客户下拉（「关联客户」用）。**必须在这里加载**：转商机要求线索已关联客户，
   * 而 `LeadCreatePage` 不采集该字段 —— 没有这个下拉，界面上建出来的线索
   * 永远转不成商机（详见 `followSchema.customerId` 的说明）。
   */
  const { data: customers } = useAsyncData<Customer[]>(
    () => masterDataApi.listCustomers(),
    [],
  );

  const openFollow = (lead: Lead) => {
    followForm.reset({
      status: lead.status,
      followNote: lead.followNote ?? '',
      nextDate: lead.nextDate ?? undefined,
      remark: lead.remark ?? '',
      customerId: lead.customerId ?? '',
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
      // '' 在契约里是"解除关联"（服务端 `@ValidateIf(v => v !== null)` 收 null）
      customerId: values.customerId === '' ? null : values.customerId,
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
          <CanCapabilityWrite capability="crm_write">
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
          </CanCapabilityWrite>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/*
        * 工具行（右对齐）与筛选卡片**分离**：「新建线索」是**写操作**，
        * 按 `AGENTS.md` 对 `FilterBar` 的定位（筛选 + 只读工具如刷新/导出）
        * 不应混进筛选卡片；这也是多数后台系统的标准布局（工具行在上、筛选卡片在下）。
        */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
        </Button>
        <Button onClick={() => navigate('/crm/leads/new')}>
          <Plus className="h-4 w-4" />
          新建线索
        </Button>
      </div>
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
      </FilterBar>
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !error && (data?.length ?? 0) === 0}
        emptyTitle="暂无线索"
        emptyText="还没有线索，先录入第一条客户线索"
        emptyAction={
          <Button onClick={() => navigate('/crm/leads/new')}>
            <Plus className="h-4 w-4" />
            新建线索
          </Button>
        }
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
                name="customerId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>关联客户</FormLabel>
                    <Select
                      value={field.value || '__none__'}
                      onValueChange={(value) =>
                        field.onChange(value === '__none__' ? '' : value)
                      }
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="未关联" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">未关联</SelectItem>
                        {(customers ?? []).map((c: Customer) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      未关联客户的线索不能转商机（转商机后合同要挂到客户名下）
                    </p>
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

