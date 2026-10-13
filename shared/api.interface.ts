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
export type ProjectStatus = 'initiating' | 'executing' | 'delivering' | 'accepting' | 'closed';
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
export type ArStatus = 'open' | 'partial' | 'settled';
export type ReceiptStatus = 'unmatched' | 'partial' | 'matched' | 'voided';
export type ApStatus = 'pending' | 'approved' | 'partial' | 'paid';
export type PaymentStatus = 'pending' | 'approved' | 'rejected' | 'paid' | 'voided';
export type InvoiceType = 'vat_special' | 'vat_normal' | 'electronic';
export type InvoiceStatus = 'issued' | 'voided';
export type InvoiceDirection = 'sales' | 'purchase';

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
  createdAt: string;
}

/* ========== 报价单 ========== */

export type QuotationStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'converted'
  | 'void';

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
  title: string;
  quoteDate: string | null;
  validUntil: string | null;
  status: QuotationStatus;
  discountPct: number;
  totalAmount: number;
  estimatedCost: number;
  marginPct: number;
  remark: string | null;
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
  pm: string | null;
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
  amount: number;
  taxRate: number;
  taxAmount: number;
  invoiceDate: string | null;
  status: InvoiceStatus;
  remark: string | null;
  createdAt: string;
  /** 软提示，如开票额超过已确认收入 */
  warning?: string;
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
  customerId?: string;
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
  owner?: string;
  paymentTerms?: string;
  startDate?: string;
  endDate?: string;
  remark?: string;
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
  pm?: string;
  deptName?: string;
  budget?: number;
  estimatedTotalCost?: number;
  startDate?: string;
  endDate?: string;
  remark?: string;
}

export type ProjectStatusAction = 'approve' | 'deliver' | 'accept' | 'close';

export interface UpdateProjectDto {
  progress?: number;
  pm?: string;
  budget?: number;
  estimatedTotalCost?: number;
  endDate?: string;
  remark?: string;
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
}

/* ========== 人力资源（二期A） ========== */

export type EmployeeStatus = 'probation' | 'active' | 'resigned';
export type LeaveType = 'annual' | 'sick' | 'personal';
export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected';
export type AttendanceStatus = 'present' | 'absent' | 'late' | 'leave';
export type PayrollStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
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
  remark?: string;
}

export type PayrollAction = 'submit' | 'approve' | 'reject';

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
export type ExpenseClaimStatus = 'pending' | 'escalated' | 'approved' | 'rejected';

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

export type ExpenseClaimAction = 'approve' | 'reject';

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
  afterValue?: string;
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
}

export interface VoucherLineItem {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  summary: string | null;
  debit: number;
  credit: number;
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
  remark?: string;
}

export interface CreateVoucherLineDto {
  accountId: string;
  summary?: string;
  debit?: number;
  credit?: number;
}

export interface CreateVoucherDto {
  voucherDate: string;
  period: string;
  summary: string;
  sourceType?: VoucherSourceType;
  sourceRef?: string;
  lines: CreateVoucherLineDto[];
  remark?: string;
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

export interface AuditListParams {
  objectType?: string;
  action?: string;
  limit?: number;
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
