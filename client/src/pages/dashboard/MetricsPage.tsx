import React, { useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import {
  FieldLabel,
  useFieldId,
} from '@client/src/components/erp/FieldLabel';
import { Explained } from '@client/src/components/erp/ItemHelp';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as biApi from '@client/src/api/bi';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
// 业务时区当前月份统一走 utils/format（原本这里自带一份"手工加 8 小时"的实现，
// 与 todayIso 的 Intl 口径重复且更脆弱：一旦业务时区/夏令时规则变化就会分叉）。
import { currentPeriod } from '@client/src/utils/format';
import { cn } from '@client/src/lib/utils';
import type {
  BiAlertSubscriptionItem,
  BiMetric,
  BiMetricsResult,
} from '@shared/api.interface';

function formatMetric(metric: BiMetric): string {
  if (metric.unit === '%') return `${metric.value.toFixed(2)}%`;
  if (metric.unit === '天') return `${metric.value.toFixed(2)} 天`;
  if (metric.unit === '个') return String(metric.value);
  return metric.value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDelta(metric: BiMetric): string | null {
  if (metric.previousValue === null) return null;
  const delta = metric.value - metric.previousValue;
  if (Math.abs(delta) < 0.005) return '与上期持平';
  const sign = delta > 0 ? '+' : '';
  const unit = metric.unit === '元' ? '' : metric.unit;
  return `较上期 ${sign}${delta.toFixed(2)}${unit}`;
}

/**
 * D-12：BI 指标中心。
 *
 * 三个设计要点（对应需求书 D-12 的验收口径）：
 * 1. **每个指标必须显示口径说明**（`formula`），否则业务方无法核对数字来源，
 *    指标中心就退化成一个"只能看不能信"的仪表盘。
 * 2. **下钻链接只指向真实存在的页面**：后端 `drillUrl` 为 null 时不渲染链接，
 *    避免死链（`formula`/`drillUrl` 都由后端指标注册表提供，前端不硬编码）。
 * 3. **预警订阅与指标同页**：看到异常指标后能立刻订阅，不用跳另一个页面找入口。
 */
const MetricsPage: React.FC = () => {
  const [period, setPeriod] = useState<string>(currentPeriod());
  const [subMetricKey, setSubMetricKey] = useState<string>('');
  const [subDirection, setSubDirection] = useState<'gt' | 'lt'>('gt');
  const [subThreshold, setSubThreshold] = useState<string>('');
  const [subChannel, setSubChannel] = useState<'feishu' | 'inbox'>('feishu');
  const [busy, setBusy] = useState(false);
  /**
   * P2-3：阈值输入框的 id —— 由 `useFieldId()`（内部是 `React.useId()`）生成，
   * 保证全页唯一。手写固定 id 在"页面被渲染两次"（如抽屉里再放一次本组件）时
   * 会撞车，撞车后 `htmlFor` 指向第一个元素，点标签会聚焦到**别的输入框**，
   * 比不关联更糟。
   */
  const thresholdId = useFieldId('metrics-threshold');

  const {
    data: metricsData,
    loading,
    error,
    reload,
  } = useAsyncData<BiMetricsResult>(() => biApi.getMetrics(period), [period]);
  const {
    data: subscriptions,
    reload: reloadSubscriptions,
  } = useAsyncData<BiAlertSubscriptionItem[]>(
    () => biApi.listAlertSubscriptions(),
    [],
  );

  const metrics = metricsData?.metrics ?? [];
  const subs = subscriptions ?? [];

  const subscribe = async () => {
    if (!subMetricKey) {
      toast.error('请选择要订阅的指标');
      return;
    }
    const threshold = Number(subThreshold);
    if (!Number.isFinite(threshold)) {
      toast.error('请填写阈值');
      return;
    }
    setBusy(true);
    try {
      await biApi.upsertAlertSubscription({
        metricKey: subMetricKey,
        thresholdDirection: subDirection,
        threshold,
        channel: subChannel,
      });
      toast.success('订阅已保存');
      setSubThreshold('');
      reloadSubscriptions();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '订阅失败'));
    } finally {
      setBusy(false);
    }
  };

  const removeSub = async (item: BiAlertSubscriptionItem) => {
    try {
      await biApi.removeAlertSubscription(item.id);
      toast.success('已取消订阅');
      reloadSubscriptions();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '取消失败'));
    }
  };

  return (
    <PageShell
      title="指标中心"
      description="核心经营指标（含口径说明与下钻）、上期对比与阈值预警订阅"
      actions={
        <div className="flex items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="metrics-period" className="text-xs">
              期间
            </Label>
            <Input
              id="metrics-period"
              className="w-32"
              value={period}
              placeholder="2026-10"
              onChange={(event) => setPeriod(event.target.value)}
            />
          </div>
          <Button type="button" variant="outline" onClick={reload}>
            刷新
          </Button>
        </div>
      }
    >
      <DataBoundary
        loading={loading}
        error={error}
        empty={metrics.length === 0}
        emptyText="暂无指标数据"
        onRetry={reload}
      >
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <h3 className="text-base font-semibold">
              核心指标（{metricsData?.period ?? period}）
            </h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {metrics.map((metric) => {
                const delta = formatDelta(metric);
                const worse = delta?.startsWith('较上期 -');
                return (
                  <div key={metric.key} className="flex flex-col gap-2">
                    <StatCard
                      label={metric.name}
                      value={formatMetric(metric)}
                      tone={
                        metric.unit === '%' && metric.value < 0
                          ? 'warning'
                          : 'primary'
                      }
                      delta={delta ?? undefined}
                    />
                    <p className="text-xs text-muted-foreground">
                      {metric.formula}
                    </p>
                    <div className="flex items-center justify-between">
                      {metric.drillUrl ? (
                        <Link
                          to={metric.drillUrl}
                          className="text-xs text-primary hover:underline"
                        >
                          查看明细 →
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          该指标暂无明细页
                        </span>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className={cn('text-xs', worse && 'text-destructive')}
                        onClick={() => {
                          setSubMetricKey(metric.key);
                          setSubThreshold(String(metric.value));
                        }}
                      >
                        订阅预警
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-base font-semibold">预警订阅</h3>
            <div className="grid items-end gap-3 rounded-lg border bg-card p-4 md:grid-cols-5">
              <div className="grid gap-1">
                <Explained
                  title="指标"
                  content="选择要盯的经营数字。告警按这个指标的当前值判断。"
                >
                  <FieldLabel>指标</FieldLabel>
                </Explained>
                <Select value={subMetricKey} onValueChange={setSubMetricKey}>
                  <SelectTrigger aria-label="预警订阅指标">
                    <SelectValue placeholder="选择指标" />
                  </SelectTrigger>
                  <SelectContent>
                    {metrics.map((metric) => (
                      <SelectItem key={metric.key} value={metric.key}>
                        {metric.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1">
                <Explained
                  title="触发方向"
                  content="高于阈值告警，还是低于阈值告警。方向选反了，告警会反着响。"
                >
                  <FieldLabel>触发方向</FieldLabel>
                </Explained>
                <Select
                  value={subDirection}
                  onValueChange={(value) => setSubDirection(value as 'gt' | 'lt')}
                >
                  <SelectTrigger aria-label="触发方向">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gt">高于阈值</SelectItem>
                    <SelectItem value="lt">低于阈值</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1">
                <Explained
                  title="阈值"
                  content="指标越过这个数就告警。单位和所选指标一致，例如金额或百分比。"
                >
                  <FieldLabel htmlFor={thresholdId}>阈值</FieldLabel>
                </Explained>
                <Input
                  id={thresholdId}
                  inputMode="decimal"
                  value={subThreshold}
                  placeholder="0"
                  onChange={(event) => setSubThreshold(event.target.value)}
                />
              </div>
              <div className="grid gap-1">
                <FieldLabel>通知渠道</FieldLabel>
                <Select
                  value={subChannel}
                  onValueChange={(value) =>
                    setSubChannel(value as 'feishu' | 'inbox')
                  }
                >
                  <SelectTrigger aria-label="通知渠道">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="feishu">飞书消息 + 站内信</SelectItem>
                    <SelectItem value="inbox">仅站内信</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" disabled={busy} onClick={subscribe}>
                {busy ? '保存中…' : '保存订阅'}
              </Button>
            </div>

            {subs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                暂无订阅。选择指标与阈值后保存，系统每日 08:30 扫描并推送命中项。
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="p-2 font-medium">指标</th>
                      <th className="p-2 font-medium">触发条件</th>
                      <th className="p-2 font-medium">渠道</th>
                      <th className="p-2 font-medium">最近触发</th>
                      <th className="p-2 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subs.map((item) => (
                      <tr key={item.id} className="border-t">
                        <td className="p-2">{item.metricName}</td>
                        <td className="p-2">
                          {item.thresholdDirection === 'gt' ? '高于' : '低于'}{' '}
                          {item.threshold}
                        </td>
                        <td className="p-2">
                          {item.channel === 'feishu' ? '飞书 + 站内信' : '站内信'}
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">
                          {item.lastTriggeredAt
                            ? new Date(item.lastTriggeredAt).toLocaleString('zh-CN')
                            : '尚未触发'}
                        </td>
                        <td className="p-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => removeSub(item)}
                          >
                            取消
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </DataBoundary>
    </PageShell>
  );
};

export default MetricsPage;
