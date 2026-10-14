import React from 'react';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as assetApi from '@client/src/api/asset';
import type { AssetLifecycleResult } from '@shared/api.interface';
import { cn } from '@client/src/lib/utils';

/**
 * D-08 ⑤：资产完整生命周期时间线。
 *
 * 为什么把 5 类事件放在同一条轴上：审计要回答的是
 * 「某次变更是否发生在减值测试之后」「处置时的净值快照是否与折旧记录一致」
 * 这类**顺序问题**。分散在四张表里逐个查是无法回答的。
 */
const EVENT_META: Record<
  AssetLifecycleResult['events'][number]['eventType'],
  { label: string; className: string }
> = {
  purchase: { label: '采购建卡', className: 'bg-sky-500' },
  change: { label: '资产变更', className: 'bg-violet-500' },
  depreciation: { label: '折旧计提', className: 'bg-slate-400' },
  impairment: { label: '减值测试', className: 'bg-amber-500' },
  disposal: { label: '处置报废', className: 'bg-rose-500' },
};

interface Props {
  assetId: string;
}

const AssetLifecyclePanel: React.FC<Props> = ({ assetId }) => {
  const { data, loading, error, reload } = useAsyncData(
    () => assetApi.getLifecycle(assetId),
    [assetId],
  );

  const lifecycle: AssetLifecycleResult | null = data;

  return (
    <DataBoundary
      loading={loading}
      error={error}
      empty={!lifecycle}
      emptyText="暂无生命周期数据"
      onRetry={reload}
    >
      {lifecycle && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatCard
              label="资产原值"
              value={lifecycle.originalValue.toFixed(2)}
            />
            <StatCard
              label="累计折旧"
              value={lifecycle.accumulatedDepreciation.toFixed(2)}
            />
            <StatCard
              label="累计减值"
              value={lifecycle.accumulatedImpairment.toFixed(2)}
              tone={lifecycle.accumulatedImpairment > 0 ? 'warning' : 'neutral'}
            />
            <StatCard
              label="账面净值"
              value={lifecycle.netBookValue.toFixed(2)}
              tone="info"
            />
            <StatCard label="残值" value={lifecycle.residualValue.toFixed(2)} />
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            <span>
              状态：<span className="text-foreground">{lifecycle.status}</span>
            </span>
            <span>
              使用部门：
              <span className="text-foreground">
                {lifecycle.departmentName ?? '—'}
              </span>
            </span>
            <span>
              归属项目：
              <span className="text-foreground">
                {lifecycle.projectName ?? '—'}
              </span>
            </span>
            <span>
              采购订单：
              <span className="text-foreground">
                {lifecycle.purchaseOrderId ?? '—'}
              </span>
            </span>
          </div>

          <div className="flex flex-col gap-0">
            {lifecycle.events.length === 0 && (
              <p className="text-sm text-muted-foreground">暂无生命周期事件</p>
            )}
            {lifecycle.events.map((event, index) => {
              const meta = EVENT_META[event.eventType];
              const isLast = index === lifecycle.events.length - 1;
              return (
                <div key={`${event.eventType}-${event.refCode}-${index}`} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span
                      className={cn('mt-1.5 h-2.5 w-2.5 rounded-full', meta.className)}
                      aria-hidden
                    />
                    {!isLast && <span className="w-px flex-1 bg-border" />}
                  </div>
                  <div className={cn('flex-1 pb-5', isLast && 'pb-0')}>
                    <div className="flex flex-wrap items-baseline gap-x-3">
                      <span className="text-sm font-medium">{event.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {event.occurredAt}
                      </span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {meta.label}
                      </span>
                      {event.amount !== null && (
                        <span
                          className={cn(
                            'text-sm tabular-nums',
                            event.amount < 0 ? 'text-destructive' : 'text-foreground',
                          )}
                        >
                          {event.amount.toFixed(2)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {event.refCode}
                      {event.detail ? ` · ${event.detail}` : ''}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </DataBoundary>
  );
};

export default AssetLifecyclePanel;
