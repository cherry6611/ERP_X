import React from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { DataState } from '@client/src/components/DataState';
import PageShell from '@client/src/components/PageShell';
import { usePageEntityName } from '@client/src/components/page-meta';
import { AttachmentList } from '@client/src/components/attachments/AttachmentList';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent, CardHeader } from '@client/src/components/ui/card';
import { voucherApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import {
  VoucherStatusBadge,
  VOUCHER_SOURCE_LABELS,
} from './components/VoucherBadges';
import type { VoucherItem, VoucherLineItem } from '@shared/api.interface';

const lineColumns: TableColumnsType<VoucherLineItem> = [
  { title: '科目编码', dataIndex: 'accountCode', width: 120 },
  { title: '科目名称', dataIndex: 'accountName', width: 160 },
  { title: '摘要', dataIndex: 'summary', render: (v: string | null) => v ?? '-' },
  {
    title: '借方',
    dataIndex: 'debit',
    width: 130,
    align: 'right',
    render: (v: number) => formatMoney(v),
  },
  {
    title: '贷方',
    dataIndex: 'credit',
    width: 130,
    align: 'right',
    render: (v: number) => formatMoney(v),
  },
];

const VoucherDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const stateItem = (location.state as { item?: VoucherItem } | null)?.item;

  const { data, loading, error } = useAsyncData<VoucherItem | null>(async () => {
    if (!id) return null;
    if (stateItem?.id === id) return stateItem;
    const res = await voucherApi.listVouchers({ page: 1, pageSize: 500 });
    return res.items.find((item) => item.id === id) ?? null;
  }, [id, stateItem]);

  usePageEntityName(data ? data.code : null);

  return (
    <PageShell
      title={data ? `凭证 · ${data.code}` : '凭证详情'}
      description={
        data
          ? `日期 ${data.voucherDate ?? '-'} · 期间 ${data.period} · 来源 ${
              VOUCHER_SOURCE_LABELS[data.sourceType] ?? data.sourceType
            }`
          : undefined
      }
      actions={
        <Button variant="outline" onClick={() => navigate('/voucher')}>
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>
      }
    >
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !data}
        emptyText="凭证不存在或已删除"
        skeleton="default"
      >
        {data ? (
          <div className="mx-auto max-w-5xl space-y-6">
            <Card>
              <CardHeader>
                <SectionTitle>基本信息</SectionTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <p>
                  <span className="text-muted-foreground">摘要：</span>
                  {data.summary ?? '-'}
                </p>
                <p className="flex items-center gap-2">
                  <span className="text-muted-foreground">状态：</span>
                  <VoucherStatusBadge status={data.status} />
                </p>
                <p>
                  <span className="text-muted-foreground">关联单号：</span>
                  {data.sourceRef ?? '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">备注：</span>
                  {data.remark ?? '-'}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>分录</SectionTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Table
                  columns={lineColumns}
                  dataSource={data.lines}
                  rowKey="id"
                  pagination={false}
                  scroll={{ x: 700 }}
                />
                <p className="text-sm">
                  借方合计{' '}
                  <span className="font-medium">{formatMoney(data.totalDebit)}</span>
                  {'　'}贷方合计{' '}
                  <span className="font-medium">{formatMoney(data.totalCredit)}</span>
                  {Math.abs(data.totalDebit - data.totalCredit) < 0.001 ? (
                    <span className="ml-3 text-muted-foreground">借贷平衡</span>
                  ) : (
                    <span className="ml-3 text-destructive">借贷不平衡</span>
                  )}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>附件</SectionTitle>
              </CardHeader>
              <CardContent>
                <AttachmentList resourceType="fin_voucher" resourceId={data.id} />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DataState>
    </PageShell>
  );
};

export default VoucherDetailPage;
