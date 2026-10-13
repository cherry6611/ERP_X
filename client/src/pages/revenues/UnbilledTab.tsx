import React from 'react';
import { Table, TableColumnsType } from 'antd';
import { DataState } from '@client/src/components/DataState';
import { revenuesApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import type { UnbilledItem } from '@shared/api.interface';

const UnbilledTab: React.FC = () => {
  const { data, loading, error, reload } = useAsyncData<UnbilledItem[]>(
    () => revenuesApi.listUnbilled(),
    [],
  );

  const columns: TableColumnsType<UnbilledItem> = [
    { title: '项目', dataIndex: 'projectName', fixed: 'left', width: 280 },
    {
      title: '已确认收入',
      dataIndex: 'recognizedAmount',
      width: 140,
      render: (v: number) => formatMoney(v),
    },
    {
      title: '已开票金额',
      dataIndex: 'invoicedAmount',
      width: 140,
      render: (v: number) => formatMoney(v),
    },
    {
      title: '未开票金额',
      dataIndex: 'unbilledAmount',
      width: 140,
      render: (v: number) => (
        <span className="font-semibold">{formatMoney(v)}</span>
      ),
    },
  ];

  const totalUnbilled = (data ?? []).reduce((acc: number, item) => acc + item.unbilledAmount, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm text-muted-foreground">未开票收入合计</p>
        <p className="text-xl font-semibold">{formatMoney(totalUnbilled)}</p>
      </div>
      <DataState
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          columns={columns}
          dataSource={data ?? []}
          rowKey="projectId"
          scroll={{ x: 900, y: 500 }}
          pagination={false}
          locale={{ emptyText: '暂无未开票收入' }}
        />
      </DataState>
    </div>
  );
};

export default UnbilledTab;
