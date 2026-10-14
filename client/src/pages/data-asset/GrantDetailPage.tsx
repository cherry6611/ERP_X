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
import { dataAssetApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import DataAssetBadge, { GRANT_STATUS_LABELS } from './components/DataAssetBadge';
import type { GrantItem } from '@shared/api.interface';

const GrantDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const stateItem = (location.state as { item?: GrantItem } | null)?.item;

  const { data, loading, error } = useAsyncData<GrantItem | null>(async () => {
    if (!id) return null;
    if (stateItem?.id === id) return stateItem;
    const res = await dataAssetApi.listGrants({ page: 1, pageSize: 500 });
    return res.items.find((item) => item.id === id) ?? null;
  }, [id, stateItem]);

  usePageEntityName(data ? data.code : null);

  return (
    <PageShell
      title={data ? `授权 · ${data.code}` : '授权详情'}
      actions={
        <Button
          variant="outline"
          onClick={() => navigate('/data-asset?tab=grants')}
        >
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>
      }
    >
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !data}
        emptyText="授权记录不存在或已删除"
        skeleton="default"
      >
        {data ? (
          <div className="mx-auto max-w-3xl space-y-6">
            <Card>
              <CardHeader>
                <SectionTitle>基本信息</SectionTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                  <p>
                    <span className="text-muted-foreground">数据集：</span>
                    {data.datasetName}
                  </p>
                  <p>
                    <span className="text-muted-foreground">客户：</span>
                    {data.customerName ?? '-'}
                  </p>
                  <p>
                    <span className="text-muted-foreground">项目：</span>
                    {data.projectName ?? '-'}
                  </p>
                  <p className="flex items-center gap-2">
                    <span className="text-muted-foreground">状态：</span>
                    <DataAssetBadge status={data.status} labels={GRANT_STATUS_LABELS} />
                  </p>
                  <p>
                    <span className="text-muted-foreground">开始日期：</span>
                    {data.startDate ?? '-'}
                  </p>
                  <p>
                    <span className="text-muted-foreground">结束日期：</span>
                    {data.endDate ?? '-'}
                  </p>
                </div>
                <p>
                  <span className="text-muted-foreground">授权范围：</span>
                  {data.scope ?? '-'}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>附件</SectionTitle>
              </CardHeader>
              <CardContent>
                <AttachmentField
                  resourceType="da_grant"
                  resourceId={data.id}
                  usageHint="授权协议、审批文件等"
                />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DataState>
    </PageShell>
  );
};

export default GrantDetailPage;
