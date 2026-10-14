import React, { useState } from 'react';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
import { cn } from '@client/src/lib/utils';
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
    <PageShell
      title="固定资产"
      description="资产台账、月度折旧计提与领用/调拨/报废变更审批"
    >
      <div className="flex gap-2 flex-wrap" data-ai-section-type="card-list">
        {ASSET_TABS.map((item) => (
          <Button
            key={item.key}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setTab(item.key)}
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
      <div>{ASSET_TAB_CONTENT[tab]}</div>
    </PageShell>
  );
};

export default AssetPage;
