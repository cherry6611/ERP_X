import React, { useState } from 'react';
import AssetPanel from './components/AssetPanel';
import AssetDepreciationPanel from './components/AssetDepreciationPanel';
import AssetChangePanel from './components/AssetChangePanel';

const ASSET_TABS = [
  { key: 'assets', label: '资产台账' },
  { key: 'depreciation', label: '折旧计提' },
  { key: 'changes', label: '变更审批' },
] as const;

const ASSET_TAB_CONTENT: Record<string, React.ReactNode> = {
  assets: <AssetPanel />,
  depreciation: <AssetDepreciationPanel />,
  changes: <AssetChangePanel />,
};

const AssetPage: React.FC = () => {
  const [tab, setTab] = useState<string>('assets');

  return (
    <div className="p-6 flex flex-col gap-6" data-ai-section-type="card-list">
      <div>
        <h1 className="text-2xl font-semibold">固定资产</h1>
        <p className="text-sm text-muted-foreground mt-1">
          资产台账、月度折旧计提与领用/调拨/报废变更审批
        </p>
      </div>
      <div className="flex gap-2 flex-wrap">
        {ASSET_TABS.map((item) => (
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
      <div>{ASSET_TAB_CONTENT[tab]}</div>
    </div>
  );
};

export default AssetPage;
