import React from 'react';
import { Badge } from '@client/src/components/ui/badge';

/* 预算费控域状态文案 */

export const APPLY_TYPE_LABELS: Record<string, string> = {
  travel: '差旅',
  purchase: '采购',
};

export const APPLY_STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  closed: '已关闭',
};

export const CLAIM_STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  escalated: '超预算升级审批',
  approved: '已批准',
  rejected: '已驳回',
};

/* 颜色语义：待审批=灰、已批准=蓝、驳回=红、升级审批=黄、关闭=绿 */

const GREEN_CLASS =
  'border-transparent bg-emerald-100 text-emerald-700 hover:bg-emerald-100';
const YELLOW_CLASS =
  'border-transparent bg-amber-100 text-amber-700 hover:bg-amber-100';

const GREEN_STATUSES = new Set(['closed']);
const YELLOW_STATUSES = new Set(['escalated']);
const BLUE_STATUSES = new Set(['approved']);
const RED_STATUSES = new Set(['rejected']);

interface FinStatusBadgeProps {
  status: string;
  labels: Record<string, string>;
}

const FinStatusBadge: React.FC<FinStatusBadgeProps> = ({ status, labels }) => {
  let variant: 'secondary' | 'default' | 'destructive' = 'secondary';
  let className = '';
  if (GREEN_STATUSES.has(status)) {
    className = GREEN_CLASS;
  } else if (YELLOW_STATUSES.has(status)) {
    className = YELLOW_CLASS;
  } else if (BLUE_STATUSES.has(status)) {
    variant = 'default';
  } else if (RED_STATUSES.has(status)) {
    variant = 'destructive';
  }
  return (
    <Badge variant={variant} className={className}>
      {labels[status] ?? status}
    </Badge>
  );
};

export default FinStatusBadge;
