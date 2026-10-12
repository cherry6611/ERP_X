import React from 'react';
import { Badge } from '@client/src/components/ui/badge';
import type { AdminBillStatus } from '@shared/api.interface';

/* 行政缴费类型文案 */
export const BILL_TYPE_LABELS: Record<string, string> = {
  rent: '房租',
  property: '物业费',
  water_electric: '水电费',
  office: '办公用品',
  vehicle_travel: '车辆/差旅',
  other: '其他',
};

/* 行政缴费状态文案 */
export const BILL_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  submitted: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  paid: '已付款',
};

/* 颜色语义：草稿=灰、待审批=黄、已批准=蓝、已付款=绿、已驳回=红 */
const YELLOW_CLASS =
  'border-transparent bg-amber-100 text-amber-700 hover:bg-amber-100';
const BLUE_CLASS =
  'border-transparent bg-blue-100 text-blue-700 hover:bg-blue-100';
const GREEN_CLASS =
  'border-transparent bg-emerald-100 text-emerald-700 hover:bg-emerald-100';

interface AdminBillStatusBadgeProps {
  status: AdminBillStatus;
}

const AdminBillStatusBadge: React.FC<AdminBillStatusBadgeProps> = ({
  status,
}) => {
  let variant: 'secondary' | 'default' | 'destructive' = 'secondary';
  let className = '';
  if (status === 'paid') {
    className = GREEN_CLASS;
  } else if (status === 'submitted') {
    className = YELLOW_CLASS;
  } else if (status === 'approved') {
    variant = 'default';
    className = BLUE_CLASS;
  } else if (status === 'rejected') {
    variant = 'destructive';
  }
  return (
    <Badge variant={variant} className={className}>
      {BILL_STATUS_LABELS[status] ?? status}
    </Badge>
  );
};

export default AdminBillStatusBadge;
