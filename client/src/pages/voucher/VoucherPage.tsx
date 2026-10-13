import React, { useState } from 'react';
import PageShell from '@client/src/components/PageShell';
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
      <div>{TAB_CONTENT[tab]}</div>
    </PageShell>
  );
};

export default VoucherPage;
