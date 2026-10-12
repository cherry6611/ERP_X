import React from 'react';
import { Badge } from '@client/src/components/ui/badge';
import type { AdminAffairStatus } from '@shared/api.interface';

export const AFFAIR_STATUS_LABELS: Record<AdminAffairStatus, string> = {
  registered: '已登记',
  settled: '已结清',
};

/* 颜色语义：已登记=黄、已结清=绿 */

const YELLOW_CLASS =
  'border-transparent bg-amber-100 text-amber-700 hover:bg-amber-100';
const GREEN_CLASS =
  'border-transparent bg-emerald-100 text-emerald-700 hover:bg-emerald-100';

const AffairStatusBadge: React.FC<{ status: AdminAffairStatus }> = ({
  status,
}) => (
  <Badge
    variant="secondary"
    className={status === 'settled' ? GREEN_CLASS : YELLOW_CLASS}
  >
    {AFFAIR_STATUS_LABELS[status]}
  </Badge>
);

export default AffairStatusBadge;
