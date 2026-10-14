import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { Textarea } from '@client/src/components/ui/textarea';
import { finExpenseApi, hrApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { formatMoney } from '@client/src/utils/format';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import FinStatusBadge, { APPLY_STATUS_LABELS } from './FinStatusBadge';
import type {
  CreateExpenseApplyDto,
  Department,
  ExpenseApplyAction,
  ExpenseApplyItem,
  PagedResult,
  Project,
} from '@shared/api.interface';

const NONE = 'none';

const applySchema = z.object({
  applyType: z.string().min(1, '请选择申请类型'),
  title: z.string().min(1, '请填写申请标题'),
  departmentId: z.string(),
  projectId: z.string(),
  expenseCategory: z.string().min(1, '请填写费用科目'),
  amount: z.coerce.number().min(0, '申请金额不能为负'),
  expectDate: z.string().optional(),
  reason: z.string(),
  remark: z.string(),
});

type ApplyFormData = z.infer<typeof applySchema>;

const EMPTY_FORM: ApplyFormData = {
  applyType: 'travel',
  title: '',
  departmentId: NONE,
  projectId: NONE,
  expenseCategory: '',
  amount: 0,
  expectDate: undefined,
  reason: '',
  remark: '',
};

const PAGE_SIZE = 20;

const APPLY_STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '待审批' },
  { value: 'approved', label: '已批准' },
  { value: 'rejected', label: '已驳回' },
  { value: 'closed', label: '已关闭' },
];

const ExpenseApplyPanel: React.FC = () => {
  const navigate = useNavigate();
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
    const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData<
    PagedResult<ExpenseApplyItem>
  >(() =>
    finExpenseApi.listApplies({
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

  const form = useForm<z.input<typeof applySchema>, unknown, ApplyFormData>({
    resolver: zodResolver(applySchema),
    defaultValues: EMPTY_FORM,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateExpenseApplyDto = {
      applyType: values.applyType as 'travel' | 'purchase',
      title: values.title,
      departmentId:
        values.departmentId !== NONE ? values.departmentId : undefined,
      projectId: values.projectId !== NONE ? values.projectId : undefined,
      expenseCategory: values.expenseCategory,
      amount: values.amount,
      expectDate: values.expectDate || undefined,
      reason: values.reason || undefined,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      const created = await finExpenseApi.createApply(dto);
      toast.success('费用申请已提交');
      setCreateOpen(false);
      form.reset(EMPTY_FORM);
      await reload();
      navigate(`/fin-expense/applies/${created.id}`, { state: { item: created } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '提交失败');
    } finally {
      setOperating(false);
    }
  });

  const doAction = async (item: ExpenseApplyItem, action: ExpenseApplyAction) => {
    if (action === 'reject') {
      const ok = await confirmDanger(
        `确认驳回费用申请 ${item.code}？`,
        { title: '确认驳回', confirmLabel: '确认驳回' },
      );
      if (!ok) return;
    }
    if (action === 'close') {
      const ok = await confirmDanger(
        `确认关闭费用申请 ${item.code}？关闭后不可继续报销。`,
        { title: '确认关闭', confirmLabel: '确认关闭' },
      );
      if (!ok) return;
    }
    try {
      await finExpenseApi.applyAction(item.id, action);
      toast.success('操作成功');
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const items = data?.items ?? [];

  const columns: TableColumnsType<ExpenseApplyItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 150 },
    {
      title: '类型',
      dataIndex: 'applyType',
      width: 80,
      render: (v: string) =>
        v === 'purchase' ? '采购' : '差旅',
    },
    { title: '标题', dataIndex: 'title', width: 200 },
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
      title: '申请金额',
      dataIndex: 'amount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '期望日期',
      dataIndex: 'expectDate',
      width: 110,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => (
        <FinStatusBadge status={v} labels={APPLY_STATUS_LABELS} />
      ),
    },
    {
      title: '申请事由',
      dataIndex: 'reason',
      width: 160,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 220,
      render: (_v: unknown, record) => (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/fin-expense/applies/${record.id}`, { state: { item: record } })}
            aria-label={`查看申请详情 ${record.code}`}
          >
            详情
          </Button>
          <CanCapability capability="finance_write">
            <div className="flex gap-1">
              {record.status === 'pending' ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void doAction(record, 'approve')}
                    aria-label={`批准申请 ${record.code}`}
                  >
                    批准
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => void doAction(record, 'reject')}
                    aria-label={`驳回申请 ${record.code}`}
                  >
                    驳回
                  </Button>
                </>
              ) : null}
              {record.status === 'approved' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void doAction(record, 'close')}
                  aria-label={`关闭申请 ${record.code}`}
                >
                  关闭
                </Button>
              ) : null}
            </div>
          </CanCapability>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="apply-status-filter">状态</Label>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setPage(1);
              setStatusFilter(v);
            }}
          >
            <SelectTrigger id="apply-status-filter" className="w-36">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              {APPLY_STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="apply-project-filter">项目</Label>
          <Select
            value={projectFilter}
            onValueChange={(v) => {
              setPage(1);
              setProjectFilter(v);
            }}
          >
            <SelectTrigger id="apply-project-filter" className="w-48">
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
          新增申请
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
        scroll={{ x: 1400, y: 500 }}
        locale={{ emptyText: '暂无费用申请，请先新增申请' }}
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
            <DialogTitle>新增费用申请</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="flex flex-wrap gap-4">
                <FormField
                  control={form.control}
                  name="applyType"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        申请类型{' '}
                        <span aria-hidden="true" className="text-destructive">
                          *
                        </span>
                      </FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="travel">差旅</SelectItem>
                          <SelectItem value="purchase">采购</SelectItem>
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
                    <FormItem className="flex-1">
                      <FormLabel>
                        标题{' '}
                        <span aria-hidden="true" className="text-destructive">
                          *
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="如：北京客户现场交付差旅" {...field} />
                      </FormControl>
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
                        申请金额（元）{' '}
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
                <FormField
                  control={form.control}
                  name="expectDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>期望日期</FormLabel>
                      <DateField value={field.value} onChange={field.onChange} />
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
                      <Textarea rows={2} placeholder="选填" {...field} />
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
                      <Input placeholder="选填" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <AttachmentHint text="保存后将自动打开详情，可在其中上传费用发票、票据凭证等附件" />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCreateOpen(false)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={operating}>
                  {operating ? '提交中...' : '提交申请'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

    </div>
  );
};

export default ExpenseApplyPanel;
