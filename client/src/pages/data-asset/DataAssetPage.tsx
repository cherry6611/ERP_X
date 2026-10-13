import React, { useState } from 'react';
import PageShell from '@client/src/components/PageShell';
import DatasetPanel from './components/DatasetPanel';
import GrantPanel from './components/GrantPanel';

const DATA_ASSET_TABS = [
  { key: 'datasets', label: '数据集目录' },
  { key: 'grants', label: '授权记录' },
] as const;

const DataAssetPage: React.FC = () => {
  const [tab, setTab] = useState<string>('datasets');

  return (
    <PageShell
      title="数据资产授权"
      description="数据集目录、授权记录与到期预警管理，项目立项前自动校验数据集授权"
    >
      <div className="flex gap-2 flex-wrap" data-ai-section-type="card-list">
        {DATA_ASSET_TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              tab === item.key
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-foreground/80 hover:bg-muted'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div>
        {tab === 'datasets' ? <DatasetPanel /> : <GrantPanel />}
      </div>
    </PageShell>
  );
};

export default DataAssetPage;
