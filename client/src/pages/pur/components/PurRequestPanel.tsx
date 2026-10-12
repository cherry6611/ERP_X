import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import PurStatusBadge, {
  PUR_REQUEST_STATUS_LABELS,
  PUR_REQUEST_TYPE_LABELS,
} from './PurStatusBadge';
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
import DateField from '@client/src/components/erp/DateField';
import { hrApi, masterDataApi, projectsApi, purApi } from '@client/src/api';
import { sendApprovalNotification } from '@client/src/api/notifications';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import type {
  CreatePurRequestDto,
  Department,
  Project,
  PurRequestItem,
  Supplier,
} from '@shared/api.interface';

const requestSchema = z.object({
  title: z.string().min(1, '请填写申请标题'),
  requestType: z.string().min(1, '请选择申请类型'),
  departmentId: z.string(),
  projectId: z.string(),
  supplierId: z.string(),
  amount: z.coerce.number().min(0, '预算金额不能为负'),
  expectDate: z.string(),
  reason: z.string(),
  remark: z.string(),
});

const EMPTY_FORM = {
  title: '',
  requestType: 'service',
  departmentId: '',
  projectId: '',
  supplierId: '',
  amount: 0,
  expectDate: '',
  reason: '',
  remark: '',
};

const PAGE_SIZE = 20;

const PurRequestPanel: React.FC = () => {
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<PurRequestItem | null>(null);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData(
    () =>
      purApi.listRequests({
        page,
        pageSize: PAGE_SIZE,
        status: statusFilter !== 'all' ? statusFilter : undefined,
      }),
    [page, statusFilter],
  );

  const { data: departments } = useAsyncData<Department[]>(
    () => hrApi.listDepartments(),
    [],
  );
  const { data: projects } = useAsyncData<Project[]>(
    () => projectsApi.listProjects(),
    [],
  );
  const { data: suppliers } = useAsyncData<Supplier[]>(
    () => masterDataApi.listSuppliers(),
    [],
  );

  const form = useForm<
    z.input<typeof requestSchema>,
    unknown,
    z.output<typeof requestSchema>
  >({
    resolver: zodResolver(requestSchema),
    defaultValues: EMPTY_FORM,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreatePurRequestDto = {
      title: values.title,
      requestType: values.requestType as CreatePurRequestDto['requestType'],
      departmentId: values.departmentId || undefined,
      projectId: values.projectId || undefined,
      supplierId: values.supplierId || undefined,
      amount: values.amount,
      expectDate: values.expectDate || undefined,
      reason: values.reason || undefined,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      const item = await purApi.createRequest(dto);
      void sendApprovalNotification({
        bizType: 'purchase',
        bizCode: item.code,
        title: '采购审批待办',
        content: `采购申请 ${item.code}（${item.title}）已提交，预算金额 ${formatMoney(item.amount)}`,
      });
      toast.success('采购申请已创建');
      setCreateOpen(false);
      form.reset(EMPTY_FORM);
      setPage(1);
      await reload();
      setDetailTarget(item);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建采购申请失败');
    } finally {
      setOperating(false);
    }
  });

  const doAction = async (item: PurRequestItem, action: 'approve' | 'reject') => {
    try {
      await purApi.requestAction(item.id, action);
      toast.success(action === 'approve' ? '采购申请已批准' : '采购申请已驳回');
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const columns: TableColumnsType<PurRequestItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '标题', dataIndex: 'title', width: 180 },
    {
      title: '类型',
      dataIndex: 'requestType',
      width: 100,
      render: (v: string) => PUR_REQUEST_TYPE_LABELS[v] ?? v,
    },
    { title: '部门', dataIndex: 'departmentName', width: 110, render: (v: string | null) => v ?? '-' },
    { title: '项目', dataIndex: 'projectName', width: 130, render: (v: string | null) => v ?? '-' },
    { title: '供应商', dataIndex: 'supplierName', width: 130, render: (v: string | null) => v ?? '-' },
    {
      title: '预算金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '期望日期', dataIndex: 'expectDate', width: 110, render: (v: string | null) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => (
        <PurStatusBadge status={s} labels={PUR_REQUEST_STATUS_LABELS} />
      ),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 200,
      render: (_: unknown, record: PurRequestItem) => (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDetailTarget(record)}
            aria-label={`查看采购申请详情 ${record.code}`}
          >
            详情
          </Button>
          <CanRole roles={['admin']}>
            <div className="flex gap-1">
              {record.status === 'pending' ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => void doAction(record, 'approve')}>
                    批准
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => void doAction(record, 'reject')}
                  >
                    驳回
                  </Button>
                </>
              ) : null}
            </div>
          </CanRole>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="pur-request-status">状态</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger id="pur-request-status" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {Object.entries(PUR_REQUEST_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          新建采购申请
        </Button>
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
        dataSource={data?.items ?? []}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1300, y: 480 }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          showTotal: (t: number) => `共 ${t} 条`,
          onChange: (p: number) => setPage(p),
        }}
        locale={{ emptyText: '暂无采购申请记录，点击右上角新建采购申请' }}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>新建采购申请</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      申请标题 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="请输入申请标题" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="requestType"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        申请类型 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择类型" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="service">服务采购</SelectItem>
                          <SelectItem value="equipment">设备采购</SelectItem>
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
                        预算金额 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          placeholder="请输入预算金额"
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
                  control={form.control}
                  name="departmentId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>申请部门</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择部门（可选）" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(departments ?? []).map((d: Department) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.name}
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
                  name="projectId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>关联项目</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择项目（可选）" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(projects ?? []).map((p: Project) => (
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
              </div>
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="supplierId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>意向供应商</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择供应商（可选）" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(suppliers ?? []).map((s: Supplier) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}
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
                  name="expectDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>期望到货日期</FormLabel>
                      <DateField value={field.value || undefined} onChange={field.onChange} />
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
                    <FormLabel>申请事由</FormLabel>
                    <FormControl>
                      <Input placeholder="请输入申请事由" {...field} />
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
                      <Input placeholder="请输入备注" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <AttachmentHint text="保存后可在详情中上传采购需求文档、报价单等附件" />
              <DialogFooter>
                <Button type="submit" disabled={operating}>
                  提交申请
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={detailTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setDetailTarget(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>采购申请详情 {detailTarget?.code ?? ''}</DialogTitle>
          </DialogHeader>
          {detailTarget ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm">
                <span className="text-muted-foreground">标题：</span>
                {detailTarget.title}
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <p>
                  <span className="text-muted-foreground">类型：</span>
                  {PUR_REQUEST_TYPE_LABELS[detailTarget.requestType] ??
                    detailTarget.requestType}
                </p>
                <p>
                  <span className="text-muted-foreground">部门：</span>
                  {detailTarget.departmentName ?? '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">项目：</span>
                  {detailTarget.projectName ?? '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">供应商：</span>
                  {detailTarget.supplierName ?? '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">预算金额：</span>
                  {formatMoney(detailTarget.amount)}
                </p>
                <p>
                  <span className="text-muted-foreground">期望日期：</span>
                  {detailTarget.expectDate ?? '-'}
                </p>
                <p className="flex items-center gap-2">
                  <span className="text-muted-foreground">状态：</span>
                  <PurStatusBadge
                    status={detailTarget.status}
                    labels={PUR_REQUEST_STATUS_LABELS}
                  />
                </p>
              </div>
              <p className="text-sm">
                <span className="text-muted-foreground">申请事由：</span>
                {detailTarget.reason ?? '-'}
              </p>
              <p className="text-sm">
                <span className="text-muted-foreground">备注：</span>
                {detailTarget.remark ?? '-'}
              </p>
              <div className="mt-2 border-t pt-4">
                <AttachmentField
                  resourceType="pur_request"
                  resourceId={detailTarget.id}
                  usageHint="采购需求文档、报价单等"
                />
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PurRequestPanel;
