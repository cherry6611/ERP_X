import React from 'react';
import PageShell from '@client/src/components/PageShell';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import LeadsTab from './LeadsTab';
import OpportunitiesTab from './OpportunitiesTab';
import QuotationsTab from './QuotationsTab';

const CrmPage: React.FC = () => (
  <PageShell
    title="线索与商机"
    description="线索登记与跟进、商机阶段推进、报价单管理、赢单转合同"
  >
    <Tabs defaultValue="leads">
      <TabsList>
        <TabsTrigger value="leads">线索管理</TabsTrigger>
        <TabsTrigger value="opportunities">商机管理</TabsTrigger>
        <TabsTrigger value="quotations">报价单</TabsTrigger>
      </TabsList>
      <TabsContent value="leads">
        <LeadsTab />
      </TabsContent>
      <TabsContent value="opportunities">
        <OpportunitiesTab />
      </TabsContent>
      <TabsContent value="quotations">
        <QuotationsTab />
      </TabsContent>
    </Tabs>
  </PageShell>
);

export default CrmPage;
