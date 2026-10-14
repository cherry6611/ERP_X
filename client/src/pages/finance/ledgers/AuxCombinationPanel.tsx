import React, { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Layers, RefreshCw } from 'lucide-react';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as reportsApi from '@client/src/api/finance-reports';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { cn } from '@client/src/lib/utils';
import type {
  AuxAllocationPreview,
  AuxCrossDimensionResult,
  AuxMultiDimensionBalance,
} from '@shared/api.interface';

function money(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

interface Props {
  period: string;
}

/**
 * D-03：辅助核算深化面板。
 *
 * ## 三个能力，以及为什么这样呈现
 *
 * 1. **多维度组合账**：回答"研发部在 A 项目上花了多少"。
 *    关键设计是**必须同时展示覆盖度** —— 组合金额之和通常小于科目总额
 *    （部分分录只挂了部分维度）。只给组合表不给覆盖率，等于给使用者一份
 *    看似完整实则缺口的表，比不提供更危险。
 * 2. **跨维度结构对比**：占比以**本维度合计**为分母，不是全局合计 ——
 *    否则小部门占比永远接近 0，看不出结构。
 * 3. **成本分摊试算**：用最大余数法保证分摊额之和严格等于总额。
 *    界面上显式展示"分摊额合计"与"被分摊总额"是否一致，并把被补齐的
 *    项数（`adjustedCount`）告诉使用者，让尾差去向可解释。
 */
const AuxCombinationPanel: React.FC<Props> = ({ period }) => {
  const [dimensionInput, setDimensionInput] = useState('department,project');
  const [accountCode, setAccountCode] = useState('');
  const [combination, setCombination] = useState<AuxMultiDimensionBalance | null>(
    null,
  );
  const [cross, setCross] = useState<AuxCrossDimensionResult | null>(null);
  const [loading, setLoading] = useState(false);

  // 分摊试算
  const [allocAmount, setAllocAmount] = useState('1000');
  const [allocWeights, setAllocWeights] = useState('1,2,3');
  const [allocPreview, setAllocPreview] =
    useState<AuxAllocationPreview | null>(null);
  const [allocLoading, setAllocLoading] = useState(false);

  const { data: dimensions } = useAsyncData(
    () => reportsApi.listAuxDimensions(),
    [],
  );
  const dimensionList = dimensions ?? [];

  const dimensionCodes = dimensionInput
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const runCombination = async () => {
    if (dimensionCodes.length === 0) {
      toast.error('请至少填写一个维度编码');
      return;
    }
    setLoading(true);
    try {
      const result = await reportsApi.getAuxCombination({
        period,
        dimensions: dimensionCodes,
        accountCode: accountCode || undefined,
      });
      setCombination(result);
      if (!result.coverage.complete) {
        toast.warning(result.coverage.message);
      } else {
        toast.success(`组合分析完成，覆盖度 ${result.coverage.coverageRate}%`);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, '组合分析失败'));
    } finally {
      setLoading(false);
    }
  };

  const runCrossDimension = async () => {
    if (dimensionCodes.length === 0) {
      toast.error('请至少填写一个维度编码');
      return;
    }
    setLoading(true);
    try {
      setCross(
        await reportsApi.getAuxCrossDimension({
          period,
          dimensions: dimensionCodes,
          accountCode: accountCode || undefined,
        }),
      );
    } catch (err) {
      toast.error(getApiErrorMessage(err, '结构对比失败'));
    } finally {
      setLoading(false);
    }
  };

  const runAllocation = async () => {
    const amount = Number(allocAmount);
    const weights = allocWeights
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((value) => Number.isFinite(value));
    if (!Number.isFinite(amount)) {
      toast.error('待分摊总额必须为数值');
      return;
    }
    if (weights.length === 0) {
      toast.error('请填写分摊权重（逗号分隔）');
      return;
    }
    setAllocLoading(true);
    try {
      const result = await reportsApi.previewAuxAllocation({ amount, weights });
      setAllocPreview(result);
      const balanced = result.sharesSum === result.amount;
      if (balanced) {
        toast.success(
          `分摊试算完成；合计 ${money(result.sharesSum)} 与被分摊总额一致` +
            (result.adjustedCount > 0
              ? `（${result.adjustedCount} 项因四舍五入被补齐 1 分）`
              : ''),
        );
      } else {
        toast.error('分摊合计与总额不一致，请勿使用该结果');
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, '分摊试算失败'));
    } finally {
      setAllocLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-base font-semibold">辅助核算深化（D-03）</h3>
        <p className="text-sm text-muted-foreground">
          多维度组合账、跨维度结构对比、按维度权重分摊。维度编码见下方已启用维度；
          最多同时组合 3 个维度（组合数按维度数指数增长）。
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/30 p-3">
        <div className="grid gap-1">
          <Label className="text-xs">维度（逗号分隔，最多 3 个）</Label>
          <Input
            className="w-72"
            value={dimensionInput}
            placeholder="department,project"
            onChange={(event) => setDimensionInput(event.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">科目前缀（可选，如 6602）</Label>
          <Input
            className="w-40"
            value={accountCode}
            placeholder="全部科目"
            onChange={(event) => setAccountCode(event.target.value)}
          />
        </div>
        <Button type="button" disabled={loading} onClick={() => void runCombination()}>
          {loading ? (
            <RefreshCw className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Layers className="mr-1 h-4 w-4" />
          )}
          组合分析 {period}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={() => void runCrossDimension()}
        >
          跨维度结构对比
        </Button>
      </div>

      {dimensionList.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>已启用维度：</span>
          {dimensionList
            .filter((item) => item.enabled)
            .map((item) => (
              <button
                key={item.code}
                type="button"
                className="rounded bg-muted px-1.5 py-0.5 hover:bg-muted/70"
                onClick={() => {
                  const next = [...new Set([...dimensionCodes, item.code])];
                  setDimensionInput(next.slice(0, 3).join(','));
                }}
              >
                {item.name}（{item.code}）
              </button>
            ))}
        </div>
      )}

      {combination && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="组合数" value={String(combination.cells.length)} />
            <StatCard
              label="已覆盖净额"
              value={money(combination.covered.balance)}
              tone="info"
            />
            <StatCard
              label="未覆盖净额"
              value={money(combination.uncovered.balance)}
              tone={combination.uncovered.balance !== 0 ? 'warning' : 'neutral'}
            />
            <StatCard
              label="覆盖度"
              value={`${combination.coverage.coverageRate}%`}
              tone={combination.coverage.complete ? 'success' : 'warning'}
            />
          </div>

          {!combination.coverage.complete && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
              <p className="text-sm text-amber-900">
                {combination.coverage.message}
              </p>
            </div>
          )}

          <DataBoundary
            loading={false}
            error={null}
            empty={combination.cells.length === 0}
            emptyText="所选维度组合下没有已挂全维度的分录"
          >
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    {combination.dimensionNames.map((name) => (
                      <th key={name} className="p-2 font-medium">
                        {name}
                      </th>
                    ))}
                    <th className="p-2 text-right font-medium">借方</th>
                    <th className="p-2 text-right font-medium">贷方</th>
                    <th className="p-2 text-right font-medium">净额</th>
                    <th className="p-2 text-right font-medium">行数</th>
                  </tr>
                </thead>
                <tbody>
                  {combination.cells.map((cell) => (
                    <tr key={cell.key} className="border-t">
                      {cell.values.map((value) => (
                        <td key={value.dimensionCode} className="p-2">
                          {value.dimensionValue ?? value.dimensionId ?? '（未指定）'}
                        </td>
                      ))}
                      <td className="p-2 text-right tabular-nums">
                        {money(cell.debit)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {money(cell.credit)}
                      </td>
                      <td
                        className={cn(
                          'p-2 text-right tabular-nums',
                          cell.balance < 0 && 'text-destructive',
                        )}
                      >
                        {money(cell.balance)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {cell.lineCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </DataBoundary>
        </div>
      )}

      {cross && (
        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-semibold">跨维度结构对比</h4>
          <div className="grid gap-4 lg:grid-cols-2">
            {cross.totalsByDimension.map((total) => (
              <div key={total.dimensionCode} className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{total.dimensionName}</span>
                  <span className="tabular-nums text-muted-foreground">
                    合计 {money(total.total)}（{total.valueCount} 项）
                  </span>
                </div>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr className="text-left">
                        <th className="p-2 font-medium">取值</th>
                        <th className="p-2 text-right font-medium">净额</th>
                        <th className="p-2 text-right font-medium">占本维度</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cross.rows
                        .filter((row) => row.dimensionCode === total.dimensionCode)
                        .map((row) => (
                          <tr
                            key={`${row.dimensionCode}-${row.dimensionValue}`}
                            className="border-t"
                          >
                            <td className="p-2">{row.dimensionValue}</td>
                            <td className="p-2 text-right tabular-nums">
                              {money(row.balance)}
                            </td>
                            <td className="p-2 text-right tabular-nums">
                              {row.shareOfDimension.toFixed(2)}%
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            占比分母是**本维度合计**而非全局合计 —— 否则小部门占比永远接近 0，
            看不出结构。
          </p>
        </div>
      )}

      {/* 成本分摊试算 */}
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div>
          <h4 className="text-sm font-semibold">成本分摊试算</h4>
          <p className="text-xs text-muted-foreground">
            按权重分摊金额，采用最大余数法保证**分摊额之和严格等于总额**
            （否则凭证借贷不平，总账与明细账永远对不上）。只算不落库。
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label className="text-xs">待分摊总额</Label>
            <Input
              className="w-36"
              inputMode="decimal"
              value={allocAmount}
              onChange={(event) => setAllocAmount(event.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">权重（逗号分隔）</Label>
            <Input
              className="w-48"
              value={allocWeights}
              onChange={(event) => setAllocWeights(event.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={allocLoading}
            onClick={() => void runAllocation()}
          >
            {allocLoading ? '试算中…' : '试算分摊'}
          </Button>
        </div>

        {allocPreview && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <StatCard
                label="分摊额合计"
                value={money(allocPreview.sharesSum)}
                tone={
                  allocPreview.sharesSum === allocPreview.amount
                    ? 'success'
                    : 'warning'
                }
              />
              <StatCard label="被分摊总额" value={money(allocPreview.amount)} />
              <div className="flex flex-col gap-1">
                <Badge
                  variant={
                    allocPreview.sharesSum === allocPreview.amount
                      ? 'default'
                      : 'destructive'
                  }
                >
                  {allocPreview.sharesSum === allocPreview.amount
                    ? '合计一致'
                    : '合计不一致'}
                </Badge>
                {allocPreview.adjustedCount > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {allocPreview.adjustedCount} 项因四舍五入被补齐 1 分
                  </span>
                )}
                {allocPreview.equalFallback && (
                  <span className="text-xs text-amber-700">
                    权重全为 0，已按平均分摊
                  </span>
                )}
              </div>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-2 font-medium">分摊对象</th>
                    <th className="p-2 text-right font-medium">权重</th>
                    <th className="p-2 text-right font-medium">分摊额</th>
                    <th className="p-2 text-right font-medium">不含税（可选）</th>
                  </tr>
                </thead>
                <tbody>
                  {allocPreview.lines.map((line) => (
                    <tr key={line.target} className="border-t">
                      <td className="p-2">{line.target}</td>
                      <td className="p-2 text-right tabular-nums">{line.weight}</td>
                      <td className="p-2 text-right tabular-nums">
                        {money(line.share)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {line.netShare === null ? '—' : money(line.netShare)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default AuxCombinationPanel;
