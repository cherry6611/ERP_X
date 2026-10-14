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
import { hrApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import HrStatusBadge, {
  LEAVE_STATUS_LABELS,
  LEAVE_TYPE_LABELS,
} from './components/HrStatusBadge';
import type { LeaveRequest } from '@shared/api.interface';

const LeaveRequestDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const stateItem = (location.state as { item?: LeaveRequest } | null)?.item;

  const { data, loading, error } = useAsyncData<LeaveRequest | null>(
    async () => {
      if (!id) return null;
      if (stateItem?.id === id) return stateItem;
      const list = await hrApi.listLeaveRequests();
      return list.find((item) => item.id === id) ?? null;
    },
    [id, stateItem],
  );

  usePageEntityName(data ? data.code : null);

  return (
    <PageShell
      title={data ? `请假 · ${data.code}` : '请假详情'}
      actions={
        <Button
          variant="outline"
          onClick={() => navigate('/hr?tab=attendance')}
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
        emptyText="请假单不存在或已删除"
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
                    <span className="text-muted-foreground">员工：</span>
                    {data.employeeName}
                  </p>
                  <p>
                    <span className="text-muted-foreground">类型：</span>
                    {LEAVE_TYPE_LABELS[data.leaveType] ?? data.leaveType}
                  </p>
                  <p>
                    <span className="text-muted-foreground">开始日期：</span>
                    {data.startDate}
                  </p>
                  <p>
                    <span className="text-muted-foreground">结束日期：</span>
                    {data.endDate}
                  </p>
                  <p>
                    <span className="text-muted-foreground">天数：</span>
                    {data.days}
                  </p>
                  <p className="flex items-center gap-2">
                    <span className="text-muted-foreground">状态：</span>
                    <HrStatusBadge status={data.status} labels={LEAVE_STATUS_LABELS} />
                  </p>
                </div>
                <p>
                  <span className="text-muted-foreground">事由：</span>
                  {data.reason ?? '-'}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>附件</SectionTitle>
              </CardHeader>
              <CardContent>
                <AttachmentField
                  resourceType="hr_leave_request"
                  resourceId={data.id}
                  usageHint="病假条、请假证明材料等"
                />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DataState>
    </PageShell>
  );
};

export default LeaveRequestDetailPage;
