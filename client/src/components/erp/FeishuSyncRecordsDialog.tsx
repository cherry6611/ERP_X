import React, { useState } from 'react';
import { Table, TableColumnsType } from 'antd';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { feishuSyncApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import type {
  FeishuSyncDirection,
  FeishuSyncRecordItem,
  PagedResult,
} from '@shared/api.interface';

const DIRECTION_LABELS: Record<string, string> = {
  outbound: '出向',
  inbound: '入向',
};

const BIZ_TYPE_LABELS: Record<string, string> = {
  cost: '成本',
  contract: '合同',
  timesheet: '工时',
};

const STATUS_LABELS: Record<string, string> = {
  pending: '待同步',
  success: '成功',
  failed: '失败',
};

const PAGE_SIZE = 20;

interface FeishuSyncRecordsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 初始方向过滤（可切换） */
  direction?: FeishuSyncDirection;
  /** 初始业务类型过滤（可切换） */
  bizType?: string;
}

const SyncStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  if (status === 'success') {
    return (
      <Badge className="border-transparent bg-success/10 text-success hover:bg-success/10">
        成功
      </Badge>
    );
  }
  if (status === 'failed') {
    return <Badge variant="destructive">失败</Badge>;
  }
  return <Badge variant="secondary">待同步</Badge>;
};

const FeishuSyncRecordsDialog: React.FC<FeishuSyncRecordsDialogProps> = ({
  open,
  onOpenChange,
  direction,
  bizType,
}) => {
  const [directionFilter, setDirectionFilter] = useState<string>(direction ?? 'all');
  const [typeFilter, setTypeFilter] = useState<string>(bizType ?? 'all');
  const [page, setPage] = useState<number>(1);

  const { data, loading, error, reload } = useAsyncData<PagedResult<FeishuSyncRecordItem>>(
    () =>
      feishuSyncApi.fetchSyncRecords({
        direction: directionFilter !== 'all' ? directionFilter : undefined,
        bizType: typeFilter !== 'all' ? typeFilter : undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    [directionFilter, typeFilter, page],
  );

  const items: FeishuSyncRecordItem[] = data?.items ?? [];

  const columns: TableColumnsType<FeishuSyncRecordItem> = [
    {
      title: '业务编号',
      dataIndex: 'bizCode',
      fixed: 'left',
      width: 140,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: 'Base 记录',
      dataIndex: 'baseRecordId',
      width: 150,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '方向',
      dataIndex: 'direction',
      width: 80,
      render: (v: string) => DIRECTION_LABELS[v] ?? v,
    },
    {
      title: '类型',
      dataIndex: 'bizType',
      width: 80,
      render: (v: string) => BIZ_TYPE_LABELS[v] ?? v,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <SyncStatusBadge status={v} />,
    },
    {
      title: '错误信息',
      dataIndex: 'errorMsg',
      width: 260,
      render: (v: string | null) =>
        v ? <span className="break-words text-destructive">{v}</span> : '-',
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 160,
      render: (v: string) => new Date(v).toLocaleString(),
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>同步记录</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={directionFilter}
            onValueChange={(v: string) => {
              setDirectionFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-32" aria-label="按方向筛选同步记录">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部方向</SelectItem>
              <SelectItem value="outbound">出向</SelectItem>
              <SelectItem value="inbound">入向</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={typeFilter}
            onValueChange={(v: string) => {
              setTypeFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-32" aria-label="按类型筛选同步记录">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              <SelectItem value="cost">成本</SelectItem>
              <SelectItem value="contract">合同</SelectItem>
              <SelectItem value="timesheet">工时</SelectItem>
            </SelectContent>
          </Select>
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
          dataSource={items}
          loading={loading}
          rowKey="id"
          scroll={{ x: 950, y: 400 }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: data?.total ?? 0,
            showTotal: (t: number) => `共 ${t} 条`,
            onChange: (p: number) => {
              setPage(p);
            },
          }}
          locale={{ emptyText: '暂无同步记录' }}
        />
      </DialogContent>
    </Dialog>
  );
};

export default FeishuSyncRecordsDialog;
