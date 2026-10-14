import React, { useState } from 'react';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
import { cn } from '@client/src/lib/utils';
import AccountPanel from './components/AccountPanel';
import VoucherPanel from './components/VoucherPanel';
import PeriodPanel from './components/PeriodPanel';

const VOUCHER_TABS = [
  { key: 'vouchers', label: '凭证' },
  { key: 'accounts', label: '科目表' },
  { key: 'periods', label: '期间' },
] as const;

const TAB_CONTENT: Record<string, React.ReactNode> = {
  vouchers: <VoucherPanel />,
  accounts: <AccountPanel />,
  periods: <PeriodPanel />,
};

const VoucherPage: React.FC = () => {
  const [tab, setTab] = useState<string>('vouchers');

  return (
    <PageShell
      title="总账凭证"
      description="科目表维护、手工凭证编制与过账、期间试算平衡与结账管理"
    >
      <div className="flex gap-2 flex-wrap" data-ai-section-type="card-list">
        {VOUCHER_TABS.map((item) => (
          <Button
            key={item.key}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setTab(item.key)}
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
      <div>{TAB_CONTENT[tab]}</div>
    </PageShell>
  );
};

export default VoucherPage;
