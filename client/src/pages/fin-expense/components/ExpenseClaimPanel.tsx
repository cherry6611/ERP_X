/**
 * 报销单台账（§5.9 / F8）。
 *
 * 主文件只做**布局编排 + 筛选区 + 列定义 + 行内动作**；「新增报销单」弹窗
 * （表单 schema / 默认值 / `useForm` / 提交处理 / 全部表单 JSX）已抽到
 * `./dialogs/CreateExpenseClaimDialog.tsx`，抽出后本文件在 500 非空行以内。
 *
 * ## 抽出时保持不动的三件事
 *
 * ① **重置时机**：原实现的表单重置在**创建成功之后**（`toast.success(…)` →
 *    `setCreateOpen(false)` → `form.reset(EMPTY_FORM)` → `await reload()` →
 *    `navigate(…)`），**没有** reset-on-open —— 抽出后仍没有，触发点与顺序
 *    逐字不变；「取消」按钮与 ESC / 点遮罩关闭同样不重置。
 * ② **弹窗挂载方式**：`<CreateExpenseClaimDialog/>` **无条件**渲染（与原
 *    `<Dialog>` 一致），不写成 `{createOpen && …}`；条件挂载会丢掉子组件里
 *    常驻的 `operating` / `form`，并改变 `Dialog` 的挂载时机。
 * ③ **`createOpen` 留在本文件**：它的两个触发点分居两侧
 *    （工具栏按钮 `setCreateOpen(true)`、子组件成功后 `setCreateOpen(false)`），
 *    故按**同名 props** 透传，而不是把 state 搬进子组件再回调用 `useEffect` 同步。
 *
 * 数据查询（`claims` / `departments` / `projects` / `applies`）仍全部留在本文件
 * —— `projects` 被筛选下拉与弹窗共用，`departments` / `approvedApplies` 供弹窗使用。
 *
 * ## 列定义**有意**未抽走
 *
 * `columns` 依赖本文件的 `navigate` / `doAction`（行内动作），抽走必须把这两个
 * 回调一并作为 props 传下去，而收益只是行数；§5.9 的拆分判据是"零耦合的纯函数
 * 先搬"，本文件的列定义并非零耦合，故保留在此。
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
import FinStatusBadge, { CLAIM_STATUS_LABELS } from './FinStatusBadge';
import CreateExpenseClaimDialog from './dialogs/CreateExpenseClaimDialog';
import type {
  Department,
  ExpenseApplyItem,
  ExpenseClaimAction,
  ExpenseClaimItem,
  PagedResult,
  Project,
} from '@shared/api.interface';

const PAGE_SIZE = 20;

const CLAIM_STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '待审批' },
  { value: 'escalated', label: '超预算升级审批' },
  { value: 'approved', label: '已批准' },
  { value: 'rejected', label: '已驳回' },
];

const ExpenseClaimPanel: React.FC = () => {
  const navigate = useNavigate();
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);

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

  const doAction = async (item: ExpenseClaimItem, action: ExpenseClaimAction) => {
    if (action === 'reject') {
      const ok = await confirmDanger(
        `确认驳回报销单 ${item.code}？`,
        { title: '确认驳回', confirmLabel: '确认驳回' },
      );
      if (!ok) return;
    }
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
            onClick={() =>
              navigate(`/fin-expense/claims/${record.id}`, {
                state: { item: record },
              })
            }
            aria-label={`查看报销单详情 ${record.code}`}
          >
            详情
          </Button>
          {record.status === 'pending' || record.status === 'escalated' ? (
            <CanCapabilityWrite capability="finance_write">
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
            </CanCapabilityWrite>
          ) : null}
          {/*
            B12（§7.2）：`approved` 原先在界面上**没有任何后续动作** ——
            "这笔报销付了没有"无处标记、误批准也无从撤销。
            现在补齐两个出口，与后端状态机一致：
              · 标记支付：仅当对应应付单已支付时后端才放行（避免账上先标已付、钱还没出）
              · 作废：仅未支付时可作废，且会**同事务作废对应应付单**
          */}
          {record.status === 'approved' ? (
            <CanCapabilityWrite capability="finance_write">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void doAction(record, 'pay')}
                aria-label={`标记报销单已支付 ${record.code}`}
              >
                标记支付
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => void doAction(record, 'void')}
                aria-label={`作废报销单 ${record.code}`}
              >
                作废
              </Button>
            </CanCapabilityWrite>
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

      <CreateExpenseClaimDialog
        createOpen={createOpen}
        setCreateOpen={setCreateOpen}
        departments={departments}
        projects={projects}
        approvedApplies={approvedApplies}
        reload={reload}
        navigate={navigate}
      />

    </div>
  );
};

export default ExpenseClaimPanel;
