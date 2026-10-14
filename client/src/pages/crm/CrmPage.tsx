import React from 'react';
import { useSearchParams } from 'react-router-dom';
import PageShell from '@client/src/components/PageShell';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import LeadsTab from './LeadsTab';
import OpportunitiesTab from './OpportunitiesTab';

const CrmPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'opportunities' ? 'opportunities' : 'leads';

  return (
    <PageShell
      title="线索与商机"
      description="线索登记与跟进；商机详情中管理多轮报价与项目资料（整页）"
    >
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              if (v === 'leads') next.delete('tab');
              else next.set('tab', v);
              return next;
            },
            { replace: true },
          );
        }}
      >
        <TabsList>
          <TabsTrigger value="leads">线索管理</TabsTrigger>
          <TabsTrigger value="opportunities">商机管理</TabsTrigger>
        </TabsList>
        <TabsContent value="leads">
          <LeadsTab />
        </TabsContent>
        <TabsContent value="opportunities">
          <OpportunitiesTab />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
};

export default CrmPage;
