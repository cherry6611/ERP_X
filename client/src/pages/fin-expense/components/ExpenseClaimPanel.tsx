import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
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
import { finExpenseApi, hrApi, projectsApi } from '@client/src/api';
import { sendApprovalNotification } from '@client/src/api/notifications';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import FinStatusBadge, { CLAIM_STATUS_LABELS } from './FinStatusBadge';
import type {
  CreateExpenseClaimDto,
  Department,
  ExpenseApplyItem,
  ExpenseClaimAction,
  ExpenseClaimItem,
  PagedResult,
  Project,
} from '@shared/api.interface';

const NONE = 'none';

const claimSchema = z.object({
  applyId: z.string(),
  departmentId: z.string(),
  projectId: z.string(),
  expenseCategory: z.string().min(1, '请填写费用科目'),
  amount: z.coerce.number().min(0, '报销金额不能为负'),
  expenseDate: z.string().optional(),
  remark: z.string(),
});

type ClaimFormData = z.infer<typeof claimSchema>;

const EMPTY_FORM: ClaimFormData = {
  applyId: NONE,
  departmentId: NONE,
  projectId: NONE,
  expenseCategory: '',
  amount: 0,
  expenseDate: undefined,
  remark: '',
};

const PAGE_SIZE = 20;

const CLAIM_STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '待审批' },
  { value: 'escalated', label: '超预算升级审批' },
  { value: 'approved', label: '已批准' },
  { value: 'rejected', label: '已驳回' },
];

const ExpenseClaimPanel: React.FC = () => {
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<ExpenseClaimItem | null>(null);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData<
    PagedResult<ExpenseClaimItem>
  >(() =>
    finExpenseApi.listClaims({
      page,
      pageSize: PAGE_SIZE,
      status: statusFilter !== 'all' ? statusFilter : undefined,
      projectId: projectFilter !== 'all' ? projectFilter : undefined,
    }),
  [page, statusFilter, projectFilter]);
  const { data: departments } = useAsyncData<Department[]>(
    () => hrApi.listDepartments(),
    [],
  );
  const { data: projects } = useAsyncData<Project[]>(
    () => projectsApi.listProjects(),
    [],
  );
  const { data: applies } = useAsyncData<PagedResult<ExpenseApplyItem>>(
    () => finExpenseApi.listApplies({ page: 1, pageSize: 100, status: 'approved' }),
    [],
  );

  const approvedApplies = applies?.items ?? [];

  const form = useForm<z.input<typeof claimSchema>, unknown, ClaimFormData>({
    resolver: zodResolver(claimSchema),
    defaultValues: EMPTY_FORM,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateExpenseClaimDto = {
      applyId: values.applyId !== NONE ? values.applyId : undefined,
      departmentId:
        values.departmentId !== NONE ? values.departmentId : undefined,
      projectId: values.projectId !== NONE ? values.projectId : undefined,
      expenseCategory: values.expenseCategory,
      amount: values.amount,
      expenseDate: values.expenseDate || undefined,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      const item = await finExpenseApi.createClaim(dto);
      void sendApprovalNotification({
        bizType: 'expense',
        bizCode: item.code,
        title: '报销审批待办',
        content: `报销单 ${item.code} 已提交审批，金额 ${formatMoney(item.amount)}`,
      });
      toast.success(
        item.status === 'escalated'
          ? '报销单已提交（超预算，进入升级审批）'
          : '报销单已提交',
      );
      setCreateOpen(false);
      form.reset(EMPTY_FORM);
      await reload();
      setDetailTarget(item);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '提交失败');
    } finally {
      setOperating(false);
    }
  });

  const doAction = async (item: ExpenseClaimItem, action: ExpenseClaimAction) => {
    try {
      await finExpenseApi.claimAction(item.id, action);
      toast.success('操作成功');
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const items = data?.items ?? [];

  const columns: TableColumnsType<ExpenseClaimItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 150 },
    {
      title: '关联申请',
      dataIndex: 'applyCode',
      width: 150,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '部门',
      dataIndex: 'departmentName',
      width: 120,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '项目',
      dataIndex: 'projectName',
      width: 160,
      render: (v: string | null) => v ?? '-',
    },
    { title: '费用科目', dataIndex: 'expenseCategory', width: 110 },
    {
      title: '报销金额',
      dataIndex: 'amount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '费用日期',
      dataIndex: 'expenseDate',
      width: 110,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '报销人',
      dataIndex: 'applicant',
      width: 110,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (v: string) => (
        <FinStatusBadge status={v} labels={CLAIM_STATUS_LABELS} />
      ),
    },
    {
      title: '备注',
      dataIndex: 'remark',
      width: 150,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 200,
      render: (_v: unknown, record) => (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDetailTarget(record)}
            aria-label={`查看报销单详情 ${record.code}`}
          >
            详情
          </Button>
          {record.status === 'pending' || record.status === 'escalated' ? (
            <CanRole roles={['admin']}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void doAction(record, 'approve')}
                aria-label={`批准报销单 ${record.code}`}
              >
                批准
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => void doAction(record, 'reject')}
                aria-label={`驳回报销单 ${record.code}`}
              >
                驳回
              </Button>
            </CanRole>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="claim-status-filter">状态</Label>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setPage(1);
              setStatusFilter(v);
            }}
          >
            <SelectTrigger id="claim-status-filter" className="w-40">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              {CLAIM_STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="claim-project-filter">项目</Label>
          <Select
            value={projectFilter}
            onValueChange={(v) => {
              setPage(1);
              setProjectFilter(v);
            }}
          >
            <SelectTrigger id="claim-project-filter" className="w-48">
              <SelectValue placeholder="全部项目" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部项目</SelectItem>
              {(projects ?? []).map((proj: Project) => (
                <SelectItem key={proj.id} value={proj.id}>
                  {proj.code} - {proj.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setCreateOpen(true)} data-ai-section-type="button">
          <Plus className="mr-1 h-4 w-4" />
          新增报销单
        </Button>
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
        dataSource={items}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1500, y: 500 }}
        locale={{ emptyText: '暂无报销单，请先新增报销单' }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          onChange: (next: number) => setPage(next),
        }}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>新增报销单</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            报销金额超预算时单据将进入升级审批；关联申请时金额不得超过申请额。
          </p>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="flex flex-wrap gap-4">
                <FormField
                  control={form.control}
                  name="applyId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>关联费用申请</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="不关联申请" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={NONE}>不关联申请</SelectItem>
                          {approvedApplies.map((apply: ExpenseApplyItem) => (
                            <SelectItem key={apply.id} value={apply.id}>
                              {apply.code}（{apply.expenseCategory} /{' '}
                              {formatMoney(apply.amount)}）
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
                  name="expenseDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>费用日期</FormLabel>
                      <DateField value={field.value} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex flex-wrap gap-4">
                <FormField
                  control={form.control}
                  name="departmentId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>部门</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="不限部门" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={NONE}>不限部门</SelectItem>
                          {(departments ?? []).map((dept: Department) => (
                            <SelectItem key={dept.id} value={dept.id}>
                              {dept.name}
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
                      <FormLabel>项目</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="不限项目" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={NONE}>不限项目</SelectItem>
                          {(projects ?? []).map((proj: Project) => (
                            <SelectItem key={proj.id} value={proj.id}>
                              {proj.code} - {proj.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex flex-wrap gap-4">
                <FormField
                  control={form.control}
                  name="expenseCategory"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        费用科目{' '}
                        <span aria-hidden="true" className="text-destructive">
                          *
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="如：差旅费" {...field} />
                      </FormControl>
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
                        报销金额（元）{' '}
                        <span aria-hidden="true" className="text-destructive">
                          *
                        </span>
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
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Input placeholder="选填" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <AttachmentHint text="保存后将自动打开详情，可在其中上传发票、行程单、票据等附件" />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCreateOpen(false)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={operating}>
                  {operating ? '提交中...' : '提交报销单'}
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
            <DialogTitle>报销单详情 {detailTarget?.code ?? ''}</DialogTitle>
          </DialogHeader>
          {detailTarget ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <p>
                  <span className="text-muted-foreground">关联申请：</span>
                  {detailTarget.applyCode ?? '-'}
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
                  <span className="text-muted-foreground">费用科目：</span>
                  {detailTarget.expenseCategory}
                </p>
                <p>
                  <span className="text-muted-foreground">报销金额：</span>
                  {formatMoney(detailTarget.amount)}
                </p>
                <p>
                  <span className="text-muted-foreground">费用日期：</span>
                  {detailTarget.expenseDate ?? '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">报销人：</span>
                  {detailTarget.applicant ?? '-'}
                </p>
                <p className="flex items-center gap-2">
                  <span className="text-muted-foreground">状态：</span>
                  <FinStatusBadge
                    status={detailTarget.status}
                    labels={CLAIM_STATUS_LABELS}
                  />
                </p>
              </div>
              <p className="text-sm">
                <span className="text-muted-foreground">备注：</span>
                {detailTarget.remark ?? '-'}
              </p>
              <div className="mt-2 border-t pt-4">
                <AttachmentField
                  resourceType="fin_expense_claim"
                  resourceId={detailTarget.id}
                  usageHint="发票、行程单、票据等"
                />
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ExpenseClaimPanel;
