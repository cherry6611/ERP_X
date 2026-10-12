import React, { useState } from 'react';
import PageShell from '@client/src/components/PageShell';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import RevenuesTab from './RevenuesTab';
import UnbilledTab from './UnbilledTab';
import AdjustmentsTab from './AdjustmentsTab';

const RevenuePage: React.FC = () => {
  const [tab, setTab] = useState('items');
  return (
    <PageShell title="收入确认" description="按里程碑/进度确认收入、未开票收入台账、收入调整">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="items">收入台账</TabsTrigger>
          <TabsTrigger value="unbilled">未开票收入</TabsTrigger>
          <TabsTrigger value="adjustments">收入调整</TabsTrigger>
        </TabsList>
        <TabsContent value="items">
          <RevenuesTab />
        </TabsContent>
        <TabsContent value="unbilled">
          <UnbilledTab />
        </TabsContent>
        <TabsContent value="adjustments">
          <AdjustmentsTab />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
};

export default RevenuePage;
