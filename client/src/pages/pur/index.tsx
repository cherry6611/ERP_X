import React, { useState } from 'react';
import PurRequestPanel from './components/PurRequestPanel';
import PurOrderPanel from './components/PurOrderPanel';
import PurChainPanel from './components/PurChainPanel';

const PUR_TABS = [
  { key: 'requests', label: '采购申请' },
  { key: 'orders', label: '采购订单' },
  { key: 'chain', label: '采购看板' },
] as const;

const PUR_TAB_CONTENT: Record<string, React.ReactNode> = {
  requests: <PurRequestPanel />,
  orders: <PurOrderPanel />,
  chain: <PurChainPanel />,
};

const PurPage: React.FC = () => {
  const [tab, setTab] = useState<string>('requests');

  return (
    <div className="p-6 flex flex-col gap-6" data-ai-section-type="card-list">
      <div>
        <h1 className="text-2xl font-semibold">采购管理</h1>
        <p className="text-sm text-muted-foreground mt-1">
          采购申请、采购订单与验收，联动应付、项目成本与资产入库的全链路管理
        </p>
      </div>
      <div className="flex gap-2 flex-wrap">
        {PUR_TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              tab === item.key
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-foreground/80 hover:bg-muted'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div>{PUR_TAB_CONTENT[tab]}</div>
    </div>
  );
};

export default PurPage;
