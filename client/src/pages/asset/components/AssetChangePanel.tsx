import React, { useState } from 'react';
import { toast } from 'sonner';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import {
  AssetChangeStatusBadge,
  ASSET_CHANGE_STATUS_LABELS,
  ASSET_CHANGE_TYPE_LABELS,
} from './AssetStatusBadge';
import { Button } from '@client/src/components/ui/button';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { assetApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import type { AssetChangeItem } from '@shared/api.interface';

const PAGE_SIZE = 20;

const AssetChangePanel: React.FC = () => {
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [operatingId, setOperatingId] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsyncData(
    () =>
      assetApi.listChanges({
        page,
        pageSize: PAGE_SIZE,
        status: statusFilter !== 'all' ? statusFilter : undefined,
      }),
    [page, statusFilter],
  );

  const doAction = async (change: AssetChangeItem, action: 'approve' | 'reject') => {
    setOperatingId(change.id);
    try {
      await assetApi.changeAction(change.id, action);
      toast.success(
        action === 'approve'
          ? `变更单 ${change.code} 已批准${change.changeType === 'scrap' ? '，资产已报废并终止折旧' : ''}`
          : `变更单 ${change.code} 已驳回`,
      );
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '审批操作失败');
    } finally {
      setOperatingId(null);
    }
  };

  const items: AssetChangeItem[] = data?.items ?? [];

  const columns: TableColumnsType<AssetChangeItem> = [
    { title: '单号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '资产编号', dataIndex: 'assetCode', width: 140 },
    { title: '资产名称', dataIndex: 'assetName', width: 160 },
    {
      title: '变更类型',
      dataIndex: 'changeType',
      width: 90,
      render: (v: string) => ASSET_CHANGE_TYPE_LABELS[v] ?? v,
    },
    {
      title: '变更前快照',
      dataIndex: 'beforeValue',
      width: 220,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '变更后',
      dataIndex: 'afterValue',
      width: 200,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <AssetChangeStatusBadge status={s} />,
    },
    {
      title: '备注',
      dataIndex: 'remark',
      width: 160,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 150,
      render: (_: unknown, record: AssetChangeItem) => (
        <div className="flex gap-1">
          {record.status === 'pending' ? (
            <CanRole roles={['admin']}>
              <Button
                variant="ghost"
                size="sm"
                disabled={operatingId === record.id}
                onClick={() => void doAction(record, 'approve')}
              >
                通过
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                disabled={operatingId === record.id}
                onClick={() => void doAction(record, 'reject')}
              >
                驳回
              </Button>
            </CanRole>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="asset-change-status-filter">状态</Label>
          <Select
            value={statusFilter}
            onValueChange={(v: string) => {
              setStatusFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger id="asset-change-status-filter" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              {Object.entries(ASSET_CHANGE_STATUS_LABELS).map(
                ([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
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
        scroll={{ x: 1300, y: 500 }}
        locale={{ emptyText: '暂无变更单，请在资产台账中发起变更' }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          onChange: (p: number) => setPage(p),
        }}
      />
    </div>
  );
};

export default AssetChangePanel;
