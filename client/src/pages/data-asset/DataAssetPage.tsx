import React, { useState } from 'react';
import DatasetPanel from './components/DatasetPanel';
import GrantPanel from './components/GrantPanel';

const DATA_ASSET_TABS = [
  { key: 'datasets', label: '数据集目录' },
  { key: 'grants', label: '授权记录' },
] as const;

const DataAssetPage: React.FC = () => {
  const [tab, setTab] = useState<string>('datasets');

  return (
    <div className="p-6 flex flex-col gap-6" data-ai-section-type="card-list">
      <div>
        <h1 className="text-2xl font-semibold">数据资产授权</h1>
        <p className="text-sm text-muted-foreground mt-1">
          数据集目录、授权记录与到期预警管理，项目立项前自动校验数据集授权
        </p>
      </div>
      <div className="flex gap-2 flex-wrap">
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
    </div>
  );
};

export default DataAssetPage;
