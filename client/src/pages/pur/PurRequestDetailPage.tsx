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
import { purApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import PurStatusBadge, {
  PUR_REQUEST_STATUS_LABELS,
  PUR_REQUEST_TYPE_LABELS,
} from './components/PurStatusBadge';
import type { PurRequestItem } from '@shared/api.interface';

const PurRequestDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const stateItem = (location.state as { item?: PurRequestItem } | null)?.item;

  const { data, loading, error } = useAsyncData<PurRequestItem | null>(
    async () => {
      if (!id) return null;
      if (stateItem?.id === id) return stateItem;
      const res = await purApi.listRequests({ page: 1, pageSize: 500 });
      return res.items.find((item) => item.id === id) ?? null;
    },
    [id, stateItem],
  );

  usePageEntityName(data ? data.code : null);

  return (
    <PageShell
      title={data ? `采购申请 · ${data.code}` : '采购申请详情'}
      description={data?.title}
      actions={
        <Button variant="outline" onClick={() => navigate('/pur?tab=requests')}>
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>
      }
    >
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !data}
        emptyText="采购申请不存在或已删除"
        skeleton="default"
      >
        {data ? (
          <div className="mx-auto max-w-3xl space-y-6">
            <Card>
              <CardHeader>
                <SectionTitle>基本信息</SectionTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>
                  <span className="text-muted-foreground">标题：</span>
                  {data.title}
                </p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                  <p>
                    <span className="text-muted-foreground">类型：</span>
                    {PUR_REQUEST_TYPE_LABELS[data.requestType] ?? data.requestType}
                  </p>
                  <p>
                    <span className="text-muted-foreground">部门：</span>
                    {data.departmentName ?? '-'}
                  </p>
                  <p>
                    <span className="text-muted-foreground">项目：</span>
                    {data.projectName ?? '-'}
                  </p>
                  <p>
                    <span className="text-muted-foreground">供应商：</span>
                    {data.supplierName ?? '-'}
                  </p>
                  <p>
                    <span className="text-muted-foreground">预算金额：</span>
                    {formatMoney(data.amount)}
                  </p>
                  <p>
                    <span className="text-muted-foreground">期望日期：</span>
                    {data.expectDate ?? '-'}
                  </p>
                  <p className="flex items-center gap-2">
                    <span className="text-muted-foreground">状态：</span>
                    <PurStatusBadge
                      status={data.status}
                      labels={PUR_REQUEST_STATUS_LABELS}
                    />
                  </p>
                </div>
                <p>
                  <span className="text-muted-foreground">申请事由：</span>
                  {data.reason ?? '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">备注：</span>
                  {data.remark ?? '-'}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>附件</SectionTitle>
              </CardHeader>
              <CardContent>
                <AttachmentField
                  resourceType="pur_request"
                  resourceId={data.id}
                  usageHint="采购需求文档、报价单等"
                />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DataState>
    </PageShell>
  );
};

export default PurRequestDetailPage;
