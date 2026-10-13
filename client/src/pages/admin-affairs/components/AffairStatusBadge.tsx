import React from 'react';
import { Badge } from '@client/src/components/ui/badge';
import type { AdminAffairStatus } from '@shared/api.interface';

export const AFFAIR_STATUS_LABELS: Record<AdminAffairStatus, string> = {
  registered: '已登记',
  settled: '已结清',
};

/* 颜色语义：已登记=黄、已结清=绿 */

const YELLOW_CLASS =
  'border-transparent bg-warning/10 text-warning hover:bg-warning/10';
const GREEN_CLASS =
  'border-transparent bg-success/10 text-success hover:bg-success/10';

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
