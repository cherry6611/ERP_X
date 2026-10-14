import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Pencil, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
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
import { Progress } from '@client/src/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { finBudgetApi, hrApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { currentPeriod, formatMoney } from '@client/src/utils/format';
import type {
  BudgetItem,
  CreateBudgetDto,
  Department,
  PagedResult,
  Project,
} from '@shared/api.interface';

const NONE = 'none';

const budgetSchema = z.object({
  departmentId: z.string(),
  projectId: z.string(),
  expenseCategory: z.string().min(1, '请填写费用科目'),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '期间格式为 YYYY-MM'),
  budgetAmount: z.coerce.number().min(0, '预算金额不能为负'),
  remark: z.string(),
});

type BudgetFormData = z.infer<typeof budgetSchema>;

const EMPTY_FORM: BudgetFormData = {
  departmentId: NONE,
  projectId: NONE,
  expenseCategory: '',
  period: currentPeriod(),
  budgetAmount: 0,
  remark: '',
};

const PAGE_SIZE = 20;

const BudgetPanel: React.FC = () => {
  const [page, setPage] = useState<number>(1);
  const [periodFilter, setPeriodFilter] = useState<string>('');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [departmentFilter, setDepartmentFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<BudgetItem | null>(null);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData<PagedResult<BudgetItem>>(
    () =>
      finBudgetApi.listBudgets({
        page,
        pageSize: PAGE_SIZE,
        period: periodFilter || undefined,
        projectId: projectFilter !== 'all' ? projectFilter : undefined,
        departmentId:
          departmentFilter !== 'all' ? departmentFilter : undefined,
      }),
    [page, periodFilter, projectFilter, departmentFilter],
  );
  const { data: departments } = useAsyncData<Department[]>(
    () => hrApi.listDepartments(),
    [],
  );
  const { data: projects } = useAsyncData<Project[]>(
    () => projectsApi.listProjects(),
    [],
  );

  const form = useForm<
    z.input<typeof budgetSchema>,
    unknown,
    BudgetFormData
  >({
    resolver: zodResolver(budgetSchema),
    defaultValues: EMPTY_FORM,
  });

  const openCreate = () => {
    setEditTarget(null);
    form.reset(EMPTY_FORM);
    setCreateOpen(true);
  };

  const openEdit = (item: BudgetItem) => {
    setEditTarget(item);
    form.reset({
      departmentId: item.departmentId ?? NONE,
      projectId: item.projectId ?? NONE,
      expenseCategory: item.expenseCategory,
      period: item.period,
      budgetAmount: item.budgetAmount,
      remark: item.remark ?? '',
    });
    setCreateOpen(true);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setOperating(true);
    try {
      if (editTarget) {
        await finBudgetApi.updateBudget(editTarget.id, {
          budgetAmount: values.budgetAmount,
          remark: values.remark || undefined,
        });
        toast.success('预算已更新');
      } else {
        const dto: CreateBudgetDto = {
          departmentId:
            values.departmentId !== NONE ? values.departmentId : undefined,
          projectId:
            values.projectId !== NONE ? values.projectId : undefined,
          expenseCategory: values.expenseCategory,
          period: values.period,
          budgetAmount: values.budgetAmount,
          remark: values.remark || undefined,
        };
        await finBudgetApi.createBudget(dto);
        toast.success('预算已创建');
      }
      setCreateOpen(false);
      form.reset(EMPTY_FORM);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setOperating(false);
    }
  });

  const items = data?.items ?? [];

  const columns: TableColumnsType<BudgetItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '期间', dataIndex: 'period', width: 90 },
    {
      title: '部门',
      dataIndex: 'departmentName',
      width: 130,
      render: (v: string | null) => v ?? '不限',
    },
    {
      title: '项目',
      dataIndex: 'projectName',
      width: 180,
      render: (v: string | null, record) =>
        v ?? (record.projectId ? '未知项目' : '不限'),
    },
    { title: '费用科目', dataIndex: 'expenseCategory', width: 120 },
    {
      title: '预算金额',
      dataIndex: 'budgetAmount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '已占用',
      dataIndex: 'occupiedAmount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '已执行',
      dataIndex: 'executedAmount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '可用金额',
      dataIndex: 'availableAmount',
      width: 130,
      align: 'right',
      render: (v: number) => (
        <span className={v < 0 ? 'text-destructive font-medium' : ''}>
          {formatMoney(v)}
        </span>
      ),
    },
    {
      title: '执行率',
      key: 'usage',
      width: 150,
      render: (_v: unknown, record) => {
        const used = record.occupiedAmount + record.executedAmount;
        const rate =
          record.budgetAmount > 0
            ? Math.min(100, (used / record.budgetAmount) * 100)
            : 0;
        return (
          <div className="flex items-center gap-2">
            <Progress value={rate} className="w-16" />
            <span className="text-xs text-muted-foreground">
              {rate.toFixed(0)}%
            </span>
          </div>
        );
      },
    },
    {
      title: '备注',
      dataIndex: 'remark',
      width: 140,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 90,
      render: (_v: unknown, record) => (
        <CanCapabilityWrite capability="finance_write">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openEdit(record)}
            aria-label={`编辑预算 ${record.code}`}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" />
            编辑
          </Button>
        </CanCapabilityWrite>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="budget-period-filter">期间（YYYY-MM）</Label>
          <Input
            id="budget-period-filter"
            className="w-36"
            placeholder={currentPeriod()}
            value={periodFilter}
            onChange={(e) => {
              setPage(1);
              setPeriodFilter(e.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="budget-dept-filter">部门</Label>
          <Select
            value={departmentFilter}
            onValueChange={(v) => {
              setPage(1);
              setDepartmentFilter(v);
            }}
          >
            <SelectTrigger id="budget-dept-filter" className="w-40">
              <SelectValue placeholder="全部部门" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部部门</SelectItem>
              {(departments ?? []).map((dept: Department) => (
                <SelectItem key={dept.id} value={dept.id}>
                  {dept.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="budget-project-filter">项目</Label>
          <Select
            value={projectFilter}
            onValueChange={(v) => {
              setPage(1);
              setProjectFilter(v);
            }}
          >
            <SelectTrigger id="budget-project-filter" className="w-48">
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
        <CanCapabilityWrite capability="finance_write">
          <Button onClick={openCreate} data-ai-section-type="button">
            <Plus className="mr-1 h-4 w-4" />
            新增预算
          </Button>
        </CanCapabilityWrite>
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
        scroll={{ x: 1600, y: 500 }}
        locale={{ emptyText: '暂无预算数据，请先新增预算' }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          onChange: (next: number) => setPage(next),
        }}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editTarget ? '编辑预算' : '新增预算'}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              {!editTarget ? (
                <>
                  <div className="flex flex-wrap gap-4">
                    <FormField
                      control={form.control}
                      name="departmentId"
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          <FormLabel>部门</FormLabel>
                          <Select
                            value={field.value}
                            onValueChange={field.onChange}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="不限部门" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value={NONE}>不限部门</SelectItem>
                              {(departments ?? []).map(
                                (dept: Department) => (
                                  <SelectItem key={dept.id} value={dept.id}>
                                    {dept.name}
                                  </SelectItem>
                                ),
                              )}
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
                          <Select
                            value={field.value}
                            onValueChange={field.onChange}
                          >
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
                            <span
                              aria-hidden="true"
                              className="text-destructive"
                            >
                              *
                            </span>
                          </FormLabel>
                          <FormControl>
                            <Input
                              placeholder="如：差旅费"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="period"
                      render={({ field }) => (
                        <FormItem className="w-40">
                          <FormLabel>
                            期间{' '}
                            <span
                              aria-hidden="true"
                              className="text-destructive"
                            >
                              *
                            </span>
                          </FormLabel>
                          <FormControl>
                            <Input placeholder="YYYY-MM" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  预算 {editTarget.code}（{editTarget.period} /{' '}
                  {editTarget.expenseCategory}），仅可调整预算金额与备注。
                </p>
              )}
              <div className="flex flex-wrap gap-4">
                <FormField
                  control={form.control}
                  name="budgetAmount"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        预算金额（元）{' '}
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
                  name="remark"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>备注</FormLabel>
                      <FormControl>
                        <Input placeholder="选填" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCreateOpen(false)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={operating}>
                  {operating ? '保存中...' : '保存'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default BudgetPanel;
