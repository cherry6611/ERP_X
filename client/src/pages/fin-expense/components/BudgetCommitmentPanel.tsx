import React, { useState } from 'react';
import { Badge } from '@client/src/components/ui/badge';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as budgetApi from '@client/src/api/fin-budget';
import { cn } from '@client/src/lib/utils';
import type {
  BudgetCommitmentSummary,
  BudgetCommitmentSummaryRow,
  CommitmentGapRow,
} from '@shared/api.interface';

const SOURCE_LABELS: Record<CommitmentGapRow['sourceType'], string> = {
  purchase_order: '采购订单',
  contract: '合同',
  expense_apply: '费用申请',
};

function money(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * C-09：预算承诺与「三算对比」面板。
 *
 * 为什么要有「承诺」这一列：已签合同/已下采购单的钱虽然还没花，
 * 但已经不能再挪用。只看"预算 vs 已执行"会让预算看着还有余额，
 * 实际一付款就超支。因此本表把**承诺+实际**合并判断超支，
 * 并对「仅承诺就已超预算」单独打红标（说明签约阶段就失控了）。
 *
 * 另外单列「无预算覆盖的承诺」：这类承诺在三算表里根本不会出现
 * （没有匹配的预算行），却是最容易漏管的一类。
 */
const BudgetCommitmentPanel: React.FC = () => {
  const [period, setPeriod] = useState<string>('');
  const scope = period || undefined;

  const { data, loading, error, reload } =
    useAsyncData<BudgetCommitmentSummary>(
      () => budgetApi.getCommitments(scope),
      [period],
    );
  const { data: gaps } = useAsyncData<CommitmentGapRow[]>(
    () => budgetApi.getCommitmentGaps(scope),
    [period],
  );

  const rows: BudgetCommitmentSummaryRow[] = data?.rows ?? [];
  const totals = data?.totals;
  const gapRows = gaps ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          承诺 = 已批准采购订单 + 已生效合同（不含税净额）+ 待批费用申请；
          实际 = 已批准报销 + 已批准费用申请。
          可用余额 = 预算 − 承诺 − 实际，为负说明已经超支（即使尚未付款）。
        </p>
        <div className="grid gap-1">
          <Label htmlFor="commitment-period" className="text-xs">
            期间（留空看全部）
          </Label>
          <Input
            id="commitment-period"
            className="w-36"
            value={period}
            placeholder="2026-10"
            onChange={(event) => setPeriod(event.target.value)}
          />
        </div>
      </div>

      {totals && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="预算合计" value={money(totals.budgetAmount)} />
          <StatCard
            label="承诺合计"
            value={money(totals.committedAmount)}
            tone="warning"
          />
          <StatCard label="实际合计" value={money(totals.actualAmount)} />
          <StatCard
            label="可用余额合计"
            value={money(totals.availableAmount)}
            tone={totals.availableAmount < 0 ? 'warning' : 'success'}
          />
        </div>
      )}

      <DataBoundary
        loading={loading}
        error={error}
        empty={rows.length === 0}
        emptyText="暂无预算数据，请先在「预算」页维护预算行"
        onRetry={reload}
      >
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th className="p-2 font-medium">期间</th>
                <th className="p-2 font-medium">部门</th>
                <th className="p-2 font-medium">项目</th>
                <th className="p-2 font-medium">费用类别</th>
                <th className="p-2 text-right font-medium">预算</th>
                <th className="p-2 text-right font-medium">承诺</th>
                <th className="p-2 text-right font-medium">实际</th>
                <th className="p-2 text-right font-medium">可用余额</th>
                <th className="p-2 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.period}-${row.departmentId ?? '-'}-${row.projectId ?? '-'}-${row.expenseCategory}`}
                  className={cn(
                    'border-t',
                    row.overCommitted && 'bg-destructive/5',
                  )}
                >
                  <td className="p-2">{row.period}</td>
                  <td className="p-2">{row.departmentName ?? '不限'}</td>
                  <td className="p-2">{row.projectName ?? '不限'}</td>
                  <td className="p-2">{row.expenseCategory || '—'}</td>
                  <td className="p-2 text-right tabular-nums">
                    {money(row.budgetAmount)}
                  </td>
                  <td className="p-2 text-right tabular-nums text-amber-700">
                    {money(row.committedAmount)}
                  </td>
                  <td className="p-2 text-right tabular-nums">
                    {money(row.actualAmount)}
                  </td>
                  <td
                    className={cn(
                      'p-2 text-right tabular-nums',
                      row.availableAmount < 0 && 'font-medium text-destructive',
                    )}
                  >
                    {money(row.availableAmount)}
                  </td>
                  <td className="p-2">
                    {row.commitmentAloneExceedsBudget ? (
                      <Badge variant="destructive">承诺即超预算</Badge>
                    ) : row.overCommitted ? (
                      <Badge variant="destructive">已超支</Badge>
                    ) : row.availableAmount < row.budgetAmount * 0.1 ? (
                      <Badge variant="secondary">接近上限</Badge>
                    ) : (
                      <Badge variant="outline">正常</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataBoundary>

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-base font-semibold">无预算覆盖的承诺</h3>
          <p className="text-sm text-muted-foreground">
            这些承诺在三算表里不会出现（没有匹配的预算行），最容易漏管：
            请补录对应期间的预算或调整承诺来源。
          </p>
        </div>
        {gapRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            没有发现无预算覆盖的承诺。
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-2 font-medium">来源</th>
                  <th className="p-2 font-medium">单据编号</th>
                  <th className="p-2 font-medium">内容</th>
                  <th className="p-2 font-medium">期间</th>
                  <th className="p-2 font-medium">状态</th>
                  <th className="p-2 text-right font-medium">金额</th>
                </tr>
              </thead>
              <tbody>
                {gapRows.map((gap) => (
                  <tr key={`${gap.sourceType}-${gap.sourceId}`} className="border-t">
                    <td className="p-2">{SOURCE_LABELS[gap.sourceType]}</td>
                    <td className="p-2 font-mono text-xs">
                      {gap.sourceCode || '—'}
                    </td>
                    <td className="p-2">{gap.sourceTitle}</td>
                    <td className="p-2">{gap.period}</td>
                    <td className="p-2">{gap.status}</td>
                    <td className="p-2 text-right tabular-nums">
                      {money(gap.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default BudgetCommitmentPanel;
