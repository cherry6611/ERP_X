import React from 'react';
import { Badge } from '@client/src/components/ui/badge';
import type { AdminRentContractStatus } from '@shared/api.interface';

const STATUS_CONFIG: Record<
  AdminRentContractStatus,
  { label: string; variant: 'secondary' | 'default' | 'destructive' }
> = {
  draft: { label: '草稿', variant: 'secondary' },
  active: { label: '生效中', variant: 'default' },
  expired: { label: '已到期', variant: 'destructive' },
  terminated: { label: '已终止', variant: 'secondary' },
};

const RentStatusBadge: React.FC<{ status: AdminRentContractStatus }> = ({
  status,
}) => {
  const config = STATUS_CONFIG[status] ?? {
    label: status,
    variant: 'secondary' as const,
  };
  return <Badge variant={config.variant}>{config.label}</Badge>;
};

export default RentStatusBadge;
