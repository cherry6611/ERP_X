import type { BadgeProps } from '@client/src/components/ui/badge';
import { withDictionaryFallback } from '@client/src/utils/dict-labels';

/**
 * 业务状态标签（B-05：`sys_dict` 为唯一权威，此处的字面量是**兜底值**）。
 *
 * ## 这个文件现在是什么
 *
 * 每个常量都用 `withDictionaryFallback(dictType, {...})` 包了一层：
 * **读取时**先查字典，字典缺该项才用这里的字面量。因此：
 * - 调用点完全不用改（仍是 `LABELS[value]`），也不会有异步问题；
 * - 业务方在「设置 → 字典」改 `dict_label` 即生效，无需发版 —— 这正是 B-05 的目的；
 * - 字典尚未加载（首屏、网络失败）时界面显示不变，不会退化成英文 key。
 *
 * 兜底值必须与迁移 `2026-10-15-upgrade-batch1z-b05-biz-labels-dict.sql`
 * 种入的文案**保持一致**，否则"是否已加载字典"会表现为界面文案跳变。
 *
 * ## 为什么 `COST_TYPE_LABELS` 没有接管字典
 *
 * 既有 `cost_type` 字典（由 `batch1-system-config.sql` 种入）的键集与这里的常量
 * **不一致**：字典有 `outsourcing/purchase/software/data/other`，
 * 常量有 `outsource/compute/storage/tool/flex_labor`。
 * 强行接管会导致界面出现常量里没有的键，或反过来显示原始英文 key。
 * 这属于**既有数据不一致**，需业务确认统一口径后再接管 —— 此处如实保留，
 * 不用"看起来已统一"的方式掩盖。已知会产生的表现：
 * 成本类型下拉（取自字典）与成本列表标签（取自常量）在个别类型上文案不同。
 */

export const LEAD_STATUS_LABELS: Record<string, string> = withDictionaryFallback(
  'lead_status',
  {
    new: '新建',
    following: '跟进中',
    converted: '已转化',
    lost: '已流失',
  },
);

export const OPP_STAGE_LABELS: Record<string, string> = withDictionaryFallback(
  'opp_stage',
  {
    new: '新建',
    following: '跟进中',
    quoting: '方案报价',
    negotiating: '谈判',
    won: '赢单',
    lost: '输单',
  },
);

export const QUOTATION_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('quotation_status', {
    draft: '草稿',
    pending_approval: '待审批',
    approved: '已生效',
    converted: '已转合同',
    void: '已作废',
  });

export const VOUCHER_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('voucher_status', {
    draft: '草稿',
    posted: '已过账',
    voided: '已作废',
  });

export const AR_SOURCE_LABELS: Record<string, string> = withDictionaryFallback(
  'ar_source',
  {
    manual: '手工登记',
    revenue: '收入确认',
  },
);

export const CONTRACT_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('contract_status', {
    draft: '草稿',
    approving: '审批中',
    active: '已生效',
    performing: '履约中',
    completed: '已完成',
    closed: '已关闭',
    terminated: '已终止',
  });

export const PROJECT_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('project_status', {
    initiating: '立项中',
    executing: '执行中',
    delivering: '交付中',
    accepting: '验收中',
    closed: '已结项',
  });

export const BILLING_MODEL_LABELS: Record<string, string> =
  withDictionaryFallback('billing_model', {
    project: '项目制',
    quantity: '按量计费',
    subscription: '订阅制',
    framework: '框架合同',
  });

/**
 * 成本类型标签 —— **未接管字典**，原因见文件头注释。
 * 保留为普通常量，避免出现"部分键来自字典、部分来自常量"的混合映射。
 */
export const COST_TYPE_LABELS: Record<string, string> = {
  labor: '人力成本',
  outsource: '外包成本',
  compute: '算力成本',
  storage: '存储成本',
  tool: '工具成本',
  travel: '差旅成本',
  flex_labor: '灵活用工',
};

export const TIMESHEET_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('timesheet_status', {
    draft: '草稿',
    submitted: '已提交',
    confirmed: '已确认',
  });

export const AR_STATUS_LABELS: Record<string, string> = withDictionaryFallback(
  'ar_status',
  {
    open: '待回款',
    partial: '部分回款',
    settled: '已结清',
  },
);

export const RECEIPT_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('receipt_status', {
    unmatched: '未核销',
    partial: '部分核销',
    matched: '已核销',
  });

export const AP_STATUS_LABELS: Record<string, string> = withDictionaryFallback(
  'ap_status',
  {
    pending: '待付款',
    partial: '部分付款',
    paid: '已付清',
  },
);

export const PAYMENT_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('payment_status', {
    pending: '待审批',
    approved: '已批准',
    rejected: '已驳回',
    paid: '已核销',
  });

/**
 * 发票类型标签 —— **未接管字典**。
 * 既有 `invoice_type` 字典的键（`vat_special` / `vat_normal`）与常量一致，
 * 但该字典还有 `electronic` 等额外键，接管后行为变化需业务确认。
 * 保留为常量并在台账登记。
 */
export const INVOICE_TYPE_LABELS: Record<string, string> = {
  vat_special: '增值税专用发票',
  vat_normal: '增值税普通发票',
};

export const REVENUE_METHOD_LABELS: Record<string, string> =
  withDictionaryFallback('revenue_method', {
    progress: '进度法',
    milestone: '里程碑',
    quantity: '按量交付',
    subscription: '分期确认',
  });

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
