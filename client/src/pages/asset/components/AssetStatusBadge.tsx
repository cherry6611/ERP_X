import React from 'react';
import { Badge } from '@client/src/components/ui/badge';

/* 固定资产域文案 */

export const ASSET_STATUS_LABELS: Record<string, string> = {
  in_use: '在用',
  idle: '闲置',
  repair: '维修',
  scrapped: '已报废',
};

export const ASSET_CATEGORY_LABELS: Record<string, string> = {
  server_gpu: 'GPU 服务器',
  office: '办公设备',
  other: '其他',
};

export const ASSET_CHANGE_TYPE_LABELS: Record<string, string> = {
  receive: '领用',
  transfer: '调拨',
  scrap: '报废',
};

export const ASSET_CHANGE_STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
};

/* 资产状态：在用=蓝、闲置=灰、维修=黄、已报废=红 */

export const AssetStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  let variant: 'default' | 'secondary' | 'destructive' | 'outline' =
    'secondary';
  let extra = '';
  if (status === 'in_use') variant = 'default';
  if (status === 'scrapped') variant = 'destructive';
  if (status === 'repair') {
    variant = 'outline';
    extra = 'border-yellow-300 bg-yellow-50 text-yellow-700';
  }
  return (
    <Badge variant={variant} className={extra}>
      {ASSET_STATUS_LABELS[status] ?? status}
    </Badge>
  );
};

/* 变更单状态：待审批=灰、已批准=蓝、已驳回=红 */

export const AssetChangeStatusBadge: React.FC<{ status: string }> = ({
  status,
}) => {
  let variant: 'default' | 'secondary' | 'destructive' = 'secondary';
  if (status === 'approved') variant = 'default';
  if (status === 'rejected') variant = 'destructive';
  return (
    <Badge variant={variant}>
      {ASSET_CHANGE_STATUS_LABELS[status] ?? status}
    </Badge>
  );
};

export default AssetStatusBadge;
