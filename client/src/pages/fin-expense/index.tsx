import React from 'react';
import { useSearchParams } from 'react-router-dom';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
import { cn } from '@client/src/lib/utils';
import BudgetPanel from './components/BudgetPanel';
import BudgetCommitmentPanel from './components/BudgetCommitmentPanel';
import FullBudgetPanel from './components/FullBudgetPanel';
import ExpenseApplyPanel from './components/ExpenseApplyPanel';
import ExpenseClaimPanel from './components/ExpenseClaimPanel';

const FIN_EXPENSE_TABS = [
  { key: 'budgets', label: '预算' },
  // C-09：预算 − 承诺 − 实际 三算对比（承诺=已签合同/已下采购单/待批申请）
  { key: 'commitments', label: '三算对比' },
  // D-05：全面预算（收入/资本预算 + 滚动预测 + 差异分析）
  { key: 'full-budget', label: '全面预算' },
  { key: 'applies', label: '费用申请' },
  { key: 'claims', label: '报销单' },
] as const;

const TAB_SET = new Set(FIN_EXPENSE_TABS.map((t) => t.key));

const FIN_EXPENSE_TAB_CONTENT: Record<string, React.ReactNode> = {
  budgets: <BudgetPanel />,
  commitments: <BudgetCommitmentPanel />,
  'full-budget': <FullBudgetPanel />,
  applies: <ExpenseApplyPanel />,
  claims: <ExpenseClaimPanel />,
};

const FinExpensePage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? 'budgets';
  const tab = TAB_SET.has(raw as (typeof FIN_EXPENSE_TABS)[number]['key'])
    ? raw
    : 'budgets';

  return (
    <PageShell
      title="预算费控"
      description="部门/项目/费用科目/期间多维预算、费用申请预占预算、报销审批联动应付与项目成本"
    >
      <div className="flex gap-2 flex-wrap" data-ai-section-type="card-list">
        {FIN_EXPENSE_TABS.map((item) => (
          <Button
            key={item.key}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  if (item.key === 'budgets') next.delete('tab');
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
      <div>{FIN_EXPENSE_TAB_CONTENT[tab]}</div>
    </PageShell>
  );
};

export default FinExpensePage;
