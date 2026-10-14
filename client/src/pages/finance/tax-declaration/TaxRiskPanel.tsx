import React, { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import * as reportsApi from '@client/src/api/finance-reports';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { cn } from '@client/src/lib/utils';
import type {
  TaxRiskCategory,
  TaxRiskScanResult,
  TaxRiskSeverity,
} from '@shared/api.interface';

const SEVERITY_LABELS: Record<TaxRiskSeverity, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

const SEVERITY_STYLE: Record<TaxRiskSeverity, string> = {
  high: 'border-destructive/50 bg-destructive/5',
  medium: 'border-amber-300 bg-amber-50',
  low: 'border-border bg-muted/40',
};

const CATEGORY_LABELS: Record<TaxRiskCategory, string> = {
  burden_rate: '税负率异常',
  invoice_ledger_mismatch: '进销项匹配异常',
  invoice_anomaly: '发票异常',
};

function money(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

interface Props {
  /** 期间由父页面（增值税底稿页）控制，保持与底稿同期 */
  period: string;
}

/**
 * D-06：税务风险扫描面板。
 *
 * ## 这个面板要传达的核心信息
 *
 * 系统**不做合规判定**，只做偏差检测 —— 税负率是否异常高度依赖行业，
 * 系统无法自己下结论。因此面板必须同时展示：
 *   1. 判定依据（阈值来自 `sys_param`，界面显式列出，不是黑盒）；
 *   2. 每条风险的**具体数字**（可复核，而不是"系统觉得有问题"）；
 *   3. 建议的下一步动作 —— 风险清单的价值在于"告诉人去查什么"。
 *
 * 另外必须诚实展示 `skipped`：某个扫描方向取数失败时，报告里要能看到
 * "这一段没跑成功"，而不是让人误以为"没报就是没问题"。
 */
const TaxRiskPanel: React.FC<Props> = ({ period }) => {
  const [result, setResult] = useState<TaxRiskScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<string>('all');

  const runScan = async () => {
    setLoading(true);
    try {
      const data = await reportsApi.scanTaxRisk({ period });
      setResult(data);
      if (data.totalFindings === 0) {
        toast.success(`${period} 未发现税务风险线索`);
      } else {
        toast.warning(
          `${period} 发现 ${data.totalFindings} 条线索（高 ${data.bySeverity.high} / 中 ${data.bySeverity.medium} / 低 ${data.bySeverity.low}）`,
        );
      }
      if (data.skipped.length > 0) {
        toast.warning(`有 ${data.skipped.length} 个扫描方向未完成，详见面板提示`);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, '扫描失败'));
    } finally {
      setLoading(false);
    }
  };

  const findings = (result?.findings ?? []).filter((item) =>
    severityFilter === 'all' ? true : item.severity === severityFilter,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">税务风险扫描（D-06）</h3>
          <p className="text-sm text-muted-foreground">
            扫描三个方向：税负率异常、进销项匹配异常、发票异常。
            系统只做偏差检测与线索归纳，**不做合规判定** —— 阈值可按贵司行业调整。
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="grid gap-1">
            <Label className="text-xs">严重程度</Label>
            <Select value={severityFilter} onValueChange={setSeverityFilter}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="high">仅高风险</SelectItem>
                <SelectItem value="medium">仅中风险</SelectItem>
                <SelectItem value="low">仅低风险</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="button" disabled={loading} onClick={() => void runScan()}>
            {loading ? (
              <>
                <RefreshCw className="mr-1 h-4 w-4 animate-spin" />
                扫描中…
              </>
            ) : (
              <>
                <ShieldCheck className="mr-1 h-4 w-4" />
                扫描 {period}
              </>
            )}
          </Button>
        </div>
      </div>

      {result && (
        <div className="flex flex-col gap-4">
          {/* 阈值口径：显式展示，避免"黑盒判定" */}
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            判定口径（可在「设置 → 参数」调整）：
            税负率参考区间 {result.thresholds.burdenRateMin}%~{result.thresholds.burdenRateMax}%，
            环比波动阈值 ±{result.thresholds.burdenRateFluctuation} 个百分点，
            作废率阈值 {result.thresholds.voidRateThreshold}%。
            {result.taxEntityName && ` 纳税主体：${result.taxEntityName}。`}
          </div>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatCard
              label="风险线索"
              value={String(result.totalFindings)}
              tone={
                result.bySeverity.high > 0
                  ? 'warning'
                  : result.totalFindings > 0
                    ? 'info'
                    : 'success'
              }
            />
            <StatCard
              label="高风险"
              value={String(result.bySeverity.high)}
              tone={result.bySeverity.high > 0 ? 'warning' : 'neutral'}
            />
            <StatCard label="中风险" value={String(result.bySeverity.medium)} />
            <StatCard label="涉及金额" value={money(result.totalAmountInvolved)} />
            <StatCard
              label="本期税负率"
              value={
                result.burdenRate ? `${result.burdenRate.rate.toFixed(2)}%` : '—'
              }
              tone={
                result.burdenRate?.withinRange === false ? 'warning' : 'success'
              }
            />
          </div>

          {result.burdenRate && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
              <span>
                不含税收入：
                <span className="text-foreground">
                  {money(result.burdenRate.revenue)}
                </span>
              </span>
              <span>
                销项：
                <span className="text-foreground">
                  {money(result.burdenRate.outputTax)}
                </span>
              </span>
              <span>
                进项：
                <span className="text-foreground">
                  {money(result.burdenRate.inputTax)}
                </span>
              </span>
              <span>
                应交增值税：
                <span
                  className={cn(
                    'text-foreground',
                    result.burdenRate.payableTax < 0 && 'text-amber-700',
                  )}
                >
                  {money(result.burdenRate.payableTax)}
                </span>
              </span>
              <span>
                底稿勾稽：
                <span
                  className={
                    result.reconciled ? 'text-emerald-600' : 'text-destructive'
                  }
                >
                  {result.reconciled ? '发票口径与总账口径一致' : '存在差异'}
                </span>
              </span>
            </div>
          )}

          {result.skipped.length > 0 && (
            <div className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-900">
                <AlertTriangle className="mr-1 inline h-4 w-4" />
                以下扫描方向未完成（结果不完整，不代表没有问题）
              </p>
              {result.skipped.map((item) => (
                <p key={item} className="text-xs text-amber-800">
                  · {item}
                </p>
              ))}
            </div>
          )}

          <DataBoundary
            loading={false}
            error={null}
            empty={findings.length === 0}
            emptyText={
              result.skipped.length > 0
                ? '当前筛选下无风险线索（但扫描不完整，请先处理上面的告警）'
                : '未发现税务风险线索'
            }
          >
            <div className="flex flex-col gap-3">
              {findings.map((item) => (
                <div
                  key={item.code}
                  className={cn('flex flex-col gap-2 rounded-lg border p-4', SEVERITY_STYLE[item.severity])}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        item.severity === 'high'
                          ? 'destructive'
                          : item.severity === 'medium'
                            ? 'secondary'
                            : 'outline'
                      }
                    >
                      {SEVERITY_LABELS[item.severity]}风险
                    </Badge>
                    <span className="text-sm font-medium">{item.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {CATEGORY_LABELS[item.category]}
                    </span>
                    {item.amount !== null && (
                      <span className="ml-auto text-sm tabular-nums">
                        {money(item.amount)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    依据：{item.evidence}
                  </p>
                  <p className="text-xs text-foreground/80">
                    建议：{item.suggestion}
                  </p>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {item.code}
                  </p>
                </div>
              ))}
            </div>
          </DataBoundary>

          <p className="text-xs text-muted-foreground">
            扫描时间：{new Date(result.generatedAt).toLocaleString('zh-CN')}
          </p>
        </div>
      )}

      {!result && (
        <p className="text-sm text-muted-foreground">
          点击「扫描 {period}」开始检查。建议在提交增值税申报前跑一次，
          逐条确认后归档。
        </p>
      )}
    </div>
  );
};

export default TaxRiskPanel;
