import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
import ContractFormDialog from './ContractFormDialog';

const ContractCreatePage: React.FC = () => {
  const navigate = useNavigate();

  return (
    <PageShell
      title="登记合同"
      description="填写合同主体信息，保存后进入合同详情上传附件"
      actions={
        <Button variant="outline" onClick={() => navigate('/contracts')}>
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>
      }
    >
      <ContractFormDialog
        asPage
        open
        onCreated={(id) => navigate(`/contracts/${id}`, { replace: true })}
        onCancel={() => navigate('/contracts')}
      />
    </PageShell>
  );
};

export default ContractCreatePage;
