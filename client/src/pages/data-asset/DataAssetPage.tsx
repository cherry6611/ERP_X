import React from 'react';
import { useSearchParams } from 'react-router-dom';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
import { cn } from '@client/src/lib/utils';
import DatasetPanel from './components/DatasetPanel';
import GrantPanel from './components/GrantPanel';
import DataMaskPanel from './components/DataMaskPanel';

const DATA_ASSET_TABS = [
  { key: 'datasets', label: '数据集目录' },
  { key: 'grants', label: '授权记录' },
  // C-13：脱敏等级、字段登记、授权回收审计（双人确认 + 销毁凭证）
  { key: 'mask', label: '脱敏与回收审计' },
] as const;

const TAB_SET = new Set(DATA_ASSET_TABS.map((t) => t.key));

const DataAssetPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? 'datasets';
  const tab = TAB_SET.has(raw as (typeof DATA_ASSET_TABS)[number]['key'])
    ? raw
    : 'datasets';

  return (
    <PageShell
      title="数据资产授权"
      description="数据集目录、授权记录、脱敏等级与授权回收审计"
    >
      <div className="flex gap-2 flex-wrap" data-ai-section-type="card-list">
        {DATA_ASSET_TABS.map((item) => (
          <Button
            key={item.key}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  if (item.key === 'datasets') next.delete('tab');
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
      <div>
        {tab === 'datasets' && <DatasetPanel />}
        {tab === 'grants' && <GrantPanel />}
        {tab === 'mask' && <DataMaskPanel />}
      </div>
    </PageShell>
  );
};

export default DataAssetPage;
