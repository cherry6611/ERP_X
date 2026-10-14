import React, { useEffect } from 'react';
import { AlertTriangle, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { Table, TableColumnsType } from 'antd';
import { DataState } from '@client/src/components/DataState';
import { SectionTitle } from '@client/src/components/SectionTitle';
import StatCard from '@client/src/components/erp/StatCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { biApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import type {
  ProjectFinancialHealthItem,
  ProjectHealthLevel,
} from '@shared/api.interface';

/** 预警优先级：预计超支 / 目标不可达 最上，其次成本关注，再健康 */
const HEALTH_RANK: Record<ProjectHealthLevel, number> = {
  over_budget: 0,
  unreachable: 0,
  watch: 1,
  healthy: 2,
};

const HEALTH_META: Record<
  ProjectHealthLevel,
  { label: string; variant: 'success' | 'warning' | 'destructive' }
> = {
  healthy: { label: '健康', variant: 'success' },
  watch: { label: '成本关注', variant: 'warning' },
  over_budget: { label: '预计超支', variant: 'destructive' },
  unreachable: { label: '目标不可达', variant: 'destructive' },
};

const ProjectFinancialHealthPanel: React.FC = () => {
  const { data, loading, error, reload } = useAsyncData(
    () => biApi.getProjectFinancialHealth(),
    [],
  );

  useEffect(() => {
    if (error) {
      toast.error('获取项目财务健康数据失败', { description: error });
    }
  }, [error]);

  const sorted: ProjectFinancialHealthItem[] = [...(data?.items ?? [])].sort(
    (a: ProjectFinancialHealthItem, b: ProjectFinancialHealthItem) => {
      const rankDiff = HEALTH_RANK[a.healthLevel] - HEALTH_RANK[b.healthLevel];
      if (rankDiff !== 0) return rankDiff;
      return (
        b.projectedFinalCost - b.budget - (a.projectedFinalCost - a.budget)
      );
    },
  );

  const columns: TableColumnsType<ProjectFinancialHealthItem> = [
    { title: '项目编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '项目名称', dataIndex: 'name', width: 200 },
    { title: '负责人', dataIndex: 'pm', width: 100, render: (v) => v ?? '-' },
    {
      title: '预算',
      dataIndex: 'budget',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '预计总成本',
      dataIndex: 'estimatedTotalCost',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '已发生成本',
      dataIndex: 'actualCost',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '确认收入',
      dataIndex: 'recognizedRevenue',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '外推完工成本',
      dataIndex: 'projectedFinalCost',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: 'SPI',
      dataIndex: 'spi',
      width: 90,
      align: 'right',
      render: (v: number | null) => (v != null ? v.toFixed(2) : '-'),
    },
    {
      title: 'CPI',
      dataIndex: 'cpi',
      width: 90,
      align: 'right',
      render: (v: number | null) => (v != null ? v.toFixed(2) : '-'),
    },
    {
      title: 'EAC',
      dataIndex: 'eac',
      width: 120,
      align: 'right',
      render: (v: number | null) => (v != null ? formatMoney(v) : '-'),
    },
    {
      title: '逾期里程碑',
      dataIndex: 'overdueMilestoneCount',
      width: 110,
      align: 'right',
      render: (v: number) =>
        v > 0 ? <Badge variant="destructive">延期 {v} 个</Badge> : String(v),
    },
    {
      title: '健康度',
      dataIndex: 'healthLevel',
      width: 110,
      render: (v: ProjectHealthLevel) => (
        <Badge variant={HEALTH_META[v].variant}>{HEALTH_META[v].label}</Badge>
      ),
    },
    {
      title: '说明',
      dataIndex: 'healthReason',
      width: 240,
      render: (v: string | null) => v ?? '-',
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>项目财务健康</SectionTitle>
      <p className="text-sm text-muted-foreground">
        基于预算与外推完工成本评估项目财务健康，预警项目优先展示
      </p>
      {error ? (
        <p className="text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reload()}>
            重试
          </Button>
        </p>
      ) : null}
      {data ? (
        <div data-ai-section-type="card-stat" className="grid grid-cols-2 gap-4">
          <StatCard
            label="预计超支项目"
            value={
              <span className="text-destructive">
                {String(data.overBudgetCount)}
              </span>
            }
            icon={AlertTriangle}
            tone="neutral"
          />
          <StatCard
            label="成本关注项目"
            value={String(data.watchCount)}
            icon={Eye}
            tone="warning"
          />
        </div>
      ) : null}
      <DataState loading={loading} skeleton="table">
        <Table
          columns={columns}
          dataSource={sorted}
          rowKey="projectId"
          scroll={{ x: 1850, y: 400 }}
          pagination={false}
          locale={{ emptyText: '暂无项目财务健康数据' }}
        />
      </DataState>
    </div>
  );
};

export default ProjectFinancialHealthPanel;
