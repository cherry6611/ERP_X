import React, { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Pencil, Users, Wallet } from 'lucide-react';
import { CanRole } from '@client/src/platform/auth';
import PageShell from '@client/src/components/PageShell';
import StatCard from '@client/src/components/erp/StatCard';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@client/src/components/ui/card';
import { biApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import { BILLING_MODEL_LABELS, PROJECT_STATUS_LABELS } from '@client/src/utils/biz-labels';
import ArApSection from '@client/src/pages/projects/components/ArApSection';
import ChangeSection from '@client/src/pages/projects/components/ChangeSection';
import CloseProjectSection from '@client/src/pages/projects/components/CloseProjectSection';
import CostSection from '@client/src/pages/projects/components/CostSection';
import DeliverableSection from '@client/src/pages/projects/components/DeliverableSection';
import InvoiceSection from '@client/src/pages/projects/components/InvoiceSection';
import MilestoneSection from '@client/src/pages/projects/components/MilestoneSection';
import MinutesSection from '@client/src/pages/projects/components/MinutesSection';
import ProjectDocSection from '@client/src/pages/projects/components/ProjectDocSection';
import ProjectEditDialog from '@client/src/pages/projects/components/ProjectEditDialog';
import ProjectOverviewSection from '@client/src/pages/projects/components/ProjectOverviewSection';
import QuotationSection from '@client/src/pages/projects/components/QuotationSection';
import RevenueSection from '@client/src/pages/projects/components/RevenueSection';
import TimesheetSection from '@client/src/pages/projects/components/TimesheetSection';
import type {
  ProjectChainOverview,
  ProjectDetail,
  ProjectFinancialHealthItem,
  ProjectFinancialHealthSummary,
  ProjectStatusAction,
} from '@shared/api.interface';

// close 动作入口由 CloseProjectSection 的结项表单提供，状态按钮只保留其余流转
const STATUS_ACTIONS: Partial<
  Record<string, { action: ProjectStatusAction; label: string }[]>
> = {
  initiating: [{ action: 'approve', label: '批准立项' }],
  executing: [{ action: 'deliver', label: '进入交付' }],
  delivering: [{ action: 'accept', label: '进入验收' }],
};

interface InfoItem {
  label: string;
  value: React.ReactNode;
}

const InfoGrid: React.FC<{ items: InfoItem[] }> = ({ items }) => (
  <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
    {items.map((item) => (
      <div key={item.label} className="flex justify-between gap-2">
        <span className="text-muted-foreground">{item.label}</span>
        <span className="break-words">{item.value}</span>
      </div>
    ))}
  </div>
);

const ProjectDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [acting, setActing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const {
    data: detail,
    loading: detailLoading,
    error: detailError,
    reload: reloadDetail,
  } = useAsyncData<ProjectDetail>(
    () => projectsApi.getProject(id ?? ''),
    [id],
  );

  const {
    data: chain,
    loading: chainLoading,
    error: chainError,
    reload: reloadChain,
  } = useAsyncData<ProjectChainOverview>(
    () => projectsApi.getProjectChain(id ?? ''),
    [id],
  );

  const {
    data: health,
    loading: healthLoading,
    reload: reloadHealth,
  } = useAsyncData<ProjectFinancialHealthSummary>(
    () => biApi.getProjectFinancialHealth(),
    [],
  );

  const reloadAll = useCallback(() => {
    void reloadDetail();
    void reloadChain();
    void reloadHealth();
  }, [reloadDetail, reloadChain, reloadHealth]);

  const doAction = async (action: ProjectStatusAction) => {
    if (!id) return;
    setActing(true);
    try {
      await projectsApi.changeProjectStatus(id, action);
      toast.success('状态已更新');
      await reloadDetail();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setActing(false);
    }
  };

  if (detailError) {
    return (
      <PageShell title="项目详情" description="项目全链路信息">
        <p className="text-sm text-destructive">
          {detailError}
          <Button
            variant="ghost"
            size="sm"
            className="ml-2"
            onClick={() => void reloadDetail()}
          >
            重试
          </Button>
        </p>
      </PageShell>
    );
  }

  if (detailLoading || !detail) {
    return (
      <PageShell title="项目详情" description="项目全链路信息">
        <p className="text-sm text-muted-foreground">加载中...</p>
      </PageShell>
    );
  }

  const accounting = detail.accounting;
  const projectId = detail.id;
  const actions = (STATUS_ACTIONS[detail.status] ?? []).filter(
    (item) => item.action !== 'close',
  );
  const evm =
    health?.items.find(
      (item: ProjectFinancialHealthItem) => item.projectId === detail.id,
    ) ?? null;

  const customerItems: InfoItem[] = chain?.customer
    ? [
        { label: '客户编号', value: chain.customer.code },
        { label: '客户名称', value: chain.customer.name },
        { label: '行业', value: chain.customer.industry ?? '-' },
        { label: '信用等级', value: chain.customer.creditLevel ?? '-' },
        { label: '信用额度', value: formatMoney(chain.customer.creditLimit) },
        { label: '账期（天）', value: String(chain.customer.termsDays) },
      ]
    : [];

  const contractItems: InfoItem[] = chain?.contract
    ? [
        {
          label: '合同编号',
          value: (
            <Link
              to="/contracts"
              className="text-primary underline underline-offset-2"
            >
              {chain.contract.code}
            </Link>
          ),
        },
        { label: '合同名称', value: chain.contract.name },
        {
          label: '计费模式',
          value:
            BILLING_MODEL_LABELS[chain.contract.billingModel ?? ''] ??
            chain.contract.billingModel ??
            '-',
        },
        { label: '合同金额', value: formatMoney(chain.contract.amount) },
        { label: '税率（%）', value: String(chain.contract.taxRate) },
        {
          label: '合同状态',
          value: chain.contract.status ?? '-',
        },
        { label: '签订日期', value: chain.contract.signDate ?? '-' },
        {
          label: '付款条款',
          value: chain.contract.paymentTerms ?? '-',
        },
        { label: '负责人', value: chain.contract.owner ?? '-' },
      ]
    : [];

  return (
    <PageShell
      title={`${detail.code} ${detail.name}`}
      description="项目全链路信息：客户、合同、收入成本、发票、结算与工时"
      actions={
        <>
          <Button variant="outline" onClick={() => navigate('/projects')}>
            <ArrowLeft className="h-4 w-4" />
            返回列表
          </Button>
          <CanRole roles={['admin']}>
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="h-4 w-4" />
              编辑项目
            </Button>
            {actions.map((item) => (
              <Button
                key={item.action}
                disabled={acting}
                onClick={() => void doAction(item.action)}
              >
                {item.label}
              </Button>
            ))}
          </CanRole>
        </>
      }
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <StatusBadge status={detail.status} labels={PROJECT_STATUS_LABELS} />
        <span>
          项目经理 {detail.pm ?? '-'} · 部门 {detail.deptName ?? '-'} · 进度{' '}
          {formatPercent(detail.progress)} · 预算 {formatMoney(detail.budget)} ·
          预计总成本 {formatMoney(detail.estimatedTotalCost)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4" data-ai-section-type="card-stat">
        <StatCard
          label="已确认收入"
          value={formatMoney(accounting.recognizedRevenue)}
          tone="primary"
          icon={Wallet}
        />
        <StatCard
          label="已归集成本"
          value={formatMoney(accounting.totalCost)}
          tone="warning"
          hint={
            chain ? `期间费用分摊 ${formatMoney(chain.periodExpense)} 元` : undefined
          }
        />
        <StatCard
          label="毛利"
          value={formatMoney(accounting.grossMargin)}
          tone="success"
          hint={`毛利率 ${formatPercent(accounting.marginRate)}`}
        />
        <StatCard
          label="未回款金额"
          value={formatMoney(chain?.arOpenAmount ?? 0)}
          tone="info"
          icon={Users}
          hint={
            chain
              ? `已开票 ${formatMoney(chain.invoiceTotalAmount)} 元`
              : undefined
          }
        />
      </div>

      {chainError ? (
        <p className="text-sm text-destructive">全链路数据加载失败：{chainError}</p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>项目健康指标（EVM）</CardTitle>
        </CardHeader>
        <CardContent>
          {healthLoading ? (
            <p className="text-sm text-muted-foreground">加载中...</p>
          ) : evm ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm xl:grid-cols-4">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">SPI</span>
                <span>{evm.spi != null ? evm.spi.toFixed(2) : '-（需设置里程碑权重）'}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">CPI</span>
                <span>{evm.cpi != null ? evm.cpi.toFixed(2) : '-（需设置里程碑权重）'}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">EAC</span>
                <span>{evm.eac != null ? formatMoney(evm.eac) : '-'}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">逾期里程碑</span>
                {evm.overdueMilestoneCount > 0 ? (
                  <Badge variant="destructive">
                    延期里程碑 {evm.overdueMilestoneCount} 个
                  </Badge>
                ) : (
                  <span>0 个</span>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">暂无项目健康数据</p>
          )}
        </CardContent>
      </Card>

      <ProjectOverviewSection projectId={projectId} />

      <ProjectDocSection projectId={projectId} onChanged={reloadAll} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>客户信息</CardTitle>
          </CardHeader>
          <CardContent>
            {chain?.customer ? (
              <InfoGrid items={customerItems} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {chainLoading ? '加载中...' : '该项目未关联客户'}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>关联合同</CardTitle>
          </CardHeader>
          <CardContent>
            {chain?.contract ? (
              <InfoGrid items={contractItems} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {chainLoading ? '加载中...' : '该项目未关联合同'}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <QuotationSection projectId={projectId} />

      <RevenueSection projectId={projectId} onChanged={reloadAll} />

      <CostSection projectId={projectId} onChanged={reloadAll} />

      <InvoiceSection projectId={projectId} onChanged={reloadAll} />

      <ArApSection projectId={projectId} onChanged={reloadAll} />

      <TimesheetSection projectId={projectId} onChanged={reloadAll} />

      <MilestoneSection projectId={projectId} onChanged={reloadAll} />

      <DeliverableSection projectId={projectId} onChanged={reloadAll} />

      <ChangeSection projectId={projectId} onChanged={reloadAll} />

      <MinutesSection projectId={projectId} onChanged={reloadAll} />

      <CloseProjectSection projectId={projectId} onChanged={reloadAll} />

      <ProjectEditDialog
        project={detail}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={reloadAll}
      />
    </PageShell>
  );
};

export default ProjectDetailPage;
