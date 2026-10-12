import React, { useState } from 'react';
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
    <div className="p-6 flex flex-col gap-6" data-ai-section-type="card-list">
      <div>
        <h1 className="text-2xl font-semibold">总账凭证</h1>
        <p className="text-sm text-muted-foreground mt-1">
          科目表维护、手工凭证编制与过账、期间试算平衡与结账管理
        </p>
      </div>
      <div className="flex gap-2 flex-wrap">
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
    </div>
  );
};

export default VoucherPage;
