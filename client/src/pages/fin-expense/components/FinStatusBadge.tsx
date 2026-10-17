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
  /*
   * B12（§7.2）：补齐终态文案。
   *
   * 缺了这两行不会空白（`labels[status] ?? status` 会回退），
   * 但界面上会直接显示英文 key `paid` / `voided` —— 中文系统里的英文状态
   * 使用者第一反应是"系统是不是坏了"。
   */
  paid: '已支付',
  voided: '已作废',
};

/* 颜色语义：待审批=灰、已批准=蓝、驳回/作废=红、升级审批=黄、已支付/关闭=绿 */

const GREEN_CLASS =
  'border-transparent bg-success/10 text-success hover:bg-success/10';
const YELLOW_CLASS =
  'border-transparent bg-warning/10 text-warning hover:bg-warning/10';

/** 终态成功：已关闭（申请单）、已支付（报销/工资） */
const GREEN_STATUSES = new Set(['closed', 'paid']);
const YELLOW_STATUSES = new Set(['escalated']);
const BLUE_STATUSES = new Set(['approved']);
/** 驳回与作废同属"这笔钱不走了"，用同一危险色 —— 使用者不需要区分两者 */
const RED_STATUSES = new Set(['rejected', 'voided']);

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
