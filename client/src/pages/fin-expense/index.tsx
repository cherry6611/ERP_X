import React, { useState } from 'react';
import BudgetPanel from './components/BudgetPanel';
import ExpenseApplyPanel from './components/ExpenseApplyPanel';
import ExpenseClaimPanel from './components/ExpenseClaimPanel';

const FIN_EXPENSE_TABS = [
  { key: 'budgets', label: '预算' },
  { key: 'applies', label: '费用申请' },
  { key: 'claims', label: '报销单' },
] as const;

const FIN_EXPENSE_TAB_CONTENT: Record<string, React.ReactNode> = {
  budgets: <BudgetPanel />,
  applies: <ExpenseApplyPanel />,
  claims: <ExpenseClaimPanel />,
};

const FinExpensePage: React.FC = () => {
  const [tab, setTab] = useState<string>('budgets');

  return (
    <div className="p-6 flex flex-col gap-6" data-ai-section-type="card-list">
      <div>
        <h1 className="text-2xl font-semibold">预算费控</h1>
        <p className="text-sm text-muted-foreground mt-1">
          部门/项目/费用科目/期间多维预算、费用申请预占预算、报销审批联动应付与项目成本
        </p>
      </div>
      <div className="flex gap-2 flex-wrap">
        {FIN_EXPENSE_TABS.map((item) => (
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
      <div>{FIN_EXPENSE_TAB_CONTENT[tab]}</div>
    </div>
  );
};

export default FinExpensePage;
