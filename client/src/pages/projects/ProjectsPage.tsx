import React, { useState } from 'react';
import { ColumnHelpTitle } from '@client/src/components/erp/ItemHelp';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Download, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import ProjectQuickViewDrawer from './components/ProjectQuickViewDrawer';
import SimilarItemsDialog, {
  type SimilarTarget,
} from '@client/src/components/SimilarItemsDialog';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { useListQuery } from '@client/src/hooks/useListQuery';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import { PROJECT_STATUS_LABELS } from '@client/src/utils/biz-labels';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import type { Project } from '@shared/api.interface';

const PROJECT_EXPORT_COLUMNS: ExcelSheetColumn<Project>[] = [
  { header: '项目编号', value: (row: Project) => row.code },
  { header: '名称', value: (row: Project) => row.name },
  { header: '合同', value: (row: Project) => row.contractName ?? '' },
  {
    header: '成交报价',
    value: (row: Project) => row.wonQuotationCode ?? '',
  },
  { header: '项目经理', value: (row: Project) => row.pm ?? '' },
  { header: '预算基线', value: (row: Project) => row.budget },
  { header: '进度（%）', value: (row: Project) => row.progress },
  {
    header: '状态',
    value: (row: Project) => PROJECT_STATUS_LABELS[row.status] ?? row.status,
  },
  { header: '开始日期', value: (row: Project) => row.startDate ?? '' },
];

const ProjectsPage: React.FC = () => {
  const navigate = useNavigate();
  const { q, setQ, debouncedQ, debouncing } = useListQuery();
  const [statusFilter, setStatusFilter] = useState('all');
  const [similarTarget, setSimilarTarget] = useState<SimilarTarget | null>(null);
  const [quickViewProject, setQuickViewProject] = useState<Project | null>(null);

  const { data, loading, error, reload } = useAsyncData<Project[]>(
    () =>
      projectsApi.listProjects({
        status: statusFilter !== 'all' ? statusFilter : undefined,
        keyword: debouncedQ || undefined,
      }),
    [statusFilter, debouncedQ],
  );

  const handleExport = () => {
    const rows: Project[] = data ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('项目列表.xlsx', '项目', PROJECT_EXPORT_COLUMNS, rows);
  };

  const columns: TableColumnsType<Project> = [
    { title: '项目编号', dataIndex: 'code', fixed: 'left', width: 120, ellipsis: true },
    {
      title: '名称',
      dataIndex: 'name',
      width: 180,
      render: (v: string, record: Project) => (
        <Link
          to={`/projects/${record.id}`}
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          {v}
        </Link>
      ),
    },
    {
      title: (
        <ColumnHelpTitle
          title="成交报价"
          content="来自已赢单的报价。它不是预算基线，费用能不能提交看的是预算基线。"
        />
      ),
      key: 'wonQuote',
      width: 150,
      render: (_, row) =>
        row.wonQuotationId ? (
          <Link
            to={`/crm/quotations/${row.wonQuotationId}`}
            className="text-primary underline-offset-2 hover:underline"
          >
            {row.wonQuotationCode}
            {row.wonQuotationAmount != null
              ? ` · ${formatMoney(row.wonQuotationAmount)}`
              : ''}
          </Link>
        ) : (
          '-'
        ),
    },
    {
      title: (
        <ColumnHelpTitle
          title="预算基线"
          content="费用能不能提交，看的是这个数。留空时使用合同净额。"
        />
      ),
      dataIndex: 'budget',
      width: 110,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: (
        <ColumnHelpTitle
          title="进度"
          content="有里程碑权重时按已达成权重自动重算。进度不会自动确认收入。"
        />
      ),
      dataIndex: 'progress', width: 70, render: (v: number) => formatPercent(v) },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (s: string) => <StatusBadge status={s} labels={PROJECT_STATUS_LABELS} />,
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 180,
      render: (_, record) => (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setQuickViewProject(record)}
          >
            查看
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/projects/${record.id}`)}
          >
            详情
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`查找与 ${record.name} 相似的项目`}
            onClick={() =>
              setSimilarTarget({ id: record.id, code: record.code, name: record.name })
            }
          >
            找相似
          </Button>
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title="项目管理"
      description="立项、状态与交付进度"
      actions={
        /* 写操作（项目立项）归页头；「导出 Excel」是对当前筛选结果的只读工具，留在筛选行 */
        <CanCapabilityWrite capability="projects_write">
          <Button onClick={() => navigate('/projects/new')}>
            <Plus className="h-4 w-4" />
            项目立项
          </Button>
        </CanCapabilityWrite>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="project-status-filter">状态</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger id="project-status-filter" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {Object.entries(PROJECT_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Input
          aria-label="搜索项目"
          placeholder="搜索项目名称或编号"
          className="w-64"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {debouncing ? (
          <span className="text-xs text-muted-foreground">筛选中…</span>
        ) : null}
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
        </Button>
      </div>
      <DataState
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          className="overflow-hidden rounded-xl border border-border/80 bg-card"
          columns={columns}
          dataSource={data ?? []}
          rowKey="id"
          scroll={{ x: 900, y: 500 }}
          pagination={{
            pageSize: 10,
            showTotal: (total: number) => `共 ${total} 条`,
          }}
          locale={{ emptyText: '暂无项目，点击「项目立项」进入整页创建' }}
        />
      </DataState>
      <SimilarItemsDialog
        open={similarTarget !== null}
        onClose={() => setSimilarTarget(null)}
        type="project"
        target={similarTarget}
        onPick={(item) => {
          setSimilarTarget(null);
          navigate(`/projects/${item.id}`);
        }}
      />
      <ProjectQuickViewDrawer
        project={quickViewProject}
        onOpenChange={(open) => {
          if (!open) setQuickViewProject(null);
        }}
      />
    </PageShell>
  );
};

export default ProjectsPage;







