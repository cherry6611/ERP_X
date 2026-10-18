/*
 * 本面板现在**只负责展示**：期间 / 纳税主体 / 严重程度三个筛选在父页面的
 * `FilterBar`，「扫描」按钮在父页面的 `PageShell.actions`。
 * 因此 `useState` / `toast` / `reportsApi` / `getApiErrorMessage` /
 * `Button` / `Label` / `Select*` / 按钮图标 都不再需要 —— 留在这里会被 lint 报未使用。
 */
import React from 'react';
import { AlertTriangle } from 'lucide-react';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import { Badge } from '@client/src/components/ui/badge';
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
  /**
   * 期间由父页面（增值税底稿页）控制，保持与底稿同期。
   *
   * ⚠️ 本面板**不再自己持有** `period` 之外的任何状态，也**不持有操作按钮**：
   * 期间 / 纳税主体 / 严重程度三个筛选在父页面的 `FilterBar`，
   * 「扫描」在父页面的 `PageShell.actions`。本面板只消费 `result` 并展示。
   * 原因见下方组件注释「为什么把扫描状态提升到父页面」。
   */
  period: string;
  /** 已扫描的结果；`null` 表示尚未扫描 */
  result: TaxRiskScanResult | null;
  /** 严重程度筛选（父页面的 FilterBar 控制，本面板只消费） */
  severityFilter: string;
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
 *
 * ## 为什么把扫描状态提升到父页面（2026-10-17 改）
 *
 * 原来本面板自带「严重程度」下拉 + 「扫描」按钮，渲染在自己的标题行右侧。
 * 三个问题：
 *   ① **同一页两个主体口径**：父页面有「纳税主体」筛选（作用于底稿），
 *      而扫描只传了 `period` —— 使用者以为扫描也跟着筛，实际扫的是全主体。
 *   ② **筛选区不纯**：按钮长在筛选控件旁边，与外层 `FilterBar` 的语义冲突。
 *   ③ **主操作没有落位**：`PageShell` 有 `actions` 插槽（页头右侧主操作位），
 *      而这里的「扫描」才是本页主操作，却挤在面板标题行里（截图可见拥挤）。
 *
 * 现在：`period` / 纳税主体 / 严重程度 三个**筛选**都进 `FilterBar`，
 * 「扫描」进 `PageShell.actions`，本面板只负责**展示结果**。
 */
const TaxRiskPanel: React.FC<Props> = ({
  period,
  result,
  severityFilter,
}) => {
  const findings = (result?.findings ?? []).filter((item) =>
    severityFilter === 'all' ? true : item.severity === severityFilter,
  );

  return (
    <div className="flex flex-col gap-4">
      {/*
        ⚠️ 这里**不要**再加"点击扫描开始检查"的空态框。
        本文件下方（`{!result && …}`）已有一句同义提示，两处并存会出现
        **同一句话连显示两遍** —— 实测截图抓到过（提升按钮位置时误加）。
      */}

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


    </div>
  );
};

export default TaxRiskPanel;



