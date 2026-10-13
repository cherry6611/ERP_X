import React from 'react';
import { BellRing } from 'lucide-react';
import { DataState } from '@client/src/components/DataState';
import { Badge } from '@/components/ui/badge';
import { biApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import type { AlertItem } from '@shared/api.interface';

const CATEGORY_LABELS: Record<string, string> = {
  ar_overdue: '应收逾期',
  grant_expiring: '授权到期',
  asset_scrapping: '资产报废',
};

function daysText(item: AlertItem): string {
  if (item.category === 'asset_scrapping') {
    return `报废流程发起 ${item.days} 天`;
  }
  if (item.days < 0) return `已逾期 ${-item.days} 天`;
  if (item.days === 0) return '今日到期';
  return `${item.days} 天后到期`;
}

const AlertsPanel: React.FC = () => {
  const { data, loading, error, reload } = useAsyncData(
    () => biApi.getAlerts(),
    [],
  );
  const sorted: AlertItem[] = [...(data?.items ?? [])].sort(
    (a: AlertItem, b: AlertItem) => {
      if (a.severity !== b.severity) {
        return a.severity === 'danger' ? -1 : 1;
      }
      return a.days - b.days;
    },
  );

  return (
    <div data-ai-section-type="card-list" className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2">
        <BellRing className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-base font-semibold">通知中心</h2>
        {sorted.length > 0 ? (
          <span className="text-sm text-muted-foreground">
            共 {sorted.length} 项逾期与预警
          </span>
        ) : null}
      </div>
      <DataState
        loading={loading}
        error={error ? `通知中心加载失败：${error}` : null}
        empty={!loading && !error && sorted.length === 0}
        emptyText="暂无逾期与预警事项"
        onRetry={() => void reload()}
      >
        <ul className="mt-3 divide-y">
          {sorted.map((item: AlertItem, index: number) => (
            <li
              key={`${item.category}-${item.refCode}-${index}`}
              className="flex items-center gap-3 py-2.5"
            >
              <Badge
                variant={item.severity === 'danger' ? 'destructive' : 'outline'}
                className={
                  item.severity === 'warning'
                    ? 'border-transparent bg-warning/15 text-warning'
                    : undefined
                }
              >
                {CATEGORY_LABELS[item.category] ?? item.category}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-sm">
                {item.title}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {item.refCode}
              </span>
              <span
                className={`shrink-0 text-sm font-medium ${
                  item.severity === 'danger'
                    ? 'text-destructive'
                    : 'text-warning'
                }`}
              >
                {daysText(item)}
              </span>
            </li>
          ))}
        </ul>
      </DataState>
    </div>
  );
};

export default AlertsPanel;
