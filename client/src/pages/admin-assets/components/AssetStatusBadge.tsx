import React from 'react';
import { Badge } from '@client/src/components/ui/badge';
import type { AdminAssetStatus } from '@shared/api.interface';

export const ASSET_STATUS_LABELS: Record<AdminAssetStatus, string> = {
  in_use: '在用',
  idle: '闲置',
  scrapped: '已报废',
};

/* 颜色语义：在用=蓝、闲置=灰、已报废=红 */

const AssetStatusBadge: React.FC<{ status: AdminAssetStatus }> = ({
  status,
}) => {
  if (status === 'in_use') {
    return <Badge variant="default">{ASSET_STATUS_LABELS.in_use}</Badge>;
  }
  if (status === 'scrapped') {
    return <Badge variant="destructive">{ASSET_STATUS_LABELS.scrapped}</Badge>;
  }
  return <Badge variant="secondary">{ASSET_STATUS_LABELS.idle}</Badge>;
};

export default AssetStatusBadge;
