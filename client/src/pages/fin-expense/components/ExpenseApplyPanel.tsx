/**
 * 费用申请台账（§5.9 / F8）。
 *
 * 主文件只做**布局编排 + 筛选区 + 列定义 + 行内动作**；「新增申请」弹窗
 * （表单 schema / 默认值 / `useForm` / 提交处理 / 全部表单 JSX）已抽到
 * `./dialogs/CreateExpenseApplyDialog.tsx`。
 *
 * ## 抽出时保持不动的三件事
 *
 * ① **重置时机**：原实现的表单重置在**创建成功之后**（弹窗内
 *    `toast.success` → `setCreateOpen(false)` → `form.reset(EMPTY_FORM)`），
 *    **没有** reset-on-open —— 抽出后仍没有，触发点与顺序逐字不变。
 * ② **弹窗挂载方式**：`<CreateExpenseApplyDialog/>` **无条件**渲染（与原
 *    `<Dialog>` 一致），不写成 `{createOpen && …}`；条件挂载会丢掉子组件里
 *    常驻的 `operating` / `form`。
 * ③ **`createOpen` 留在本文件**：它的两个触发点分居两侧
 *    （工具栏按钮 `setCreateOpen(true)`、子组件成功后 `setCreateOpen(false)`），
 *    故按**同名 props** 透传，而不是把 state 搬进子组件再回调用 `useEffect` 同步。
 *
 * 数据查询（`applies` / `departments` / `projects`）仍全部留在本文件 ——
 * `projects` 被筛选下拉与弹窗共用，`departments` 供弹窗使用，均为同名 props 下传。
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { Button } from '@client/src/components/ui/button';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { finExpenseApi, hrApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { formatMoney } from '@client/src/utils/format';
import FinStatusBadge, { APPLY_STATUS_LABELS } from './FinStatusBadge';
import CreateExpenseApplyDialog from './dialogs/CreateExpenseApplyDialog';
import type {
  Department,
  ExpenseApplyAction,
  ExpenseApplyItem,
  PagedResult,
  Project,
} from '@shared/api.interface';

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
          <CanCapabilityWrite capability="finance_write">
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
          </CanCapabilityWrite>
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

      <CreateExpenseApplyDialog
        createOpen={createOpen}
        setCreateOpen={setCreateOpen}
        departments={departments}
        projects={projects}
        reload={reload}
        navigate={navigate}
      />
    </div>
  );
};

export default ExpenseApplyPanel;
