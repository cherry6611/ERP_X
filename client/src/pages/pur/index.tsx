import React from 'react';
import { useSearchParams } from 'react-router-dom';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
import { cn } from '@client/src/lib/utils';
import PurRequestPanel from './components/PurRequestPanel';
import PurOrderPanel from './components/PurOrderPanel';
import PurChainPanel from './components/PurChainPanel';

const PUR_TABS = [
  { key: 'requests', label: '采购申请' },
  { key: 'orders', label: '采购订单' },
  { key: 'chain', label: '采购看板' },
] as const;

const TAB_SET = new Set(PUR_TABS.map((t) => t.key));

const PUR_TAB_CONTENT: Record<string, React.ReactNode> = {
  requests: <PurRequestPanel />,
  orders: <PurOrderPanel />,
  chain: <PurChainPanel />,
};

const PurPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? 'requests';
  const tab = TAB_SET.has(raw as (typeof PUR_TABS)[number]['key'])
    ? raw
    : 'requests';

  return (
    <PageShell
      title="采购管理"
      description="采购申请、采购订单与验收，联动应付、项目成本与资产入库的全链路管理"
    >
      <div className="flex gap-2 flex-wrap" data-ai-section-type="card-list">
        {PUR_TABS.map((item) => (
          <Button
            key={item.key}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  if (item.key === 'requests') next.delete('tab');
                  else next.set('tab', item.key);
                  return next;
                },
                { replace: true },
              );
            }}
            className={cn(
              tab === item.key
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-foreground/80',
            )}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <div>{PUR_TAB_CONTENT[tab]}</div>
    </PageShell>
  );
};

export default PurPage;
