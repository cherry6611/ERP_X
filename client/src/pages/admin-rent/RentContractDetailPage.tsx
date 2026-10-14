import React from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DataState } from '@client/src/components/DataState';
import PageShell from '@client/src/components/PageShell';
import { usePageEntityName } from '@client/src/components/page-meta';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent, CardHeader } from '@client/src/components/ui/card';
import { adminApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, formatNumber } from '@client/src/utils/format';
import RentStatusBadge from './components/RentStatusBadge';
import type {
  AdminPaymentCycle,
  AdminRentContractItem,
} from '@shared/api.interface';

const PAYMENT_CYCLE_LABELS: Record<AdminPaymentCycle, string> = {
  monthly: '月付',
  quarterly: '季付',
  half_yearly: '半年付',
  yearly: '年付',
};

const DetailRow: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex gap-2 text-sm">
    <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
    <span className="min-w-0 flex-1 break-words">{children}</span>
  </div>
);

const RentContractDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const stateItem = (location.state as { item?: AdminRentContractItem } | null)?.item;

  const { data, loading, error } = useAsyncData<AdminRentContractItem | null>(
    async () => {
      if (!id) return null;
      if (stateItem?.id === id) return stateItem;
      const res = await adminApi.listRentContracts({ page: 1, pageSize: 500 });
      return res.items.find((item) => item.id === id) ?? null;
    },
    [id, stateItem],
  );

  usePageEntityName(data ? `${data.code} ${data.name}` : null);

  return (
    <PageShell
      title={data ? `租房合同 · ${data.code}` : '租房合同详情'}
      description={data?.name}
      actions={
        <Button variant="outline" onClick={() => navigate('/admin-rent')}>
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>
      }
    >
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !data}
        emptyText="合同不存在或已删除"
        skeleton="default"
      >
        {data ? (
          <div className="mx-auto max-w-3xl space-y-6">
            <Card>
              <CardHeader>
                <SectionTitle>基本信息</SectionTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <DetailRow label="状态">
                  <RentStatusBadge status={data.status} />
                </DetailRow>
                <DetailRow label="房产地址">{data.propertyAddress}</DetailRow>
                <DetailRow label="出租方">{data.lessor}</DetailRow>
                <DetailRow label="月租金">{formatMoney(data.monthlyRent)}</DetailRow>
                <DetailRow label="押金">
                  {data.deposit == null ? '-' : formatMoney(data.deposit)}
                </DetailRow>
                <DetailRow label="面积">
                  {data.area == null ? '-' : `${formatNumber(data.area)} ㎡`}
                </DetailRow>
                <DetailRow label="租期">
                  {data.startDate} ~ {data.endDate}
                </DetailRow>
                <DetailRow label="付款方式">
                  {PAYMENT_CYCLE_LABELS[data.paymentCycle] ?? data.paymentCycle}
                </DetailRow>
                <DetailRow label="备注">{data.remark ?? '-'}</DetailRow>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>附件</SectionTitle>
              </CardHeader>
              <CardContent>
                <AttachmentField
                  resourceType="admin_rent_contract"
                  resourceId={data.id}
                  usageHint="租赁合同扫描件等"
                />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DataState>
    </PageShell>
  );
};

export default RentContractDetailPage;
