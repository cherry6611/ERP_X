import { Badge } from '@client/src/components/ui/badge';
import { STATUS_VARIANTS } from '@client/src/utils/biz-labels';

interface StatusBadgeProps {
  status: string;
  labels: Record<string, string>;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ status, labels }) => (
  <Badge variant={STATUS_VARIANTS[status] ?? 'secondary'}>
    {labels[status] ?? status}
  </Badge>
);

export default StatusBadge;
