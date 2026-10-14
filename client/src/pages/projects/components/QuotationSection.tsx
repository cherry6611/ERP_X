import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Table, TableColumnsType } from 'antd';
import StatusBadge from '@client/src/components/erp/StatusBadge';
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
import { formatMoney, formatPercent } from '@client/src/utils/format';
import { QUOTATION_STATUS_LABELS } from '@client/src/utils/biz-labels';
import type {
  ChainQuotationItem,
  ProjectChainOverview,
} from '@shared/api.interface';

interface QuotationSectionProps {
  projectId: string;
}

const QuotationSection: React.FC<QuotationSectionProps> = ({ projectId }) => {
  const navigate = useNavigate();

  const { data: chain, loading, error, reload } = useAsyncData<ProjectChainOverview>(
    () => projectsApi.getProjectChain(projectId),
    [projectId],
  );

  const quotations: ChainQuotationItem[] = chain?.quotations ?? [];

  const columns: TableColumnsType<ChainQuotationItem> = [
    {
      title: '报价编号',
      dataIndex: 'code',
      fixed: 'left',
      width: 150,
      render: (v: string, row) => (
        <Link
          to={`/crm/quotations/${row.id}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          {v}
        </Link>
      ),
    },
    { title: '标题', dataIndex: 'title', ellipsis: true },
    {
      title: '报价日期',
      dataIndex: 'quoteDate',
      width: 110,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '总额（元）',
      dataIndex: 'totalAmount',
      width: 130,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '预估毛利',
      key: 'estimatedMargin',
      width: 200,
      align: 'right',
      render: (_, record) => (
        <span className={record.marginPct < 20 ? 'text-destructive' : ''}>
          {formatMoney(record.totalAmount - record.estimatedCost)}（
          {formatPercent(record.marginPct)}）
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={QUOTATION_STATUS_LABELS} />,
    },
  ];

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-base font-semibold">关联报价</CardTitle>
        <CardDescription>
          商机或合同关联的报价单，点击进入整页详情
        </CardDescription>
      </CardHeader>
      <CardContent>
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
          dataSource={quotations}
          loading={loading}
          rowKey="id"
          scroll={{ x: 900 }}
          pagination={{ pageSize: 5, showTotal: (t: number) => `共 ${t} 条` }}
          locale={{ emptyText: '暂无关联报价（商机或合同关联的报价将展示在此）' }}
          onRow={(record: ChainQuotationItem) => ({
            onClick: () => navigate(`/crm/quotations/${record.id}`),
            className: 'cursor-pointer',
          })}
        />
      </CardContent>
    </Card>
  );
};

export default QuotationSection;
