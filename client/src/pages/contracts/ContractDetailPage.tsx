import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import { usePageEntityName } from '@client/src/components/page-meta';
import { Button } from '@client/src/components/ui/button';
import { contractsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import type { ContractDetail } from '@shared/api.interface';
import ContractDetailDialog from './ContractDetailDialog';

const ContractDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data } = useAsyncData<ContractDetail | null>(
    () => (id ? contractsApi.getContract(id) : Promise.resolve(null)),
    [id],
  );

  usePageEntityName(data ? `${data.code} ${data.name}` : null);

  return (
    <PageShell
      title={data ? `合同详情 · ${data.code}` : '合同详情'}
      description={data?.name}
      actions={
        <Button variant="outline" onClick={() => navigate('/contracts')}>
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>
      }
    >
      <ContractDetailDialog asPage contractId={id ?? null} open />
    </PageShell>
  );
};

export default ContractDetailPage;
