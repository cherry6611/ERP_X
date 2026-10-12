import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Download, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import PageShell from '@client/src/components/PageShell';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import ProjectFormDialog from './ProjectFormDialog';
import ProjectDetailDialog from './ProjectDetailDialog';
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
  const [statusFilter, setStatusFilter] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [similarTarget, setSimilarTarget] = useState<SimilarTarget | null>(null);

  const { data, loading, error, reload } = useAsyncData<Project[]>(
    () =>
      projectsApi.listProjects({
        status: statusFilter !== 'all' ? statusFilter : undefined,
        keyword: keyword || undefined,
      }),
    [statusFilter, keyword],
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
    { title: '项目编号', dataIndex: 'code', fixed: 'left', width: 140 },
    {
      title: '名称',
      dataIndex: 'name',
      width: 220,
      render: (v: string, record: Project) => (
        <Link
          to={`/projects/${record.id}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          {v}
        </Link>
      ),
    },
    { title: '合同', dataIndex: 'contractName', width: 200 },
    { title: '项目经理', dataIndex: 'pm', width: 100, render: (v) => v ?? '-' },
    {
      title: '预算基线',
      dataIndex: 'budget',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '进度', dataIndex: 'progress', width: 90, render: (v: number) => formatPercent(v) },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={PROJECT_STATUS_LABELS} />,
    },
    { title: '开始日期', dataIndex: 'startDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 150,
      render: (_, record) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setDetailId(record.id)}>
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
    <PageShell title="项目管理" description="立项、状态流转、里程碑、变更审批与项目核算">
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
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <CanRole roles={['admin']}>
          <Button onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4" />
            项目立项
          </Button>
        </CanRole>
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reload()}>
            重试
          </Button>
        </p>
      ) : null}
      <Table
        columns={columns}
        dataSource={data ?? []}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1300, y: 500 }}
        pagination={{
          pageSize: 10,
          showTotal: (total: number) => `共 ${total} 条`,
        }}
        locale={{ emptyText: '暂无项目，点击右上角「新建项目」创建' }}
      />
      <ProjectFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        onCreated={(id: string) => {
          setDetailId(id);
          void reload();
        }}
      />
      <SimilarItemsDialog
        open={similarTarget !== null}
        onClose={() => setSimilarTarget(null)}
        type="project"
        target={similarTarget}
        onPick={(item) => {
          setSimilarTarget(null);
          setDetailId(item.id);
        }}
      />
      <ProjectDetailDialog
        projectId={detailId}
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      />
    </PageShell>
  );
};

export default ProjectsPage;
