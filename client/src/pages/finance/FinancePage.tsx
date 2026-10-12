import React, { useState } from 'react';
import PageShell from '@client/src/components/PageShell';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ArTab from './ArTab';
import ApTab from './ApTab';
import InvoicesTab from './InvoicesTab';
import AgingTab from './AgingTab';
import CashFlowTab from './CashFlowTab';

const FinancePage: React.FC = () => {
  const [tab, setTab] = useState('ar');
  return (
    <PageShell title="应收应付" description="应收与回款核销、应付与付款审批、发票登记与账龄分析">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="ar">应收与回款</TabsTrigger>
          <TabsTrigger value="ap">应付与付款</TabsTrigger>
          <TabsTrigger value="invoices">发票登记</TabsTrigger>
          <TabsTrigger value="aging">账龄分析</TabsTrigger>
          <TabsTrigger value="cashflow">现金流</TabsTrigger>
        </TabsList>
        <TabsContent value="ar">
          <ArTab />
        </TabsContent>
        <TabsContent value="ap">
          <ApTab />
        </TabsContent>
        <TabsContent value="invoices">
          <InvoicesTab />
        </TabsContent>
        <TabsContent value="aging">
          <AgingTab />
        </TabsContent>
        <TabsContent value="cashflow">
          <CashFlowTab />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
};

export default FinancePage;
