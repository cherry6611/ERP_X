import React from 'react';
import { Badge } from '@client/src/components/ui/badge';

/* 数据资产域状态文案 */

export const DATASET_STATUS_LABELS: Record<string, string> = {
  active: '已上线',
  offline: '已下线',
};

export const GRANT_STATUS_LABELS: Record<string, string> = {
  active: '生效中',
  expired: '已失效',
};

export const MASK_LEVEL_OPTIONS = ['L1', 'L2', 'L3', 'L4'];

const YELLOW_CLASS =
  'border-transparent bg-amber-100 text-amber-700 hover:bg-amber-100';

/* 颜色语义：生效/激活=蓝（default），失效/下线=灰（secondary） */

interface DataAssetBadgeProps {
  status: string;
  labels: Record<string, string>;
}

const DataAssetBadge: React.FC<DataAssetBadgeProps> = ({ status, labels }) => {
  const variant: 'default' | 'secondary' | 'destructive' =
    status === 'active' ? 'default' : 'secondary';
  return (
    <Badge variant={variant}>{labels[status] ?? status}</Badge>
  );
};

/* 到期预警徽标：30 天内到期=黄，已过期=红 */

interface WarningBadgeProps {
  daysLeft: number;
}

export const WarningBadge: React.FC<WarningBadgeProps> = ({ daysLeft }) => {
  if (daysLeft < 0) {
    return (
      <Badge variant="destructive">已过期 {Math.abs(daysLeft)} 天</Badge>
    );
  }
  if (daysLeft === 0) {
    return <Badge className={YELLOW_CLASS}>今日到期</Badge>;
  }
  return <Badge className={YELLOW_CLASS}>{daysLeft} 天后到期</Badge>;
};

export default DataAssetBadge;
