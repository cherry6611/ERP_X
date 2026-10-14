import React from 'react';
import { useSearchParams } from 'react-router-dom';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
import { cn } from '@client/src/lib/utils';
import DatasetPanel from './components/DatasetPanel';
import GrantPanel from './components/GrantPanel';

const DATA_ASSET_TABS = [
  { key: 'datasets', label: '数据集目录' },
  { key: 'grants', label: '授权记录' },
] as const;

const DataAssetPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'grants' ? 'grants' : 'datasets';

  return (
    <PageShell
      title="数据资产授权"
      description="数据集目录、授权记录与到期预警管理，项目立项前自动校验数据集授权"
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
      <div>{tab === 'datasets' ? <DatasetPanel /> : <GrantPanel />}</div>
    </PageShell>
  );
};

export default DataAssetPage;
