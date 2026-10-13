import type { BadgeProps } from '@client/src/components/ui/badge';

export const LEAD_STATUS_LABELS: Record<string, string> = {
  new: '新建',
  following: '跟进中',
  converted: '已转化',
  lost: '已流失',
};

export const OPP_STAGE_LABELS: Record<string, string> = {
  new: '新建',
  following: '跟进中',
  quoting: '方案报价',
  negotiating: '谈判',
  won: '赢单',
  lost: '输单',
};

export const QUOTATION_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  pending_approval: '待审批',
  approved: '已生效',
  converted: '已转合同',
  void: '已作废',
};

export const VOUCHER_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  posted: '已过账',
  voided: '已作废',
};

export const AR_SOURCE_LABELS: Record<string, string> = {
  manual: '手工登记',
  revenue: '收入确认',
};

export const CONTRACT_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  approving: '审批中',
  active: '已生效',
  performing: '履约中',
  completed: '已完成',
  closed: '已关闭',
  terminated: '已终止',
};

export const PROJECT_STATUS_LABELS: Record<string, string> = {
  initiating: '立项中',
  executing: '执行中',
  delivering: '交付中',
  accepting: '验收中',
  closed: '已结项',
};

export const BILLING_MODEL_LABELS: Record<string, string> = {
  project: '项目制',
  quantity: '按量计费',
  subscription: '订阅制',
  framework: '框架合同',
};

export const COST_TYPE_LABELS: Record<string, string> = {
  labor: '人力成本',
  outsource: '外包成本',
  compute: '算力成本',
  storage: '存储成本',
  tool: '工具成本',
  travel: '差旅成本',
  flex_labor: '灵活用工',
};

export const TIMESHEET_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交',
  confirmed: '已确认',
};

export const AR_STATUS_LABELS: Record<string, string> = {
  open: '待回款',
  partial: '部分回款',
  settled: '已结清',
};

export const RECEIPT_STATUS_LABELS: Record<string, string> = {
  unmatched: '未核销',
  partial: '部分核销',
  matched: '已核销',
};

export const AP_STATUS_LABELS: Record<string, string> = {
  pending: '待付款',
  partial: '部分付款',
  paid: '已付清',
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  paid: '已核销',
};

export const INVOICE_TYPE_LABELS: Record<string, string> = {
  vat_special: '增值税专用发票',
  vat_normal: '增值税普通发票',
};

export const REVENUE_METHOD_LABELS: Record<string, string> = {
  progress: '进度法',
  milestone: '里程碑',
  quantity: '按量交付',
  subscription: '分期确认',
};

type BadgeVariant = NonNullable<BadgeProps['variant']>;

export const STATUS_VARIANTS: Record<string, BadgeVariant> = {
  draft: 'secondary',
  new: 'secondary',
  pending: 'secondary',
  unmatched: 'secondary',
  submitted: 'warning',
  initiating: 'warning',
  following: 'warning',
  quoting: 'warning',
  negotiating: 'warning',
  approving: 'warning',
  pending_approval: 'warning',
  executing: 'warning',
  delivering: 'warning',
  accepting: 'warning',
  performing: 'warning',
  partial: 'warning',
  open: 'info',
  active: 'info',
  void: 'destructive',
  completed: 'success',
  closed: 'success',
  settled: 'success',
  matched: 'success',
  paid: 'success',
  confirmed: 'success',
  reached: 'success',
  approved: 'info',
  won: 'success',
  converted: 'success',
  recognized: 'success',
  issued: 'success',
  lost: 'destructive',
  rejected: 'destructive',
  overdue: 'destructive',
};
