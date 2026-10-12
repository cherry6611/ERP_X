import React from 'react';
import { Badge } from '@client/src/components/ui/badge';

/* 采购域状态文案 */

export const PUR_REQUEST_TYPE_LABELS: Record<string, string> = {
  service: '服务采购',
  equipment: '设备采购',
};

export const PUR_REQUEST_STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
};

export const PUR_ORDER_STATUS_LABELS: Record<string, string> = {
  pending: '待验收',
  accepted: '已验收',
  cancelled: '已取消',
};

export const PUR_ORDER_CATEGORY_LABELS: Record<string, string> = {
  service: '服务类',
  equipment: '设备类',
};

/* 采购域 Badge 颜色语义：待审批/待验收=灰、已批准/已验收=蓝、驳回/已取消=红 */

const BLUE_STATUSES = new Set(['approved', 'accepted']);
const RED_STATUSES = new Set(['rejected', 'cancelled']);

interface PurStatusBadgeProps {
  status: string;
  labels: Record<string, string>;
}

const PurStatusBadge: React.FC<PurStatusBadgeProps> = ({ status, labels }) => {
  let variant: 'secondary' | 'default' | 'destructive' = 'secondary';
  if (BLUE_STATUSES.has(status)) {
    variant = 'default';
  } else if (RED_STATUSES.has(status)) {
    variant = 'destructive';
  }
  return <Badge variant={variant}>{labels[status] ?? status}</Badge>;
};

export default PurStatusBadge;
