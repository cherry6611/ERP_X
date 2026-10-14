import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DataState } from '@client/src/components/DataState';
import PageShell from '@client/src/components/PageShell';
import { usePageEntityName } from '@client/src/components/page-meta';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent, CardHeader } from '@client/src/components/ui/card';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { crmApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { LEAD_STATUS_LABELS } from '@client/src/utils/biz-labels';
import type { Lead } from '@shared/api.interface';

const LeadDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, loading, error } = useAsyncData<Lead | null>(async () => {
    if (!id) return null;
    const list = await crmApi.listLeads();
    return list.find((item) => item.id === id) ?? null;
  }, [id]);

  usePageEntityName(data ? `${data.code} ${data.customerName}` : null);

  return (
    <PageShell
      title={data ? `线索详情 · ${data.code}` : '线索详情'}
      description={data?.customerName}
      actions={
        <Button variant="outline" onClick={() => navigate('/crm?tab=leads')}>
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>
      }
    >
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !data}
        emptyText="线索不存在或已删除"
        skeleton="default"
      >
        {data ? (
          <div className="mx-auto max-w-4xl space-y-6">
            <Card>
              <CardHeader>
                <SectionTitle>基本信息</SectionTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">客户名称</span>
                    <span>{data.customerName}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">来源</span>
                    <span>{data.source ?? '-'}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">联系人</span>
                    <span>{data.contactName ?? '-'}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">联系电话</span>
                    <span>{data.contactPhone ?? '-'}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">状态</span>
                    <StatusBadge status={data.status} labels={LEAD_STATUS_LABELS} />
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">负责人</span>
                    <span>{data.owner ?? '-'}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">下次跟进</span>
                    <span>{data.nextDate ?? '-'}</span>
                  </div>
                  <div className="col-span-2 flex justify-between gap-2">
                    <span className="shrink-0 text-muted-foreground">跟进记录</span>
                    <span className="text-right">{data.followNote ?? '-'}</span>
                  </div>
                  <div className="col-span-2 flex justify-between gap-2">
                    <span className="shrink-0 text-muted-foreground">备注</span>
                    <span className="text-right">{data.remark || '-'}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>附件</SectionTitle>
              </CardHeader>
              <CardContent>
                <AttachmentField
                  resourceType="crm_lead"
                  resourceId={data.id}
                  usageHint="客户需求文档、沟通记录等"
                />
              </CardContent>
            </Card>
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => navigate('/crm?tab=leads')}>
                返回
              </Button>
            </div>
          </div>
        ) : null}
      </DataState>
    </PageShell>
  );
};

export default LeadDetailPage;
