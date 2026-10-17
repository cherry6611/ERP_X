import React, { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Pencil, Users, Wallet } from 'lucide-react';
import { CanRole } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import { usePageEntityName } from '@client/src/components/page-meta';
import PageShell from '@client/src/components/PageShell';
import SectionBoundary from '@client/src/components/erp/SectionBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Card, CardContent, CardHeader } from '@client/src/components/ui/card';
import { biApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import { confirmDanger } from '@client/src/utils/confirmDanger';
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
import ProjectOverviewSection from '@client/src/pages/projects/components/ProjectOverviewSection';
import QuotationSection from '@client/src/pages/projects/components/QuotationSection';
import RevenueSection from '@client/src/pages/projects/components/RevenueSection';
import TimesheetSection from '@client/src/pages/projects/components/TimesheetSection';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  ProjectChainOverview,
  ProjectDetail,
  ProjectFinancialHealthItem,
  ProjectFinancialHealthSummary,
  ProjectStatusAction,
} from '@shared/api.interface';

/*
 * close 动作入口由 CloseProjectSection 的结项表单提供（要填结项摘要），
 * 状态按钮只保留其余流转。
 *
 * B6（§7.2）：补齐两条**退出路径** —— 原表只有正向流转，
 * 导致项目一进入任一非终态就无法退出，且已结项无法撤回：
 *   · `cancel`：任意非终态 → 已取消。误建/中途取消的项目必须能退出，
 *     否则同一合同下"全部项目已结项"永远不成立，合同状态卡在 active。
 *   · `reopen`：已结项 → 验收中。结项会发结项报告并回写合同，
 *     结错了必须能撤回，否则项目被彻底锁死。
 * `accepting` 的入口仍是 CloseProjectSection（要填结项摘要），不是这里的按钮。
 */
const STATUS_ACTIONS: Partial<
  Record<string, { action: ProjectStatusAction; label: string }[]>
> = {
  initiating: [
    { action: 'approve', label: '批准立项' },
    { action: 'cancel', label: '取消项目' },
  ],
  executing: [
    { action: 'deliver', label: '进入交付' },
    { action: 'cancel', label: '取消项目' },
  ],
  delivering: [
    { action: 'accept', label: '进入验收' },
    { action: 'cancel', label: '取消项目' },
  ],
  // accepting 只允许结项（见上方说明：此时全部交付物已验收，取消会让它们失去归属）
  closed: [{ action: 'reopen', label: '反结项' }],
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

  usePageEntityName(detail ? `${detail.code} ${detail.name}` : null);

  const reloadAll = useCallback(() => {
    void reloadDetail();
    void reloadChain();
    void reloadHealth();
  }, [reloadDetail, reloadChain, reloadHealth]);

  const doAction = async (action: ProjectStatusAction) => {
    if (!id) return;
    /*
     * B6：`cancel` 与 `reopen` 是**有后果的终态变更**，必须二次确认。
     *
     * 尤其 `cancel`：同合同下只要有项目被取消，
     * `tryCompleteContract` 的"全部项目 closed"就永远不成立，
     * **合同状态会一直停在 active** —— 这不是一个能随手点的按钮。
     * `reopen` 同样会把已发出的结项报告变成与系统状态不一致。
     *
     * 用 `confirmDanger` 而不是 `window.confirm`：本仓既有约定
     * （`utils/confirmDanger.ts`），且它统一处理了"确认按钮用危险色"。
     */
    if (action === 'cancel' || action === 'reopen') {
      const message =
        action === 'cancel'
          ? '取消后项目进入终态，且同合同下只要有项目被取消，合同状态将永远无法自动回写为「已完成」。确认取消？'
          : '反结项会把项目退回「验收中」。若结项报告已发出，报告将与系统状态不一致。确认反结项？';
      const ok = await confirmDanger(message, {
        title: action === 'cancel' ? '确认取消项目' : '确认反结项',
      });
      if (!ok) return;
    }
    setActing(true);
    try {
      await projectsApi.changeProjectStatus(id, action);
      toast.success('状态已更新');
      await reloadDetail();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
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
        <DataState loading />
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
    >
      <div className="sticky top-14 z-10 -mx-6 flex flex-wrap items-center gap-2 border-b bg-background/95 px-6 py-2 backdrop-blur">
        <Button variant="outline" onClick={() => navigate('/projects')}>
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>
        <CanRole roles={['admin']}>
          <Button
            variant="outline"
            onClick={() => navigate(`/projects/${detail.id}/edit`)}
          >
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
      </div>

      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={detail.status} labels={PROJECT_STATUS_LABELS} />
          <span>
            项目经理 {detail.pm ?? '-'} · 部门 {detail.deptName ?? '-'} · 进度{' '}
            {formatPercent(detail.progress)} · 预算 {formatMoney(detail.budget)} ·
            预计总成本 {formatMoney(detail.estimatedTotalCost)}
          </span>
        </div>
        <div>
          最终成交报价：
          {detail.wonQuotationId ? (
            <Link
              to={`/crm/quotations/${detail.wonQuotationId}`}
              className="text-primary underline-offset-2 hover:underline"
            >
              {detail.wonQuotationCode}
              {detail.wonQuotationTitle ? ` · ${detail.wonQuotationTitle}` : ''}
              {detail.wonQuotationAmount != null
                ? `（${formatMoney(detail.wonQuotationAmount)}）`
                : ''}
            </Link>
          ) : (
            '未关联'
          )}
          {detail.opportunityId ? (
            <>
              {' · '}
              商机：
              <Link
                to={`/crm/opportunities/${detail.opportunityId}`}
                className="text-primary underline-offset-2 hover:underline"
              >
                {detail.opportunityTitle ?? detail.opportunityId}
              </Link>
            </>
          ) : null}
        </div>
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
          <SectionTitle>项目健康指标（EVM）</SectionTitle>
        </CardHeader>
        <CardContent>
          <DataState
            loading={healthLoading}
            empty={!healthLoading && !evm}
            emptyText="暂无项目健康数据"
          >
            {evm ? (
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
            ) : null}
          </DataState>
        </CardContent>
      </Card>

      <SectionBoundary title="项目概览">
        <ProjectOverviewSection projectId={projectId} />
      </SectionBoundary>

      <SectionBoundary title="项目文档">
        <ProjectDocSection projectId={projectId} onChanged={reloadAll} />
      </SectionBoundary>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <SectionTitle>客户信息</SectionTitle>
          </CardHeader>
          <CardContent>
            {chain?.customer ? (
              <InfoGrid items={customerItems} />
            ) : chainLoading ? (
              <DataState loading />
            ) : (
              <p className="text-sm text-muted-foreground">该项目未关联客户</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <SectionTitle>关联合同</SectionTitle>
          </CardHeader>
          <CardContent>
            {chain?.contract ? (
              <InfoGrid items={contractItems} />
            ) : chainLoading ? (
              <DataState loading />
            ) : (
              <p className="text-sm text-muted-foreground">该项目未关联合同</p>
            )}
          </CardContent>
        </Card>
      </div>

      <SectionBoundary title="报价单">
        <QuotationSection projectId={projectId} />
      </SectionBoundary>

      <SectionBoundary title="收入确认">
        <RevenueSection projectId={projectId} onChanged={reloadAll} />
      </SectionBoundary>

      <SectionBoundary title="成本">
        <CostSection projectId={projectId} onChanged={reloadAll} />
      </SectionBoundary>

      <SectionBoundary title="发票">
        <InvoiceSection projectId={projectId} onChanged={reloadAll} />
      </SectionBoundary>

      <SectionBoundary title="应收应付">
        <ArApSection projectId={projectId} onChanged={reloadAll} />
      </SectionBoundary>

      <SectionBoundary title="工时">
        <TimesheetSection projectId={projectId} onChanged={reloadAll} />
      </SectionBoundary>

      <SectionBoundary title="里程碑">
        <MilestoneSection projectId={projectId} onChanged={reloadAll} />
      </SectionBoundary>

      <SectionBoundary title="交付物">
        <DeliverableSection projectId={projectId} onChanged={reloadAll} />
      </SectionBoundary>

      <SectionBoundary title="变更">
        <ChangeSection projectId={projectId} onChanged={reloadAll} />
      </SectionBoundary>

      <SectionBoundary title="周报与纪要">
        <MinutesSection projectId={projectId} onChanged={reloadAll} />
      </SectionBoundary>

      <SectionBoundary title="结项">
        <CloseProjectSection projectId={projectId} onChanged={reloadAll} />
      </SectionBoundary>
    </PageShell>
  );
};

export default ProjectDetailPage;
