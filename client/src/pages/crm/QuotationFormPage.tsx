import React from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import { Button } from '@client/src/components/ui/button';
import { crmApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import QuotationFormDialog from './QuotationFormDialog';
import type { OpportunityDetail, Quotation } from '@shared/api.interface';

const QuotationFormPage: React.FC = () => {
  const { id: quotationId, opportunityId: routeOppId } = useParams<{
    id?: string;
    opportunityId?: string;
  }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const isEdit = Boolean(quotationId);

  const oppId = routeOppId ?? params.get('opportunityId') ?? undefined;

  const { data: editTarget, loading: editLoading, error: editError } =
    useAsyncData<Quotation | null>(
      () => (isEdit ? crmApi.getQuotation(quotationId!) : Promise.resolve(null)),
      [quotationId, isEdit],
    );

  const { data: opportunity } = useAsyncData<OpportunityDetail | null>(
    () => (oppId ? crmApi.getOpportunity(oppId) : Promise.resolve(null)),
    [oppId],
  );

  const backTo =
    opportunity?.id
      ? `/crm/opportunities/${opportunity.id}`
      : editTarget?.opportunityId
        ? `/crm/opportunities/${editTarget.opportunityId}`
        : '/crm?tab=opportunities';

  const onSaved = (saved: Quotation) => {
    if (saved.opportunityId) {
      navigate(`/crm/opportunities/${saved.opportunityId}`, { replace: true });
    } else {
      navigate(`/crm/quotations/${saved.id}`, { replace: true });
    }
  };

  return (
    <PageShell
      title={isEdit ? '编辑报价单' : '新增一轮报价'}
      description={
        opportunity
          ? `商机：${opportunity.code} · ${opportunity.title}`
          : '填写报价明细后保存'
      }
      actions={
        <Button variant="outline" onClick={() => navigate(backTo)}>
          <ArrowLeft className="h-4 w-4" />
          返回
        </Button>
      }
    >
      <DataState
        loading={isEdit && editLoading}
        error={editError}
        skeleton="default"
      >
        {!isEdit || editTarget ? (
          <QuotationFormDialog
            asPage
            open
            editTarget={editTarget}
            preset={
              !isEdit
                ? {
                    customerId: opportunity?.customerId,
                    opportunityId: opportunity?.id ?? oppId,
                    title: opportunity
                      ? `${opportunity.title} · 第${(opportunity.quotationCount ?? 0) + 1}轮报价`
                      : undefined,
                  }
                : undefined
            }
            onSaved={onSaved}
            onCancel={() => navigate(backTo)}
          />
        ) : null}
      </DataState>
    </PageShell>
  );
};

export default QuotationFormPage;
