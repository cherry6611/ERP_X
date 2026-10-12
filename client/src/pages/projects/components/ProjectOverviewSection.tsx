import React from 'react';
import {
  Clock,
  Coins,
  FileText,
  Flag,
  Landmark,
  Receipt,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';
import StatCard from '@client/src/components/erp/StatCard';
import { Button } from '@client/src/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@client/src/components/ui/card';
import { projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, formatNumber, formatPercent } from '@client/src/utils/format';
import type {
  ChainCostTypeItem,
  ChainMilestoneItem,
  ChainRevenuePeriod,
  ProjectChainOverview,
} from '@shared/api.interface';

interface ProjectOverviewSectionProps {
  projectId: string;
}

const ProjectOverviewSection: React.FC<ProjectOverviewSectionProps> = ({
  projectId,
}) => {
  const { data: chain, loading, error, reload } = useAsyncData<ProjectChainOverview>(
    () => projectsApi.getProjectChain(projectId),
    [projectId],
  );

  if (error) {
    return (
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-base font-semibold">项目全景</CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>
    );
  }

  const quotations = chain?.quotations ?? [];
  const revenueTotal = (chain?.revenueByPeriod ?? []).reduce(
    (sum: number, item: ChainRevenuePeriod) => sum + item.amount,
    0,
  );
  const costTotal = (chain?.costByType ?? []).reduce(
    (sum: number, item: ChainCostTypeItem) => sum + item.amount,
    0,
  );
  const marginAmount = revenueTotal - costTotal;
  const marginRate =
    revenueTotal > 0 ? (marginAmount / revenueTotal) * 100 : null;
  const milestones = chain?.milestones ?? [];
  const reachedCount = milestones.filter(
    (m: ChainMilestoneItem) => m.status === 'reached',
  ).length;
  const milestoneRate =
    milestones.length > 0 ? (reachedCount / milestones.length) * 100 : null;

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-base font-semibold">项目全景</CardTitle>
        <CardDescription>收入、成本、结算与里程碑执行摘要</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">加载中...</p>
        ) : (
          <div className="flex flex-wrap gap-4">
            <div className="min-w-[200px] flex-1">
              <StatCard
                label="关联报价数"
                value={String(quotations.length)}
                tone="info"
                icon={FileText}
              />
            </div>
            <div className="min-w-[200px] flex-1">
              <StatCard
                label="已确认收入合计"
                value={formatMoney(revenueTotal)}
                tone="primary"
                icon={Wallet}
              />
            </div>
            <div className="min-w-[200px] flex-1">
              <StatCard
                label="成本合计"
                value={formatMoney(costTotal)}
                tone="warning"
                icon={Receipt}
              />
            </div>
            <div className="min-w-[200px] flex-1">
              <StatCard
                label="毛利额"
                value={
                  marginAmount < 0 ? (
                    <span className="text-destructive">
                      {formatMoney(marginAmount)}
                    </span>
                  ) : (
                    formatMoney(marginAmount)
                  )
                }
                tone={marginAmount < 0 ? 'warning' : 'success'}
                icon={TrendingUp}
                hint={marginRate != null ? `毛利率 ${formatPercent(marginRate)}` : undefined}
              />
            </div>
            <div className="min-w-[200px] flex-1">
              <StatCard
                label="应收未结"
                value={formatMoney(chain?.arOpenAmount ?? 0)}
                tone="info"
                icon={Users}
              />
            </div>
            <div className="min-w-[200px] flex-1">
              <StatCard
                label="应付未付"
                value={formatMoney(chain?.apOpenAmount ?? 0)}
                tone="warning"
                icon={Landmark}
              />
            </div>
            <div className="min-w-[200px] flex-1">
              <StatCard
                label="已开票金额"
                value={formatMoney(chain?.invoiceTotalAmount ?? 0)}
                tone="info"
                icon={Coins}
              />
            </div>
            <div className="min-w-[200px] flex-1">
              <StatCard
                label="累计工时"
                value={`${formatNumber(chain?.totalHours ?? 0)} 小时`}
                tone="neutral"
                icon={Clock}
              />
            </div>
            <div className="min-w-[200px] flex-1">
              <StatCard
                label="里程碑达成率"
                value={milestoneRate != null ? formatPercent(milestoneRate) : '-'}
                tone="success"
                icon={Flag}
                hint={
                  milestones.length > 0
                    ? `已达成 ${reachedCount}/${milestones.length}`
                    : undefined
                }
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default ProjectOverviewSection;
