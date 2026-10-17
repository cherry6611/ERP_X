import React from 'react';
import { Badge } from '@client/src/components/ui/badge';

/* HR 域状态文案 */

export const EMPLOYEE_STATUS_LABELS: Record<string, string> = {
  probation: '试用期',
  active: '在职',
  inactive: '停用',
  resigned: '已离职',
};

export const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  full_time: '全职',
  part_time: '兼职',
  flex: '灵活用工',
  intern: '实习',
  dispatch: '劳务派遣',
};

export const ATTENDANCE_STATUS_LABELS: Record<string, string> = {
  present: '正常出勤',
  absent: '缺勤',
  late: '迟到',
  leave: '请假',
};

export const LEAVE_TYPE_LABELS: Record<string, string> = {
  annual: '年假',
  sick: '病假',
  personal: '事假',
};

export const LEAVE_STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
};

export const PAYROLL_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  submitted: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  /*
   * B12（§7.2）：补齐两个终态文案。
   *
   * `approved` 只表示"同意发"，不表示"已经发了" —— 出纳原先只能靠线下表格
   * 区分这两件事。缺了 `paid` 这一行，界面上会显示英文 key `paid`。
   */
  paid: '已发放',
  voided: '已作废',
};

export const CANDIDATE_STAGE_LABELS: Record<string, string> = {
  pending: '待面试',
  interview: '面试中',
  offer: '已发 offer',
  hired: '已入职',
  rejected: '已淘汰',
};

export const APPRAISAL_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
};

export const TRAINING_STATUS_LABELS: Record<string, string> = {
  planned: '进行中',
  done: '已完成',
};

export const RECRUIT_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  open: '招聘中',
  closed: '已关闭',
  finished: '已完成',
};

/* HR 域 Badge 颜色语义：草稿/待审批=灰、已生效/已批准=蓝、完成/已入职=绿、驳回/淘汰=红、进行中=黄 */

const GREEN_CLASS =
  'border-transparent bg-success/10 text-success hover:bg-success/10';
const YELLOW_CLASS =
  'border-transparent bg-warning/10 text-warning hover:bg-warning/10';

const GREEN_STATUSES = new Set([
  'present',
  'confirmed',
  'done',
  'hired',
  'completed',
  'finished',
  'closed',
  // B12：工资单"已发放"是终态成功（与"已批准"分列两种颜色，
  // 是为了让出纳一眼分辨"批了没发"与"已发"）
  'paid',
]);

const YELLOW_STATUSES = new Set(['probation', 'late', 'interview', 'open']);

const BLUE_STATUSES = new Set(['active', 'approved', 'offer', 'leave']);

const RED_STATUSES = new Set(['rejected', 'absent', 'voided']);

interface HrStatusBadgeProps {
  status: string;
  labels: Record<string, string>;
}

const HrStatusBadge: React.FC<HrStatusBadgeProps> = ({ status, labels }) => {
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

export default HrStatusBadge;
