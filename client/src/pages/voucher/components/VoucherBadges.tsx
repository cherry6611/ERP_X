import React from 'react';
import { Badge } from '@client/src/components/ui/badge';

/* 总账凭证域文案与状态 Badge */

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  asset: '资产',
  liability: '负债',
  equity: '权益',
  revenue: '收入',
  expense: '费用',
};

export const VOUCHER_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  posted: '已过账',
  voided: '已作废',
};

export const VOUCHER_SOURCE_LABELS: Record<string, string> = {
  receipt: '回款',
  payment: '付款',
  expense: '报销',
  payroll: '工资',
  depreciation: '折旧',
  invoice: '发票',
  manual: '手工',
};

/* 凭证状态颜色语义：草稿=灰、已过账=蓝、已作废=红 */

interface VoucherStatusBadgeProps {
  status: string;
}

const VoucherStatusBadge: React.FC<VoucherStatusBadgeProps> = ({ status }) => {
  let variant: 'secondary' | 'default' | 'destructive' = 'secondary';
  if (status === 'posted') {
    variant = 'default';
  } else if (status === 'voided') {
    variant = 'destructive';
  }
  return <Badge variant={variant}>{VOUCHER_STATUS_LABELS[status] ?? status}</Badge>;
};

interface AccountStatusBadgeProps {
  status: string;
}

const AccountStatusBadge: React.FC<AccountStatusBadgeProps> = ({ status }) => {
  if (status === 'active') {
    return <Badge variant="default">启用</Badge>;
  }
  return <Badge variant="secondary">{status === 'inactive' ? '停用' : status}</Badge>;
};

export { VoucherStatusBadge, AccountStatusBadge };
