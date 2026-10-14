import React, { useState } from 'react';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { cn } from '@client/src/lib/utils';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as assetApi from '@client/src/api/asset';
import AssetPanel from './components/AssetPanel';
import AssetDepreciationPanel from './components/AssetDepreciationPanel';
import AssetChangePanel from './components/AssetChangePanel';
import AssetImpairmentPanel from './components/AssetImpairmentPanel';
import AssetDisposalPanel from './components/AssetDisposalPanel';
import AssetLifecyclePanel from './components/AssetLifecyclePanel';

const ASSET_TABS = [
  { key: 'assets', label: '资产台账' },
  { key: 'depreciation', label: '折旧计提' },
  { key: 'impairment', label: '减值测试' },
  { key: 'disposal', label: '处置报废' },
  { key: 'changes', label: '变更审批' },
  { key: 'lifecycle', label: '生命周期' },
] as const;

/**
 * 固定资产工作台（D-08）。
 *
 * 「生命周期」Tab 需要一个具体资产才能渲染时间线，因此该 Tab 顶部提供资产选择器，
 * 默认取台账第一项 —— 避免用户切到该页看到空白而无从下手。
 */
const AssetPage: React.FC = () => {
  const [tab, setTab] = useState<string>('assets');
  const [lifecycleAssetId, setLifecycleAssetId] = useState<string>('');

  const { data: assets } = useAsyncData(
    () => assetApi.listAssets({ pageSize: 200 }),
    [],
  );
  const assetOptions = assets?.items ?? [];
  const selectedLifecycleAsset =
    lifecycleAssetId || assetOptions[0]?.id || '';

  return (
    <PageShell
      title="固定资产"
      description="资产台账、折旧计提、减值测试、处置报废、变更审批与全生命周期追溯"
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
      <div className="flex flex-col gap-4">
        {tab === 'assets' && <AssetPanel />}
        {tab === 'depreciation' && <AssetDepreciationPanel />}
        {tab === 'impairment' && <AssetImpairmentPanel />}
        {tab === 'disposal' && <AssetDisposalPanel />}
        {tab === 'changes' && <AssetChangePanel />}
        {tab === 'lifecycle' && (
          <>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">选择资产</span>
              <Select
                value={selectedLifecycleAsset}
                onValueChange={setLifecycleAssetId}
              >
                <SelectTrigger className="w-80">
                  <SelectValue placeholder="选择资产查看生命周期" />
                </SelectTrigger>
                <SelectContent>
                  {assetOptions.map((asset) => (
                    <SelectItem key={asset.id} value={asset.id}>
                      {asset.code} {asset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selectedLifecycleAsset ? (
              <AssetLifecyclePanel assetId={selectedLifecycleAsset} />
            ) : (
              <p className="text-sm text-muted-foreground">
                暂无资产，请先在「资产台账」建卡。
              </p>
            )}
          </>
        )}
      </div>
    </PageShell>
  );
};

export default AssetPage;
