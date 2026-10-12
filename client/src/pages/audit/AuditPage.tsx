import React, { useState } from 'react';
import { Table, TableColumnsType } from 'antd';
import PageShell from '@client/src/components/PageShell';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { auditApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import type { AuditLog } from '@shared/api.interface';

const OBJECT_TYPE_LABELS: Record<string, string> = {
  'master-data': '主数据',
  crm: 'CRM',
  contracts: '合同',
  projects: '项目',
  costs: '成本',
  revenues: '收入',
  finance: '财务',
  bi: 'BI',
  audit: '审计',
};

const ACTION_LABELS: Record<string, string> = {
  create: '创建',
  update: '更新',
  delete: '删除',
};

const AuditPage: React.FC = () => {
  const [objectType, setObjectType] = useState<string>('all');
  const [action, setAction] = useState<string>('all');
  const [limit, setLimit] = useState(100);

  const { data, loading, error, reload } = useAsyncData<AuditLog[]>(
    () =>
      auditApi.listAuditLogs({
        objectType: objectType !== 'all' ? objectType : undefined,
        action: action !== 'all' ? action : undefined,
        limit,
      }),
    [objectType, action, limit],
  );

  const columns: TableColumnsType<AuditLog> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      fixed: 'left',
      width: 170,
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
    { title: '操作人', dataIndex: 'actor', width: 150 },
    {
      title: '操作',
      dataIndex: 'action',
      width: 90,
      render: (a: string) => <Badge variant="secondary">{ACTION_LABELS[a] ?? a}</Badge>,
    },
    {
      title: '模块',
      dataIndex: 'objectType',
      width: 100,
      render: (t: string) => OBJECT_TYPE_LABELS[t] ?? t,
    },
    { title: '对象编号', dataIndex: 'objectCode', width: 150 },
    {
      title: '状态变化',
      key: 'statusChange',
      width: 180,
      render: (_, record) =>
        record.statusAfter
          ? `${record.statusBefore ?? '-'} → ${record.statusAfter}`
          : '-',
    },
    {
      title: '详情',
      dataIndex: 'detail',
      render: (d: string | null) => (
        <span className="text-muted-foreground text-xs break-all line-clamp-2" title={d ?? ''}>
          {d ?? '-'}
        </span>
      ),
    },
  ];

  return (
    <PageShell title="审计日志" description="全局写操作审计记录（只追加，不可篡改）">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-object-type">模块</Label>
          <Select value={objectType} onValueChange={setObjectType}>
            <SelectTrigger id="audit-object-type" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部模块</SelectItem>
              {Object.entries(OBJECT_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-action">操作类型</Label>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger id="audit-action" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部操作</SelectItem>
              {Object.entries(ACTION_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-limit">条数</Label>
          <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
            <SelectTrigger id="audit-limit" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="50">50 条</SelectItem>
              <SelectItem value="100">100 条</SelectItem>
              <SelectItem value="200">200 条</SelectItem>
            </SelectContent>
          </Select>
        </div>
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
        scroll={{ x: 1100, y: 500 }}
        pagination={{
          pageSize: 10,
          showTotal: (t: number) => `共 ${t} 条`,
        }}
        locale={{ emptyText: '暂无审计日志，系统写操作将自动记录' }}
      />
    </PageShell>
  );
};

export default AuditPage;
