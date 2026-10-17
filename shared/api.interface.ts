/* 前后端共享的类型写在这里（晟笙 ERP 全量契约） */

/* ========== 通用 ========== */

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/* ========== 枚举（字符串联合） ========== */

export type LeadStatus = 'new' | 'following' | 'converted' | 'lost';
export type OpportunityStage = 'new' | 'following' | 'quoting' | 'negotiating' | 'won' | 'lost';
export type ContractStatus = 'draft' | 'approving' | 'active' | 'performing' | 'completed' | 'closed' | 'terminated';
export type BillingModel = 'project' | 'quantity' | 'subscription' | 'framework';
export type MilestoneStatus = 'pending' | 'reached';
/**
 * 项目状态。
 *
 * B6（§7.2）：新增 'cancelled'（取消/终止）终态。
 *
 * 原状态集 initiating / executing / delivering / accepting / closed
 * 里，前四个**全是死胡同**（没有任何出口动作）：
 *   · 误建或中途取消的项目永远卡住；
 *   · 	ryCompleteContract 要求"同合同下全部项目 closed"，
 *     于是**一个卡住的项目让整个合同永远无法回写 completed**。
 */
export type ProjectStatus =
  | 'initiating'
  | 'executing'
  | 'delivering'
  | 'accepting'
  | 'closed'
  | 'cancelled';
export type ChangeType = 'scope' | 'budget' | 'schedule';
export type ChangeStatus = 'pending' | 'approved' | 'rejected';
export type CostType =
  | 'labor'
  | 'outsource'
  | 'compute'
  | 'storage'
  | 'tool'
  | 'travel'
  | 'flex_labor';
export type TimesheetStatus = 'draft' | 'submitted' | 'confirmed';
export type RevenueMethod = 'progress' | 'milestone' | 'quantity' | 'subscription';
export type AdjustType = 'discount' | 'return' | 'other';
/**
 * B1：应收终态。新增 `'voided'`（作废）。
 *
 * 原状态集没有退出路径 —— 一张误录的 100 万应收无法撤销，会**每天**污染
 * 现金流预测、账龄与催款、客户信用额度、BI 报表四个下游。作废是**不可逆**的
 * 终态，前置条件：`settledAmount = 0` 且无有效发票引用（见 `ArService.voidAr`）。
 */
export type ArStatus = 'open' | 'partial' | 'settled' | 'voided';
export type ReceiptStatus = 'unmatched' | 'partial' | 'matched' | 'voided';
/**
 * B1：应付终态。新增 `'voided'`（作废）。前置条件：`paidAmount = 0`、
 * 无未作废付款单、无有效进项发票引用（见 `ApService.voidAp`）。
 */
export type ApStatus = 'pending' | 'approved' | 'partial' | 'paid' | 'voided';
export type PaymentStatus = 'pending' | 'approved' | 'rejected' | 'paid' | 'voided';
export type InvoiceType = 'vat_special' | 'vat_normal' | 'electronic';
export type InvoiceStatus = 'issued' | 'voided';
export type InvoiceDirection = 'sales' | 'purchase';

/** C-01：发票查验状态 */
export type InvoiceVerifyStatus =
  | 'unverified' // 未查验
  | 'verifying' // 查验中（异步查验占位，本实现同步返回，仅作状态机预留）
  | 'verified' // 查验通过（税局/第三方确认存在且要素一致）
  | 'failed'; // 查验失败（税局无记录、要素不符或调用异常）

/** C-01：勾选认证状态 */
export type InvoiceCertificationStatus =
  | 'uncertified' // 未认证
  | 'certified' // 已认证（勾选并通过）
  | 'deducted'; // 已抵扣（已计入进项抵扣）

/* ========== 主数据 ========== */

export interface Customer {
  id: string;
  code: string;
  name: string;
  uscc: string | null;
  industry: string | null;
  creditLevel: string | null;
  creditLimit: number;
  termsDays: number;
  status: string;
  remark: string | null;
  taxEntityId?: string | null;
  defaultTaxRate?: number | null;
  createdAt: string;
}

export interface CustomerContact {
  id: string;
  customerId: string;
  name: string;
  phone: string | null;
  email: string | null;
  position: string | null;
  isPrimary: boolean;
  remark: string | null;
}

export interface CreditSummary {
  customerId: string;
  customerName: string;
  creditLimit: number;
  openArAmount: number;
  overdueAmount: number;
  exceedLimit: boolean;
  hasOverdue: boolean;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  type: string | null;
  contactName: string | null;
  contactPhone: string | null;
  bankAccount: string | null;
  rating: number;
  status: string;
  remark: string | null;
  taxEntityId?: string | null;
  defaultTaxRate?: number | null;
  createdAt: string;
}

export interface Employee {
  id: string;
  code: string;
  name: string;
  orgName: string | null;
  position: string | null;
  status: string;
  departmentId: string | null;
  departmentName: string | null;
  positionId: string | null;
  roleName: string | null;
  hireDate: string | null;
  employmentType: string | null;
  phone: string | null;
  resignDate: string | null;
  platformUserId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  ssCityCode?: string | null;
  ssBase?: number | null;
}

/** 身份中心用户（前后端契约） */
export interface IdentityUser {
  id: string;
  username: string;
  displayName: string;
  status: string;
  email: string | null;
  mobile: string | null;
  roles: string[];
  employeeId: string | null;
  employeeName: string | null;
  feishuBound: boolean;
  feishuOpenId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  temporaryPassword?: string;
}

/** 品牌公开配置 */
export interface BrandConfig {
  brandName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  logoFileId: string | null;
}

/** 报价 Bitable 配置 */
export interface QuotationBitableConfig {
  configured: boolean;
  appToken?: string;
  tableId?: string;
  fieldMap: Record<string, string>;
  enabled?: boolean;
}

/* ========== CRM ========== */

export interface Lead {
  id: string;
  code: string;
  customerName: string;
  source: string | null;
  contactName: string | null;
  contactPhone: string | null;
  customerId?: string | null;
  convertedOpportunityId?: string | null;
  status: LeadStatus;
  owner: string | null;
  followNote: string | null;
  nextDate: string | null;
  remark: string | null;
  createdAt: string;
}

export interface Opportunity {
  id: string;
  code: string;
  customerId: string;
  customerName: string;
  title: string;
  stage: OpportunityStage;
  amount: number;
  winRate: number;
  owner: string | null;
  expectedDate: string | null;
  remark: string | null;
  /** 最终成交报价单 */
  wonQuotationId: string | null;
  wonQuotationCode: string | null;
  wonQuotationTitle: string | null;
  contractId: string | null;
  quotationCount: number;
  createdAt: string;
}

/* ========== 报价单 ========== */

export type QuotationStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'converted'
  | 'void';

/** 商机下多轮报价摘要（详情页历史列表） */
export interface OpportunityQuotationSummary {
  id: string;
  code: string;
  roundNo: number | null;
  title: string;
  quoteDate: string | null;
  validUntil: string | null;
  status: QuotationStatus;
  totalAmount: number;
  estimatedCost: number;
  marginPct: number;
  remark: string | null;
  isWon: boolean;
  createdAt: string;
}

export interface OpportunityDetail extends Opportunity {
  quotations: OpportunityQuotationSummary[];
}

export interface QuotationItem {
  id: string;
  quotationId: string;
  seq: number;
  itemName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  estUnitCost: number;
  lineAmount: number;
  remark: string | null;
}

export interface QuotationItemInput {
  itemName: string;
  unit?: string;
  quantity: number;
  unitPrice: number;
  discountPct?: number;
  estUnitCost?: number;
  remark?: string;
}

export interface Quotation {
  id: string;
  code: string;
  customerId: string;
  customerName: string;
  opportunityId: string | null;
  opportunityTitle: string | null;
  roundNo: number | null;
  title: string;
  quoteDate: string | null;
  validUntil: string | null;
  status: QuotationStatus;
  discountPct: number;
  totalAmount: number;
  estimatedCost: number;
  marginPct: number;
  remark: string | null;
  contractId: string | null;
  isWon: boolean;
  items: QuotationItem[];
  createdAt: string;
}

export interface CreateQuotationDto {
  customerId: string;
  opportunityId?: string;
  title: string;
  quoteDate?: string;
  validUntil?: string;
  discountPct?: number;
  remark?: string;
  items: QuotationItemInput[];
}

export interface UpdateQuotationDto {
  /**
   * 客户。
   *
   * ⚠️ 原先**漏了这个字段**，导致"编辑报价单时改客户"被**静默丢弃**：
   * 前端编辑弹窗的「客户」下拉是可改的，提交走 `CreateQuotationDto`，
   * 而 PATCH 端点的 body 类是 `CreateQuotationBodyDto`（实现 Create 契约），
   * 因此 `customerId` 能通过 `forbidNonWhitelisted` 校验、**不会 400** ——
   * 但服务端 `update()` 的 patch 里没有它，于是请求成功、提示"已更新"，
   * 而客户仍是原值。使用者以为改成功了，之后按报价单转合同时会带到**错的客户**。
   *
   * 补齐后与 `title` / `opportunityId` 同一处理方式（`!== undefined` 才 patch）。
   */
  customerId?: string;
  opportunityId?: string;
  title?: string;
  quoteDate?: string;
  validUntil?: string;
  discountPct?: number;
  remark?: string;
  items?: QuotationItemInput[];
}

/* 报价云文档导入 */

export interface ParseQuotationDocDto {
  docUrl: string;
}

export interface ParsedQuotationItem {
  itemName: string;
  unit: string | null;
  quantity: number;
  unitPrice: number;
  discountPct: number | null;
  estUnitCost: number | null;
  remark: string | null;
}

export interface ParsedQuotationDraft {
  title: string | null;
  quoteDate: string | null;
  validUntil: string | null;
  remark: string | null;
  /** 整单折扣%（多维表格头字段，与行折扣区分） */
  headerDiscountPct?: number | null;
  items: ParsedQuotationItem[];
}

/* ========== 合同 ========== */

export interface Contract {
  id: string;
  code: string;
  name: string;
  customerId: string;
  customerName: string;
  billingModel: BillingModel;
  amount: number;
  taxRate: number;
  netAmount?: number;
  taxAmount?: number;
  taxEntityId?: string | null;
  rateSource?: string | null;
  status: ContractStatus;
  signDate: string | null;
  startDate: string | null;
  endDate: string | null;
  owner: string | null;
  paymentTerms: string | null;
  remark: string | null;
  createdAt: string;
}

export interface ContractMilestone {
  id: string;
  contractId: string;
  name: string;
  amount: number;
  dueCondition: string | null;
  dueDate: string | null;
  status: MilestoneStatus;
  actualDate: string | null;
  remark: string | null;
}

export interface ContractVersion {
  id: string;
  contractId: string;
  versionNo: number;
  changeLog: string;
  changeAmount: number;
  createdAt: string;
}

export interface Calloff {
  id: string;
  code: string;
  contractId: string;
  seq: number;
  projectId: string | null;
  projectName: string | null;
  amount: number;
  quantity?: number | null;
  unitPrice?: number | null;
  orderDate: string | null;
  remark: string | null;
}

export interface BillableSummary {
  contractAmount: number;
  invoicedAmount: number;
  billableAmount: number;
  calloffTotal: number;
}

export interface ContractDetail extends Contract {
  milestones: ContractMilestone[];
  calloffs: Calloff[];
  versions: ContractVersion[];
  billable: BillableSummary;
}

/* ========== 项目 ========== */

export interface Project {
  id: string;
  code: string;
  name: string;
  contractId: string;
  contractName: string;
  /** 最终成交报价单 */
  wonQuotationId: string | null;
  wonQuotationCode: string | null;
  wonQuotationTitle: string | null;
  wonQuotationAmount: number | null;
  opportunityId: string | null;
  opportunityTitle: string | null;
  pm: string | null;
  /** 项目经理系统用户 ID */
  pmUserId: string | null;
  deptName: string | null;
  budget: number;
  estimatedTotalCost: number;
  startDate: string | null;
  endDate: string | null;
  progress: number;
  status: ProjectStatus;
  remark: string | null;
  closeSummary: string | null;
  satisfaction: number | null;
  retrospective: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface ProjectMilestone {
  id: string;
  projectId: string;
  name: string;
  planDate: string | null;
  actualDate: string | null;
  status: MilestoneStatus;
  baselineDate: string | null;
  forecastDate: string | null;
  weightPct: number;
  remark: string | null;
}

export interface ProjectChange {
  id: string;
  code: string;
  projectId: string;
  changeType: ChangeType;
  content: string;
  beforeValue: string | null;
  afterValue: string | null;
  status: ChangeStatus;
  applicant: string | null;
  remark: string | null;
  createdAt: string;
}

export interface ProjectAccounting {
  budget: number;
  recognizedRevenue: number;
  totalCost: number;
  grossMargin: number;
  marginRate: number;
}

export interface ProjectDetail extends Project {
  milestones: ProjectMilestone[];
  changes: ProjectChange[];
  deliverables: DeliverableItem[];
  accounting: ProjectAccounting;
}

export type DeliverableStatus = 'pending' | 'submitted' | 'accepted' | 'returned';

export interface DeliverableItem {
  id: string;
  code: string;
  projectId: string;
  name: string;
  deliverableType: string;
  acceptanceCriteria: string | null;
  dueDate: string | null;
  status: DeliverableStatus;
  reviewer: string | null;
  submittedAt: string | null;
  acceptedAt: string | null;
  acceptConclusion: string | null;
  returnedReason: string | null;
  remark: string | null;
  createdAt: string;
}

export interface ChainCustomer {
  id: string;
  code: string;
  name: string;
  industry: string | null;
  creditLevel: string | null;
  creditLimit: number;
  termsDays: number;
}

export interface ChainContractSummary {
  id: string;
  code: string;
  name: string;
  billingModel: string | null;
  amount: number;
  taxRate: number;
  /** 合同所属纳税主体，前端用于按纳税人类型过滤税率下拉 */
  taxEntityId?: string | null;
  status: string | null;
  signDate: string | null;
  startDate: string | null;
  endDate: string | null;
  owner: string | null;
  paymentTerms: string | null;
}

export interface ChainRevenuePeriod {
  period: string;
  amount: number;
}

export interface ChainCostTypeItem {
  costType: string;
  amount: number;
}

export interface ChainInvoiceItem {
  id: string;
  code: string;
  invoiceNo: string | null;
  invoiceType: string | null;
  amount: number;
  taxRate: number;
  taxAmount: number;
  invoiceDate: string | null;
  status: string | null;
}

export interface ChainArItem {
  id: string;
  code: string;
  amount: number;
  settledAmount: number;
  dueDate: string | null;
  status: string | null;
  ownerUserId: string | null;
}

export interface ChainApItem {
  id: string;
  code: string;
  supplierName: string | null;
  amount: number;
  paidAmount: number;
  dueDate: string | null;
  status: string | null;
}

export interface ChainTimesheetItem {
  employeeName: string;
  confirmedHours: number;
  totalHours: number;
}

export interface ChainQuotationItem {
  id: string;
  code: string;
  title: string;
  quoteDate: string | null;
  status: QuotationStatus;
  totalAmount: number;
  estimatedCost: number;
  marginPct: number;
}

export interface ChainMilestoneItem {
  id: string;
  name: string;
  status: MilestoneStatus;
  planDate: string | null;
  baselineDate: string | null;
  forecastDate: string | null;
  weightPct: number;
}

export interface ProjectChainOverview {
  customer: ChainCustomer | null;
  contract: ChainContractSummary | null;
  quotations: ChainQuotationItem[];
  milestones: ChainMilestoneItem[];
  revenueByPeriod: ChainRevenuePeriod[];
  /**
   * 已确认收入的**含税**合计（= `revenueByPeriod` 各行 `amount` 之和）。
   *
   * 注意与 `revenueNetTotal` 的区别：`erp_project_revenue.amount` 存的是**价税合计**，
   * 而项目核算口径（毛利/毛利率、`recognizedRevenue`）用的是**不含税净额**
   * （按合同税率拆分，见 `projects.service.ts` 的 accounting 查询）。
   * 两个数在含税项目上必然不相等，界面必须分别标注，否则同一个项目会出现
   * 两个数值不同但同名的"已确认收入"。
   */
  revenueGrossTotal: number;
  /**
   * 已确认收入的**不含税净额**合计（按合同税率拆分）。
   * 与 `accounting.recognizedRevenue` 同口径，可直接与成本相减算毛利。
   */
  revenueNetTotal: number;
  costByType: ChainCostTypeItem[];
  periodExpense: number;
  invoices: ChainInvoiceItem[];
  invoiceTotalAmount: number;
  arItems: ChainArItem[];
  arTotalAmount: number;
  arOpenAmount: number;
  apItems: ChainApItem[];
  apTotalAmount: number;
  apOpenAmount: number;
  timesheetByEmployee: ChainTimesheetItem[];
  totalHours: number;
}

/* 项目云归档同步 */

export interface DriveSyncDetail {
  fileName: string;
  status: 'synced' | 'skipped' | 'failed';
  remark: string | null;
}

export interface ProjectDriveSyncResult {
  projectId: string;
  folderToken: string | null;
  folderUrl: string | null;
  syncedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  archiveDocUrl: string | null;
  wikiPermissionDenied: boolean;
  details: DriveSyncDetail[];
}

export interface DriveSyncStatusItem {
  attachmentId: string;
  fileName: string;
  syncStatus: 'pending' | 'synced' | 'skipped' | 'failed';
  remark: string | null;
}

export interface ProjectDriveSyncStatus {
  folderUrl: string | null;
  archiveDocUrl: string | null;
  lastSyncedAt: string | null;
  items: DriveSyncStatusItem[];
}

/* ========== 成本 ========== */

export interface CostItem {
  id: string;
  code: string;
  projectId: string;
  projectName: string;
  costType: CostType;
  amount: number;
  period: string;
  occurredDate: string | null;
  sourceRef: string;
  supplierName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  contractId: string | null;
  contractName: string | null;
  remark: string | null;
  createdAt: string;
}

export interface LaborRate {
  id: string;
  roleName: string;
  rate: number;
  effectiveFrom: string | null;
}

export interface Timesheet {
  id: string;
  code: string;
  projectId: string;
  projectName: string;
  employeeName: string;
  employeeId?: string | null;
  roleName: string | null;
  workDate: string | null;
  hours: number;
  status: TimesheetStatus;
  costGenerated: boolean;
  remark: string | null;
  createdAt: string;
}

export interface CostAllocation {
  id: string;
  code: string;
  sourceDesc: string;
  costType: CostType;
  amount: number;
  targetProjectId: string;
  targetProjectName: string;
  period: string;
  sourceRef: string;
  remark: string | null;
}

/**
 * D-07：一笔公共成本按**权重**分摊到多个项目。
 *
 * 为什么需要：原先 `CreateAllocationDto` 只能指定**一个**
 * `targetProjectId` + 一个 `amount`，把一笔公共成本拆到 N 个项目
 * 就要手工算 N 次金额、发 N 次请求 —— 金额靠人手算，
 * 而分摊额之和必须严格等于被分摊总额（差 1 分凭证就不平），
 * 这种人工算术正是最容易出错的地方。
 *
 * 现在可以给出权重，由服务端用**最大余数法**分摊并保证
 * `Σ share === amount`（到分），一个请求生成 N 条分摊记录。
 */
export interface CostAllocationTarget {
  projectId: string;
  /** 分摊权重（如工时、收入占比、机时）。必须 > 0 */
  weight: number;
}

export interface CreateCostAllocationBatchDto {
  sourceDesc: string;
  costType: CostType;
  /** 待分摊总额（含税口径与单目标模式一致） */
  amount: number;
  period: string;
  sourceRef: string;
  /** 分摊目标与权重，至少 1 项 */
  targets: CostAllocationTarget[];
  remark?: string;
}

/** 分摊结果：每个目标实际分到的金额（`Σ amount === 请求的 amount`） */
export interface CostAllocationBatchResult {
  /** 本批生成的公共成本分摊单编号（与 targets 一一对应） */
  allocations: CostAllocation[];
  /** 分摊前总额（= 请求的 amount） */
  totalAmount: number;
  /** 分配合计（服务端保证等于 totalAmount，供调用方自检） */
  allocatedAmount: number;
  /** 因四舍五入被补齐 1 分的项数（向使用者解释尾差去向） */
  adjustedCount: number;
  /** 权重合计为 0 时是否退化为平均分摊 */
  equalFallback: boolean;
}

export interface CostTypeSummary {
  costType: CostType;
  amount: number;
}

export type CostDimension = 'costType' | 'department' | 'contract' | 'period';

export interface CostDimensionSummary {
  dimension: CostDimension;
  key: string;
  label: string;
  amount: number;
}

/* ========== 收入 ========== */

export interface RevenueItem {
  id: string;
  code: string;
  projectId: string;
  projectName: string;
  contractId: string | null;
  period: string;
  method: RevenueMethod;
  amount: number;
  basis: string | null;
  status: string;
  remark: string | null;
  createdAt: string;
}

export interface RevenueAdjust {
  id: string;
  code: string;
  revenueId: string;
  adjustType: AdjustType;
  amount: number;
  reason: string | null;
  status: string;
  createdAt: string;
}

export interface UnbilledItem {
  projectId: string;
  projectName: string;
  recognizedAmount: number;
  invoicedAmount: number;
  unbilledAmount: number;
}

/**
 * N-3 / B-4：收入→应收→凭证 三方对账自检的缺口类型。
 *
 * - `missing_ar`          ：有合同却查不到应收单（收入确认时应收未落库）
 * - `ar_amount_mismatch`  ：应收金额 ≠ 已确认收入金额（两条链路金额口径分叉）
 * - `missing_voucher`     ：既无凭证、也不在补偿队列（凭证彻底缺失）
 * - `voucher_pending`     ：凭证在 `comp_voucher_job` 队列中待重试（可由重试任务自愈）
 */
export type RevenueChainGapKind =
  | 'missing_ar'
  | 'ar_amount_mismatch'
  | 'missing_voucher'
  | 'voucher_pending';

export interface RevenueChainGap {
  revenueId: string;
  code: string;
  projectId: string;
  projectName: string;
  contractId: string | null;
  period: string;
  amount: number;
  gapKind: RevenueChainGapKind;
  /** 中文说明，直接可展示（含存在的另一侧金额等） */
  detail: string;
}

export interface RevenueChainReconcileResult {
  /** 本次检查限定的期间；未指定时为 null（全量） */
  period: string | null;
  /** 纳入检查的已确认收入笔数 */
  checked: number;
  /** 缺口条数（= gaps.length，便于前端免遍历判断） */
  gapCount: number;
  /** 是否全部三方一致 */
  consistent: boolean;
  gaps: RevenueChainGap[];
}

/* ========== 应收应付 ========== */

export interface ArItem {
  id: string;
  code: string;
  contractId: string | null;
  contractName: string | null;
  customerId: string;
  customerName: string;
  projectId: string | null;
  projectName: string | null;
  amount: number;
  settledAmount: number;
  dueDate: string | null;
  status: ArStatus;
  source: string;
  overdue: boolean;
  ownerUserId: string | null;
  /** B1：作废原因（仅 `status='voided'` 有值） */
  voidReason: string | null;
  /** B1：作废时间（ISO 字符串） */
  voidedAt: string | null;
  /** B1：作废操作人 */
  voidedBy: string | null;
  remark: string | null;
  createdAt: string;
}

export interface ReceiptItem {
  id: string;
  code: string;
  customerId: string;
  customerName: string;
  amount: number;
  receiptDate: string | null;
  method: string;
  source: string | null;
  status: ReceiptStatus;
  remark: string | null;
  createdAt: string;
}

export interface ApItem {
  id: string;
  code: string;
  supplierId: string;
  supplierName: string;
  projectId: string | null;
  projectName: string | null;
  amount: number;
  paidAmount: number;
  dueDate: string | null;
  status: ApStatus;
  source: string;
  sourceRef: string | null;
  /** B1：作废原因（仅 `status='voided'` 有值） */
  voidReason: string | null;
  /** B1：作废时间（ISO 字符串） */
  voidedAt: string | null;
  /** B1：作废操作人 */
  voidedBy: string | null;
  remark: string | null;
  createdAt: string;
}

export interface PaymentItem {
  id: string;
  code: string;
  apId: string;
  apCode: string | null;
  supplierId: string;
  supplierName: string;
  amount: number;
  payDate: string | null;
  method: string;
  status: PaymentStatus;
  approver: string | null;
  remark: string | null;
  createdAt: string;
}

export interface InvoiceItem {
  id: string;
  code: string;
  contractId: string;
  contractName: string;
  customerId: string;
  customerName: string;
  projectId: string | null;
  projectName: string | null;
  invoiceNo: string | null;
  invoiceType: InvoiceType;
  direction: InvoiceDirection;
  supplierId: string | null;
  supplierName: string | null;
  arId: string | null;
  arCode: string | null;
  /** 进项勾稽应付 */
  apId: string | null;
  apCode: string | null;
  amount: number;
  taxRate: number;
  taxAmount: number;
  invoiceDate: string | null;
  status: InvoiceStatus;
  /** C-01：查验状态 */
  verifyStatus: InvoiceVerifyStatus;
  /** C-01：最近查验时间（ISO 字符串，未查验为 null） */
  verifyTime: string | null;
  /** C-01：查验失败原因 */
  verifyError: string | null;
  /** C-01：勾选认证状态 */
  certificationStatus: InvoiceCertificationStatus;
  /** C-01：勾选所属税款所属期 YYYY-MM */
  certificationPeriod: string | null;
  /**
   * P0-C / P0-D：该发票是否为**红字发票**（冲减票）。
   *
   * 由 `sourceRef` 存在且金额为负判定。红字发票参与增值税底稿的销项/进项汇总
   * （负数即冲减），但**不可**被勾选认证（认证路径会拒绝）。
   */
  isRedLetter: boolean;
  /**
   * P0-C：该发票所属期是否已有**已确认**的增值税申报底稿。
   *
   * `true` 时不可作废（跨月/已申报只能开红字发票），前端据此禁用「作废」按钮
   * 并提示改走红字流程 —— 而不是让用户点了才报错。
   */
  declaredPeriodConfirmed: boolean;
  /** B1 / P0-C：作废原因 */
  voidReason: string | null;
  /** B1 / P0-C：作废时间（ISO 字符串） */
  voidedAt: string | null;
  /** B1 / P0-C：作废操作人 */
  voidedBy: string | null;
  remark: string | null;
  createdAt: string;
  /** 软提示，如开票额超过已确认收入 */
  warning?: string;
}

/* ===================== C-01 发票查验与勾选认证 ===================== */

/** Provider 查验结果（由具体查验实现返回，服务层据此落库） */
export interface InvoiceVerifyOutcome {
  /** 是否在税局/第三方存在且要素一致 */
  verified: boolean;
  /** 查验来源：none=未接入查验/ manual=人工确认/ vendor=第三方服务商 */
  source: 'none' | 'manual' | 'vendor';
  /** 人读结论（成功或失败原因） */
  message: string;
  /** 结构化明细（如税局返回的发票要素，供核对/审计） */
  details?: Record<string, unknown>;
}

/** 单次查验后的返回（含落库后的状态与审计信息） */
export interface InvoiceVerifyResult {
  id: string;
  code: string;
  verifyStatus: InvoiceVerifyStatus;
  verifyTime: string | null;
  verifyError: string | null;
  /** 本次查验来源 */
  source: 'none' | 'manual' | 'vendor';
  message: string;
}

/** 批量查验结果（逐张隔离，单张失败不阻断其余） */
export interface BatchInvoiceVerifyResult {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  items: Array<{
    id: string;
    code: string;
    verifyStatus: InvoiceVerifyStatus;
    message: string;
  }>;
}

/** 发票查验/认证状态视图（GET verify-status 返回） */
export interface InvoiceVerifyStatusView {
  id: string;
  code: string;
  direction: InvoiceDirection;
  status: InvoiceStatus;
  verifyStatus: InvoiceVerifyStatus;
  verifyTime: string | null;
  verifyError: string | null;
  certificationStatus: InvoiceCertificationStatus;
  certificationPeriod: string | null;
  certifiedAt: string | null;
}

/** C-01：勾选认证入参（class DTO 的契约类型，API-1） */
export interface CertifyInvoiceDto {
  /** 勾选所属税款所属期，格式 YYYY-MM */
  certificationPeriod: string;
  /** 认证动作：certify=认证 / deduct=已抵扣 */
  action?: 'certify' | 'deduct';
}

/** C-01：批量查验入参 */
export interface BatchInvoiceVerifyDto {
  /** 发票 id 列表（1~200） */
  ids: string[];
}

export interface AgingBucket {
  label: string;
  amount: number;
  count: number;
}

export interface CashFlowWeek {
  weekStart: string;
  inflow: number;
  outflow: number;
  netFlow: number;
  cumulativeCash: number;
}

export interface CashFlowForecast {
  openingCash: number;
  weeks: CashFlowWeek[];
}

export interface FinanceSummary {
  openArAmount: number;
  overdueArAmount: number;
  receivedTotal: number;
  openApAmount: number;
  paidTotal: number;
  invoiceTotal: number;
}

/* ========== BI ========== */

export interface BiOverview {
  contractAmount: number;
  recognizedRevenue: number;
  totalCost: number;
  grossMargin: number;
  marginRate: number;
  openArAmount: number;
  openApAmount: number;
  activeProjectCount: number;
  activeContractCount: number;
  customerCount: number;
  periodExpenseTotal: number;
  operatingProfit: number;
}

export interface ProjectMargin {
  projectId: string;
  code: string;
  name: string;
  pm: string | null;
  recognizedRevenue: number;
  totalCost: number;
  grossMargin: number;
  marginRate: number;
  allocatedFixedCost: number;
  contributionMargin: number;
}

export interface BiProjectCostBreakdownItem {
  costType: string;
  totalAmount: number;
  /** 占该项目成本总额的百分比（0-100，一位小数语义） */
  ratio?: number;
}

export type ProjectHealthLevel = 'healthy' | 'watch' | 'over_budget' | 'unreachable';

export interface ProjectFinancialHealthItem {
  projectId: string;
  code: string;
  name: string;
  pm: string | null;
  budget: number;
  estimatedTotalCost: number;
  actualCost: number;
  recognizedRevenue: number;
  projectedFinalCost: number;
  healthLevel: ProjectHealthLevel;
  healthReason: string | null;
  spi: number | null;
  cpi: number | null;
  eac: number | null;
  overdueMilestoneCount: number;
  /**
   * B3：里程碑权重合计（仅计权重 > 0 的里程碑）。
   *
   * 与 `milestoneWeightBalanced` 一起把"进度基准是否配平"暴露到前端：
   * 权重和 ≠ 100 时 SPI/CPI 本身仍是有效比值（分母已归一化），
   * 但它**不再等价于"完成百分比"** —— 只看 SPI 会误判。
   */
  milestoneWeightTotal: number;
  /** B3：|Σ权重 − 100| ≤ 0.01。false 时前端必须显示"进度基准未配平"提示 */
  milestoneWeightBalanced: boolean;
}

export interface ProjectFinancialHealthSummary {
  items: ProjectFinancialHealthItem[];
  overBudgetCount: number;
  watchCount: number;
}

export interface CustomerContribution {
  customerId: string;
  name: string;
  contractAmount: number;
  recognizedRevenue: number;
  openArAmount: number;
}

export interface MonthlyTrend {
  period: string;
  revenue: number;
  cost: number;
  periodExpense: number;
}

/* ========== 审计 ========== */

export interface AuditLog {
  id: string;
  actor: string;
  action: string;
  objectType: string;
  objectId: string | null;
  objectCode: string | null;
  statusBefore: string | null;
  statusAfter: string | null;
  detail: string | null;
  createdAt: string;
}

/* ========== 请求 DTO ========== */

export interface CreateCustomerDto {
  name: string;
  uscc?: string;
  industry?: string;
  creditLevel?: string;
  creditLimit?: number;
  termsDays?: number;
  status?: string;
  remark?: string;
  taxEntityId?: string | null;
  defaultTaxRate?: number | null;
}

export interface UpdateCustomerDto {
  name?: string;
  uscc?: string;
  industry?: string;
  creditLevel?: string;
  creditLimit?: number;
  termsDays?: number;
  status?: string;
  remark?: string;
  taxEntityId?: string | null;
  defaultTaxRate?: number | null;
}

export interface CreateContactDto {
  name: string;
  phone?: string;
  email?: string;
  position?: string;
  isPrimary?: boolean;
  remark?: string;
}

export interface CreateSupplierDto {
  name: string;
  type?: string;
  contactName?: string;
  contactPhone?: string;
  bankAccount?: string;
  rating?: number;
  status?: string;
  remark?: string;
  taxEntityId?: string | null;
  defaultTaxRate?: number | null;
}

export interface UpdateSupplierDto {
  name?: string;
  type?: string;
  contactName?: string;
  contactPhone?: string;
  bankAccount?: string;
  rating?: number;
  status?: string;
  remark?: string;
  taxEntityId?: string | null;
  defaultTaxRate?: number | null;
}

export interface CreateLeadDto {
  customerName: string;
  customerId?: string;
  source?: string;
  contactName?: string;
  contactPhone?: string;
  owner?: string;
  nextDate?: string;
  remark?: string;
}

export interface UpdateLeadDto {
  status?: LeadStatus;
  /**
   * 关联客户。`null` = **解除关联**（PATCH 语义：`undefined` 才是不改）。
   *
   * 为什么需要 `null`：转商机要求线索已关联客户，而跟进弹窗的客户下拉里
   * 必然有"未关联"这一档；只有允许显式清空，界面才与服务端状态一致。
   */
  customerId?: string | null;
  followNote?: string;
  nextDate?: string;
  remark?: string;
}

export interface CreateOpportunityDto {
  customerId: string;
  title: string;
  amount?: number;
  winRate?: number;
  owner?: string;
  expectedDate?: string;
  remark?: string;
}

export interface UpdateOpportunityDto {
  stage?: OpportunityStage;
  amount?: number;
  winRate?: number;
  remark?: string;
  owner?: string;
  expectedDate?: string;
  /** 选定最终成交报价单；传 null 清除 */
  wonQuotationId?: string | null;
}

export interface CreateMilestoneDto {
  name: string;
  amount: number;
  dueCondition?: string;
  dueDate?: string;
  remark?: string;
}

export interface CreateContractDto {
  name: string;
  customerId: string;
  billingModel: BillingModel;
  amount: number;
  taxRate?: number;
  taxEntityId?: string;
  signDate?: string;
  startDate?: string;
  endDate?: string;
  owner?: string;
  paymentTerms?: string;
  remark?: string;
  milestones?: CreateMilestoneDto[];
}

export interface UpdateContractDto {
  name?: string;
  amount?: number;
  taxRate?: number;
  taxEntityId?: string;
  /**
   * 合同客户。
   *
   * ⚠️ 服务端**只允许 `draft` 状态**修改（与 `amount` 同一判据，见
   * `server/modules/contracts/contract-update-guard.ts`）：客户一改，
   * 已开具的发票与已登记的应收仍挂在**原客户**上，而
   * `applyWriteoffInTx`（`server/modules/finance/ar.service.ts`）有
   * 「回款客户与应收客户不一致，不可核销」的守卫 —— 改了会让既有应收**无法核销**。
   * 非 draft 会被 400 拒绝（可读中文原因）。
   */
  customerId?: string;
  /**
   * 计费模式。与 `name` / `taxRate` 同级：属**普通**可改字段，
   * 但已关闭/已终止（冻结状态）的合同不可改。
   */
  billingModel?: BillingModel;
  /** 签订日期；`null` 表示**清空**，`undefined` 表示不改（PATCH 语义） */
  signDate?: string | null;
  owner?: string;
  paymentTerms?: string;
  /** 开始日期；`null` 表示**清空**，`undefined` 表示不改 */
  startDate?: string | null;
  /** 结束日期；`null` 表示**清空**，`undefined` 表示不改 */
  endDate?: string | null;
  remark?: string;
  /*
   * ⚠️ 这里**有意没有** `milestones`（新建用的 `CreateContractDto` 有）。
   *
   * 里程碑已有独立的写入路径 —— `POST /api/contracts/:id/milestones`（登记）与
   * `PATCH /api/contracts/milestones/:id`（达成/改名/改额），前端入口是合同详情页的
   * 「登记里程碑」弹窗。若把里程碑并进本契约，同一份数据就有了**两条写入路径**：
   * 编辑表单提交的是**打开弹窗那一刻的旧快照**，会覆盖掉期间在详情页刚登记/刚达成的
   * 里程碑（谁后写入谁生效），且"改里程碑"到底走状态机还是走全量覆盖将无法判定。
   * 故本契约只承载合同**表头**字段。
   */
}

export type ContractStatusAction = 'submit' | 'approve' | 'reject' | 'start' | 'complete' | 'close' | 'terminate';

export interface CreateCalloffDto {
  amount: number;
  quantity?: number;
  unitPrice?: number;
  projectId?: string;
  orderDate?: string;
  remark?: string;
}

export interface ContractChangeDto {
  changeLog: string;
  newAmount?: number;
}

export interface CreateProjectDto {
  name: string;
  contractId: string;
  /** 关联最终成交报价单（须属于所选合同对应商机，或已转合同的报价） */
  wonQuotationId?: string;
  pm?: string;
  pmUserId?: string;
  deptName?: string;
  budget?: number;
  estimatedTotalCost?: number;
  startDate?: string;
  endDate?: string;
  remark?: string;
}

/**
 * B6：项目状态动作。
 *
 * cancel（取消/终止）与 eopen（反结项）是本轮新增的**退出路径** ——
 * 原表只有 4 条正向流转，导致项目一旦进入任一非终态就无法退出，
 * 且已结项无法撤回（详见 projects.transform.ts 的 PROJECT_STATUS_FLOW）。
 */
export type ProjectStatusAction =
  | 'approve'
  | 'deliver'
  | 'accept'
  | 'close'
  | 'cancel'
  | 'reopen';

export interface UpdateProjectDto {
  progress?: number;
  pm?: string;
  pmUserId?: string | null;
  budget?: number;
  estimatedTotalCost?: number;
  endDate?: string;
  remark?: string;
  wonQuotationId?: string | null;
}

export interface CreateProjectMilestoneDto {
  name: string;
  planDate?: string;
  weightPct?: number;
  remark?: string;
}

export interface UpdateProjectMilestoneDto {
  forecastDate?: string;
  weightPct?: number;
  remark?: string;
}

export interface CloseProjectDto {
  closeSummary: string;
  satisfaction?: number;
  retrospective?: string;
}

export interface CreateDeliverableDto {
  name: string;
  deliverableType?: string;
  acceptanceCriteria?: string;
  dueDate?: string;
  reviewer?: string;
  remark?: string;
}

export interface UpdateDeliverableDto {
  name?: string;
  deliverableType?: string;
  acceptanceCriteria?: string;
  dueDate?: string;
  reviewer?: string;
  remark?: string;
}

export interface AcceptDeliverableDto {
  reviewer?: string;
  acceptConclusion?: string;
}

export interface ReturnDeliverableDto {
  reason: string;
}

export interface CreateProjectChangeDto {
  changeType: ChangeType;
  content: string;
  beforeValue?: string;
  afterValue?: string;
  applicant?: string;
  remark?: string;
}

export interface CreateCostDto {
  projectId: string;
  costType: CostType;
  amount: number;
  occurredDate?: string;
  sourceRef: string;
  supplierId?: string;
  departmentId?: string;
  remark?: string;
}

export interface CreateTimesheetDto {
  projectId: string;
  employeeId?: string;
  employeeName?: string;
  roleName?: string;
  workDate: string;
  hours: number;
  remark?: string;
}

export type TimesheetAction = 'submit' | 'confirm' | 'reject';

export interface CreateLaborRateDto {
  roleName: string;
  rate: number;
  effectiveFrom?: string;
}

export interface CreateAllocationDto {
  sourceDesc: string;
  costType: CostType;
  amount: number;
  targetProjectId: string;
  period: string;
  sourceRef: string;
  remark?: string;
}

export interface CreateRevenueDto {
  projectId: string;
  period: string;
  method: RevenueMethod;
  amount: number;
  basis?: string;
  remark?: string;
}

export interface CreateRevenueAdjustDto {
  revenueId: string;
  adjustType: AdjustType;
  amount: number;
  reason?: string;
}

export interface ReverseRevenueDto {
  reason?: string;
}

export interface CreateProjectRevenueDto {
  /** 收入确认期间，格式 YYYY-MM */
  period: string;
  amount: number;
  note?: string;
}

export interface ProjectRevenueItem {
  id: string;
  code: string;
  projectId: string;
  contractId: string | null;
  period: string;
  amount: number;
  status: string;
  remark: string | null;
  createdAt: string;
}

export interface CreateArDto {
  contractId: string;
  amount: number;
  dueDate?: string;
  projectId?: string;
  source?: string;
  /** 幂等键（收入确认等）：同一 sourceRef 至多一条应收 */
  sourceRef?: string;
  remark?: string;
  ownerUserId?: string;
}

export interface CreateReceiptDto {
  customerId: string;
  amount: number;
  receiptDate?: string;
  method?: string;
  source?: string;
  remark?: string;
  /**
   * 登记回款时**直接指定要核销的应收单**（可选）。
   *
   * ## 为什么需要它
   *
   * 项目详情页的「登记回款」弹窗要求使用者**必选**一张应收单
   * （`receiptSchema.arId` 为 `min(1)`），并显示「该应收单未回款 ¥X」。
   * 但契约里原先**没有这个字段**，提交的 DTO 也不含它 —— 于是那个必选项
   * 被**静默丢弃**：生成的回款单状态是 `unmatched`，与所选应收单毫无关联，
   * 而使用者以为这笔钱已经回款到那张单上了。
   *
   * ## 语义
   *
   * 传了它就表示"这笔回款就是要核销这张应收"：服务端在**同一事务内**
   * 创建回款并核销该应收（核销金额即 `amount`），回款状态随之变为
   * `matched` / `partial`。不传则维持原行为（登记为 `unmatched`，
   * 之后再单独核销）。
   *
   * 校验与独立「核销」入口**共用同一份实现**
   * （`ArService.applyWriteoffInTx`），因此作废应收、客户不一致、
   * 超额核销这些守卫一条都不会少。
   */
  arId?: string;
}

export interface ArWriteoffDto {
  arId: string;
  receiptId: string;
  amount: number;
}

export interface ApWriteoffDto {
  apId: string;
  paymentId: string;
  amount: number;
}

export interface CreateApDto {
  supplierId: string;
  amount: number;
  dueDate?: string;
  projectId?: string;
  source?: string;
  remark?: string;
  sourceRef?: string;
}

export interface CreatePaymentDto {
  apId: string;
  amount: number;
  payDate?: string;
  method?: string;
  remark?: string;
}

/* ========== 外协供应商结算 ========== */

export interface VendorSettlementLine {
  employeeId: string;
  employeeName: string;
  roleName: string | null;
  hours: number;
  rate: number;
  amount: number;
}

export interface VendorSettlementPreview {
  supplierId: string;
  supplierName: string;
  period: string;
  projectId: string | null;
  lines: VendorSettlementLine[];
  totalAmount: number;
  sourceRef: string;
  alreadyGenerated: boolean;
}

export interface GenerateVendorSettlementDto {
  supplierId: string;
  period: string;
  projectId?: string | null;
  dueDate?: string;
}

export interface GenerateVendorSettlementResult {
  apId: string;
  code: string;
  amount: number;
}

/* ========== 项目周报/纪要 ========== */

export const MINUTES_TYPES = ['weekly_report', 'meeting'] as const;

export type MinutesType = (typeof MINUTES_TYPES)[number];

export interface ProjectMinutes {
  id: string;
  projectId: string;
  title: string;
  minutesType: MinutesType;
  meetingDate: string;
  content: string | null;
  createdAt: string;
}

export interface CreateProjectMinutesDto {
  title: string;
  minutesType: MinutesType;
  meetingDate: string;
  content?: string;
}

export type PaymentAction = 'approve' | 'reject';

export interface CreateInvoiceDto {
  contractId?: string;
  invoiceType: InvoiceType;
  direction?: InvoiceDirection;
  supplierId?: string;
  arId?: string;
  /** 进项发票勾稽应付单 */
  apId?: string;
  amount: number;
  taxRate?: number;
  projectId?: string;
  /** 发票号码（真实票号，缺省用系统编号占位） */
  invoiceNo?: string;
  invoiceDate?: string;
  remark?: string;
}

export interface UpdateInvoiceDto {
  invoiceNo?: string;
  arId?: string | null;
  remark?: string;
  /**
   * ## 登记后编辑（用户要求）
   *
   * 下面这些字段原先**不可编辑** —— 发票登记时录错金额/税率/日期，只能作废重开。
   * 现按本仓既有的记账哲学放开：**仅当该发票的记账凭证尚未过账时**可改，
   * 改动后服务端会重建凭证（作废旧草稿 + 重新生成）。
   *
   * 判据与文案见 `server/modules/finance/invoice-edit-guard.ts`（含 9 条断言）：
   * - 凭证 `draft` / 无凭证 / 已作废 → 可改，且重建凭证
   * - 凭证 `posted` → **拒绝**，提示「先作废该发票（会生成冲回凭证）再重新登记」
   *
   * 这条限制来自 `voucher.controller.ts:317` 的既有约定：
   * *「仅草稿凭证可改（已过账凭证的分录摘要属于已入账信息，改动需走红冲）」*。
   * 已过账还允许改，会让明细账与发票台账永久对不上 —— 而使用者以为自己只是改了张单子。
   */
  amount?: number;
  taxRate?: number;
  invoiceDate?: string;
  invoiceType?: InvoiceType;
  direction?: InvoiceDirection;
  projectId?: string | null;
  contractId?: string | null;
  supplierId?: string | null;
  apId?: string | null;
}

/* ========== 人力资源（二期A） ========== */

export type EmployeeStatus = 'probation' | 'active' | 'resigned';
export type LeaveType = 'annual' | 'sick' | 'personal';
export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected';
export type AttendanceStatus = 'present' | 'absent' | 'late' | 'leave';
/**
 * 工资单状态。
 *
 * B12（§7.2）：新增 'paid'（已发放）与 'voided'（作废）两个**终态**。
 *
 * 原状态集到 pproved 就停了 —— 而"已批准"只表示**同意发**，
 * 不表示**已经发了**。后果：
 *   · 无法区分"批准了但还没打款"和"已打款"，出纳只能靠线下表格跟踪；
 *   · 现金流出预测里工资是"按最近已审批周期应发总额"估的，
 *     与实际是否已付无关（这一点对预测无妨，但对账龄/对账有害）；
 *   · 误批准的工资单**没有任何退出路径**（与 B1 的应收/应付同源问题）。
 *
 * oided 的前置条件是"尚未发放"（llocationGenerated 与凭证需一并处理），
 * 因为已发放的工资单作废涉及资金追回，不是系统能单方面决定的事。
 */
export type PayrollStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'paid'
  | 'voided';
export type CandidateStage = 'pending' | 'interview' | 'offer' | 'hired' | 'rejected';
export type AppraisalStatus = 'draft' | 'confirmed';
export type TrainingStatus = 'planned' | 'done';

export interface Department {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
  status: string;
  remark: string | null;
  createdAt: string;
}

export interface Position {
  id: string;
  code: string;
  name: string;
  roleName: string | null;
  status: string;
  remark: string | null;
  createdAt: string;
}

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  workDate: string;
  status: AttendanceStatus;
  remark: string | null;
}

export interface LeaveBalance {
  id: string;
  employeeId: string;
  employeeName: string;
  leaveType: LeaveType;
  year: string;
  totalDays: number;
  usedDays: number;
  remainingDays: number;
}

export interface LeaveRequest {
  id: string;
  code: string;
  employeeId: string;
  employeeName: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: LeaveRequestStatus;
  createdAt: string;
}

export interface PayrollItem {
  id: string;
  code: string;
  employeeId: string;
  employeeName: string;
  period: string;
  baseSalary: number;
  perfSalary: number;
  allowance: number;
  socialInsurance: number;
  housingFund: number;
  tax: number;
  netSalary: number;
  status: PayrollStatus;
  allocationGenerated: boolean;
  remark: string | null;
  createdAt: string;
}

export interface RecruitReq {
  id: string;
  code: string;
  departmentId: string | null;
  departmentName: string | null;
  title: string;
  headcount: number;
  hiredCount: number;
  status: string;
  remark: string | null;
  createdAt: string;
}

export interface Candidate {
  id: string;
  code: string;
  recruitReqId: string;
  recruitReqTitle: string | null;
  name: string;
  phone: string | null;
  stage: CandidateStage;
  remark: string | null;
  createdAt: string;
}

export interface AppraisalItem {
  id: string;
  code: string;
  employeeId: string;
  employeeName: string;
  period: string;
  score: number;
  grade: string | null;
  status: AppraisalStatus;
  remark: string | null;
  createdAt: string;
}

export interface Training {
  id: string;
  code: string;
  name: string;
  trainer: string | null;
  hours: number;
  startDate: string | null;
  endDate: string | null;
  status: TrainingStatus;
  attendeeCount: number;
  remark: string | null;
  createdAt: string;
}

export interface HeadcountPoint {
  month: string;
  count: number;
}

export interface HrOverview {
  activeCount: number;
  probationCount: number;
  hiredThisYear: number;
  resignedThisYear: number;
  revenuePerHead: number;
  headcountTrend: HeadcountPoint[];
  /** 最近一个已审批工资单周期（YYYY-MM），无已审批工资单时为 null */
  latestLaborCostPeriod: string | null;
  /** 最近已审批周期人力成本（实发 + 社保 + 公积金） */
  latestLaborCost: number;
  /** 近 30 天人均确认项目工时（小时） */
  avgProjectHoursPerHead: number;
  /** 在职员工部门分布 */
  departmentDistribution: DepartmentHeadcount[];
  /** 近 6 个月工资总包 vs 项目人力成本 */
  laborCostTrend: LaborCostPoint[];
}

export interface DepartmentHeadcount {
  departmentName: string;
  count: number;
}

export interface LaborCostPoint {
  period: string;
  /** 已审批工资单口径：实发 + 社保 + 公积金 */
  payrollCost: number;
  /** 工时归集生成的项目人力成本（cost_type = labor） */
  projectLaborCost: number;
}

export interface CreateDepartmentDto {
  name: string;
  parentId?: string;
  remark?: string;
}

export interface UpdateDepartmentDto {
  name?: string;
  parentId?: string;
  status?: string;
  remark?: string;
}

export interface CreatePositionDto {
  name: string;
  roleName?: string;
  remark?: string;
}

export interface UpdatePositionDto {
  name?: string;
  roleName?: string;
  status?: string;
  remark?: string;
}

export interface CreateEmployeeDto {
  name: string;
  departmentId?: string;
  positionId?: string;
  hireDate?: string;
  employmentType?: string;
  phone?: string;
  status?: string;
  remark?: string;
  platformUserId?: string;
  supplierId?: string;
  ssCityCode?: string;
  ssBase?: number;
}

export interface UpdateEmployeeDto {
  name?: string;
  departmentId?: string;
  positionId?: string;
  hireDate?: string;
  employmentType?: string;
  phone?: string;
  status?: string;
  resignDate?: string;
  platformUserId?: string | null;
  supplierId?: string | null;
  ssCityCode?: string | null;
  ssBase?: number | null;
}

export interface UpsertAttendanceDto {
  employeeId: string;
  workDate: string;
  status: AttendanceStatus;
  remark?: string;
}

export interface SetLeaveBalanceDto {
  employeeId: string;
  leaveType: LeaveType;
  year: string;
  totalDays: number;
}

export interface CreateLeaveRequestDto {
  employeeId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  days: number;
  reason?: string;
}

export type LeaveRequestAction = 'approve' | 'reject';

export interface CreatePayrollDto {
  employeeId: string;
  period: string;
  baseSalary: number;
  perfSalary?: number;
  allowance?: number;
  socialInsurance?: number;
  housingFund?: number;
  tax?: number;
  /**
   * P2-9：其他税前扣除（企业年金、商业健康险等，本月发生额）。
   * 既减少累计应纳税所得额，也从实发中扣除（由引擎处理）。
   */
  otherDeduction?: number;
  /** 默认 true：走社保/个税引擎；false 时使用手工传入的三金/个税 */
  useEngine?: boolean;
  remark?: string;
}

/**
 * B12：工资单动作。
 *
 * pay = 标记已发放（pproved → paid）；oid = 作废（pproved → voided）。
 *
 * 原实现只有 submit/approve/reject，于是 pproved 是死胡同：
 *   · "批准了但还没打款"与"已经打款"在系统里无法区分，出纳靠线下表格跟踪；
 *   · 误批准的工资单没有撤销路径（只能反审批或线下处理）。
 */
export type PayrollAction = 'submit' | 'approve' | 'reject' | 'pay' | 'void';

export interface CreateRecruitReqDto {
  title: string;
  departmentId?: string;
  headcount?: number;
  remark?: string;
}

export interface CreateCandidateDto {
  recruitReqId: string;
  name: string;
  phone?: string;
  remark?: string;
}

export type CandidateAction = 'interview' | 'offer' | 'hired' | 'rejected';

export interface CreateAppraisalDto {
  employeeId: string;
  period: string;
  score: number;
  grade?: string;
  remark?: string;
}

export type AppraisalAction = 'confirm';

export interface CreateTrainingDto {
  name: string;
  trainer?: string;
  hours?: number;
  startDate?: string;
  endDate?: string;
  remark?: string;
}

export interface AddTrainingAttendeesDto {
  trainingId: string;
  employeeIds: string[];
}

export type TrainingAction = 'finish';

/* ========== 人力资源扩展（三期：自助/补卡/离职/人效） ========== */

export type AttendanceAmendmentStatus = 'pending' | 'approved' | 'rejected';
export type AttendanceAmendmentAction = 'approve' | 'reject';

export interface AttendanceAmendment {
  id: string;
  code: string;
  employeeId: string;
  employeeName: string;
  workDate: string;
  reason: string;
  status: AttendanceAmendmentStatus;
  createdAt: string;
}

export interface CreateAttendanceAmendmentDto {
  workDate: string;
  reason: string;
}

/** 员工自助中心：当前登录用户绑定员工的档案、本月考勤、本年假期余额、已审批工资单 */
export interface MyHrSummary {
  employee: Employee | null;
  attendance: AttendanceRecord[];
  leaveBalances: LeaveBalance[];
  payrolls: PayrollItem[];
}

export interface InitLeaveBalancesDto {
  year: string;
}

export interface InitLeaveBalancesResult {
  year: string;
  /** 按司龄规则新建年假余额的员工数 */
  initializedCount: number;
  /** 已存在年度年假余额、跳过的员工数 */
  skippedCount: number;
}

export interface OffboardEmployeeDto {
  resignDate: string;
  remark?: string;
}

/** 离职待交接项目：员工近 60 天有确认工时记录的项目 */
export interface HandoverProject {
  projectId: string;
  projectName: string;
  lastWorkDate: string | null;
  confirmedHours: number;
}

export interface OffboardResult {
  employee: Employee;
  handoverProjects: HandoverProject[];
}

/* ========== 预算费控（二期B） ========== */

export type ExpenseApplyType = 'travel' | 'purchase';
export type ExpenseApplyStatus = 'pending' | 'approved' | 'rejected' | 'closed';
/**
 * 报销单状态。
 *
 * B12（§7.2）：新增 'paid'（已支付）与 'voided'（作废）。
 *
 * 原状态集到 pproved 即停，而已批准的报销单在 in-expense.service.ts
 * 里会**同事务生成一张 rp_ap_bill（source_ref='expense:<单号>'）**。
 * 那张应付单有自己的生命周期（pending → paid），但**报销单本身永远停在 approved**
 * —— 于是"这笔报销到底付了没有"在报销台账里查不到，只能去应付台账反查。
 * 更糟的是误批准的报销单无法作废（B1 同源问题），只能靠作废应付单绕过，
 * 而作废应付单**不会**同步报销单状态，两者从此不一致。
 */
export type ExpenseClaimStatus =
  | 'pending'
  | 'escalated'
  | 'approved'
  | 'rejected'
  | 'paid'
  | 'voided';

export interface BudgetItem {
  id: string;
  code: string;
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  expenseCategory: string;
  period: string;
  budgetAmount: number;
  occupiedAmount: number;
  executedAmount: number;
  availableAmount: number;
  remark: string | null;
  createdAt: string;
}

export interface ExpenseApplyItem {
  id: string;
  code: string;
  applyType: ExpenseApplyType;
  title: string;
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  expenseCategory: string;
  amount: number;
  expectDate: string | null;
  status: ExpenseApplyStatus;
  reason: string | null;
  remark: string | null;
  createdAt: string;
}

export interface ExpenseClaimItem {
  id: string;
  code: string;
  applyId: string | null;
  applyCode: string | null;
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  expenseCategory: string;
  amount: number;
  expenseDate: string | null;
  applicant: string | null;
  status: ExpenseClaimStatus;
  remark: string | null;
  createdAt: string;
}

export interface BudgetExecution {
  period: string;
  budgetAmount: number;
  occupiedAmount: number;
  executedAmount: number;
  availableAmount: number;
}

export interface CreateBudgetDto {
  departmentId?: string;
  projectId?: string;
  expenseCategory: string;
  period: string;
  budgetAmount: number;
  remark?: string;
}

export interface UpdateBudgetDto {
  budgetAmount?: number;
  remark?: string;
}

export interface CreateExpenseApplyDto {
  applyType: ExpenseApplyType;
  title: string;
  departmentId?: string;
  projectId?: string;
  expenseCategory: string;
  amount: number;
  expectDate?: string;
  reason?: string;
  remark?: string;
}

export type ExpenseApplyAction = 'approve' | 'reject' | 'close';

export interface CreateExpenseClaimDto {
  applyId?: string;
  departmentId?: string;
  projectId?: string;
  expenseCategory: string;
  amount: number;
  expenseDate?: string;
  remark?: string;
}

/**
 * B12：报销单动作。
 *
 * pay = 标记已支付（与应付单 paid 同步）；oid = 作废（仅未支付时可作废）。
 * 原实现只有 pprove / eject，导致 pproved 是一个**没有出口**的状态。
 */
export type ExpenseClaimAction = 'approve' | 'reject' | 'pay' | 'void';

/* ========== 采购（二期B） ========== */

export type PurRequestType = 'service' | 'equipment';
export type PurRequestStatus = 'pending' | 'approved' | 'rejected';
export type PurOrderStatus = 'pending' | 'accepted' | 'cancelled';
export type PurOrderCategory = 'service' | 'equipment';

export interface PurRequestItem {
  id: string;
  code: string;
  title: string;
  requestType: PurRequestType;
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  amount: number;
  expectDate: string | null;
  status: PurRequestStatus;
  reason: string | null;
  remark: string | null;
  createdAt: string;
}

export interface PurOrderItem {
  id: string;
  code: string;
  requestId: string | null;
  requestCode: string | null;
  contractId: string | null;
  contractName: string | null;
  supplierId: string;
  supplierName: string;
  projectId: string | null;
  projectName: string | null;
  itemName: string;
  category: PurOrderCategory;
  quantity: number;
  unitPrice: number;
  amount: number;
  /** 进项税率（%），法定档位 0/1/3/6/9/13；验收凭证优先用此值 */
  taxRate?: number | null;
  orderDate: string | null;
  acceptedQuantity: number;
  acceptDate: string | null;
  /**
   * **已验收金额**（= 该订单所有有效验收应付之和，含税）。
   *
   * ## 为什么必须由服务端给
   *
   * 验收单打印件原先自己算 `unitPrice * acceptedQuantity` 并**一次性取整**，
   * 而服务端 `PurService.acceptOrder` 是**逐次验收各自取整**后落
   * `erp_ap_bill.amount`。两者在单价超过两位小数时必然分叉：
   *   · 单价 0.333、分 3 次各验 1 → 打印件 1.00（0.333×3 = 0.999），
   *     实际应付 0.33×3 = **0.99**；
   *   · 单价 2.675、一次验完 → 打印件 2.67（`(2.675).toFixed(2)`），
   *     实际应付 `round2(2.675)` = **2.68**（同一列表格的「订单金额」列也显示
   *     2.68，即打印件与列表自相矛盾）。
   *
   * 客户端**拿不到每次验收的金额**（本接口原先只有 `acceptedQuantity` /
   * `acceptDate` 两个汇总字段），所以正确修法只能是服务端把已验收金额算好发下来。
   *
   * ⚠️ **不要改成"客户端按单价×数量重算"** —— 那会重新引入取整顺序差异，
   * 正是本次要消除的形态。
   */
  acceptedAmount: number;
  status: PurOrderStatus;
  remark: string | null;
  createdAt: string;
}

export interface PurChainSummary {
  pendingRequestCount: number;
  openOrderCount: number;
  acceptedOrderCount: number;
  openApAmount: number;
  paidAmount: number;
}

export interface CreatePurRequestDto {
  title: string;
  requestType: PurRequestType;
  departmentId?: string;
  projectId?: string;
  supplierId?: string;
  amount: number;
  expectDate?: string;
  reason?: string;
  remark?: string;
}

export type PurRequestAction = 'approve' | 'reject';

export interface CreatePurOrderDto {
  requestId?: string;
  contractId?: string;
  supplierId: string;
  projectId?: string;
  itemName: string;
  category: PurOrderCategory;
  quantity: number;
  unitPrice: number;
  taxRate?: number;
  orderDate?: string;
  remark?: string;
}

export interface UpdatePurOrderDto {
  taxRate?: number | null;
  remark?: string;
}

export interface AcceptPurOrderDto {
  quantity: number;
  acceptDate?: string;
}

export type PurOrderAction = 'cancel';

/* ========== 固定资产（三期） ========== */

export type AssetCategory = 'server_gpu' | 'office' | 'other';
export type AssetStatus = 'in_use' | 'idle' | 'repair' | 'scrapped';
export type AssetChangeType = 'receive' | 'transfer' | 'scrap';
export type AssetChangeStatus = 'pending' | 'approved' | 'rejected';

export interface AssetItem {
  id: string;
  code: string;
  name: string;
  category: AssetCategory;
  originalValue: number;
  residualValue: number;
  netValue: number;
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  purchaseDate: string | null;
  usefulMonths: number;
  status: AssetStatus;
  remark: string | null;
  createdAt: string;
}

export interface AssetDepreciationItem {
  id: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  period: string;
  amount: number;
  costGenerated: boolean;
  remark: string | null;
  createdAt: string;
}

export interface AssetChangeItem {
  id: string;
  code: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  changeType: AssetChangeType;
  beforeValue: string | null;
  afterValue: string | null;
  /** D-08：目标部门 / 目标项目（结构化，审批通过后写回资产） */
  targetDepartmentId: string | null;
  targetDepartmentName: string | null;
  targetProjectId: string | null;
  targetProjectName: string | null;
  status: AssetChangeStatus;
  remark: string | null;
  createdAt: string;
}

export interface AssetOverview {
  totalOriginalValue: number;
  totalNetValue: number;
  inUseCount: number;
  scrappedCount: number;
  gpuCount: number;
}

export interface CreateAssetDto {
  name: string;
  category: AssetCategory;
  originalValue: number;
  residualValue?: number;
  departmentId?: string;
  projectId?: string;
  purchaseDate?: string;
  usefulMonths?: number;
  remark?: string;
}

export interface CreateAssetChangeDto {
  assetId: string;
  changeType: AssetChangeType;
  /**
   * **展示用**的目标说明文本（可选）。不承担数据传递职责
   * —— 真正生效的是下面两个结构化目标字段。
   */
  afterValue?: string;
  /**
   * D-08：转交后的目标部门 / 目标项目（结构化）。
   *
   * `changeType='transfer'` 时**至少填一个**，否则审批通过后没有任何归属变更，
   * 转交会"看起来成功但实际什么都没发生"。
   * 可只填一个（允许只转部门或只转项目）。
   */
  targetDepartmentId?: string;
  targetProjectId?: string;
  remark?: string;
}

export type AssetChangeAction = 'approve' | 'reject';

export interface DepreciatePeriodDto {
  period: string;
}

export interface DepreciateResult {
  period: string;
  assetCount: number;
  totalAmount: number;
}

/* ========== 总账凭证（三期） ========== */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type VoucherStatus = 'draft' | 'posted' | 'voided';
export type VoucherSourceType =
  | 'receipt'
  | 'payment'
  | 'expense'
  | 'payroll'
  | 'depreciation'
  | 'invoice'
  | 'manual';

export interface AccountItem {
  id: string;
  code: string;
  name: string;
  accountType: AccountType;
  status: string;
  remark: string | null;
  createdAt: string;
  /** A-10：上级科目编码（一级科目为 null） */
  parentCode: string | null;
  /** A-10：科目层级，1 为一级 */
  level: number;
  /** A-10：是否末级科目（只有末级可做账） */
  isLeaf: boolean;
  /** A-10：余额方向 */
  direction: AccountDirection;
  /** A-05：必填辅助核算维度编码集合 */
  auxRequired: string[];
}

/** A-10：会计科目余额方向 */
export type AccountDirection = 'debit' | 'credit';

/** A-05：凭证行辅助核算值 */
export interface VoucherLineAuxItem {
  dimensionCode: string;
  dimensionName: string | null;
  dimensionId: string | null;
  dimensionValue: string | null;
}

export interface VoucherLineItem {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  summary: string | null;
  debit: number;
  credit: number;
  /** A-05：该行挂的辅助核算值 */
  aux: VoucherLineAuxItem[];
}

export interface VoucherItem {
  id: string;
  code: string;
  voucherDate: string | null;
  period: string;
  summary: string | null;
  sourceType: VoucherSourceType;
  sourceRef: string | null;
  status: VoucherStatus;
  remark: string | null;
  lines: VoucherLineItem[];
  totalDebit: number;
  totalCredit: number;
  createdAt: string;
}

export interface PeriodStatus {
  period: string;
  voucherCount: number;
  draftCount: number;
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
  closed: boolean;
}

export interface CreateAccountDto {
  code: string;
  name: string;
  accountType: AccountType;
  parentCode?: string;
  direction?: AccountDirection;
  auxRequired?: string[];
  remark?: string;
}

/** A-05：凭证行辅助核算入参 */
export interface VoucherLineAuxDto {
  dimensionCode: string;
  dimensionId?: string;
  dimensionValue?: string;
}

export interface CreateVoucherLineDto {
  accountId: string;
  summary?: string;
  debit?: number;
  credit?: number;
  /** A-05：科目要求挂的辅助核算维度值 */
  auxDimensions?: VoucherLineAuxDto[];
}

export interface CreateVoucherDto {
  voucherDate: string;
  period: string;
  summary: string;
  sourceType?: VoucherSourceType;
  sourceRef?: string;
  lines: CreateVoucherLineDto[];
  remark?: string;
  /**
   * A-01/A-06：凭证归属的纳税主体。
   *
   * 不传时由后端推导：① 来源单据（合同）的主体 → ② 系统唯一的默认主体。
   * 都推导不出则留空 —— 该凭证不计入任何主体的报表，由视图
   * `v_fin_voucher_unassigned_entity` 暴露，需人工补主体。
   */
  taxEntityId?: string;
}

export type VoucherAction = 'post' | 'void';

export interface ClosePeriodDto {
  period: string;
}

/* ========== 数据资产授权（三期） ========== */

export type DatasetStatus = 'active' | 'offline';
export type GrantStatus = 'active' | 'expired';

export interface DatasetItem {
  id: string;
  code: string;
  name: string;
  source: string | null;
  maskLevel: string;
  contractId: string | null;
  contractName: string | null;
  status: DatasetStatus;
  remark: string | null;
  createdAt: string;
}

export interface GrantItem {
  id: string;
  code: string;
  datasetId: string;
  datasetName: string;
  customerId: string | null;
  customerName: string | null;
  projectId: string | null;
  projectName: string | null;
  scope: string | null;
  startDate: string | null;
  endDate: string | null;
  status: GrantStatus;
  remark: string | null;
  createdAt: string;
}

export interface GrantWarningItem {
  grantId: string;
  grantCode: string;
  datasetName: string;
  customerName: string | null;
  endDate: string;
  daysLeft: number;
}

export interface CreateDatasetDto {
  name: string;
  source?: string;
  maskLevel?: string;
  contractId?: string;
  remark?: string;
}

export interface UpdateDatasetDto {
  name?: string;
  source?: string;
  maskLevel?: string;
  /**
   * 关联合同（PATCH 三态语义）。
   *
   * 与 `CreateDatasetDto.contractId`（只增不改）不同，这里**允许显式 `null`**：
   * 数据集可能不再挂靠任何合同（合同作废/数据转内部使用），
   * 这与 `UpdateInvoiceDto.arId?: string | null` 是同一个先例 —— 传 `null` 即清除关联。
   *
   * 三态口径（服务端 `data-asset.service.ts#updateDataset` 严格按此实现）：
   * · 传 UUID  → 校验合同存在后写入；
   * · 传 `null` → 清除关联；
   * · 不传（`undefined`）→ **保持原值不动**。
   *
   * ⚠️ 前端**不能**把 `contractId` 折成 `values.contractId || undefined`：
   * 那样"清空"会变成"不传"，清除操作被静默丢弃。
   */
  contractId?: string | null;
  status?: DatasetStatus;
  remark?: string;
}

export type DatasetAction = 'offline' | 'activate';

export interface CreateGrantDto {
  datasetId: string;
  customerId?: string;
  projectId?: string;
  scope?: string;
  startDate: string;
  endDate: string;
  remark?: string;
}

export type GrantAction = 'expire';

/* ========== 审批通知 ========== */

export type ApprovalBizType =
  | 'expense'
  | 'purchase'
  | 'leave'
  | 'payroll'
  | 'admin_bill'
  | 'admin_rent_contract'
  | 'quotation';

export interface SendApprovalNotificationRequest {
  bizType: ApprovalBizType;
  bizCode: string;
  title: string;
  content: string;
}

export interface ApprovalNotificationResult {
  sent: boolean;
  reason?: 'no_recipients' | 'send_failed';
}

/** B8：站内信收件箱条目 */
export interface InboxMessage {
  id: string;
  userId: string;
  title: string | null;
  content: string | null;
  bizType: string | null;
  bizCode: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ListInboxMessagesResult {
  items: InboxMessage[];
}

export interface MarkInboxMessageReadResult {
  ok: true;
  id: string;
  readAt: string;
}

/* ========== 逾期与预警（通知中心） ========== */

export interface AlertItem {
  category: 'ar_overdue' | 'grant_expiring' | 'asset_scrapping';
  refCode: string;
  title: string;
  /** 相对今天的天数：已逾期/已到期为负数（-N 表示已逾期 N 天），未到期为正数剩余天数；资产待报废为报废流程发起至今天数（正数） */
  days: number;
  severity: 'warning' | 'danger';
}

export interface AlertsResult {
  items: AlertItem[];
}

/* ========== 附件（通用，挂任意单据） ========== */

export const ATTACHMENT_RESOURCE_TYPES = [
  'fin_expense_claim',
  'erp_contract',
  'pur_request',
  'hr_leave_request',
  'fin_voucher',
  'fin_expense_apply',
  'pur_order',
  'ast_asset',
  'da_dataset',
  'da_grant',
  'erp_project',
  'crm_lead',
  'crm_opportunity',
  'admin_rent_contract',
  'admin_bill',
  'erp_invoice',
  'crm_quotation',
  'hr_payroll',
  'erp_project_cost',
  'erp_deliverable',
  'erp_project_minutes',
] as const;

export type AttachmentResourceType = (typeof ATTACHMENT_RESOURCE_TYPES)[number];

export type AttachmentSourceType = 'upload' | 'feishu_doc';

export interface Attachment {
  id: string;
  resourceType: string;
  resourceId: string;
  fileName: string;
  fileUrl: string;
  fileSize: number;
  sourceType: AttachmentSourceType;
  feishuToken?: string | null;
  feishuDocType?: string | null;
  feishuUrl?: string | null;
  uploadedBy: string | null;
  createdAt: string;
  /** 当前用户是否可删除（上传人本人） */
  canDelete: boolean;
}

export interface CreateAttachmentDto {
  resourceType: AttachmentResourceType;
  resourceId: string;
  fileName: string;
  fileUrl: string;
  fileSize?: number;
  sourceType?: AttachmentSourceType;
  feishuToken?: string;
  feishuDocType?: string;
  feishuUrl?: string;
}

/** 飞书云文档链接解析结果（可扩展 docType） */
export interface ParsedFeishuDocLink {
  title: string;
  docType: string;
  token: string;
  url: string;
  /** 元数据拉取失败时的提示，仍可登记 */
  warning?: string;
}

/* ========== 飞书多维表格同步 ========== */

export type FeishuSyncDirection = 'outbound' | 'inbound';

export interface FeishuSyncResult {
  direction: FeishuSyncDirection;
  bizType: 'cost' | 'contract' | 'timesheet';
  total: number;
  synced: number;
  skipped: number;
  failed: number;
  message: string;
  pending: number;
}

export interface FeishuSyncRecordItem {
  id: string;
  direction: FeishuSyncDirection;
  bizType: string;
  bizCode: string | null;
  baseRecordId: string | null;
  status: 'pending' | 'success' | 'failed';
  errorMsg: string | null;
  updatedAt: string;
}

/* ========== 行政管理 ========== */

export type AdminRentContractStatus = 'draft' | 'active' | 'expired' | 'terminated';
export type AdminRentContractAction = 'activate' | 'terminate';
export type AdminPaymentCycle = 'monthly' | 'quarterly' | 'half_yearly' | 'yearly';

export interface AdminRentContractItem {
  id: string;
  code: string;
  name: string;
  propertyAddress: string;
  lessor: string;
  monthlyRent: number;
  deposit: number | null;
  area: number | null;
  startDate: string;
  endDate: string;
  paymentCycle: AdminPaymentCycle;
  status: AdminRentContractStatus;
  remark: string | null;
  createdAt: string;
}

export interface AdminRentContractStats {
  activeCount: number;
  expiringCount: number;
  totalMonthlyRent: number;
}

export interface CreateAdminRentContractDto {
  name: string;
  propertyAddress: string;
  lessor: string;
  monthlyRent: number;
  deposit?: number;
  area?: number;
  startDate: string;
  endDate: string;
  paymentCycle?: AdminPaymentCycle;
  remark?: string;
}

export interface UpdateAdminRentContractDto {
  name?: string;
  propertyAddress?: string;
  lessor?: string;
  monthlyRent?: number;
  deposit?: number | null;
  area?: number | null;
  startDate?: string;
  endDate?: string;
  paymentCycle?: AdminPaymentCycle;
  remark?: string | null;
}

export type AdminBillType =
  | 'rent'
  | 'property'
  | 'water_electric'
  | 'office'
  | 'vehicle_travel'
  | 'other';
export type AdminBillStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'paid';
export type AdminBillAction = 'submit' | 'approve' | 'reject' | 'pay';

export interface AdminBillItem {
  id: string;
  code: string;
  title: string;
  billType: AdminBillType;
  amount: number;
  period: string;
  payee: string | null;
  expenseDate: string;
  rentContractId: string | null;
  rentContractCode: string | null;
  status: AdminBillStatus;
  payDate: string | null;
  payMethod: string | null;
  approveRemark: string | null;
  remark: string | null;
  createdAt: string;
}

export interface AdminBillStats {
  monthPaidAmount: number;
  submittedCount: number;
  draftCount: number;
}

export interface CreateAdminBillDto {
  title: string;
  billType: AdminBillType;
  amount: number;
  period: string;
  expenseDate: string;
  payee?: string;
  rentContractId?: string;
  remark?: string;
}

export interface UpdateAdminBillDto {
  title?: string;
  billType?: AdminBillType;
  amount?: number;
  period?: string;
  expenseDate?: string;
  payee?: string | null;
  rentContractId?: string | null;
  remark?: string | null;
}

export interface AdminBillActionDto {
  payDate?: string;
  payMethod?: string;
  approveRemark?: string;
}

export type AdminAssetCategory = 'office_equipment' | 'office_furniture' | 'other';
export type AdminAssetStatus = 'in_use' | 'idle' | 'scrapped';

export interface AdminAssetItem {
  id: string;
  code: string;
  name: string;
  category: AdminAssetCategory;
  quantity: number;
  unitPrice: number;
  amount: number;
  location: string | null;
  owner: string | null;
  purchaseDate: string | null;
  status: AdminAssetStatus;
  remark: string | null;
  createdAt: string;
}

export interface CreateAdminAssetDto {
  name: string;
  category: AdminAssetCategory;
  quantity: number;
  unitPrice: number;
  location?: string;
  owner?: string;
  purchaseDate?: string;
  status?: AdminAssetStatus;
  remark?: string;
}

export interface UpdateAdminAssetDto {
  name?: string;
  category?: AdminAssetCategory;
  quantity?: number;
  unitPrice?: number;
  location?: string | null;
  owner?: string | null;
  purchaseDate?: string | null;
  status?: AdminAssetStatus;
  remark?: string | null;
}

export type AdminAffairType = 'vehicle' | 'travel';
export type AdminAffairStatus = 'registered' | 'settled';
export type AdminAffairAction = 'settle';

export interface AdminAffairItem {
  id: string;
  code: string;
  affairType: AdminAffairType;
  title: string;
  participants: string[];
  startDate: string;
  endDate: string | null;
  amount: number | null;
  status: AdminAffairStatus;
  remark: string | null;
  createdAt: string;
}

export interface AutomationConfigItem {
  taskKey: string;
  taskName: string;
  description: string | null;
  enabled: boolean;
  updatedAt: string;
}

export interface UpdateAutomationConfigDto {
  enabled: boolean;
}

export interface CreateAdminAffairDto {
  affairType: AdminAffairType;
  title: string;
  participants?: string[];
  startDate: string;
  endDate?: string;
  amount?: number;
  remark?: string;
}

export interface UpdateAdminAffairDto {
  affairType?: AdminAffairType;
  title?: string;
  participants?: string[];
  startDate?: string;
  endDate?: string | null;
  amount?: number | null;
  remark?: string | null;
}

export type SemanticBizType = 'contract' | 'project';

export interface SemanticSimilarItem {
  id: string;
  code: string;
  name: string;
  similarity: number;
}

export interface SemanticSimilarResponse {
  items: SemanticSimilarItem[];
}

// ===== 飞书云空间/知识库（开放平台直连）=====

export type DriveItemType =
  | 'folder'
  | 'doc'
  | 'docx'
  | 'sheet'
  | 'bitable'
  | 'file'
  | 'slides'
  | 'mindnote'
  | 'shortcut'
  | 'other';

export interface DriveItem {
  token: string;
  name: string;
  type: DriveItemType;
  size: number | null;
  modifiedTime: string | null;
  url: string;
}

export interface DriveFolderChildrenResponse {
  items: DriveItem[];
  hasMore: boolean;
  pageToken: string | null;
}

export interface CreateFolderRequest {
  parentToken: string;
  name: string;
}

export interface DriveCreatedItem {
  token: string;
  name: string;
  url: string;
}

export interface CreateDocumentRequest {
  folderToken: string;
  title: string;
}

export interface UploadFileRequest {
  folderToken: string;
  fileName: string;
  base64Content: string;
  size: number;
}

export interface RenameFileRequest {
  name: string;
}

export interface DeleteFileResponse {
  token: string;
  deleted: boolean;
}

export interface WikiNode {
  nodeToken: string;
  title: string;
  objType: string | null;
  hasChild: boolean;
  nodeEditTime: string | null;
  url: string;
}

export interface WikiNodesResponse {
  items: WikiNode[];
  hasMore: boolean;
  pageToken: string | null;
  permissionDenied?: boolean;
}

export interface SyncToWikiRequest {
  fileToken: string;
  fileType: 'doc' | 'docx' | 'sheet' | 'bitable' | 'mindnote' | 'file';
}

export interface SyncToWikiResponse {
  taskId: string;
  wikiUrl: string | null;
}

export interface FeishuDriveConfigResponse {
  appId: string;
  appSecretMasked: string;
  rootFolderToken: string;
  wikiSpaceId: string;
  updatedAt: string | null;
}

export interface UpdateFeishuDriveConfigRequest {
  appId?: string;
  appSecret?: string;
  rootFolderToken?: string;
  wikiSpaceId?: string;
}

/* ========== 列表/查询请求参数（前后端契约） ========== */

export interface ListAccountParams {
  page: number;
  pageSize: number;
  keyword?: string;
}

export interface ListVoucherParams {
  page: number;
  pageSize: number;
  status?: string;
  period?: string;
  sourceType?: string;
}

export interface PurRequestListParams {
  page?: number;
  pageSize?: number;
  status?: string;
  projectId?: string;
}

export interface PurOrderListParams {
  page?: number;
  pageSize?: number;
  status?: string;
  supplierId?: string;
}

export interface ProjectListParams {
  status?: string;
  keyword?: string;
}

export interface ApprovalNotifyPayload {
  bizType: string;
  bizCode: string;
  title: string;
  content: string;
}

/** axios 错误的最小形状，供前端把接口错误转成可读文案 */
export interface AxiosLikeError {
  response?: { data?: { error?: { message?: string } } };
  message?: string;
}

export interface ExpenseListParams {
  page?: number;
  pageSize?: number;
  status?: string;
  projectId?: string;
}

export interface BudgetListParams {
  page?: number;
  pageSize?: number;
  period?: string;
  projectId?: string;
  departmentId?: string;
}

export interface DatasetListParams {
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface GrantListParams {
  datasetId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface QuotationListParams {
  customerId?: string;
  opportunityId?: string;
  status?: QuotationStatus;
}

export interface ContractListParams {
  status?: string;
  keyword?: string;
  customerId?: string;
}

/**
 * 审计日志查询条件。
 *
 * ⚠️ 所有条件都必须在 **SQL 层**生效（`where`），不能在取回结果后再过滤：
 * 原实现的 `action` 是"先按 limit 取最新 N 行、再在内存里 filter"，
 * 于是同一次查询的条数会随分页大小变化（limit=100 得 2 行、limit=200 得 12 行，
 * 而库里实际有 93 条 update）—— 审计查询给出**不确定的答案**比慢更危险。
 */
export interface AuditListParams {
  objectType?: string;
  action?: string;
  /** 操作人：妙搭 userId 原文，或 `anonymous` / `system` 等非用户主体 */
  actor?: string;
  /** 起始日期（含），`YYYY-MM-DD`，按业务时区 */
  dateFrom?: string;
  /** 结束日期（含），`YYYY-MM-DD`，按业务时区 */
  dateTo?: string;
  limit?: number;
}

/** 审计日志列表（带总数，供界面显示"共 N 条"；N 是筛选后的真实条数） */
export interface AuditLogListResult {
  items: AuditLog[];
  /** 满足筛选条件的总条数（不受 limit 影响） */
  total: number;
  /** 本次返回的条数（= min(total, limit)） */
  returned: number;
}

/** 审计日志导出结果（CSV 由服务端生成，客户端只负责下载） */
export interface AuditLogExportResult {
  csv: string;
  /** CSV 中的数据行数（不含表头） */
  rowCount: number;
  /** 命中条数超过导出上限而为 true（CSV 只含最新的上限条） */
  truncated: boolean;
  /** 命中总数，供界面提示"已导出 200 / 共 1500" */
  total: number;
}

/** 审计日志操作人选项（筛选下拉用） */
export interface AuditActorOption {
  actor: string;
  count: number;
}

export interface AssetListParams {
  page?: number;
  pageSize?: number;
  status?: string;
  category?: string;
  projectId?: string;
}

export interface AssetChangeListParams {
  page?: number;
  pageSize?: number;
  status?: string;
}

export interface AssetDepreciationListParams {
  page?: number;
  pageSize?: number;
  period?: string;
  assetId?: string;
}

export interface RentContractListParams {
  page?: number;
  pageSize?: number;
  status?: string;
}

export interface AdminBillListParams {
  page?: number;
  pageSize?: number;
  billType?: string;
  period?: string;
  status?: string;
}

export interface AdminAssetListParams {
  page?: number;
  pageSize?: number;
  category?: string;
  status?: string;
}

export interface AdminAffairListParams {
  page?: number;
  pageSize?: number;
  affairType?: string;
  status?: string;
}

export interface FetchSyncRecordsParams {
  direction?: string;
  bizType?: string;
  page: number;
  pageSize: number;
}

/* ========== 纳税主体 / 合同明细 / BI 税分布 ========== */

export interface TaxEntity {
  id: string;
  code: string;
  name: string;
  uscc: string | null;
  taxpayerType: 'general' | 'small';
  defaultOutputRate: number;
  defaultInputRate: number;
  /**
   * 城建税率（百分数：市区 7 / 县镇 5 / 其他 1）；null = 未配置。
   *
   * 口径与库约束 `chk_tax_entity_urban_maint_rate` 一致：未配置（null）时
   * 附加税计提会**拒绝出数**，而不是按 0 计提。
   *
   * 声明为**可选**的原因：该字段是后加的，既有响应/构造点没有它；
   * 可选可保证老数据与既有对象字面量都不受影响。
   */
  urbanMaintRate?: number | null;
  /**
   * T9：增值税申报周期 —— 小规模免征额度判定的**必要要件**。
   *
   * `'monthly'`（按月，免征额度 10 万）/ `'quarterly'`（按季，30 万）/ `null`（未声明）。
   *
   * 未声明时底稿**不做免征判定**（按偏严口径不减免，不会少缴），并推
   * `small_scale_exemption_cycle_missing` 差异项提示补录 ——
   * 否则主体会长期多缴而无人察觉。
   */
  vatFilingCycle?: 'monthly' | 'quarterly' | null;
  /** T9：是否启用免征额度判定；`false` = 一律不免征（如放弃免税权） */
  vatExemptionEnabled?: boolean;
  /**
   * §4.7(e)：企业所得税「小型微利企业」资格。
   *
   * 	rue = 已人工确认符合三项条件（应纳税所得额 ≤ 300 万、从业人数 ≤ 300、
   * 资产总额 ≤ 5000 万）→ 享受 **5%** 实际税负；
   * alse = 已确认不符合 → 25%；
   * **null / 未提供 = 未确认** → 按不享受处理（偏严：多缴而非少缴）。
   *
   * 为什么是"人工确认"而不是系统自动判定：条件②③需要从业人数与资产总额，
   * 这两个数在本仓分别属于人资与资产模块，主体资料里没有；
   * 在这里猜会在人数/资产超标时**错误享受 5%**（实打实的少缴 + 滞纳金）。
   * 条件①（≤300 万）由 `computeIncomeTax` 自行判断并在超门槛时自动降级。
   */
  citSmallMicro?: boolean | null;
  invoiceTitle: string | null;
  invoiceAddress: string | null;
  invoicePhone: string | null;
  invoiceBank: string | null;
  invoiceAccount: string | null;
  isDefault: boolean;
  status: 'active' | 'inactive';
  remark: string | null;
}

export interface ContractItem {
  id: string;
  contractId: string;
  versionNo: number;
  seq: number;
  itemName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxRate: number;
  amount: number;
  netAmount: number;
  taxAmount: number;
  estUnitCost: number;
  sourceType: string;
}

export interface TaxDistributionItem {
  taxEntityId: string | null;
  taxEntityName: string;
  amount: number;
  taxAmount: number;
}


/* ========== 批次一 A 线：会计账簿与法定报表 ========== */

export type BalanceSide = 'debit' | 'credit' | 'flat';

/** A-03：账簿查询通用参数 */
export interface LedgerQueryParams {
  period: string;
  /** 科目层级上限，缺省全部 */
  level?: number;
  taxEntityId?: string;
  /** P0-2：含草稿预览口径（默认只取已过账） */
  includeDraft?: boolean;
}

export interface AccountBalanceRow {
  accountCode: string;
  accountName: string;
  level: number;
  isLeaf: boolean;
  direction: AccountDirection;
  accountType: string;
  openingDebit: number;
  openingCredit: number;
  debitOccur: number;
  creditOccur: number;
  closingDebit: number;
  closingCredit: number;
  /** 期末净额（借 − 贷） */
  closingNet: number;
  closingSide: BalanceSide;
}

export interface AccountBalanceSheet {
  period: string;
  level: number;
  items: AccountBalanceRow[];
  totals: {
    openingDebit: number;
    openingCredit: number;
    debitOccur: number;
    creditOccur: number;
    closingDebit: number;
    closingCredit: number;
  };
  balanced: boolean;
}

export interface AuxBalanceRow {
  dimensionCode: string;
  dimensionId: string | null;
  dimensionValue: string | null;
  accountCode: string;
  accountName: string;
  openingDebit: number;
  openingCredit: number;
  debitOccur: number;
  creditOccur: number;
  closingDebit: number;
  closingCredit: number;
  closingNet: number;
  closingSide: BalanceSide;
}

export interface AuxBalanceSheet {
  period: string;
  dimensionCode: string;
  dimensionName: string;
  items: AuxBalanceRow[];
  totals: {
    debitOccur: number;
    creditOccur: number;
    closingDebit: number;
    closingCredit: number;
  };
  balanced: boolean;
}

export interface GeneralLedgerRow {
  accountCode: string;
  accountName: string;
  direction: AccountDirection;
  accountType: string;
  openingDebit: number;
  openingCredit: number;
  debitOccur: number;
  creditOccur: number;
  closingDebit: number;
  closingCredit: number;
  closingNet: number;
  closingSide: BalanceSide;
  childCount: number;
}

export interface GeneralLedgerSheet {
  period: string;
  items: GeneralLedgerRow[];
  totals: {
    debitOccur: number;
    creditOccur: number;
    closingDebit: number;
    closingCredit: number;
  };
  balanced: boolean;
}

export interface DetailLedgerLine {
  lineId: string;
  voucherId: string;
  voucherCode: string;
  voucherDate: string | null;
  summary: string | null;
  /** 同一凭证内其他行的科目名称（对方科目） */
  counterpartAccounts: string[];
  debit: number;
  credit: number;
  /** 逐行滚动余额（借正贷负） */
  balance: number;
  balanceSide: BalanceSide;
  sourceType: string | null;
  sourceRef: string | null;
  aux: Array<{ dimensionCode: string; dimensionValue: string | null }>;
}

export interface DetailLedgerResult {
  period: string;
  accountCode: string;
  accountName: string;
  direction: AccountDirection;
  openingBalance: number;
  openingDebit: number;
  openingCredit: number;
  closingBalance: number;
  closingDebit: number;
  closingCredit: number;
  periodDebit: number;
  periodCredit: number;
  items: DetailLedgerLine[];
  total: number;
  page: number;
  pageSize: number;
  pageDebit: number;
  pageCredit: number;
}

/** A-05：辅助核算维度定义 */
export interface AuxDimensionItem {
  id: string;
  code: string;
  name: string;
  sourceType:
    | 'department'
    | 'project'
    | 'customer'
    | 'supplier'
    | 'employee'
    | 'custom';
  enabled: boolean;
  sortNo: number;
  remark: string | null;
}

export type ReportCode = 'balance_sheet' | 'income_statement' | 'cash_flow';

/** 报表行的取数明细（用于前端下钻） */
export interface ReportRowDetail {
  accountCode: string;
  accountName: string;
  amount: number;
}

export interface ReportRow {
  rowNo: string;
  rowName: string;
  formula: string;
  indent: number;
  bold: boolean;
  /** 本期（资产负债表为期末）金额 */
  amount: number;
  /** 累计金额（利润表/现金流量表本年累计；资产负债表与 amount 相同） */
  ytdAmount: number;
  /** 上期（资产负债表为年初）金额 */
  previousAmount: number;
  /** 该行取数明细（按科目展开） */
  details: ReportRowDetail[];
}

export interface ReportCheck {
  code: string;
  label: string;
  left: number;
  right: number;
  difference: number;
  passed: boolean;
}

export interface ReportSheet {
  reportCode: ReportCode;
  reportName: string;
  period: string;
  taxEntityId: string | null;
  taxEntityName: string | null;
  rows: ReportRow[];
  checks: ReportCheck[];
  balanced: boolean;
  generatedAt: string;
}

export interface BalanceSheetResult extends ReportSheet {
  reportCode: 'balance_sheet';
  assetsTotal: number;
  liabilitiesTotal: number;
  equityTotal: number;
}

export interface IncomeStatementResult extends ReportSheet {
  reportCode: 'income_statement';
  revenueTotal: number;
  costTotal: number;
  operatingProfit: number;
  netProfit: number;
}

export interface CashFlowResult extends ReportSheet {
  reportCode: 'cash_flow';
  operatingNet: number;
  investingNet: number;
  financingNet: number;
  netIncrease: number;
  openingCash: number;
  closingCash: number;
  /** 与资产负债表货币资金核对差异 */
  cashDifference: number;
}

export interface ReportQueryParams {
  period: string;
  taxEntityId?: string;
  /** 利润表/现金流量表：是否输出累计列 */
  ytd?: boolean;
}

/** A-04：期末结转损益与年结 */
export interface PeriodCarryForwardPreview {
  period: string;
  taxEntityId: string | null;
  items: Array<{
    accountCode: string;
    accountName: string;
    accountType: string;
    debitOccur: number;
    creditOccur: number;
    carryAmount: number;
    carryDirection: 'debit' | 'credit';
  }>;
  totalRevenue: number;
  totalExpense: number;
  netProfit: number;
  checks: Array<{
    code: string;
    label: string;
    passed: boolean;
    message: string;
  }>;
  canCarry: boolean;
  alreadyCarried: boolean;
}

export interface YearEndStatusItem {
  fiscalYear: number;
  period: string;
  taxEntityId: string | null;
  status: 'closed' | 'open';
  profitAmount: number;
  carryVoucherId: string | null;
  carryVoucherCode: string | null;
  closedAt: string | null;
  closedBy: string | null;
  reopenedAt: string | null;
  reopenedBy: string | null;
}

export interface YearEndCloseResult {
  fiscalYear: number;
  period: string;
  taxEntityId: string | null;
  status: 'closed' | 'open';
  profitAmount: number;
  carryVoucherId: string | null;
  carryVoucherCode: string | null;
  message: string;
}

/** A-06：增值税申报底稿 */
export interface VatDeclarationLine {
  rowNo: string;
  rowName: string;
  category: 'output' | 'input' | 'transfer' | 'credit' | 'payable';
  amount: number;
  ledgerAmount: number;
  difference: number;
  explained: boolean;
  /**
   * 该行是否可与其它行**相加**得出一个有意义的小计。
   *
   * 第 17 行（上期留抵）与第 20 行（期末留抵）是**减项/余额**，与第 1 行的
   * 不含税销售额、第 11/12/13 行的税额**不同量纲**：把它们一起求和会得到
   * 「销售额 + 税额 − 留抵」这种没有任何会计含义的数字。
   * 前端表尾据本字段只汇总可加行，见 `TaxDeclarationPage` 的 `summable` 过滤。
   */
  summable: boolean;
}

export interface VatDeclarationResult {
  period: string;
  taxEntityId: string | null;
  taxEntityName: string | null;
  status: 'draft' | 'confirmed';
  lines: VatDeclarationLine[];
  outputTaxFromInvoices: number;
  inputTaxFromInvoices: number;
  /**
   * P0-A：本期已登记但**未勾选认证**的进项税额（专票）。
   *
   * 这部分税额依法不得在当期抵扣（国家税务总局公告 2019 年第 45 号），
   * 因此**不计入** `inputTaxFromInvoices`，单独列出供财务核对
   * 「台账进项总额 = 可抵扣进项 + 待认证进项」。
   */
  uncertifiedInputTax: number;
  /** P0-A：未认证进项发票张数（用于文案） */
  uncertifiedInvoiceCount: number;
  outputTaxFromLedger: number;
  inputTaxFromLedger: number;
  previousCredit: number;
  /**
   * P0-B：上期留抵的取数来源。
   *
   * - `confirmed_declaration`：取自**上期已确认底稿**的 `closing_credit`（权威）；
   * - `ledger_estimate`：上期底稿未确认，按总账 222102/222101 余额推算（**估数**）。
   *
   * 两者对"防重复抵扣"的可靠性不同，前端需据此提示。
   */
  previousCreditSource: 'confirmed_declaration' | 'ledger_estimate';
  /**
   * T8：本期**未开票收入**的不含税额（已确认收入 − 已开销项发票净额）。
   *
   * 底稿原先销项 100% 来自发票台账，这部分**零申报**（少缴增值税）。
   * 现已计入申报表第 1 行销售额；其销项税额因收入台账无税率列而按 0 计，
   * 通过 `unbilled_revenue_tax_pending` 差异项提示人工确认。
   */
  unbilledRevenueNet: number;
  /**
   * T9：小规模免征额度判定结果。
   *
   * - `within`：额度内，已免征教育费附加与地方教育附加（城建税仍征）；
   * - `beyond`：超出额度，照征；
   * - `unknown`：**要件缺失（未声明申报周期等），按偏严口径未减免** ——
   *   这一态会让主体长期多缴，必须在界面上明确提示补录要件。
   * - `not_applicable`：非小规模纳税人，或主体已关闭免征判定。
   */
  smallScaleExemption:
    | 'within'
    | 'beyond'
    | 'unknown'
    | 'not_applicable';
  /** T9：免征额度未判定时的原因（`smallScaleExemption = 'unknown'` 时有值） */
  smallScaleExemptionReason: string | null;
  payableTax: number;
  closingCredit: number;
  reconciled: boolean;
  differences: Array<{
    code: string;
    label: string;
    amount: number;
    reason: string | null;
  }>;
  /**
   * 附加税费（城建税 / 教育费附加 / 地方教育附加）。
   *
   * `blocked = true` 表示**要件缺失、拒绝出数**（如主体未配城建税率），
   * 此时 `blockedReason` 有值且下面三个金额不可用 —— 不可当作 0 处理。
   */
  surcharge: {
    blocked: boolean;
    blockedReason: string | null;
    /** 主体城建税率（百分数，7/5/1）；null = 未配置 */
    urbanMaintRate: number | null;
    urbanMaint: number;
    education: number;
    localEducation: number;
    total: number;
    /** 仅为「合法的 0」出现（期末留抵 / 免税） */
    skippedReason: string | null;
    /** 本次适用的减免，逐条可解释 */
    adjustments: string[];
    /**
     * 计提凭证状态：`created` = 凭证已就绪（含重复确认命中去重）；
     * `skipped` = 本期无附加税可提（留抵 / 免税）；`failed` = 生成失败已进补偿队列；
     * `not_attempted` = 尚未确认（底稿预览）。
     */
    accrualVoucher: 'created' | 'skipped' | 'failed' | 'not_attempted';
  };
  /**
   * T-S3：月末转出未交增值税凭证状态（借 222103 / 贷 222104）。
   *
   * `created` = 结转凭证已就绪（含重复确认命中去重）；
   * `skipped` = 本期无税可转（期末留抵 / 免税）；
   * `failed` = 生成失败已进补偿队列；
   * `not_attempted` = 尚未确认（底稿预览）。
   */
  transferVoucher: 'created' | 'skipped' | 'failed' | 'not_attempted';
  generatedAt: string;
  generatedBy: string | null;
}

export interface ConfirmVatDeclarationDto {
  period: string;
  taxEntityId?: string;
  differenceReason?: string;
}

/** A-07：个税累计预扣预缴 */
export type TaxDeductionType =
  | 'child_education'
  | 'continuing_education'
  | 'medical'
  | 'housing_loan'
  | 'housing_rent'
  | 'elderly_support'
  | 'infant_care';

export interface EmployeeTaxDeductionItem {
  id: string;
  employeeId: string;
  employeeName: string | null;
  taxYear: number;
  deductionType: TaxDeductionType;
  monthlyAmount: number;
  startMonth: number;
  endMonth: number | null;
  remark: string | null;
  /** 赡养老人：是否独生子女。null = 未声明（历史数据），下次编辑必须声明 */
  isOnlyChild: boolean | null;
  /** 赡养老人：非独生子女本人分摊额（元/月，上限 1500） */
  shareAmount: number | null;
  /** 子女教育 / 婴幼儿照护：人数，上限 = 标准 × 人数 */
  dependentCount: number;
  /** 本人扣除比例（0~1，父母各扣 50% 填 0.5） */
  shareRatio: number;
}

export interface UpsertTaxDeductionDto {
  employeeId: string;
  taxYear: number;
  deductionType: TaxDeductionType;
  monthlyAmount: number;
  startMonth?: number;
  endMonth?: number | null;
  remark?: string;
  /** 赡养老人必填：是否独生子女 */
  isOnlyChild?: boolean | null;
  /** 非独生子女赡养老人必填：本人分摊额（元/月） */
  shareAmount?: number | null;
  /** 子女教育 / 婴幼儿照护：人数，默认 1 */
  dependentCount?: number;
  /** 本人扣除比例，默认 1 */
  shareRatio?: number;
}

export interface PayrollTaxPreview {
  employeeId: string;
  period: string;
  monthIndex: number;
  ytdIncome: number;
  ytdTaxFreeIncome: number;
  ytdBasicDeduction: number;
  ytdSpecialDeduction: number;
  ytdAdditionalDeduction: number;
  ytdOtherDeduction: number;
  taxableIncome: number;
  taxRate: number;
  quickDeduction: number;
  ytdTaxPayable: number;
  ytdTaxWithheld: number;
  currentTax: number;
  netSalary: number;
}

/* ========== 批次二 C 线：银行账户/流水、银企对账、异步导出、待办中心 ========== */

/** C-02：银行流水借贷方向（income=收款入账，expense=付款出账） */
export type BankStatementDirection = 'income' | 'expense';
/** C-02：流水匹配状态 */
export type BankStatementMatchStatus = 'unmatched' | 'matched' | 'manual' | 'ignored';
/** C-02：匹配到的对方单据类型 */
export type BankMatchBizType = 'receipt' | 'payment' | 'voucher';

export interface BankAccountItem {
  id: string;
  code: string;
  name: string;
  accountNo: string;
  bankName: string;
  branchName: string | null;
  currency: string;
  /** 关联会计科目编码（通常为 1002 银行存款，可细化到末级明细科目） */
  accountCode: string | null;
  accountName: string | null;
  /** 手工维护的期初余额（对账用，来自银行对账单口径） */
  openingBalance: number;
  isDefault: boolean;
  status: string;
  contactPerson: string | null;
  contactPhone: string | null;
  remark: string | null;
  createdAt: string;
}

export interface CreateBankAccountDto {
  name: string;
  accountNo: string;
  bankName: string;
  branchName?: string;
  currency?: string;
  accountCode?: string;
  openingBalance?: number;
  isDefault?: boolean;
  status?: string;
  contactPerson?: string;
  contactPhone?: string;
  remark?: string;
}

export interface UpdateBankAccountDto {
  name?: string;
  accountNo?: string;
  bankName?: string;
  branchName?: string;
  currency?: string;
  accountCode?: string;
  openingBalance?: number;
  isDefault?: boolean;
  status?: string;
  contactPerson?: string;
  contactPhone?: string;
  remark?: string;
}

export interface BankStatementItem {
  id: string;
  bankAccountId: string;
  bankAccountName: string | null;
  transactionDate: string;
  direction: BankStatementDirection;
  amount: number;
  balance: number | null;
  counterpartyName: string | null;
  counterpartyAccount: string | null;
  summary: string | null;
  transactionNo: string | null;
  /** 用于去重的业务指纹（交易流水号缺失时按 账户+日期+方向+金额+摘要 生成） */
  dedupeKey: string;
  matchStatus: BankStatementMatchStatus;
  bizType: BankMatchBizType | null;
  bizId: string | null;
  bizCode: string | null;
  matchScore: number | null;
  remark: string | null;
  createdAt: string;
}

/** C-02：导入字段映射（不同银行列名不同，逐字段映射到标准列） */
export interface BankStatementMapping {
  transactionDate: string;
  direction?: string;
  /** 借贷方向为同一列时该列取值中的收入关键词（逗号分隔），缺省用内置词表 */
  creditKeywords?: string;
  debitKeywords?: string;
  amount: string;
  balance?: string;
  counterpartyName?: string;
  counterpartyAccount?: string;
  summary?: string;
  transactionNo?: string;
  /** 是否包含表头行，默认 true */
  hasHeader?: boolean;
  /** 工作表名（xlsx 多 sheet 时指定） */
  sheetName?: string;
}

export interface BankStatementImportError {
  row: number;
  reason: string;
}

export interface BankStatementImportResult {
  bankAccountId: string;
  totalRows: number;
  imported: number;
  duplicated: number;
  invalid: number;
  errors: BankStatementImportError[];
  /** 导入后触发的自动匹配结果 */
  match: BankStatementMatchStat;
}

export interface BankStatementMatchStat {
  bankAccountId: string | null;
  period: string | null;
  total: number;
  matched: number;
  unmatched: number;
  ignored: number;
  /** 匹配率 = matched / (total - ignored)，分母为 0 时为 0 */
  matchRate: number;
}

export interface AutoMatchResult {
  scanned: number;
  matched: number;
  details: Array<{
    statementId: string;
    bizType: BankMatchBizType;
    bizId: string;
    bizCode: string;
    score: number;
  }>;
}

export interface ManualMatchBankStatementDto {
  bizType: BankMatchBizType;
  bizId: string;
  remark?: string;
}

export interface UnmatchBankStatementDto {
  remark?: string;
}

/** C-02：可复用的导入字段映射模板（不同银行格式不同） */
export interface BankImportMappingItem {
  id: string;
  name: string;
  bankName: string | null;
  mapping: BankStatementMapping;
  remark: string | null;
  createdAt: string;
}

export interface SaveBankImportMappingDto {
  name: string;
  bankName?: string;
  mapping: BankStatementMapping;
  remark?: string;
}

export interface BankStatementListParams {
  bankAccountId?: string;
  period?: string;
  matchStatus?: BankStatementMatchStatus;
  page?: number;
  pageSize?: number;
}

/** C-02/C-03：未达账项（可追溯到具体流水或凭证） */
export interface BankReconciliationOutstandingItem {
  /** bank_only=银行已入账企业未入账；book_only=企业已入账银行未入账 */
  side: 'bank_only' | 'book_only';
  direction: BankStatementDirection;
  source: 'bank_statement' | 'voucher';
  sourceId: string;
  sourceCode: string | null;
  tradeDate: string;
  amount: number;
  description: string;
}

/** C-03：恒等式断言项 */
export interface BankReconciliationCheck {
  key: string;
  label: string;
  left: number;
  right: number;
  difference: number;
  passed: boolean;
}

export interface BankReconciliationReport {
  bankAccountId: string;
  bankAccountName: string;
  bankAccountNo: string;
  accountCode: string;
  period: string;
  currency: string;
  /** ① 银行对账单余额 */
  bankStatementBalance: number;
  bankStatementBalanceSource: 'statement' | 'manual' | 'none';
  /** ② 企业已收银行未收（银行侧未达账项，加项） */
  enterpriseReceivedBankNotReceived: number;
  /** ③ 企业已付银行未付（银行侧未达账项，减项） */
  enterprisePaidBankNotPaid: number;
  /** ④ 银行已收企业未收（企业侧未达账项，加项） */
  bankReceivedEnterpriseNotReceived: number;
  /** ⑤ 银行已付企业未付（企业侧未达账项，减项） */
  bankPaidEnterpriseNotPaid: number;
  /** 左侧：调节后银行对账单余额 = ① + ② − ③ */
  adjustedBankBalance: number;
  /** ⑥ 企业账面余额（会计科目期末余额） */
  bookBalance: number;
  /** 右侧：调节后企业账面余额 = ⑥ + ④ − ⑤ */
  adjustedBookBalance: number;
  /** 未达账项明细，bank_only/book_only 可追溯到具体流水或凭证 */
  outstandingItems: BankReconciliationOutstandingItem[];
  checks: BankReconciliationCheck[];
  balanced: boolean;
  /** 未达账项条数 */
  outstandingCount: number;
  generatedAt: string;
}

/** C-07：异步导出任务状态 */
export type ExportTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type ExportFileFormat = 'xlsx' | 'csv';

/** 支持导出的资源类型（服务端注册表，见 export-resources.ts） */
export type ExportResourceType =
  | 'bank_statement'
  | 'bank_statement_unmatched'
  | 'bank_reconciliation'
  | 'bank_account';

export interface ExportTaskItem {
  id: string;
  code: string;
  resourceType: ExportResourceType;
  resourceLabel: string;
  format: ExportFileFormat;
  filterParams: Record<string, string | number | boolean | null>;
  /** 写入文件首行的筛选条件说明（审计要求） */
  filterSummary: string;
  status: ExportTaskStatus;
  fileName: string | null;
  fileSize: number | null;
  rowCount: number | null;
  errorMessage: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  downloadUrl: string | null;
}

export interface CreateExportTaskDto {
  resourceType: ExportResourceType;
  format?: ExportFileFormat;
  filterParams?: Record<string, string | number | boolean | null>;
}

export interface ExportTaskListParams {
  status?: ExportTaskStatus;
  resourceType?: ExportResourceType;
  page?: number;
  pageSize?: number;
}

/** C-08：统一待办紧急度 */
export type TaskUrgency = 'overdue' | 'urgent' | 'normal';

/** C-08：统一待办业务类型 */
export type TaskBizType =
  | 'quotation_approval'
  | 'contract_approval'
  | 'payment_approval'
  | 'expense_approval'
  | 'leave_approval'
  | 'attendance_approval'
  | 'purchase_approval'
  | 'asset_change_approval'
  | 'deliverable_acceptance'
  | 'ar_overdue'
  | 'delivery_overdue'
  | 'budget_overrun'
  | 'contract_expiry'
  | 'rent_expiry'
  | 'reconciliation_difference';

export interface TaskItem {
  bizType: TaskBizType;
  bizId: string;
  bizCode: string | null;
  title: string;
  urgency: TaskUrgency;
  dueAt: string | null;
  /** 前端跳转地址（点击直达详情） */
  url: string;
  /** 归属模块中文名，用于分组展示 */
  moduleLabel: string;
  /** 附加说明（金额、客户等） */
  detail: string | null;
}

export interface TaskSummary {
  total: number;
  overdue: number;
  urgent: number;
  normal: number;
  byType: Array<{ bizType: TaskBizType; label: string; count: number }>;
}

export interface TaskListParams {
  bizType?: TaskBizType;
  urgency?: TaskUrgency;
  sortBy?: 'urgency' | 'dueAt' | 'bizType';
  page?: number;
  pageSize?: number;
  /** 仅取角标数量时置 false，跳过明细裁剪 */
  includeItems?: boolean;
}

/* ========== 批次一 A-11：凭证来源单据关联（voucher.controller 使用） ========== */

/** 凭证来源单据引用（供前端「来源单据」区块跳转） */
export interface VoucherSourceRef {
  /** 来源类型，与 fin_voucher.source_type 一致 */
  sourceType: VoucherSourceType;
  /** 归一化后的业务类型，供前端选择跳转目标 */
  bizType: string;
  /** 业务单据主键；source_ref 只带业务编码时无法解析，此时为 null */
  bizId: string | null;
  /** 原始 source_ref 文本（如 `invoice:INV2026100001`） */
  sourceRef: string | null;
  /** 业务单据编码（如 INV2026100001、APB2026100001） */
  bizCode: string | null;
  /** 可读标题，如「销项发票 INV2026100001」 */
  title: string;
  /** 前端跳转路径；无法定位时为 null（前端应展示"未关联到具体单据"） */
  url: string | null;
  /** 该来源类型是否需要人工核对（例如手工凭证） */
  manual: boolean;
}

/** A-11：凭证行备注编辑入参 */
export interface UpdateVoucherLineDto {
  summary?: string;
}

/* ========== B-1 / REQ-BE-01：凭证主体归属自检 ========== */

/**
 * 未归属纳税主体的凭证（逐张下钻用）。
 *
 * 这些凭证**不会出现在任何主体的报表里**（`fin_voucher.tax_entity_id IS NULL`），
 * 因此必须在界面上显式暴露，否则等同于“凭证静默消失”。
 */
export interface UnassignedEntityVoucher {
  id: string;
  code: string;
  period: string;
  voucherDate: string;
  /** `NULL` 在视图/接口里统一归一为 `(manual)` */
  sourceType: string;
  sourceRef: string | null;
  summary: string;
  /** 该凭证借方合计（单边口径，与视图一致） */
  totalDebit: number;
}

/** 未归属凭证的「期间 × 来源类型」聚合行 */
export interface UnassignedEntityGroup {
  period: string;
  sourceType: string;
  voucherCount: number;
  totalDebit: number;
}

/**
 * 凭证主体归属自检结果（GET /api/voucher/unassigned-entity）。
 *
 * `consistent = voucherCount === 0` 表示本期无缺口；前端据此决定是否弹提示。
 */
export interface UnassignedEntityCheckResult {
  /** 本次检查限定的期间；未指定为 null（全量） */
  period: string | null;
  /** 本次检查限定的来源类型；未指定为 null（全部） */
  sourceType: string | null;
  voucherCount: number;
  totalDebit: number;
  consistent: boolean;
  /** 按「期间 + 来源类型」聚合（与视图 `v_fin_voucher_unassigned_entity` 同口径） */
  groups: UnassignedEntityGroup[];
  /** 逐张明细（下钻），按期间 + 凭证编码排序 */
  vouchers: UnassignedEntityVoucher[];
}

/* ========== 批次一 A 线补充契约：模板行 / 年结留痕 / 申报历史 / 试算平衡 ========== */

/** 报表模板行（GET /api/finance/reports/templates/:reportCode） */
export interface ReportTemplateRow {
  reportCode: string;
  rowNo: string;
  rowName: string;
  formula: string;
  section: string;
  indent: number;
  bold: boolean;
  sortNo: number;
}

/** 年结留痕记录（GET /api/finance/year-end/log） */
export interface YearEndLogItem {
  id: string;
  fiscalYear: number;
  action: string;
  actorUserId: string | null;
  reason: string | null;
  createdAt: string;
}

/** 增值税申报底稿历史（GET /api/finance/tax-declaration/list） */
export interface VatDeclarationHistoryItem {
  period: string;
  taxEntityId: string | null;
  taxEntityName: string | null;
  status: string;
  outputTax: number;
  inputTax: number;
  payableTax: number;
  closingCredit: number;
  reconciled: boolean;
  differenceReason: string | null;
  generatedBy: string | null;
  generatedAt: string | null;
}

/** 试算平衡（GET /api/finance/ledgers/trial-balance） */
export interface TrialBalanceResult {
  period: string;
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

/** 财务报表/账簿查询参数（period 必填，其余可选） */
export interface ReportQueryArgs {
  period: string;
  taxEntityId?: string;
  /**
   * P0-2：「含草稿预览」开关。默认 false = 只取已过账凭证（正式口径）；
   * true = 已过账 + 草稿（预览口径，需在页面明确标注）。
   */
  includeDraft?: boolean;
}

export interface LedgerQueryArgs extends ReportQueryArgs {
  /** 科目层级上限 1~6 */
  level?: number;
}

export interface DetailLedgerQueryArgs {
  accountCode: string;
  period: string;
  page?: number;
  pageSize?: number;
  taxEntityId?: string;
  includeChildren?: boolean;
  includeDraft?: boolean;
}

export interface AuxBalanceQueryArgs {
  period: string;
  /** 辅助维度编码，如 project / department */
  dimension: string;
  dimensionId?: string;
  taxEntityId?: string;
  includeDraft?: boolean;
}

export interface CarryForwardArgs {
  period: string;
  taxEntityId?: string;
}

export interface ReverseYearEndArgs {
  fiscalYear: number;
  reason: string;
  approved: boolean;
  taxEntityId?: string;
}

/* ========== 批次一 B-02：数据级权限（行级可见范围） ========== */

/** B-02：行级可见范围 */
export type DataScopeType =
  | 'all'
  | 'dept'
  | 'dept_and_child'
  | 'self'
  | 'custom'
  /** 未配置即拒绝；仅运行时计算结果，不写入 sys_data_scope */
  | 'none';

/** B-02：可配置数据权限的资源类型 */
export type DataScopeResource =
  | 'project'
  | 'customer'
  | 'finance_ledger'
  | 'employee'
  | 'attendance';

/** B-02：单条数据权限配置（GET /api/system/data-scopes） */
export interface DataScopeConfigItem {
  roleCode: string;
  resourceType: DataScopeResource;
  scope: DataScopeType;
  /** scope=custom 时生效的显式 id 列表 */
  customIds: string[];
  enabled: boolean;
  remark: string | null;
}

/** B-02：数据权限配置写入（POST /api/system/data-scopes） */
export interface UpsertDataScopeDto {
  roleCode: string;
  resourceType: DataScopeResource;
  scope: DataScopeType;
  customIds?: string[];
  enabled?: boolean;
  remark?: string;
}

/* ========== 批次一 A-12 / 批次二 C-06：打印与套打（后端数据包） ========== */

/** 打印抬头（取自 sys_brand_config，与 settings.service.ts 的 getBrand 同源） */
export interface PrintHeader {
  brandName: string;
  /** 有 Logo 时为 /api/settings/brand/logo，否则 null */
  logoUrl: string | null;
  title: string;
  subtitle: string | null;
}

/** 打印件上的签章位（会计基础工作规范要求的基本要素） */
export interface PrintSignatureSlot {
  /** 槽位标识：prepared / reviewed / posted / chief_accountant 等 */
  slot: string;
  /** 中文签章栏名称 */
  label: string;
  /** 预填的经办人姓名（未登录/未指定为 null，前端留空手签） */
  signer: string | null;
}

/** 报表打印行（去掉下钻明细，便于整页排版） */
export interface ReportPrintRow {
  rowNo: string;
  rowName: string;
  indent: number;
  bold: boolean;
  amount: number;
  ytdAmount: number;
  previousAmount: number;
}

/**
 * A-12：报表打印数据包（GET /api/finance/reports/:reportCode/print）。
 *
 * 纯前端打印（react-to-print + @media print）所需的全部数据一次给全，
 * 避免前端为了排版再发 N 个请求。
 */
export interface ReportPrintPack {
  reportCode: ReportCode;
  reportName: string;
  period: string;
  taxEntityId: string | null;
  taxEntityName: string | null;
  header: PrintHeader;
  rows: ReportPrintRow[];
  checks: ReportCheck[];
  balanced: boolean;
  /**
   * 报表合计/净额的中文大写（A-12 验收标准③）。
   * 口径：资产负债表取「资产总计」，利润表取「净利润」，现金流量表取「现金净增加额」。
   */
  totalLabel: string;
  totalAmount: number;
  totalInWords: AmountInWords;
  /** 签章栏（制单/审核/记账/会计主管） */
  signatures: PrintSignatureSlot[];
  /** 页脚说明（含打印时间、操作人） */
  footerNote: string;
  /** 是否可用浏览器打印为 PDF（恒 true，保留字段便于将来切换服务端渲染） */
  clientPrint: boolean;
  generatedAt: string;
}

/** 金额中文大写（A-12 验收标准③） */
export interface AmountInWords {
  /** 原始金额（元，两位小数语义） */
  amount: number;
  /** 人民币大写，如「壹仟贰佰叁拾肆元伍角陆分」 */
  text: string;
}


/* ========== 批次一 B-03 / B-07 / B-08：系统字典、参数、编号规则、数据保留 ========== */

/** 字典项（GET /api/system/dictionary） */
export interface DictionaryItem {
  dictType: string;
  dictKey: string;
  dictLabel: string;
  extra: string | null;
  sortNo: number;
  enabled: boolean;
  /** 内置项：后端拒绝删除（409），只能停用 */
  builtin: boolean;
  remark: string | null;
}

/** 字典项新增/更新（POST /api/system/dictionary） */
export interface UpsertDictionaryDto {
  dictType: string;
  dictKey: string;
  dictLabel: string;
  extra?: string;
  sortNo?: number;
  enabled?: boolean;
  remark?: string;
}

/** 前端下拉快照（GET /api/system/dictionary/options）：只含启用项 */
export interface DictionaryOptionsResult {
  dictionary: Record<
    string,
    Array<{ key: string; label: string; extra: string | null }>
  >;
  /** 税率档位数值（正式来源为字典，缺失时后端回落到 shared/tax.ts） */
  taxRates: number[];
}

/** 系统参数（GET /api/system/params） */
export interface SystemParamItem {
  paramKey: string;
  paramValue: string;
  valueType: 'string' | 'number' | 'boolean' | 'json';
  paramGroup: string;
  description: string | null;
  /** false 表示只读参数（财务口径红线），设置页禁止修改 */
  editable: boolean;
}

/** 编号规则（GET/POST /api/system/code-rules） */
export interface CodeRuleItem {
  bizType: string;
  bizName: string;
  prefix: string;
  datePattern: 'YYYYMM' | 'YYYY' | 'NONE';
  seqLength: number;
  resetPolicy: 'never' | 'yearly' | 'monthly';
  /** 财务类单据强制为 false（审计红线） */
  allowReuse: boolean;
  enabled: boolean;
  remark: string | null;
}

/** 数据保留策略（GET /api/system/retention-policies） */
export interface RetentionPolicyItem {
  dataType: string;
  displayName: string;
  retainDays: number;
  action: 'none' | 'archive' | 'delete';
  enabled: boolean;
  lastRunAt: string | null;
  lastRunCount: number | null;
  remark: string | null;
}

/** 保留策略更新（POST /api/system/retention-policies/:dataType） */
export interface UpdateRetentionDto {
  retainDays?: number;
  action?: 'none' | 'archive' | 'delete';
  enabled?: boolean;
  remark?: string;
}

/** 编号规则新增/更新（POST /api/system/code-rules） */
export interface UpsertCodeRuleDto {
  bizType: string;
  bizName?: string;
  prefix: string;
  datePattern?: 'YYYYMM' | 'YYYY' | 'NONE';
  seqLength?: number;
  resetPolicy?: 'never' | 'yearly' | 'monthly';
  allowReuse?: boolean;
  enabled?: boolean;
  remark?: string;
}

/* ========== API-1 请求体契约补充（class DTO 的 implements 来源） ========== */

/**
 * 项目里程碑更新（PATCH /api/projects/milestones/:id）。
 *
 * 与 UpdateProjectMilestoneDto 的区别：该接口额外允许把里程碑标记为已达成
 * （status='reached' + actualDate）。服务层 projects.service.ts 原先就地声明为
 * `UpdateProjectMilestoneDto & { status?: 'reached'; actualDate?: string }`。
 */
export interface ProjectMilestoneCloseDto extends UpdateProjectMilestoneDto {
  status?: 'reached';
  /** 实际达成日期（缺省取业务时区当天） */
  actualDate?: string;
}

/* ========== 批次一 B 线：前端 API 请求参数契约（把内联类型收敛到 shared） ========== */

/** 里程碑更新（PATCH /api/contracts/milestones/:id） */
export interface UpdateMilestoneDto {
  status?: 'reached';
  actualDate?: string;
  name?: string;
  amount?: number;
}

/** 合同版本登记（POST /api/contracts/:id/changes） */
export interface CreateContractVersionDto {
  changeLog: string;
  newAmount?: number;
}

/** 身份用户列表查询（GET /api/identity/users） */
export interface ListIdentityUsersParams {
  q?: string;
  status?: string;
  role?: string;
}

/** 创建身份用户（POST /api/identity/users） */
export interface CreateIdentityUserDto {
  username: string;
  displayName: string;
  password?: string;
  employeeId?: string;
  roles?: string[];
}

/** 项目结项/状态流转附带信息（POST /api/projects/:id/status） */
export interface ProjectStatusCloseDto {
  closeSummary?: string;
  satisfaction?: number;
  retrospective?: string;
}
/** 按报价单导入合同明细（POST /api/contracts/:id/items/import-quotation） */
export interface ImportQuotationItemsDto {
  quotationId: string;
}

/** 客户/员工启停（PATCH .../status）：状态值必须显式校验，避免任意字符串落库 */
export interface SetEntityStatusDto {
  status: 'active' | 'inactive';
}

/** 飞书报价表预览（POST /api/crm/quotations/feishu-bitable/preview） */
export interface FeishuBitablePreviewDto {
  recordIds?: string[];
}

/** 飞书报价表导入（POST /api/crm/quotations/feishu-bitable/import） */
export interface FeishuBitableImportDto {
  recordIds?: string[];
  /** 导入前的默认税率（%），缺省由后端按纳税主体解析 */
  taxRate?: number;
  customerId?: string;
}

/** 辅助核算维度创建（POST /api/finance/ledgers/aux-dimensions） */
export interface CreateAuxDimensionDto {
  code: string;
  name: string;
  sourceType?: string;
  remark?: string;
}

/** 辅助核算维度启停（POST /api/finance/ledgers/aux-dimensions/:code/enabled） */
export interface ToggleAuxDimensionDto {
  enabled: boolean;
}

/** 飞书联系人绑定（POST /api/identity/users/:id/feishu/bind-contact） */
export interface BindFeishuContactDto {
  openId: string;
  unionId?: string;
  name?: string;
}

/* ========== 批次三 D-08：固定资产减值、处置与全生命周期 ========== */

/** 减值测试预览（GET /api/asset/impairment-test） */
export interface ImpairmentTestPreview {
  assetId: string;
  assetCode: string;
  assetName: string;
  originalValue: number;
  accumulatedDepreciation: number;
  accumulatedImpairment: number;
  /** 账面价值 = 原值 − 累计折旧 − 已计提减值 */
  bookValue: number;
  recoverableAmount: number;
  /** 减值损失 = max(账面价值 − 可收回金额, 0) */
  impairmentLoss: number;
  /** 损失为 0 时无需建单 */
  needsImpairment: boolean;
  /** 可收回金额低于残值的提示（不阻断，仅供复核） */
  belowResidual: boolean;
}

export interface AssetImpairmentItem {
  id: string;
  code: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  testDate: string;
  period: string;
  bookValue: number;
  recoverableAmount: number;
  impairmentLoss: number;
  method: string;
  /** 关联的凭证 sourceRef；null 表示凭证生成失败（已进补偿队列） */
  voucherRef: string | null;
  remark: string | null;
  createdAt: string;
}

export interface CreateAssetImpairmentDto {
  assetId: string;
  /** 减值测试日 */
  testDate: string;
  /** 归属期间 YYYY-MM，同一资产同一期间只允许一次测试 */
  period: string;
  /** 可收回金额（公允价值减处置费用与预计未来现金流量现值孰高），由评估确定 */
  recoverableAmount: number;
  method?: string;
  remark?: string;
}

export type AssetDisposalType = 'sale' | 'scrap' | 'donate';
export type AssetDisposalStatus = 'disposing' | 'disposed' | 'scrapped' | 'rejected';
export type DisposalAction = 'complete' | 'reject';

export interface AssetDisposalItem {
  id: string;
  code: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  disposalType: AssetDisposalType;
  status: AssetDisposalStatus;
  applyDate: string;
  disposeDate: string | null;
  originalValue: number;
  accumulatedDepreciation: number;
  netValue: number;
  disposalIncome: number;
  taxRate: number | null;
  taxAmount: number;
  /** 正为处置收益（营业外收入），负为处置损失（营业外支出） */
  gainLoss: number;
  voucherRef: string | null;
  reason: string | null;
  remark: string | null;
  approvedBy: string | null;
  createdAt: string;
}

export interface CreateAssetDisposalDto {
  assetId: string;
  disposalType: AssetDisposalType;
  applyDate: string;
  /** 处置收入（不含税）；报废/捐赠为 0 */
  disposalIncome?: number;
  /** 销项税率（%） */
  taxRate?: number;
  reason?: string;
  remark?: string;
}

/** 处置预览（GET /api/asset/disposal-preview） */
export interface AssetDisposalPreview {
  netBookValue: number;
  accumulatedImpairment: number;
  taxAmount: number;
  gainLoss: number;
  lines: Array<{ accountCode: string; debit: number; credit: number }>;
}

/** 生命周期事件 */
export type AssetLifecycleEventType =
  | 'purchase'
  | 'change'
  | 'depreciation'
  | 'impairment'
  | 'disposal';

export interface AssetLifecycleEvent {
  eventType: AssetLifecycleEventType;
  /** 事件发生日 YYYY-MM-DD */
  occurredAt: string;
  title: string;
  /** 金额语义随事件类型不同：采购=原值、折旧=本期折旧、减值=减值损失、处置=净损益 */
  amount: number | null;
  refCode: string;
  detail: string;
}

/** 完整生命周期（GET /api/asset/assets/:id/lifecycle） */
export interface AssetLifecycleResult {
  assetId: string;
  assetCode: string;
  assetName: string;
  status: string;
  originalValue: number;
  accumulatedDepreciation: number;
  accumulatedImpairment: number;
  residualValue: number;
  /** 账面净值 = 原值 − 累计折旧 − 累计减值 */
  netBookValue: number;
  purchaseOrderId: string | null;
  departmentName: string | null;
  projectName: string | null;
  events: AssetLifecycleEvent[];
}

/* ========== 批次三 D-12：BI 指标中心与预警订阅 ========== */

/** 单个指标：必须带可读的公式口径说明与下钻入口 */
export interface BiMetric {
  key: string;
  name: string;
  value: number;
  unit: string;
  /** 可读中文口径说明（不是代码），例如「毛利率 =（营业收入 − 营业成本）/ 营业收入」 */
  formula: string;
  /** 前端跳转路径；无对应页面时为 null */
  drillUrl: string | null;
  /** 环比/上期对比值；无上期数据时 null */
  previousValue: number | null;
}

export interface BiMetricsResult {
  period: string;
  generatedAt: string;
  metrics: BiMetric[];
}

export type BiAlertDirection = 'gt' | 'lt';

export interface BiAlertSubscriptionItem {
  id: string;
  userId: string;
  metricKey: string;
  metricName: string;
  thresholdDirection: BiAlertDirection;
  threshold: number;
  channel: 'feishu' | 'inbox';
  enabled: boolean;
  lastTriggeredAt: string | null;
  remark: string | null;
  createdAt: string;
}

export interface UpsertBiAlertSubscriptionDto {
  metricKey: string;
  thresholdDirection?: BiAlertDirection;
  threshold: number;
  channel?: 'feishu' | 'inbox';
  enabled?: boolean;
  remark?: string;
}

/* ========== 批次二 C-09：预算承诺与「三算对比」 ========== */

/** 承诺来源：采购订单 / 已生效合同 / 待批费用申请 */
export type CommitmentSourceType = 'purchase_order' | 'contract' | 'expense_apply';

/** 单条承诺明细（可下钻到具体单据） */
export interface BudgetCommitmentRow {
  sourceType: CommitmentSourceType;
  sourceId: string;
  sourceCode: string;
  sourceTitle: string;
  projectId: string | null;
  departmentId: string | null;
  expenseCategory: string | null;
  /** 归属期间 YYYY-MM */
  period: string;
  amount: number;
  status: string;
  signedAt: string | null;
}

/** 三算对比的一行（维度：期间 × 部门 × 项目 × 费用类别） */
export interface BudgetCommitmentSummaryRow {
  period: string;
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  expenseCategory: string;
  /** 预算金额 */
  budgetAmount: number;
  /** 承诺金额（已签合同/已下采购单/待批申请，钱还没花但已不能挪用） */
  committedAmount: number;
  /** 实际金额（已批准报销 + 已批准费用申请） */
  actualAmount: number;
  /** 可用余额 = 预算 − 承诺 − 实际（可为负） */
  availableAmount: number;
  /** 承诺 + 实际 已超预算 */
  overCommitted: boolean;
  /** 仅承诺就已超预算（最紧急：签约阶段即失控） */
  commitmentAloneExceedsBudget: boolean;
}

export interface BudgetCommitmentSummary {
  generatedAt: string;
  /** 过滤的期间；null 表示全部期间 */
  period: string | null;
  totals: {
    budgetAmount: number;
    committedAmount: number;
    actualAmount: number;
    availableAmount: number;
  };
  rows: BudgetCommitmentSummaryRow[];
}

/** 孤儿承诺：没有任何预算行覆盖的承诺（三算表里看不到，风险最高） */
export type CommitmentGapRow = BudgetCommitmentRow;

/* ========== 批次二 C-13：数据资产脱敏等级与授权回收审计 ========== */

/** 脱敏等级（封闭枚举，与 server/modules/data-asset/mask-policy.ts 一致） */
export type MaskLevel = 'L1' | 'L2' | 'L3' | 'L4';

/** 敏感字段语义 */
export type SensitiveFieldKind =
  | 'name'
  | 'phone'
  | 'email'
  | 'id_card'
  | 'bank_account'
  | 'address'
  | 'amount'
  | 'location'
  | 'other';

/** 数据集脱敏字段登记项 */
export interface DatasetFieldItem {
  id: string;
  datasetId: string;
  /** 导出文件/查询结果中的列名 */
  columnName: string;
  fieldKind: SensitiveFieldKind;
  fieldLabel: string | null;
  remark: string | null;
  createdAt: string;
}

export interface UpsertDatasetFieldDto {
  columnName: string;
  fieldKind: SensitiveFieldKind;
  fieldLabel?: string;
  remark?: string;
}

/** 脱敏等级字典项 */
export interface MaskLevelOption {
  level: MaskLevel;
  label: string;
  description: string;
  /** L4 等核心等级回收授权时需要登记销毁凭证 */
  destroyProofRequired: boolean;
}

/** 脱敏预览结果（导出前让业务方确认会变成什么样） */
export interface MaskPreviewResult {
  maskLevel: MaskLevel;
  maskLevelLabel: string;
  masked: Record<string, unknown>;
  /** 该等级下被禁止导出的列（调用方必须跳过写入，而不是写空串） */
  blockedColumns: string[];
}

/** 授权回收原因 */
export type GrantRevokeReason =
  | 'expired'
  | 'manual'
  | 'contract_terminated'
  | 'violation'
  | 'project_closed';

export interface RevokeGrantDto {
  reason: GrantRevokeReason;
  /** L4 数据必填，且必须与操作人不同（双人确认） */
  reviewedBy?: string;
  /** L4 数据与"违规回收"必填：对方删除副本的凭证编号/说明 */
  destructionProof?: string;
  remark?: string;
}

export interface GrantRevokeLogItem {
  id: string;
  grantId: string;
  grantCode: string;
  datasetId: string;
  datasetName: string | null;
  maskLevel: string;
  reason: GrantRevokeReason;
  reasonLabel: string;
  operator: string;
  reviewedBy: string | null;
  destructionProof: string | null;
  remark: string | null;
  destroyRequired: boolean;
  createdAt: string;
}

/** 授权回收结果：返回审计记录 id 便于前端跳转凭证 */
export interface RevokeGrantResult {
  grant: GrantItem;
  logId: string;
}

/* ========== C-06：单据打印与套打（前端打印包契约） ========== */

/**
 * C-06 可打印单据种类。
 * 说明：报表（A-12）走 `GET /api/finance/reports/:reportCode/print` 的服务端数据包，
 * 本联合只覆盖**纯前端组包**的单据类型。
 */
export type PrintDocumentKind =
  | 'contract'
  | 'quotation'
  | 'invoice'
  | 'payment'
  | 'receipt'
  | 'expense_claim'
  | 'pur_order'
  | 'pur_acceptance'
  | 'payslip'
  | 'deliverable_acceptance'
  /** C-11 客户/供应商对账单 */
  | 'statement';

/** 打印元信息行（左上角键值区） */
export interface PrintMetaField {
  label: string;
  value: string;
}

/** 打印明细列 */
export interface PrintColumn {
  key: string;
  label: string;
  /** 列宽（mm），仅作排版提示 */
  widthMm?: number;
  align?: 'left' | 'center' | 'right';
}

/** 打印明细行：`cells` 的键必须落在 `columns[].key` 内 */
export interface PrintRowData {
  cells: Record<string, string>;
}

/** 打印合计行 */
export interface PrintTotal {
  label: string;
  amount: number;
  /** 是否在合计下方追加人民币大写行 */
  inWords?: boolean;
  emphasize?: boolean;
}

/**
 * C-06：前端打印数据包。
 *
 * 形状刻意与 A-12 `ReportPrintPack` 对齐（header / signatures / footerNote），
 * 便于后续把报表打印与单据打印收敛到同一套组件。
 */
export interface PrintPack {
  kind: PrintDocumentKind;
  /** 单据编号，套打定位与页眉副标题都用到 */
  code: string;
  header: PrintHeader;
  /** 元信息行（客户/日期/状态等），由各单据自定义 */
  meta: PrintMetaField[];
  /** 明细表标题，为空则渲染元信息后直接出合计（无明细单据，如工资条/付款单） */
  tableTitle: string | null;
  columns: PrintColumn[];
  rows: PrintRowData[];
  /** 附加键值区（明细表之后），如工资条的应发/应扣构成 */
  extraFields: PrintMetaField[];
  totals: PrintTotal[];
  /** 条款/说明段落 */
  clauses: string[];
  signatures: PrintSignatureSlot[];
  footerNote: string;
  /** 数据来源说明（例如"数据来自合同模块，打印后请核对"），套打模式下隐藏 */
  sourceNote: string | null;
}

/** C-06：套打偏移量（单位 mm，正数表示向右/向下偏移内容） */
export interface PrintOffset {
  topMm: number;
  leftMm: number;
  /** 套打模式：隐藏 Logo/水印/二维码等非必要装饰 */
  overlay: boolean;
}

/** C-06：单个单据类型的打印设置（持久化到 localStorage） */
export interface PrintPreference {
  kind: PrintDocumentKind;
  offset: PrintOffset;
}

/* ========== 批次二 C-04 / 批次三 D-02：应收应付票据（银行/商业承兑汇票） ========== */

/** 票据类型：bank=银行承兑，commercial=商业承兑 */
export type NoteType = 'bank' | 'commercial';

/** 票据状态机 */
export type NoteStatus =
  | 'received'
  | 'held'
  | 'endorsed'
  | 'discounted'
  | 'settled'
  | 'dishonored';

/** 流转动作 */
export type NoteAction = 'hold' | 'endorse' | 'discount' | 'settle' | 'dishonor';

export interface NoteItem {
  id: string;
  code: string;
  noteNo: string;
  noteType: NoteType;
  drawer: string | null;
  payee: string | null;
  amount: number;
  issueDate: string | null;
  dueDate: string;
  status: NoteStatus;
  arId: string | null;
  apId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  customerId: string | null;
  customerName: string | null;
  projectId: string | null;
  projectName: string | null;
  /** 贴现息（贴现时才算，其余为 null） */
  discountInterest: number | null;
  discountRate: number | null;
  /** 到期收款/贴现入账金额 */
  settledAmount: number | null;
  settledDate: string | null;
  endorsementCounterparty: string | null;
  remark: string | null;
  createdAt: string;
  /** 距到期天数（负数=已逾期）；由服务端按业务时区计算，不在前端算 */
  daysToDue: number;
}

export interface CreateNoteDto {
  noteNo: string;
  noteType: NoteType;
  amount: number;
  dueDate: string;
  drawer?: string;
  payee?: string;
  issueDate?: string;
  arId?: string;
  apId?: string;
  supplierId?: string;
  customerId?: string;
  projectId?: string;
  remark?: string;
}

/** 票据流转入参：按动作需要不同字段 */
export interface NoteActionDto {
  action: NoteAction;
  /** 背书受让方（endorse 必填） */
  counterparty?: string;
  /** 贴现率（%，discount 必填） */
  discountRate?: number;
  /** 贴现日（discount 必填，缺省用今天） */
  discountDate?: string;
  /** 实际收/付金额（settle 可覆盖票面，例如扣手续费） */
  settledAmount?: number;
  /** 结算日期（settle 缺省用今天） */
  settledDate?: string;
  remark?: string;
}

/** 贴现试算（提交前预览息费与到账额） */
export interface NoteDiscountPreview {
  amount: number;
  rate: number;
  days: number;
  interest: number;
  netProceeds: number;
  /** 分录预览：让财务在提交前确认科目正确 */
  lines: Array<{ accountCode: string; debit: number; credit: number }>;
}

export interface NoteLogItem {
  id: string;
  noteId: string;
  action: string;
  fromStatus: string | null;
  toStatus: string;
  amount: number | null;
  counterparty: string | null;
  voucherRef: string | null;
  operator: string | null;
  remark: string | null;
  createdAt: string;
}

export interface NoteListParams {
  page?: number;
  pageSize?: number;
  status?: string;
  noteType?: string;
  /** 只看到期日在 [from, to] 的票据 */
  dueFrom?: string;
  dueTo?: string;
  projectId?: string;
}

/** D-02 票据备查簿 */
export interface NoteRegisterResult {
  byStatus: Array<{
    status: NoteStatus;
    label: string;
    count: number;
    amount: number;
  }>;
  byType: Array<{
    noteType: NoteType;
    label: string;
    count: number;
    amount: number;
  }>;
  totalAmount: number;
  /** 未结清金额（排除已结清与已拒付） */
  outstandingAmount: number;
}

/** D-02 到期预警（逾期 / 15 天内） */
export interface NoteDueAlert {
  code: string;
  noteNo: string;
  amount: number;
  dueDate: string;
  /** 负数=已逾期 */
  daysLeft: number;
  level: 'overdue' | 'urgent' | 'upcoming';
}

/* ========== C-11 客户/供应商对账单（statement of account） ==========
 *
 * 与既有的 `reconciliation/*`（内部三方勾稽：发票↔应收/应付、回款↔核销）
 * **不是同一件事**：这里产出的是**给对手方确认用的对账单**，
 * 按期列出期初余额、本期逐笔发生、运行余额与期末余额。
 */

/** 对账方向：customer=客户对账单（我方开给客户）；supplier=供应商对账单（供应商开给我方） */
export type StatementDirection = 'customer' | 'supplier';

/** 对账单上的单据类型 */
export type StatementDocType =
  | 'ar'
  | 'ap'
  | 'receipt'
  | 'payment'
  | 'invoice'
  /** 收入折让/退回冲减：必须单列，否则被折让结清的应收在对账单上会永远显示全额 */
  | 'adjust';

/** 单据核对状态：已核销/部分核销/未核销/作废/备查（备查行不参与余额） */
export type StatementReconStatus =
  | 'reconciled'
  | 'partial'
  | 'open'
  | 'voided'
  | 'informational';

/** 对账单查询参数 */
export interface StatementQueryDto {
  /** 客户对账单传 customerId；供应商对账单传 supplierId */
  counterpartyId: string;
  /** 期间 YYYY-MM */
  period: string;
  direction: StatementDirection;
}

/**
 * 对账单打印所需的组织抬头。
 * 无组织表时字段为 null，打印件退化为只显示对账单标题（不编造主体信息）。
 */
export interface StatementOrgProfile {
  companyName: string | null;
  /** 统一社会信用代码 */
  uscc: string | null;
  address: string | null;
  phone: string | null;
  bankName: string | null;
  bankAccount: string | null;
}

/** 对手方抬头 */
export interface StatementCounterparty {
  id: string;
  code: string;
  name: string;
  /** 统一社会信用代码（客户取 uscc；供应商档案无该列时为 null） */
  uscc: string | null;
  contactName: string | null;
  contactPhone: string | null;
}

/** 对账单上的一行 */
export interface StatementLineItem {
  date: string;
  docType: StatementDocType;
  docCode: string;
  /** 本方向下的增加额（客户=应收增加；供应商=应付增加） */
  debit: number;
  /** 本方向下的减少额（客户=回款/冲减；供应商=付款/冲减） */
  credit: number;
  /** 服务端滚动算出的余额；备查行为 null */
  runningBalance: number | null;
  affectsBalance: boolean;
  status: StatementReconStatus;
  relatedDocCode: string | null;
  remark: string | null;
}

/** 期间范围（左闭右开：start 含、end 不含） */
export interface StatementPeriodRange {
  start: string;
  end: string;
  monthEnd: string;
}

/** 本期核对进度（按参与余额的单据行计数） */
export interface StatementReconSummary {
  reconciled: number;
  partial: number;
  open: number;
  voidedExcluded: number;
}

/** 对账单主结果 */
export interface StatementResult {
  direction: StatementDirection;
  period: string;
  periodRange: StatementPeriodRange;
  counterpartyId: string;
  counterparty: StatementCounterparty;
  org: StatementOrgProfile;
  /** 期初余额 = 期间开始日之前的发生额净额 */
  openingBalance: number;
  /** 本期借方合计 */
  periodDebit: number;
  /** 本期贷方合计 */
  periodCredit: number;
  /** 期末余额 = 期初 + 本期借 − 本期贷 */
  closingBalance: number;
  /** 期末余额中文大写（打印用，复用 rmb-upper） */
  closingBalanceInWords: string;
  lines: StatementLineItem[];
  /** 期初构成明细（用于核对期初口径） */
  openingLines: StatementLineItem[];
  /** 本期被整单剔除的作废单据（仅提示，不参与任何金额） */
  excludedLines: StatementLineItem[];
  reconSummary: StatementReconSummary;
  generatedAt: string;
}

/** 对账单可选对手方（按是否发生过业务过滤，便于前端下拉） */
export interface StatementCounterpartyOption {
  id: string;
  code: string;
  name: string;
  /** 该对手方最近一次业务单据日期；无单据时为 null */
  lastDocDate: string | null;
}

/* ========== P0-4 / P1-1：内部勾稽中心 ========== */

/** 勾稽明细行（进项↔应付 / 销项↔应收 / 回款↔核销 / 应收未开票 共用） */
export interface ReconRowItem {
  id: string;
  code: string;
  counterpartName: string;
  amount: number;
  linkedAmount: number;
  openAmount: number;
  status: string;
  linkId: string | null;
  linkCode: string | null;
  flag: 'ok' | 'unlinked' | 'over' | 'voided_risk';
}

/** 勾稽中心汇总指标 */
export interface ReconSummary {
  purchaseUnlinked: number;
  salesUnlinked: number;
  receiptUnlinked: number;
  voidedRisk: number;
  /** P1-1：应收已登记但未开票的数量 */
  arWithoutInvoice: number;
}

/** P0-4 / P1-1：总账收入 vs 收入台账 差异检测结果 */
export interface RevenueVariance {
  period: string;
  /** 总账口径：已过账凭证 6001/6051 贷方净发生额 */
  ledgerRevenue: number;
  /** 台账口径：收入确认（status=recognized）合计 */
  bookRevenue: number;
  difference: number;
  passed: boolean;
}

/* ========== 批次二 C-05：采购/销售退货闭环 ========== */

export type ReturnStatus = 'draft' | 'submitted' | 'approved' | 'completed' | 'void';
export type ReturnAction = 'submit' | 'approve' | 'reject' | 'complete' | 'void';

/** 可退数量查询结果（下单前先告诉用户还能退多少） */
export interface ReturnableQuantityResult {
  orderId: string;
  orderCode: string;
  itemName: string;
  /** 订购数量 */
  quantity: number;
  /** 已验收数量 */
  acceptedQuantity: number;
  /** 已退数量（未作废退货单累计） */
  returnedQuantity: number;
  /** 可退数量 = 已验收 − 已退，下限 0 */
  returnableQuantity: number;
  /** 尚未验收，不可退 */
  notAccepted: boolean;
  /** 原单含税单价（退货金额按它计算） */
  unitPrice: number;
  /** 原单税率（%） */
  taxRate: number;
  supplierId: string | null;
  supplierName: string | null;
  projectId: string | null;
}

export interface PurchaseReturnItem {
  id: string;
  code: string;
  orderId: string;
  orderCode: string | null;
  supplierId: string | null;
  supplierName: string | null;
  projectId: string | null;
  projectName: string | null;
  returnDate: string;
  returnQuantity: number;
  amount: number;
  taxRate: number | null;
  netAmount: number;
  taxAmount: number;
  apBillId: string | null;
  redInvoiceId: string | null;
  status: ReturnStatus;
  reason: string | null;
  remark: string | null;
  voucherRef: string | null;
  createdByUser: string | null;
  approvedBy: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CreatePurchaseReturnDto {
  orderId: string;
  returnDate: string;
  returnQuantity: number;
  /** 覆盖原单单价（可选，缺省用原单快照） */
  unitPrice?: number;
  apBillId?: string;
  reason?: string;
  remark?: string;
}

export interface SalesReturnItem {
  id: string;
  code: string;
  revenueId: string;
  revenueCode: string | null;
  contractId: string | null;
  customerId: string | null;
  customerName: string | null;
  projectId: string | null;
  projectName: string | null;
  returnDate: string;
  amount: number;
  taxRate: number | null;
  netAmount: number;
  taxAmount: number;
  redInvoiceId: string | null;
  revenueAdjustId: string | null;
  /** 退回商品处置方式（逐单判定）；决定成本冲回的对方科目 */
  disposalType: 'restock' | 'scrap';
  /** 已冲回的成本金额（0 = 项目缺收入/成本数据，未生成成本行） */
  costAmount: number;
  status: ReturnStatus;
  reason: string | null;
  remark: string | null;
  voucherRef: string | null;
  createdByUser: string | null;
  approvedBy: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CreateSalesReturnDto {
  revenueId: string;
  returnDate: string;
  /** 退货含税金额（销售退货按金额而非数量，收入确认没有数量概念） */
  amount: number;
  taxRate?: number;
  reason?: string;
  remark?: string;
}

export interface PurchaseReturnListParams {
  page?: number;
  pageSize?: number;
  status?: string;
  orderId?: string;
  supplierId?: string;
  projectId?: string;
}

export interface SalesReturnListParams {
  page?: number;
  pageSize?: number;
  status?: string;
  revenueId?: string;
  customerId?: string;
}

/** 退货动作入参（approve/reject/complete/void 共用） */
export interface ReturnActionDto {
  action: ReturnAction;
  remark?: string;
  /**
   * 仅销售退货 complete 动作使用：退回商品的处置方式。
   * restock = 回库可再售（借 1403 原材料）；scrap = 报废（借 6602 管理费用）。
   * 不传时沿用退货单上已有的处置方式（默认 restock）。
   */
  disposalType?: 'restock' | 'scrap';
}

/** 退货台账汇总（按状态） */
export interface ReturnRegisterResult {
  purchase: {
    byStatus: Array<{ status: ReturnStatus; count: number; amount: number }>;
    totalAmount: number;
    completedAmount: number;
  };
  sales: {
    byStatus: Array<{ status: ReturnStatus; count: number; amount: number }>;
    totalAmount: number;
    completedAmount: number;
  };
}

/* ========== 批次三 D-09 / NFR-S8：审计日志防篡改校验链 ========== */

/** 链校验结果 */
export interface AuditChainVerification {
  checkedAt: string;
  /** 在线表中参与链的日志总行数 */
  totalOnlineRows: number;
  /** 本次实际检查的行数（受 limit 限制） */
  checkedRows: number;
  /** 起点/终点的链序号；空表为 null */
  firstSeq: number | null;
  lastSeq: number | null;
  /** 链尾校验和（可外发作为锚点） */
  lastHash: string | null;
  /** true = 未发现篡改 */
  intact: boolean;
  /** 异常明细（最多 50 条） */
  broken: Array<{
    id: string;
    chainSeq: number;
    reason: string;
    expected: string;
    actual: string;
  }>;
}

/** 链锚点：应定期外发到独立系统，用于证明"日志未被整体重写" */
export interface AuditChainAnchor {
  lastSeq: number | null;
  lastHash: string | null;
  totalRows: number;
  checkedAt: string;
}

/** 只追加约束自检结果 */
export interface AuditImmutabilityProbe {
  updateBlocked: boolean;
  deleteBlocked: boolean;
  message: string;
}

/* ========== 批次三 D-06：税务风险扫描 ========== */

export type TaxRiskSeverity = 'high' | 'medium' | 'low';

export type TaxRiskCategory =
  | 'burden_rate'
  | 'invoice_ledger_mismatch'
  | 'invoice_anomaly';

export interface TaxRiskFindingItem {
  code: string;
  category: TaxRiskCategory;
  severity: TaxRiskSeverity;
  title: string;
  /** 可读依据，必须含具体数字 */
  evidence: string;
  /** 建议的下一步动作 */
  suggestion: string;
  amount: number | null;
}

/** 可配置阈值（来自 sys_param，缺省值见 tax-risk-rules.ts） */
export interface TaxRiskThresholds {
  /** 增值税税负率参考区间下限（%） */
  burdenRateMin: number;
  /** 上限（%） */
  burdenRateMax: number;
  /** 环比波动阈值（百分点） */
  burdenRateFluctuation: number;
  /** 发票作废率告警阈值（%） */
  voidRateThreshold: number;
}

export interface TaxRiskBurdenRateSnapshot {
  revenue: number;
  outputTax: number;
  inputTax: number;
  payableTax: number;
  rate: number;
  withinRange: boolean;
}

export interface TaxRiskScanResult {
  period: string;
  taxEntityId: string | null;
  taxEntityName: string | null;
  thresholds: TaxRiskThresholds;
  /** 本期税负率快照（底稿不可用时为 null） */
  burdenRate: TaxRiskBurdenRateSnapshot | null;
  /** 底稿的发票口径 vs 总账口径是否已勾稽一致 */
  reconciled: boolean;
  findings: TaxRiskFindingItem[];
  bySeverity: Record<TaxRiskSeverity, number>;
  byCategory: Array<{
    category: TaxRiskCategory;
    label: string;
    count: number;
  }>;
  totalFindings: number;
  highestSeverity: TaxRiskSeverity | null;
  /** 涉及金额合计（按 code 去重） */
  totalAmountInvolved: number;
  generatedAt: string;
  /** 哪些扫描方向因取数失败被跳过（部分失败也要如实告知） */
  skipped: string[];
}

/* ========== 批次三 D-03：辅助核算深化（多维度组合 / 跨维度分析 / 分摊） ========== */

/** 维度组合单元格里的一项取值 */
export interface AuxCombinationValue {
  dimensionCode: string;
  dimensionId: string | null;
  dimensionValue: string | null;
}

/** 多维度组合的一个单元格（= 一种维度取值组合） */
export interface AuxCombinationCell {
  /** 组合键（稳定，可作前端 key） */
  key: string;
  values: AuxCombinationValue[];
  debit: number;
  credit: number;
  balance: number;
  /** 构成该单元格的分录行数（供核对） */
  lineCount: number;
}

/** 组合覆盖度：组合金额能否代表全部账 */
export interface AuxCombinationCoverage {
  /** 已挂全所选维度的发生额占比（%） */
  coverageRate: number;
  complete: boolean;
  /** 可读中文说明（不完整时含未覆盖金额与行数） */
  message: string;
}

/** 多维度组合余额结果 */
export interface AuxMultiDimensionBalance {
  /** 单期时为 YYYY-MM；区间时为 `YYYY-MM~YYYY-MM` */
  period: string;
  dimensionCodes: string[];
  /** 与 `dimensionCodes` 一一对应的中文名 */
  dimensionNames: string[];
  cells: AuxCombinationCell[];
  covered: { debit: number; credit: number; balance: number };
  /** 只挂了部分维度的行 —— 必须显式暴露，否则"加起来不等于总量" */
  uncovered: {
    debit: number;
    credit: number;
    balance: number;
    lineCount: number;
  };
  total: { debit: number; credit: number; balance: number };
  coverage: AuxCombinationCoverage;
}

/** 跨维度结构对比的一行 */
export interface AuxCrossDimensionRow {
  dimensionCode: string;
  dimensionValue: string;
  balance: number;
  /** 占该维度合计的百分比（分母是本维度合计，不是全局合计） */
  shareOfDimension: number;
}

export interface AuxCrossDimensionResult {
  period: string;
  rows: AuxCrossDimensionRow[];
  totalsByDimension: Array<{
    dimensionCode: string;
    dimensionName: string;
    total: number;
    valueCount: number;
  }>;
}

/** 某维度在某期间的取值及余额（供前端下拉，选之前就知道金额） */
export interface AuxPeriodValue {
  dimensionId: string | null;
  dimensionValue: string;
  debit: number;
  credit: number;
  balance: number;
}

/** 成本分摊试算入参 */
export interface AuxAllocationArgs {
  /** 待分摊总额（可为负，表示冲回） */
  amount: number;
  /** 分摊权重（与 `targets` 一一对应） */
  weights: number[];
  /** 分摊对象标签（部门/项目名等），仅用于回显 */
  targets?: string[];
  /** 可选的税率（%），提供后额外给出不含税净额 */
  taxRate?: number;
  /** 权重全为 0 时的策略：equal=平均分摊（默认）/ reject=报错 */
  fallback?: 'equal' | 'reject';
}

/** 成本分摊试算结果（**只算不落库**） */
export interface AuxAllocationPreview {
  amount: number;
  totalWeight: number;
  equalFallback: boolean;
  /** 因四舍五入被调整的项数（解释尾差去向） */
  adjustedCount: number;
  /** 分摊额合计 —— 必须严格等于 `amount`，服务端已自检 */
  sharesSum: number;
  lines: Array<{
    target: string;
    weight: number;
    share: number;
    /** 不含税净额；未传税率时为 null */
    netShare: number | null;
  }>;
}

/* ========== 批次三 D-02：票据备查簿深化 ========== */

export type NoteDueBucket =
  | 'overdue'
  | 'within7'
  | 'within30'
  | 'within90'
  | 'beyond90';

/** 票号连续性检查结果（《票据管理实施办法》要求备查簿连续登记） */
export interface NoteNoCheckResult {
  totalNotes: number;
  numberedNotes: number;
  /** 无票号的票据数（票号必填，非 0 说明数据有缺口） */
  missingNoteNoCount: number;
  gaps: Array<{ before: string; after: string; missing: number }>;
  duplicates: Array<{
    noteNo: string;
    codes: string[];
    amount: number;
    /** 全部为已作废 → 可能是作废后重开，不算高风险 */
    allVoided: boolean;
  }>;
  continuous: boolean;
  hasIssues: boolean;
  message: string;
}

/** 到期结构（账龄分桶，看流动性压力） */
export interface NoteDueStructureResult {
  buckets: Array<{
    bucket: NoteDueBucket;
    label: string;
    count: number;
    amount: number;
    share: number;
  }>;
  outstandingAmount: number;
  outstandingCount: number;
  overdueAmount: number;
}

/** 贴现成本分析（资金成本分析的基础数据） */
export interface NoteDiscountCostResult {
  count: number;
  amount: number;
  interest: number;
  netProceeds: number;
  /** 综合成本率（%）= 息合计 / 金额合计，**加权**而非算术平均 */
  weightedRate: number;
  byType: Array<{
    noteType: string;
    count: number;
    amount: number;
    interest: number;
    weightedRate: number;
  }>;
  /** 年化成本率（%），按实际计息天数折算 */
  annualizedRate: number;
  /** 缺息或缺计息天数的票据编号，需补录后才能计入年化 */
  incompleteCodes: string[];
}

/** 备查簿深化汇总（可直接打印给税务/审计） */
export interface NoteRegisterDeepResult {
  generatedAt: string;
  total: { count: number; amount: number };
  byStatus: Array<{
    status: string;
    label: string;
    count: number;
    amount: number;
  }>;
  dueStructure: NoteDueStructureResult;
  numbering: NoteNoCheckResult;
  discountCost: NoteDiscountCostResult;
  /** 需关注票据（逾期 + 15 天内到期），按紧迫度排序 */
  attention: Array<{
    code: string;
    noteNo: string;
    amount: number;
    dueDate: string;
    daysLeft: number;
    status: string;
  }>;
}

/* ========== 批次三 D-05：全面预算（收入/资本预算 + 滚动预测） ========== */

export type BudgetType = 'expense' | 'revenue' | 'capital';

/** 逐月预算/实际，`actual` 为 null 表示该期间尚未确认 */
export interface BudgetForecastSeriesItem {
  period: string;
  budget: number;
  /** `null` = 尚未确认（与 `0` 语义不同：0 是"确实是 0"） */
  actual: number | null;
  /** 是否已确认（有实际数且在 asOf 之前） */
  confirmed: boolean;
}

/** 单类型滚动预测结果 */
export interface BudgetForecastResult {
  year: string;
  budgetType: BudgetType;
  /** 截止期间（null 表示按当前数据自然截止） */
  asOf: string | null;
  confirmedPeriods: string[];
  remainingPeriods: string[];
  budgetTotal: number;
  actualToDate: number;
  remainingBudget: number;
  /** **权威口径**：实际 + 剩余预算 */
  baselineForecast: number;
  baselineVariance: number;
  /** 趋势外推值；仅当偏差超阈值时非 null，**仅作提示** */
  trendForecast: number | null;
  trendGap: number | null;
  executionRate: number | null;
  needsAttention: boolean;
  message: string;
  series: BudgetForecastSeriesItem[];
}

export interface BudgetVarianceItem {
  label: string;
  budgetType: BudgetType;
  budgetAmount: number;
  actualAmount: number;
  variance: number;
  varianceRate: number | null;
  /** 费用/资本：实际少为有利；收入：实际多为有利 */
  favorable: boolean;
  conclusion: string;
  requiresExplanation: boolean;
}

export interface BudgetExpenseRatioResult {
  budgetRatio: number | null;
  actualRatio: number | null;
  ratioDelta: number | null;
  conclusion: string;
  needsAttention: boolean;
}

export interface BudgetCapitalAnalysis {
  spentPeriods: Array<{ period: string; budget: number; actual: number }>;
  totalBudget: number;
  totalActual: number;
  remaining: number;
  utilizationRate: number | null;
  overspent: boolean;
  message: string;
}

/** 全面预算总览（三类预算 + 费用率联动 + 差异 + CAPEX 分析） */
export interface FullBudgetOverview {
  year: string;
  asOf: string | null;
  thresholds: {
    forecastThreshold: number;
    varianceThreshold: number;
    ratioTolerance: number;
  };
  forecasts: {
    expense: BudgetForecastResult;
    revenue: BudgetForecastResult;
    capital: BudgetForecastResult;
  };
  expenseRatio: BudgetExpenseRatioResult;
  variances: BudgetVarianceItem[];
  capitalAnalysis: BudgetCapitalAnalysis;
  /**
   * 资本实际数是否为近似值。
   *
   * 系统目前没有独立的 CAPEX 支出表，资本实际数取自"费用申请中
   * expenseCategory 以 capex/资本 开头的已批准单据"。若贵司走采购订单/
   * 固定资产建卡流程，该数字会偏低 —— 因此**必须**把这个标记透出到界面，
   * 而不是让使用者以为它是精确值。
   */
  capitalActualIsApproximation: boolean;
  needsAttention: boolean;
  generatedAt: string;
}

/**
 * A-09：科目启用/停用。
 *
 * 语义是**两个具名状态**而不是布尔量 —— 布尔会丢掉"这是状态机取值"的含义。
 * `inactive` 的科目不接受新凭证，但其历史余额仍会出现在报表中。
 */
export interface SetAccountStatusDto {
  status: 'active' | 'inactive';
}