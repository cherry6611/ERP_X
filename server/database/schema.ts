/* eslint-disable */
/** 业务表结构。系统字段默认值依赖会话变量 app.user_id。 */
import { sql } from 'drizzle-orm';
import { check, bigint, boolean, date, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid, varchar, customType } from "drizzle-orm/pg-core"

export const customTimestamptz = customType<{
  data: Date;
  driverData: string;
  config: { precision?: number };
}>({
  dataType(config) {
    const precision = typeof config?.precision !== 'undefined'
      ? ` (${config.precision})`
      : '';
    return `timestamptz${precision}`;
  },
  toDriver(value: Date | string | number) {
    if (value == null) return value as any;
    if (typeof value === 'number') return new Date(value).toISOString();
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    throw new Error('Invalid timestamp value');
  },
  fromDriver(value: string | Date): Date {
    if (value instanceof Date) return value;
    return new Date(value);
  },
});

export const userProfile = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'user_profile';
  },
  toDriver(value: string) {
    return sql`ROW(${value}, '')::user_profile`;
  },
  fromDriver(value: string) {
    const [userId] = value.slice(1, -1).split(',');
    return userId.trim();
  },
});

export function escapeLiteral(str: string): string {
  return "'" + str.replace(/'/g, "''") + "'";
}

export const userProfileArray = customType<{
  data: string[];
  driverData: string;
}>({
  dataType() {
    return 'user_profile[]';
  },
  toDriver(value: string[]) {
    if (!value || value.length === 0) {
      return sql`'{}'::user_profile[]`;
    }
    const elements = value.map(id => `ROW(${escapeLiteral(id)}, '')::user_profile`).join(',');
    return sql.raw(`ARRAY[${elements}]::user_profile[]`);
  },
  fromDriver(value: string): string[] {
    if (!value || value === '{}') return [];
    const inner = value.slice(1, -1);
    const matches = inner.match(/\([^)]*\)/g) || [];
    return matches.map(m => m.slice(1, -1).split(',')[0].trim());
  },
});

export const compAutomationConfig = pgTable("comp_automation_config", {
  taskKey: varchar("task_key", { length: 100 }).primaryKey(),
  taskName: varchar("task_name", { length: 200 }).notNull(),
  description: varchar("description", { length: 500 }),
  enabled: boolean("enabled").notNull().default(true),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
});

export const compProjectDriveSync = pgTable("comp_project_drive_sync", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().unique(),
  kind: varchar("kind", { length: 20 }).notNull().default('file'),
  attachmentId: uuid("attachment_id").unique(),
  folderToken: varchar("folder_token", { length: 255 }),
  driveFileToken: varchar("drive_file_token", { length: 255 }),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  syncStatus: varchar("sync_status", { length: 32 }).notNull().default('synced'),
  remark: varchar("remark", { length: 500 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_project_drive_sync_attachment").on(table.attachmentId),
  uniqueIndex("uq_project_drive_sync_archive").on(table.projectId),
  index("idx_project_drive_sync_project").on(table.projectId),
]);

export const erpProjectMinutes = pgTable("erp_project_minutes", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  title: varchar("title", { length: 100 }).notNull(),
  minutesType: varchar("minutes_type", { length: 20 }).notNull(),
  meetingDate: date("meeting_date").notNull(),
  content: text("content"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_erp_minutes_project").on(table.projectId),
]);

export const crmQuotationItem = pgTable("crm_quotation_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  quotationId: uuid("quotation_id").notNull(),
  seq: integer("seq").notNull(),
  itemName: varchar("item_name", { length: 200 }).notNull(),
  unit: varchar("unit", { length: 20 }).notNull().default('人天'),
  quantity: numeric("quantity").notNull().default('1'),
  unitPrice: numeric("unit_price").notNull().default('0'),
  discountPct: numeric("discount_pct").notNull().default('0'),
  estUnitCost: numeric("est_unit_cost").notNull().default('0'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_crm_quotation_item_quotation").on(table.quotationId),
]);

export const crmQuotation = pgTable("crm_quotation", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  customerId: uuid("customer_id").notNull(),
  opportunityId: uuid("opportunity_id"),
  /** 同一商机下的报价轮次（1 起），无商机时可为 null */
  roundNo: integer("round_no"),
  title: varchar("title", { length: 200 }).notNull(),
  quoteDate: date("quote_date"),
  validUntil: date("valid_until"),
  status: varchar("status", { length: 20 }).notNull().default('draft'),
  discountPct: numeric("discount_pct").notNull().default('0'),
  totalAmount: numeric("total_amount").notNull().default('0'),
  taxRate: numeric("tax_rate"),
  estimatedCost: numeric("estimated_cost").notNull().default('0'),
  remark: text("remark"),
  contractId: uuid("contract_id"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("crm_quotation_code_key").on(table.code),
  index("idx_crm_quotation_opportunity").on(table.opportunityId),
  index("idx_crm_quotation_customer").on(table.customerId),
  check("chk_quotation_tax_rate", sql`${table.taxRate} IS NULL OR ${table.taxRate} IN (0, 1, 3, 6, 9, 13)`),
]);

export const compFeishuDriveConfig = pgTable("comp_feishu_drive_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  appId: varchar("app_id", { length: 255 }).notNull(),
  appSecret: varchar("app_secret", { length: 512 }).notNull(),
  appSecretPrev: varchar("app_secret_prev", { length: 512 }),
  secretKeyVersion: integer("secret_key_version").notNull().default(1),
  secretPrevVersion: integer("secret_prev_version"),
  secretRotatedAt: customTimestamptz("secret_rotated_at", { precision: 3 }),
  secretRotatedBy: varchar("secret_rotated_by", { length: 64 }),
  rootFolderToken: varchar("root_folder_token", { length: 255 }).notNull(),
  wikiSpaceId: varchar("wiki_space_id", { length: 255 }).notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
});

export const erpDeliverable = pgTable("erp_deliverable", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  projectId: uuid("project_id").notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  deliverableType: varchar("deliverable_type", { length: 20 }).notNull().default('dataset'),
  acceptanceCriteria: text("acceptance_criteria"),
  dueDate: date("due_date"),
  status: varchar("status", { length: 20 }).notNull().default('pending'),
  reviewer: varchar("reviewer", { length: 50 }),
  submittedAt: date("submitted_at"),
  acceptedAt: date("accepted_at"),
  returnedReason: text("returned_reason"),
  remark: text("remark"),
  acceptConclusion: text("accept_conclusion"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uk_erp_deliverable_code").on(table.code),
  index("idx_erp_deliverable_project").on(table.projectId),
]);

export const hrAttendanceAmendment = pgTable("hr_attendance_amendment", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  employeeId: uuid("employee_id"),
  workDate: date("work_date").notNull(),
  reason: varchar("reason", { length: 500 }).notNull(),
  submittedBy: varchar("submitted_by", { length: 64 }),
  status: varchar("status", { length: 20 }).notNull().default('pending'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_hr_attendance_amendment_code").on(table.code),
  uniqueIndex("uq_hr_attendance_amendment_emp_date").on(table.employeeId, table.workDate),
]);

export const erpAdminAffair = pgTable("erp_admin_affair", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  affairType: varchar("affair_type", { length: 20 }).notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  /**
   * @type string[]
   */
  participants: jsonb("participants"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  amount: numeric("amount"),
  status: varchar("status", { length: 20 }).notNull().default('registered'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_admin_affair_code").on(table.code),
  index("idx_admin_affair_status").on(table.status),
]);

export const erpAdminAsset = pgTable("erp_admin_asset", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  category: varchar("category", { length: 30 }).notNull(),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: numeric("unit_price").notNull(),
  amount: numeric("amount"),
  location: varchar("location", { length: 100 }),
  owner: userProfile("owner"),
  purchaseDate: date("purchase_date"),
  status: varchar("status", { length: 20 }).notNull().default('in_use'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_admin_asset_code").on(table.code),
  index("idx_admin_asset_status").on(table.status),
]);

export const erpAdminBill = pgTable("erp_admin_bill", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  title: varchar("title", { length: 200 }).notNull(),
  billType: varchar("bill_type", { length: 30 }).notNull(),
  amount: numeric("amount").notNull(),
  period: varchar("period", { length: 10 }).notNull(),
  payee: varchar("payee", { length: 100 }),
  expenseDate: date("expense_date").notNull(),
  rentContractId: uuid("rent_contract_id"),
  status: varchar("status", { length: 20 }).notNull().default('draft'),
  payDate: date("pay_date"),
  payMethod: varchar("pay_method", { length: 50 }),
  approveRemark: text("approve_remark"),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_admin_bill_code").on(table.code),
  index("idx_admin_bill_status").on(table.status),
  index("idx_admin_bill_period").on(table.period),
  index("idx_admin_bill_rent_contract").on(table.rentContractId),
]);

export const erpAdminRentContract = pgTable("erp_admin_rent_contract", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  propertyAddress: varchar("property_address", { length: 255 }).notNull(),
  lessor: varchar("lessor", { length: 100 }).notNull(),
  monthlyRent: numeric("monthly_rent").notNull(),
  deposit: numeric("deposit"),
  area: numeric("area"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  paymentCycle: varchar("payment_cycle", { length: 20 }).notNull().default('monthly'),
  status: varchar("status", { length: 20 }).notNull().default('draft'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_admin_rent_contract_code").on(table.code),
  index("idx_admin_rent_contract_status").on(table.status),
  index("idx_admin_rent_contract_end_date").on(table.endDate),
]);

export const compFeishuSyncRecord = pgTable("comp_feishu_sync_record", {
  id: uuid("id").primaryKey().defaultRandom(),
  direction: varchar("direction", { length: 20 }).notNull(),
  bizType: varchar("biz_type", { length: 30 }).notNull(),
  bizId: uuid("biz_id"),
  bizCode: varchar("biz_code", { length: 50 }),
  baseRecordId: varchar("base_record_id", { length: 64 }).unique(),
  status: varchar("status", { length: 20 }).notNull().default('pending'),
  errorMsg: text("error_msg"),
  retryCount: integer("retry_count").notNull().default(0),
  nextRetryAt: customTimestamptz("next_retry_at", { precision: 3 }),
  lastError: text("last_error"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_sync_out_biz").on(table.bizType, table.bizId),
  uniqueIndex("uq_sync_in_rec").on(table.baseRecordId),
  index("idx_sync_record_status").on(table.status),
]);

export const compAttachment = pgTable("comp_attachment", {
  id: uuid("id").primaryKey().defaultRandom(),
  resourceType: varchar("resource_type", { length: 100 }).notNull(),
  resourceId: uuid("resource_id").notNull(),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  fileUrl: text("file_url").notNull(),
  fileSize: bigint("file_size", { mode: 'number' }).notNull().default(0),
  sourceType: varchar("source_type", { length: 20 }).notNull().default('upload'),
  feishuToken: varchar("feishu_token", { length: 255 }),
  feishuDocType: varchar("feishu_doc_type", { length: 50 }),
  feishuUrl: text("feishu_url"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_comp_attachment_resource").on(table.resourceType, table.resourceId),
]);

export const finPeriodClose = pgTable("fin_period_close", {
  period: varchar("period", { length: 7 }).primaryKey(),
  closedAt: customTimestamptz("closed_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  closedBy: userProfile("closed_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
});

export const daGrant = pgTable("da_grant", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  datasetId: uuid("dataset_id"),
  customerId: uuid("customer_id"),
  projectId: uuid("project_id"),
  scope: varchar("scope", { length: 500 }),
  startDate: date("start_date"),
  endDate: date("end_date"),
  status: varchar("status", { length: 20 }).default('active'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("da_grant_code_key").on(table.code),
  index("idx_da_grant_dataset").on(table.datasetId),
  index("idx_da_grant_project").on(table.projectId),
  index("idx_da_grant_status").on(table.status),
]);

export const daDataset = pgTable("da_dataset", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  source: varchar("source", { length: 200 }),
  maskLevel: varchar("mask_level", { length: 20 }).default('L1'),
  contractId: uuid("contract_id"),
  status: varchar("status", { length: 20 }).default('active'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("da_dataset_code_key").on(table.code),
  index("idx_da_dataset_status").on(table.status),
]);

export const astChange = pgTable("ast_change", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  assetId: uuid("asset_id"),
  changeType: varchar("change_type", { length: 20 }).default('receive'),
  beforeValue: varchar("before_value", { length: 200 }),
  afterValue: varchar("after_value", { length: 200 }),
  status: varchar("status", { length: 20 }).default('pending'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("ast_change_code_key").on(table.code),
  index("idx_ast_change_asset").on(table.assetId),
]);

export const astDepreciation = pgTable("ast_depreciation", {
  id: uuid("id").primaryKey().defaultRandom(),
  assetId: uuid("asset_id"),
  period: varchar("period", { length: 7 }),
  amount: numeric("amount").default('0'),
  costGenerated: boolean("cost_generated").default(false),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_ast_depreciation_asset_period").on(table.assetId, table.period),
  index("idx_ast_depreciation_period").on(table.period),
]);

export const astAsset = pgTable("ast_asset", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  category: varchar("category", { length: 20 }).default('other'),
  originalValue: numeric("original_value").default('0'),
  residualValue: numeric("residual_value").default('0'),
  netValue: numeric("net_value").default('0'),
  departmentId: uuid("department_id"),
  projectId: uuid("project_id"),
  purchaseOrderId: uuid("purchase_order_id"),
  purchaseDate: date("purchase_date"),
  usefulMonths: integer("useful_months").default(36),
  status: varchar("status", { length: 20 }).default('in_use'),
  /** D-08：累计已计提减值金额（NULL 表示未计提过减值） */
  impairmentAmount: numeric("impairment_amount"),
  /** D-08：最近一次减值测试日 */
  impairmentDate: date("impairment_date"),
  /** D-08：减值后净值（账面价值 − 已计提减值） */
  netValueAfter: numeric("net_value_after"),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("ast_asset_code_key").on(table.code),
  index("idx_ast_asset_status").on(table.status),
  index("idx_ast_asset_category").on(table.category),
  index("idx_ast_asset_project").on(table.projectId),
  // D-08：采购订单 → 资产卡片一对一，防重复建卡
  uniqueIndex("uq_ast_asset_purchase_order")
    .on(table.purchaseOrderId)
    .where(sql`${table.purchaseOrderId} IS NOT NULL`),
]);

/** D-08：资产减值测试记录（减值损失走 6701 资产减值损失） */
export const astImpairment = pgTable("ast_impairment", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  assetId: uuid("asset_id").notNull(),
  testDate: date("test_date").notNull(),
  period: varchar("period", { length: 7 }),
  bookValue: numeric("book_value").notNull().default('0'),
  recoverableAmount: numeric("recoverable_amount").notNull().default('0'),
  impairmentLoss: numeric("impairment_loss").notNull().default('0'),
  method: varchar("method", { length: 30 }).notNull().default('recoverable_vs_book'),
  voucherRef: varchar("voucher_ref", { length: 100 }),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_ast_impairment_code").on(table.code),
  index("idx_ast_impairment_asset").on(table.assetId),
  index("idx_ast_impairment_period").on(table.period),
  check("chk_ast_impairment_loss", sql`${table.impairmentLoss} >= 0`),
]);

/** D-08：资产处置/报废单（状态机 disposing → disposed | scrapped，rejected 为驳回） */
export const astDisposal = pgTable("ast_disposal", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  assetId: uuid("asset_id").notNull(),
  disposalType: varchar("disposal_type", { length: 20 }).notNull().default('scrap'),
  status: varchar("status", { length: 20 }).notNull().default('disposing'),
  applyDate: date("apply_date").notNull(),
  disposeDate: date("dispose_date"),
  originalValue: numeric("original_value").notNull().default('0'),
  accumulatedDepreciation: numeric("accumulated_depreciation").notNull().default('0'),
  netValue: numeric("net_value").notNull().default('0'),
  disposalIncome: numeric("disposal_income").notNull().default('0'),
  taxRate: numeric("tax_rate"),
  taxAmount: numeric("tax_amount").notNull().default('0'),
  gainLoss: numeric("gain_loss").notNull().default('0'),
  voucherRef: varchar("voucher_ref", { length: 100 }),
  reason: varchar("reason", { length: 500 }),
  remark: text("remark"),
  approvedBy: varchar("approved_by", { length: 64 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_ast_disposal_code").on(table.code),
  index("idx_ast_disposal_asset").on(table.assetId),
  index("idx_ast_disposal_status").on(table.status),
  uniqueIndex("uq_ast_disposal_active")
    .on(table.assetId)
    .where(sql`${table.status} = 'disposing'`),
  uniqueIndex("uq_ast_disposal_voucher_ref")
    .on(table.voucherRef)
    .where(sql`${table.voucherRef} IS NOT NULL`),
]);

export const purOrder = pgTable("pur_order", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  requestId: uuid("request_id"),
  contractId: uuid("contract_id"),
  supplierId: uuid("supplier_id"),
  projectId: uuid("project_id"),
  itemName: varchar("item_name", { length: 200 }).notNull(),
  category: varchar("category", { length: 20 }).default('service'),
  quantity: integer("quantity").default(1),
  unitPrice: numeric("unit_price").default('0'),
  amount: numeric("amount").default('0'),
  taxRate: numeric("tax_rate"),
  orderDate: date("order_date"),
  acceptedQuantity: integer("accepted_quantity").default(0),
  acceptDate: date("accept_date"),
  status: varchar("status", { length: 20 }).default('pending'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("pur_order_code_key").on(table.code),
  index("idx_pur_order_status").on(table.status),
  index("idx_pur_order_supplier").on(table.supplierId),
  index("idx_pur_order_contract").on(table.contractId),
  index("idx_pur_order_project").on(table.projectId),
  check("chk_pur_order_tax_rate", sql`${table.taxRate} IS NULL OR ${table.taxRate} IN (0, 1, 3, 6, 9, 13)`),
]);

export const purRequest = pgTable("pur_request", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  title: varchar("title", { length: 200 }).notNull(),
  requestType: varchar("request_type", { length: 20 }).default('service'),
  departmentId: uuid("department_id"),
  projectId: uuid("project_id"),
  supplierId: uuid("supplier_id"),
  amount: numeric("amount").default('0'),
  expectDate: date("expect_date"),
  status: varchar("status", { length: 20 }).default('pending'),
  reason: varchar("reason", { length: 500 }),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("pur_request_code_key").on(table.code),
  index("idx_pur_request_status").on(table.status),
  index("idx_pur_request_project").on(table.projectId),
]);

/**
 * C-05：采购退货单。
 * 原单口径：pur_order 为单行订单（无明细表），验收数量累计在 accepted_quantity；
 * 退货头表冗余原单号与数量快照，明细表 pur_return_item 承载按物料行退货的扩展能力。
 */
export const purReturn = pgTable("pur_return", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  orderId: uuid("order_id").notNull(),
  orderCode: varchar("order_code", { length: 20 }),
  supplierId: uuid("supplier_id"),
  projectId: uuid("project_id"),
  returnDate: date("return_date").notNull(),
  returnQuantity: integer("return_quantity").notNull().default(0),
  amount: numeric("amount").notNull().default('0'),
  taxRate: numeric("tax_rate"),
  netAmount: numeric("net_amount").notNull().default('0'),
  taxAmount: numeric("tax_amount").notNull().default('0'),
  apBillId: uuid("ap_bill_id"),
  redInvoiceId: uuid("red_invoice_id"),
  status: varchar("status", { length: 20 }).notNull().default('draft'),
  reason: varchar("reason", { length: 500 }),
  remark: text("remark"),
  submittedAt: customTimestamptz("submitted_at", { precision: 3 }),
  approvedAt: customTimestamptz("approved_at", { precision: 3 }),
  completedAt: customTimestamptz("completed_at", { precision: 3 }),
  voucherRef: varchar("voucher_ref", { length: 100 }),
  createdByUser: varchar("created_by_user", { length: 64 }),
  approvedBy: varchar("approved_by", { length: 64 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL
    ELSE ROW(current_setting('app.user_id'::text, true), '')::user_profile END`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL
    ELSE ROW(current_setting('app.user_id'::text, true), '')::user_profile END`),
}, (table) => [
  uniqueIndex("uq_pur_return_code").on(table.code),
  index("idx_pur_return_order").on(table.orderId),
  index("idx_pur_return_status").on(table.status),
  uniqueIndex("uq_pur_return_ap_bill")
    .on(table.apBillId)
    .where(sql`${table.apBillId} IS NOT NULL AND ${table.status} <> 'void'`),
  uniqueIndex("uq_pur_return_voucher_ref")
    .on(table.voucherRef)
    .where(sql`${table.voucherRef} IS NOT NULL`),
  check("chk_pur_return_status", sql`${table.status} IN ('draft', 'submitted', 'approved', 'completed', 'void')`),
  check("chk_pur_return_quantity", sql`${table.returnQuantity} > 0`),
]);

export const purReturnItem = pgTable("pur_return_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  returnId: uuid("return_id").notNull(),
  orderId: uuid("order_id"),
  itemName: varchar("item_name", { length: 200 }).notNull(),
  quantity: integer("quantity").notNull().default(0),
  unitPrice: numeric("unit_price").notNull().default('0'),
  amount: numeric("amount").notNull().default('0'),
  taxRate: numeric("tax_rate"),
  netAmount: numeric("net_amount").notNull().default('0'),
  taxAmount: numeric("tax_amount").notNull().default('0'),
  remark: text("remark"),
  seq: integer("seq").notNull().default(1),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_pur_return_item_return").on(table.returnId),
  index("idx_pur_return_item_order").on(table.orderId),
  check("chk_pur_return_item_quantity", sql`${table.quantity} > 0`),
]);

export const finVoucherLine = pgTable("fin_voucher_line", {
  id: uuid("id").primaryKey().defaultRandom(),
  voucherId: uuid("voucher_id"),
  accountId: uuid("account_id"),
  /** A-10/A-03：冗余科目编码，避免账簿查询每次都 join fin_account */
  accountCode: varchar("account_code", { length: 20 }),
  summary: varchar("summary", { length: 200 }),
  debit: numeric("debit").default('0'),
  credit: numeric("credit").default('0'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_fin_voucher_line_voucher").on(table.voucherId),
  index("idx_fin_voucher_line_account").on(table.accountId),
  index("idx_fin_voucher_line_account_voucher").on(table.accountCode, table.voucherId),
  index("idx_fin_voucher_line_account_id_voucher").on(table.accountId, table.voucherId),
]);

/** A-05：会计辅助核算维度定义 */
export const finAuxDimension = pgTable("fin_aux_dimension", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 32 }).notNull(),
  name: varchar("name", { length: 64 }).notNull(),
  sourceType: varchar("source_type", { length: 20 }).notNull().default('custom'),
  enabled: integer("enabled").notNull().default(1),
  sortNo: integer("sort_no").notNull().default(0),
  remark: varchar("remark", { length: 200 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_fin_aux_dimension_code").on(table.code),
]);

/** A-05：凭证行 × 辅助维度 × 值 */
export const finVoucherLineAux = pgTable("fin_voucher_line_aux", {
  id: uuid("id").primaryKey().defaultRandom(),
  lineId: uuid("line_id").notNull(),
  voucherId: uuid("voucher_id"),
  dimensionCode: varchar("dimension_code", { length: 32 }).notNull(),
  dimensionId: uuid("dimension_id"),
  dimensionValue: varchar("dimension_value", { length: 200 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_fin_voucher_line_aux_line").on(table.lineId),
  index("idx_fin_voucher_line_aux_voucher").on(table.voucherId),
  index("idx_fin_voucher_line_aux_dim").on(table.dimensionCode, table.dimensionId),
]);

export const finVoucher = pgTable("fin_voucher", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  voucherDate: date("voucher_date"),
  period: varchar("period", { length: 7 }),
  summary: varchar("summary", { length: 200 }),
  sourceType: varchar("source_type", { length: 20 }),
  sourceRef: varchar("source_ref", { length: 100 }),
  status: varchar("status", { length: 20 }).default('draft'),
  crossPeriod: integer("cross_period").notNull().default(0),
  crossPeriodReason: varchar("cross_period_reason", { length: 500 }),
  crossPeriodApprover: varchar("cross_period_approver", { length: 64 }),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("fin_voucher_code_key").on(table.code),
  index("idx_fin_voucher_period").on(table.period),
  index("idx_fin_voucher_status").on(table.status),
  // 修复 P1-12：凭证幂等的唯一索引只在 SQL 迁移里建了、schema.ts 未声明，
  // 一旦有人执行 drizzle-kit push/generate，该索引会被当作"多余对象"DROP 掉，
  // 同一笔业务就会被重复出凭证（业财对账直接崩）。此处补齐声明。
  uniqueIndex("uq_fin_voucher_source")
    .on(table.sourceType, table.sourceRef)
    .where(sql`${table.sourceType} IS NOT NULL AND ${table.sourceRef} IS NOT NULL`),
]);

export const finAccount = pgTable("fin_account", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  accountType: varchar("account_type", { length: 20 }).default('asset'),
  status: varchar("status", { length: 20 }).default('active'),
  /** A-10：上级科目编码（一级科目为 NULL） */
  parentCode: varchar("parent_code", { length: 20 }),
  /** A-10：科目层级，1 为一级 */
  level: integer("level").notNull().default(1),
  /** A-10：是否末级科目（1 可做账，0 仅汇总） */
  isLeaf: integer("is_leaf").notNull().default(1),
  /** A-10：余额方向 debit | credit */
  direction: varchar("direction", { length: 10 }).notNull().default('debit'),
  /** A-05：必填辅助核算维度集合，JSON 数组字符串 */
  auxRequired: varchar("aux_required", { length: 200 }).notNull().default('[]'),
  sortNo: integer("sort_no").notNull().default(0),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("fin_account_code_key").on(table.code),
  index("idx_fin_account_parent").on(table.parentCode),
  index("idx_fin_account_level").on(table.level),
  index("idx_fin_account_leaf").on(table.isLeaf),
  check("chk_fin_account_direction", sql`${table.direction} IN ('debit', 'credit')`),
  check("chk_fin_account_level", sql`${table.level} >= 1 AND ${table.level} <= 6`),
]);

/** A-03：月度科目余额快照（避免报表全量重算） */
export const finAccountBalanceSnapshot = pgTable("fin_account_balance_snapshot", {
  id: uuid("id").primaryKey().defaultRandom(),
  period: varchar("period", { length: 7 }).notNull(),
  taxEntityId: uuid("tax_entity_id"),
  accountCode: varchar("account_code", { length: 20 }).notNull(),
  accountName: varchar("account_name", { length: 100 }),
  openingDebit: numeric("opening_debit").notNull().default('0'),
  openingCredit: numeric("opening_credit").notNull().default('0'),
  debitOccur: numeric("debit_occur").notNull().default('0'),
  creditOccur: numeric("credit_occur").notNull().default('0'),
  closingDebit: numeric("closing_debit").notNull().default('0'),
  closingCredit: numeric("closing_credit").notNull().default('0'),
  voucherCount: integer("voucher_count").notNull().default(0),
  generatedAt: customTimestamptz("generated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_fin_account_balance_snapshot_period").on(table.period),
]);

/** A-01/A-02：法定财务报表模板（行次 + 取数公式） */
export const finReportTemplate = pgTable("fin_report_template", {
  id: uuid("id").primaryKey().defaultRandom(),
  reportCode: varchar("report_code", { length: 32 }).notNull(),
  rowNo: varchar("row_no", { length: 16 }).notNull(),
  rowName: varchar("row_name", { length: 120 }).notNull(),
  formula: varchar("formula", { length: 500 }).notNull().default(''),
  /** 分区：assets/liabilities/equity/revenue/... */
  section: varchar("section", { length: 32 }).notNull().default('default'),
  indent: integer("indent").notNull().default(0),
  bold: integer("bold").notNull().default(0),
  sortNo: integer("sort_no").notNull().default(0),
  enabled: integer("enabled").notNull().default(1),
  remark: varchar("remark", { length: 200 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_fin_report_template_row").on(table.reportCode, table.rowNo),
  index("idx_fin_report_template_code").on(table.reportCode, table.sortNo),
]);

/** A-04：年结状态 */
export const finYearEndClose = pgTable("fin_year_end_close", {
  id: uuid("id").primaryKey().defaultRandom(),
  fiscalYear: integer("fiscal_year").notNull(),
  period: varchar("period", { length: 7 }).notNull(),
  taxEntityId: uuid("tax_entity_id"),
  status: varchar("status", { length: 20 }).notNull().default('closed'),
  profitAmount: numeric("profit_amount").notNull().default('0'),
  carryVoucherId: uuid("carry_voucher_id"),
  closedAt: customTimestamptz("closed_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  closedBy: varchar("closed_by", { length: 64 }),
  reopenedAt: customTimestamptz("reopened_at", { precision: 3 }),
  reopenedBy: varchar("reopened_by", { length: 64 }),
  remark: varchar("remark", { length: 500 }),
}, (table) => [
  index("idx_fin_year_end_close_period").on(table.period),
]);

/** A-04：年结 / 反年结审计留痕 */
export const finYearEndLog = pgTable("fin_year_end_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  fiscalYear: integer("fiscal_year").notNull(),
  action: varchar("action", { length: 20 }).notNull(),
  actorUserId: varchar("actor_user_id", { length: 64 }),
  reason: varchar("reason", { length: 500 }),
  snapshot: text("snapshot"),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_fin_year_end_log_year").on(table.fiscalYear, table.createdAt),
]);

/** A-06：增值税申报底稿 */
export const finVatDeclaration = pgTable("fin_vat_declaration", {
  id: uuid("id").primaryKey().defaultRandom(),
  period: varchar("period", { length: 7 }).notNull(),
  taxEntityId: uuid("tax_entity_id"),
  status: varchar("status", { length: 20 }).notNull().default('draft'),
  outputTax: numeric("output_tax").notNull().default('0'),
  inputTax: numeric("input_tax").notNull().default('0'),
  transferOut: numeric("transfer_out").notNull().default('0'),
  previousCredit: numeric("previous_credit").notNull().default('0'),
  payableTax: numeric("payable_tax").notNull().default('0'),
  closingCredit: numeric("closing_credit").notNull().default('0'),
  /** 总账口径（222101 / 222102 发生额），用于勾稽留痕 */
  ledgerOutputTax: numeric("ledger_output_tax").notNull().default('0'),
  ledgerInputTax: numeric("ledger_input_tax").notNull().default('0'),
  differenceReason: varchar("difference_reason", { length: 500 }),
  generatedBy: varchar("generated_by", { length: 64 }),
  generatedAt: customTimestamptz("generated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_fin_vat_declaration_period").on(table.period),
  // 唯一性由 SQL 迁移的 `uq_fin_vat_declaration_period_entity (period, tax_entity_id) NULLS NOT DISTINCT` 保证，
  // drizzle 0.44 的 IndexBuilder 尚不支持 nullsNotDistinct，故此处不重复声明，避免 push 时误删。
]);

export const finExpenseClaim = pgTable("fin_expense_claim", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  applyId: uuid("apply_id"),
  departmentId: uuid("department_id"),
  projectId: uuid("project_id"),
  expenseCategory: varchar("expense_category", { length: 50 }),
  amount: numeric("amount").default('0'),
  expenseDate: date("expense_date"),
  applicant: varchar("applicant", { length: 50 }),
  status: varchar("status", { length: 20 }).default('pending'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("fin_expense_claim_code_key").on(table.code),
  index("idx_fin_expense_claim_project").on(table.projectId),
  index("idx_fin_expense_claim_status").on(table.status),
  index("idx_fin_expense_claim_apply").on(table.applyId),
]);

export const finExpenseApply = pgTable("fin_expense_apply", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  applyType: varchar("apply_type", { length: 20 }).default('travel'),
  title: varchar("title", { length: 200 }).notNull(),
  departmentId: uuid("department_id"),
  projectId: uuid("project_id"),
  expenseCategory: varchar("expense_category", { length: 50 }),
  amount: numeric("amount").default('0'),
  expectDate: date("expect_date"),
  status: varchar("status", { length: 20 }).default('pending'),
  reason: varchar("reason", { length: 500 }),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("fin_expense_apply_code_key").on(table.code),
  index("idx_fin_expense_apply_project").on(table.projectId),
  index("idx_fin_expense_apply_status").on(table.status),
]);

export const finBudget = pgTable("fin_budget", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  departmentId: uuid("department_id"),
  projectId: uuid("project_id"),
  expenseCategory: varchar("expense_category", { length: 50 }),
  period: varchar("period", { length: 7 }),
  budgetAmount: numeric("budget_amount").default('0'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("fin_budget_code_key").on(table.code),
  index("idx_fin_budget_period").on(table.period),
  index("idx_fin_budget_project").on(table.projectId),
  index("idx_fin_budget_department").on(table.departmentId),
]);

export const hrTrainingRecord = pgTable("hr_training_record", {
  id: uuid("id").primaryKey().defaultRandom(),
  trainingId: uuid("training_id"),
  employeeId: uuid("employee_id"),
  status: varchar("status", { length: 20 }).default('attended'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_hr_training_record_training").on(table.trainingId),
  uniqueIndex("uq_hr_training_record_emp").on(table.trainingId, table.employeeId),
]);

export const hrTraining = pgTable("hr_training", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  trainer: varchar("trainer", { length: 50 }),
  hours: numeric("hours").default('0'),
  startDate: date("start_date"),
  endDate: date("end_date"),
  status: varchar("status", { length: 20 }).default('planned'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_hr_training_code").on(table.code),
]);

export const hrAppraisal = pgTable("hr_appraisal", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  employeeId: uuid("employee_id"),
  period: varchar("period", { length: 10 }),
  score: numeric("score").default('0'),
  grade: varchar("grade", { length: 2 }),
  status: varchar("status", { length: 20 }).default('draft'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_hr_appraisal_code").on(table.code),
  index("idx_hr_appraisal_employee").on(table.employeeId),
]);

export const hrCandidate = pgTable("hr_candidate", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  recruitReqId: uuid("recruit_req_id"),
  name: varchar("name", { length: 50 }).notNull(),
  phone: varchar("phone", { length: 30 }),
  stage: varchar("stage", { length: 20 }).default('pending'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_hr_candidate_code").on(table.code),
  index("idx_hr_candidate_req").on(table.recruitReqId),
]);

export const hrRecruitReq = pgTable("hr_recruit_req", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  departmentId: uuid("department_id"),
  title: varchar("title", { length: 200 }).notNull(),
  headcount: integer("headcount").default(1),
  status: varchar("status", { length: 20 }).default('open'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_hr_recruit_req_code").on(table.code),
]);

export const hrPayroll = pgTable("hr_payroll", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  employeeId: uuid("employee_id"),
  period: varchar("period", { length: 7 }),
  baseSalary: numeric("base_salary").default('0'),
  perfSalary: numeric("perf_salary").default('0'),
  allowance: numeric("allowance").default('0'),
  socialInsurance: numeric("social_insurance").default('0'),
  housingFund: numeric("housing_fund").default('0'),
  tax: numeric("tax").default('0'),
  netSalary: numeric("net_salary").default('0'),
  status: varchar("status", { length: 20 }).default('draft'),
  remark: text("remark"),
  allocationGenerated: boolean("allocation_generated").default(false),
  manualOverride: integer("manual_override").notNull().default(0),
  engineSnapshot: text("engine_snapshot"),
  // A-07：个税累计预扣预缴口径字段（便于逐月递推与审计复核）
  ytdIncome: numeric("ytd_income").notNull().default('0'),
  ytdTaxFreeIncome: numeric("ytd_tax_free_income").notNull().default('0'),
  ytdBasicDeduction: numeric("ytd_basic_deduction").notNull().default('0'),
  ytdDeduction: numeric("ytd_deduction").notNull().default('0'),
  ytdAdditionalDeduction: numeric("ytd_additional_deduction").notNull().default('0'),
  ytdTaxWithheld: numeric("ytd_tax_withheld").notNull().default('0'),
  ytdTaxableIncome: numeric("ytd_taxable_income").notNull().default('0'),
  taxRate: numeric("tax_rate"),
  quickDeduction: numeric("quick_deduction"),
  ytdNet: numeric("ytd_net").notNull().default('0'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_hr_payroll_code").on(table.code),
  uniqueIndex("uq_hr_payroll_emp_period").on(table.employeeId, table.period),
  index("idx_hr_payroll_period").on(table.period),
]);

/** A-07：员工专项附加扣除（员工 × 年度 × 类型，按月定额） */
export const hrEmployeeTaxDeduction = pgTable("hr_employee_tax_deduction", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id").notNull(),
  taxYear: integer("tax_year").notNull(),
  deductionType: varchar("deduction_type", { length: 32 }).notNull(),
  monthlyAmount: numeric("monthly_amount").notNull().default('0'),
  startMonth: integer("start_month").notNull().default(1),
  endMonth: integer("end_month"),
  remark: varchar("remark", { length: 200 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_hr_emp_tax_deduction").on(
    table.employeeId,
    table.taxYear,
    table.deductionType
  ),
  index("idx_hr_emp_tax_deduction_year").on(table.taxYear, table.employeeId),
]);

export const hrLeaveRequest = pgTable("hr_leave_request", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  employeeId: uuid("employee_id"),
  leaveType: varchar("leave_type", { length: 20 }).default('annual'),
  startDate: date("start_date"),
  endDate: date("end_date"),
  days: numeric("days").default('0'),
  reason: varchar("reason", { length: 500 }),
  status: varchar("status", { length: 20 }).default('pending'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_hr_leave_request_code").on(table.code),
  index("idx_hr_leave_request_employee").on(table.employeeId),
]);

export const hrLeaveBalance = pgTable("hr_leave_balance", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id"),
  leaveType: varchar("leave_type", { length: 20 }).default('annual'),
  year: varchar("year", { length: 4 }),
  totalDays: numeric("total_days").default('0'),
  usedDays: numeric("used_days").default('0'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_hr_leave_balance_employee").on(table.employeeId),
  uniqueIndex("uq_hr_leave_balance_emp_type_year").on(table.employeeId, table.leaveType, table.year),
]);

export const hrAttendance = pgTable("hr_attendance", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id"),
  workDate: date("work_date"),
  status: varchar("status", { length: 20 }).default('present'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_hr_attendance_employee").on(table.employeeId),
  uniqueIndex("uq_hr_attendance_emp_date").on(table.employeeId, table.workDate),
]);

export const hrPosition = pgTable("hr_position", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  roleName: varchar("role_name", { length: 50 }),
  status: varchar("status", { length: 20 }).default('active'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_hr_position_code").on(table.code),
]);

export const hrDepartment = pgTable("hr_department", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  parentId: uuid("parent_id"),
  status: varchar("status", { length: 20 }).default('active'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_hr_department_code").on(table.code),
]);

export const compAuditLog = pgTable("comp_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: varchar("actor", { length: 100 }),
  action: varchar("action", { length: 20 }),
  objectType: varchar("object_type", { length: 50 }),
  objectId: varchar("object_id", { length: 64 }),
  objectCode: varchar("object_code", { length: 50 }),
  statusBefore: varchar("status_before", { length: 30 }),
  statusAfter: varchar("status_after", { length: 30 }),
  detail: text("detail"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_comp_audit_log_object").on(table.objectType),
]);

export const erpInvoice = pgTable("erp_invoice", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  contractId: uuid("contract_id"),
  customerId: uuid("customer_id"),
  projectId: uuid("project_id"),
  invoiceNo: varchar("invoice_no", { length: 50 }),
  invoiceType: varchar("invoice_type", { length: 20 }).default('vat_special'),
  amount: numeric("amount").default('0'),
  taxRate: numeric("tax_rate").default('6'),
  taxAmount: numeric("tax_amount").default('0'),
  taxEntityId: uuid("tax_entity_id"),
  netAmount: numeric("net_amount"),
  oldAmount: numeric("old_amount"),
  buyerName: varchar("buyer_name", { length: 200 }),
  buyerUscc: varchar("buyer_uscc", { length: 20 }),
  sellerName: varchar("seller_name", { length: 200 }),
  sellerUscc: varchar("seller_uscc", { length: 20 }),
  invoiceDate: date("invoice_date"),
  status: varchar("status", { length: 20 }).default('issued'),
  remark: text("remark"),
  direction: varchar("direction", { length: 20 }).notNull().default('sales'),
  arId: uuid("ar_id"),
  /** 进项发票勾稽应付（F8） */
  apId: uuid("ap_id"),
  supplierId: uuid("supplier_id"),
  /** C-05：红字发票与来源单据的关联键（如 `sales-return:SRT2026100001`） */
  sourceRef: varchar("source_ref", { length: 100 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_invoice_code").on(table.code),
  index("idx_erp_invoice_contract").on(table.contractId),
  index("idx_erp_invoice_project").on(table.projectId),
  index("idx_erp_invoice_ap").on(table.apId),
  index("idx_erp_invoice_source_ref").on(table.sourceRef),
  // T8：发票税率法定档位（与迁移 chk_invoice_tax_rate 一致）
  check("chk_invoice_tax_rate", sql`${table.taxRate} IS NULL OR ${table.taxRate} IN (0, 1, 3, 6, 9, 13)`),
]);

export const erpApWriteoff = pgTable("erp_ap_writeoff", {
  id: uuid("id").primaryKey().defaultRandom(),
  apId: uuid("ap_id"),
  paymentId: uuid("payment_id"),
  amount: numeric("amount").default('0'),
  writeoffDate: date("writeoff_date"),
  reversalOf: uuid("reversal_of"),
  remark: varchar("remark", { length: 500 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_erp_ap_writeoff_ap").on(table.apId),
  uniqueIndex("uq_erp_ap_writeoff_reversal")
    .on(table.reversalOf)
    .where(sql`${table.reversalOf} IS NOT NULL`),
]);

export const erpPayment = pgTable("erp_payment", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  apId: uuid("ap_id"),
  supplierId: uuid("supplier_id"),
  amount: numeric("amount").default('0'),
  /** F4X-4：已核销金额冗余列，条件更新防并发超额 */
  usedAmount: numeric("used_amount").notNull().default('0'),
  payDate: date("pay_date"),
  method: varchar("method", { length: 20 }).default('bank'),
  status: varchar("status", { length: 20 }).default('pending'),
  approver: varchar("approver", { length: 50 }),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_payment_code").on(table.code),
  index("idx_erp_payment_ap").on(table.apId),
]);

export const erpApBill = pgTable("erp_ap_bill", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  supplierId: uuid("supplier_id"),
  projectId: uuid("project_id"),
  amount: numeric("amount").default('0'),
  paidAmount: numeric("paid_amount").default('0'),
  dueDate: date("due_date"),
  status: varchar("status", { length: 20 }).default('pending'),
  source: varchar("source", { length: 20 }).default('manual'),
  remark: text("remark"),
  sourceRef: varchar("source_ref", { length: 100 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_ap_bill_code").on(table.code),
  index("idx_erp_ap_bill_supplier").on(table.supplierId),
  uniqueIndex("uq_erp_ap_bill_source_ref")
    .on(table.sourceRef)
    .where(sql`${table.sourceRef} IS NOT NULL`),
]);

export const erpArWriteoff = pgTable("erp_ar_writeoff", {
  id: uuid("id").primaryKey().defaultRandom(),
  arId: uuid("ar_id"),
  receiptId: uuid("receipt_id"),
  amount: numeric("amount").default('0'),
  writeoffDate: date("writeoff_date"),
  /** 冲回原核销行（红字核销） */
  reversalOf: uuid("reversal_of"),
  remark: varchar("remark", { length: 500 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_erp_ar_writeoff_ar").on(table.arId),
  index("idx_erp_ar_writeoff_receipt").on(table.receiptId),
  uniqueIndex("uq_erp_ar_writeoff_reversal")
    .on(table.reversalOf)
    .where(sql`${table.reversalOf} IS NOT NULL`),
]);

export const erpReceipt = pgTable("erp_receipt", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  customerId: uuid("customer_id"),
  amount: numeric("amount").default('0'),
  /** F4X-3：已核销金额冗余列，条件更新防并发超额 */
  usedAmount: numeric("used_amount").notNull().default('0'),
  receiptDate: date("receipt_date"),
  method: varchar("method", { length: 20 }).default('bank'),
  source: varchar("source", { length: 100 }),
  status: varchar("status", { length: 20 }).default('unmatched'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_receipt_code").on(table.code),
  index("idx_erp_receipt_customer").on(table.customerId),
]);

export const erpAr = pgTable("erp_ar", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  contractId: uuid("contract_id"),
  customerId: uuid("customer_id"),
  projectId: uuid("project_id"),
  amount: numeric("amount").default('0'),
  settledAmount: numeric("settled_amount").default('0'),
  dueDate: date("due_date"),
  status: varchar("status", { length: 20 }).default('open'),
  source: varchar("source", { length: 20 }).default('manual'),
  /** D-19：收入确认等幂等键 */
  sourceRef: varchar("source_ref", { length: 100 }),
  remark: text("remark"),
  ownerUserId: varchar("owner_user_id", { length: 50 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_ar_code").on(table.code),
  index("idx_erp_ar_customer").on(table.customerId),
  index("idx_erp_ar_contract").on(table.contractId),
  uniqueIndex("uq_erp_ar_source_ref")
    .on(table.sourceRef)
    .where(sql`${table.sourceRef} IS NOT NULL`),
]);

export const erpRevenueAdjust = pgTable("erp_revenue_adjust", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  revenueId: uuid("revenue_id"),
  adjustType: varchar("adjust_type", { length: 20 }).default('discount'),
  amount: numeric("amount").default('0'),
  reason: varchar("reason", { length: 500 }),
  status: varchar("status", { length: 20 }).default('applied'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_revenue_adjust_code").on(table.code),
  index("idx_erp_revenue_adjust_revenue").on(table.revenueId),
]);

export const erpProjectRevenue = pgTable("erp_project_revenue", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  projectId: uuid("project_id"),
  contractId: uuid("contract_id"),
  period: varchar("period", { length: 7 }),
  method: varchar("method", { length: 20 }).default('progress'),
  amount: numeric("amount").default('0'),
  basis: varchar("basis", { length: 500 }),
  status: varchar("status", { length: 20 }).default('recognized'),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_project_revenue_code").on(table.code),
  index("idx_erp_project_revenue_project").on(table.projectId),
  index("idx_erp_project_revenue_period").on(table.period),
]);

/**
 * C-05：销售退货单。
 * 原单口径：收入确认（erp_project_revenue）只有金额没有数量，
 * 因此销售退货按"金额"校验（不得超过原收入已确认金额 − 已退货金额）。
 */
export const salesReturn = pgTable("sales_return", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  revenueId: uuid("revenue_id").notNull(),
  revenueCode: varchar("revenue_code", { length: 20 }),
  contractId: uuid("contract_id"),
  customerId: uuid("customer_id"),
  projectId: uuid("project_id"),
  returnDate: date("return_date").notNull(),
  amount: numeric("amount").notNull().default('0'),
  taxRate: numeric("tax_rate"),
  netAmount: numeric("net_amount").notNull().default('0'),
  taxAmount: numeric("tax_amount").notNull().default('0'),
  redInvoiceId: uuid("red_invoice_id"),
  revenueAdjustId: uuid("revenue_adjust_id"),
  status: varchar("status", { length: 20 }).notNull().default('draft'),
  reason: varchar("reason", { length: 500 }),
  remark: text("remark"),
  submittedAt: customTimestamptz("submitted_at", { precision: 3 }),
  approvedAt: customTimestamptz("approved_at", { precision: 3 }),
  completedAt: customTimestamptz("completed_at", { precision: 3 }),
  voucherRef: varchar("voucher_ref", { length: 100 }),
  createdByUser: varchar("created_by_user", { length: 64 }),
  approvedBy: varchar("approved_by", { length: 64 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_sales_return_code").on(table.code),
  index("idx_sales_return_revenue").on(table.revenueId),
  index("idx_sales_return_status").on(table.status),
  index("idx_sales_return_contract").on(table.contractId),
  uniqueIndex("uq_sales_return_voucher_ref")
    .on(table.voucherRef)
    .where(sql`${table.voucherRef} IS NOT NULL`),
  check("chk_sales_return_status", sql`${table.status} IN ('draft', 'submitted', 'approved', 'completed', 'void')`),
  check("chk_sales_return_amount", sql`${table.amount} > 0`),
]);

export const salesReturnItem = pgTable("sales_return_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  returnId: uuid("return_id").notNull(),
  revenueId: uuid("revenue_id"),
  itemName: varchar("item_name", { length: 200 }).notNull(),
  amount: numeric("amount").notNull().default('0'),
  taxRate: numeric("tax_rate"),
  netAmount: numeric("net_amount").notNull().default('0'),
  taxAmount: numeric("tax_amount").notNull().default('0'),
  remark: text("remark"),
  seq: integer("seq").notNull().default(1),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_sales_return_item_return").on(table.returnId),
  check("chk_sales_return_item_amount", sql`${table.amount} > 0`),
]);

/**
 * C-04：应收/应付票据（银行承兑 / 商业承兑）。
 * 状态机：received → held → endorsed | discounted | settled | dishonored。
 */
export const erpNote = pgTable("erp_note", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  noteNo: varchar("note_no", { length: 50 }).notNull(),
  noteType: varchar("note_type", { length: 20 }).notNull(),
  drawer: varchar("drawer", { length: 200 }),
  payee: varchar("payee", { length: 200 }),
  amount: numeric("amount").notNull().default('0'),
  issueDate: date("issue_date"),
  dueDate: date("due_date").notNull(),
  status: varchar("status", { length: 20 }).notNull().default('received'),
  arId: uuid("ar_id"),
  apId: uuid("ap_id"),
  supplierId: uuid("supplier_id"),
  customerId: uuid("customer_id"),
  projectId: uuid("project_id"),
  /** 贴现息 = 票面 × 贴现率 × 剩余天数 / 360（**计息基准需财务确认**） */
  discountInterest: numeric("discount_interest"),
  discountRate: numeric("discount_rate"),
  settledAmount: numeric("settled_amount"),
  settledDate: date("settled_date"),
  endorsementCounterparty: varchar("endorsement_counterparty", { length: 200 }),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_note_code").on(table.code),
  uniqueIndex("uq_erp_note_no").on(table.noteNo),
  index("idx_erp_note_status").on(table.status),
  index("idx_erp_note_due_date").on(table.dueDate),
  index("idx_erp_note_ar").on(table.arId),
  index("idx_erp_note_ap").on(table.apId),
  check("chk_erp_note_type", sql`${table.noteType} IN ('bank', 'commercial')`),
  check("chk_erp_note_status", sql`${table.status} IN ('received', 'held', 'endorsed', 'discounted', 'settled', 'dishonored')`),
  check("chk_erp_note_amount", sql`${table.amount} > 0`),
]);

export const erpNoteLog = pgTable("erp_note_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  noteId: uuid("note_id").notNull(),
  action: varchar("action", { length: 20 }).notNull(),
  fromStatus: varchar("from_status", { length: 20 }),
  toStatus: varchar("to_status", { length: 20 }).notNull(),
  amount: numeric("amount"),
  counterparty: varchar("counterparty", { length: 200 }),
  voucherRef: varchar("voucher_ref", { length: 100 }),
  operator: varchar("operator", { length: 64 }),
  remark: varchar("remark", { length: 500 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_erp_note_log_note").on(table.noteId),
  uniqueIndex("uq_erp_note_log_action")
    .on(table.noteId, table.action)
    .where(sql`${table.action} IN ('endorse', 'discount', 'settle', 'dishonor')`),
]);

/** D-12：BI 指标预警订阅（用户 × 指标 × 渠道唯一） */
export const biAlertSubscription = pgTable("bi_alert_subscription", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: varchar("user_id", { length: 64 }).notNull(),
  metricKey: varchar("metric_key", { length: 50 }).notNull(),
  thresholdDirection: varchar("threshold_direction", { length: 4 }).notNull().default('gt'),
  threshold: numeric("threshold").notNull().default('0'),
  channel: varchar("channel", { length: 20 }).notNull().default('feishu'),
  enabled: integer("enabled").notNull().default(1),
  lastTriggeredAt: customTimestamptz("last_triggered_at", { precision: 3 }),
  remark: varchar("remark", { length: 500 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_bi_alert_subscription_user_metric").on(table.userId, table.metricKey, table.channel),
  index("idx_bi_alert_subscription_enabled").on(table.enabled, table.metricKey),
  check("chk_bi_alert_subscription_direction", sql`${table.thresholdDirection} IN ('gt', 'lt')`),
  check("chk_bi_alert_subscription_enabled", sql`${table.enabled} IN (0, 1)`),
]);

export const erpCostAllocation = pgTable("erp_cost_allocation", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  sourceDesc: varchar("source_desc", { length: 200 }),
  costType: varchar("cost_type", { length: 20 }).default('compute'),
  amount: numeric("amount").default('0'),
  targetProjectId: uuid("target_project_id"),
  period: varchar("period", { length: 7 }),
  sourceRef: varchar("source_ref", { length: 100 }),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_cost_allocation_code").on(table.code),
  index("idx_erp_cost_allocation_project").on(table.targetProjectId),
]);

export const erpTimesheet = pgTable("erp_timesheet", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  projectId: uuid("project_id"),
  employeeName: varchar("employee_name", { length: 50 }),
  roleName: varchar("role_name", { length: 50 }),
  workDate: date("work_date"),
  hours: numeric("hours").default('0'),
  status: varchar("status", { length: 20 }).default('draft'),
  costGenerated: boolean("cost_generated").default(false),
  remark: text("remark"),
  employeeId: uuid("employee_id"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_timesheet_code").on(table.code),
  index("idx_erp_timesheet_project").on(table.projectId),
  index("idx_erp_timesheet_employee").on(table.employeeId),
]);

export const erpLaborRate = pgTable("erp_labor_rate", {
  id: uuid("id").primaryKey().defaultRandom(),
  roleName: varchar("role_name", { length: 50 }).notNull(),
  rate: numeric("rate").default('0'),
  effectiveFrom: date("effective_from"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_erp_labor_rate_role").on(table.roleName),
]);

export const erpProjectCost = pgTable("erp_project_cost", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  projectId: uuid("project_id"),
  costType: varchar("cost_type", { length: 20 }).default('labor'),
  amount: numeric("amount").default('0'),
  period: varchar("period", { length: 7 }),
  occurredDate: date("occurred_date"),
  sourceRef: varchar("source_ref", { length: 100 }),
  supplierId: uuid("supplier_id"),
  remark: text("remark"),
  departmentId: uuid("department_id"),
  contractId: uuid("contract_id"),
  isAccrual: integer("is_accrual").notNull().default(0),
  offsetOf: uuid("offset_of"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_project_cost_code").on(table.code),
  index("idx_erp_project_cost_project").on(table.projectId),
  index("idx_erp_project_cost_period").on(table.period),
  index("idx_erp_project_cost_department").on(table.departmentId),
  index("idx_erp_project_cost_contract").on(table.contractId),
  // 预提/红冲按 (period, project, is_accrual) 扫描，工资审批红冲走的就是这个索引
  index("idx_erp_project_cost_accrual").on(table.period, table.projectId, table.isAccrual),
  // T11：同一 source_ref 不可重复落成本（防红冲连点）
  // T11：仅红冲行强制唯一，避免误伤合法复用 source_ref 的业务行
  uniqueIndex("uq_erp_project_cost_redflush_source_ref")
    .on(table.sourceRef)
    .where(sql`${table.sourceRef} LIKE 'redflush:%'`),
]);

export const erpProjectChange = pgTable("erp_project_change", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  projectId: uuid("project_id"),
  changeType: varchar("change_type", { length: 20 }).default('scope'),
  content: text("content"),
  beforeValue: varchar("before_value", { length: 100 }),
  afterValue: varchar("after_value", { length: 100 }),
  status: varchar("status", { length: 20 }).default('pending'),
  applicant: varchar("applicant", { length: 50 }),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_project_change_code").on(table.code),
  index("idx_erp_project_change_project").on(table.projectId),
]);

export const erpProjectMilestone = pgTable("erp_project_milestone", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id"),
  name: varchar("name", { length: 200 }).notNull(),
  planDate: date("plan_date"),
  actualDate: date("actual_date"),
  status: varchar("status", { length: 20 }).default('pending'),
  remark: text("remark"),
  baselineDate: date("baseline_date"),
  forecastDate: date("forecast_date"),
  weightPct: numeric("weight_pct").notNull().default('0'),
  contractMilestoneId: uuid("contract_milestone_id"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_erp_project_milestone_project").on(table.projectId),
]);

export const erpProject = pgTable("erp_project", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  contractId: uuid("contract_id"),
  /** 最终成交报价单（来自关联商机的多轮报价） */
  wonQuotationId: uuid("won_quotation_id"),
  pm: varchar("pm", { length: 50 }),
  /** 项目经理系统用户 ID（工时确认等授权优先按此字段，避免同名误授权） */
  pmUserId: varchar("pm_user_id", { length: 64 }),
  deptName: varchar("dept_name", { length: 100 }),
  budget: numeric("budget").default('0'),
  startDate: date("start_date"),
  endDate: date("end_date"),
  progress: integer("progress").default(0),
  status: varchar("status", { length: 20 }).default('initiating'),
  remark: text("remark"),
  embedding: text("embedding"),
  estimatedTotalCost: numeric("estimated_total_cost").notNull().default('0'),
  closeSummary: text("close_summary"),
  satisfaction: integer("satisfaction"),
  retrospective: text("retrospective"),
  closedAt: date("closed_at"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_project_code").on(table.code),
  index("idx_erp_project_contract").on(table.contractId),
  index("idx_erp_project_won_quotation").on(table.wonQuotationId),
  // 一份合同只能立项一次（SQL 迁移已建，此处补声明防被 push 删除）
  uniqueIndex("uq_erp_project_one_contract")
    .on(table.contractId)
    .where(sql`${table.contractId} IS NOT NULL`),
  index("idx_project_embedding").using("hnsw", table.embedding),
]);

export const erpCalloff = pgTable("erp_calloff", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  contractId: uuid("contract_id"),
  seq: integer("seq").default(1),
  projectId: uuid("project_id"),
  amount: numeric("amount").default('0'),
  quantity: numeric("quantity"),
  unitPrice: numeric("unit_price"),
  status: varchar("status", { length: 20 }).default('ordered'),
  orderDate: date("order_date"),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_calloff_code").on(table.code),
  index("idx_erp_calloff_contract").on(table.contractId),
]);

export const erpContractVersion = pgTable("erp_contract_version", {
  id: uuid("id").primaryKey().defaultRandom(),
  contractId: uuid("contract_id"),
  versionNo: integer("version_no").default(1),
  changeLog: text("change_log"),
  changeAmount: numeric("change_amount").default('0'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_erp_contract_version_contract").on(table.contractId),
]);

export const erpContractMilestone = pgTable("erp_contract_milestone", {
  id: uuid("id").primaryKey().defaultRandom(),
  contractId: uuid("contract_id"),
  name: varchar("name", { length: 200 }).notNull(),
  amount: numeric("amount").default('0'),
  dueCondition: varchar("due_condition", { length: 500 }),
  dueDate: date("due_date"),
  status: varchar("status", { length: 20 }).default('pending'),
  actualDate: date("actual_date"),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_erp_contract_milestone_contract").on(table.contractId),
]);

export const erpContract = pgTable("erp_contract", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  customerId: uuid("customer_id"),
  billingModel: varchar("billing_model", { length: 20 }).default('project'),
  amount: numeric("amount").default('0'),
  taxRate: numeric("tax_rate").default('6'),
  taxEntityId: uuid("tax_entity_id"),
  netAmount: numeric("net_amount"),
  taxAmount: numeric("tax_amount"),
  rateSource: varchar("rate_source", { length: 20 }),
  status: varchar("status", { length: 20 }).default('draft'),
  signDate: date("sign_date"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  owner: varchar("owner", { length: 50 }),
  paymentTerms: varchar("payment_terms", { length: 200 }),
  remark: text("remark"),
  embedding: text("embedding"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_contract_code").on(table.code),
  index("idx_erp_contract_customer").on(table.customerId),
  index("idx_contract_embedding").using("hnsw", table.embedding),
  // T8：合同税率法定档位（与迁移 chk_contract_tax_rate 一致）
  check("chk_contract_tax_rate", sql`${table.taxRate} IS NULL OR ${table.taxRate} IN (0, 1, 3, 6, 9, 13)`),
]);

export const erpContractItem = pgTable("erp_contract_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  contractId: uuid("contract_id").notNull(),
  versionNo: integer("version_no").notNull().default(1),
  isCurrent: integer("is_current").notNull().default(1),
  seq: integer("seq").notNull().default(1),
  itemName: varchar("item_name", { length: 200 }).notNull(),
  unit: varchar("unit", { length: 20 }).notNull().default('项'),
  quantity: numeric("quantity").notNull().default('1'),
  unitPrice: numeric("unit_price").notNull().default('0'),
  discountPct: numeric("discount_pct").notNull().default('0'),
  taxRate: numeric("tax_rate").notNull().default('6'),
  amount: numeric("amount").notNull().default('0'),
  netAmount: numeric("net_amount").notNull().default('0'),
  taxAmount: numeric("tax_amount").notNull().default('0'),
  estUnitCost: numeric("est_unit_cost").notNull().default('0'),
  sourceType: varchar("source_type", { length: 20 }).notNull().default('manual'),
  sourceItemId: uuid("source_item_id"),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_erp_contract_item_contract").on(table.contractId, table.isCurrent),
  // 同一版本内明细序号不可重复（导入报价时 seq 可能重复，迁移里已先重排）
  uniqueIndex("uq_contract_item_seq")
    .on(table.contractId, table.versionNo, table.seq)
    .where(sql`${table.isCurrent} = 1`),
  check("chk_contract_item_tax_rate", sql`${table.taxRate} IN (0, 1, 3, 6, 9, 13)`),
]);

export const crmContact = pgTable("crm_contact", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id"),
  name: varchar("name", { length: 50 }).notNull(),
  phone: varchar("phone", { length: 30 }),
  email: varchar("email", { length: 100 }),
  position: varchar("position", { length: 50 }),
  isPrimary: boolean("is_primary").default(false),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_crm_contact_customer").on(table.customerId),
]);

export const crmOpportunity = pgTable("crm_opportunity", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  customerId: uuid("customer_id"),
  title: varchar("title", { length: 200 }).notNull(),
  stage: varchar("stage", { length: 20 }).default('new'),
  amount: numeric("amount").default('0'),
  winRate: integer("win_rate").default(0),
  owner: varchar("owner", { length: 50 }),
  expectedDate: date("expected_date"),
  taxRate: numeric("tax_rate"),
  contractId: uuid("contract_id"),
  /** 最终成交的报价单（一对多报价中选定的一轮） */
  wonQuotationId: uuid("won_quotation_id"),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_crm_opportunity_code").on(table.code),
  index("idx_crm_opportunity_customer").on(table.customerId),
  index("idx_crm_opportunity_won_quotation").on(table.wonQuotationId),
  // 一个商机只能转出一份合同（SQL 迁移已建，此处补声明防被 push 删除）
  uniqueIndex("uq_crm_opp_contract")
    .on(table.contractId)
    .where(sql`${table.contractId} IS NOT NULL`),
  check("chk_opp_tax_rate", sql`${table.taxRate} IS NULL OR ${table.taxRate} IN (0, 1, 3, 6, 9, 13)`),
]);

export const crmLead = pgTable("crm_lead", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  customerName: varchar("customer_name", { length: 200 }).notNull(),
  source: varchar("source", { length: 50 }),
  contactName: varchar("contact_name", { length: 50 }),
  contactPhone: varchar("contact_phone", { length: 30 }),
  status: varchar("status", { length: 20 }).default('new'),
  owner: varchar("owner", { length: 50 }),
  followNote: text("follow_note"),
  nextDate: date("next_date"),
  customerId: uuid("customer_id"),
  convertedOpportunityId: uuid("converted_opportunity_id"),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_crm_lead_code").on(table.code),
]);

export const mdEmployee = pgTable("md_employee", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 50 }).notNull(),
  orgName: varchar("org_name", { length: 100 }),
  position: varchar("position", { length: 100 }),
  status: varchar("status", { length: 20 }).default('active'),
  departmentId: uuid("department_id"),
  positionId: uuid("position_id"),
  hireDate: date("hire_date"),
  employmentType: varchar("employment_type", { length: 20 }).default('full_time'),
  phone: varchar("phone", { length: 30 }),
  resignDate: date("resign_date"),
  email: varchar("email", { length: 200 }),
  remark: text("remark"),
  feishuUnionId: varchar("feishu_union_id", { length: 64 }),
  feishuOpenId: varchar("feishu_open_id", { length: 64 }),
  feishuDepartmentId: varchar("feishu_department_id", { length: 64 }),
  avatarUrl: varchar("avatar_url", { length: 500 }),
  syncedAt: customTimestamptz("synced_at", { precision: 3 }),
  platformUserId: userProfile("platform_user_id"),
  supplierId: uuid("supplier_id"),
  /** 参保城市代码（工资引擎） */
  ssCityCode: varchar("ss_city_code", { length: 32 }),
  /** 社保缴费基数覆盖 */
  ssBase: numeric("ss_base"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_md_employee_code").on(table.code),
  index("idx_md_employee_department").on(table.departmentId),
  index("idx_md_employee_position").on(table.positionId),
  // Complex index: CREATE UNIQUE INDEX uq_md_employee_platform_user ON md_employee USING btree (((platform_user_id).user_id)),
]);

export const mdSupplier = pgTable("md_supplier", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  type: varchar("type", { length: 50 }),
  contactName: varchar("contact_name", { length: 50 }),
  contactPhone: varchar("contact_phone", { length: 30 }),
  bankAccount: varchar("bank_account", { length: 100 }),
  rating: numeric("rating").default('0'),
  status: varchar("status", { length: 20 }).default('active'),
  remark: text("remark"),
  taxEntityId: uuid("tax_entity_id"),
  defaultTaxRate: numeric("default_tax_rate"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_md_supplier_code").on(table.code),
  check("chk_supplier_default_tax_rate", sql`${table.defaultTaxRate} IS NULL OR ${table.defaultTaxRate} IN (0, 1, 3, 6, 9, 13)`),
]);

export const mdCustomer = pgTable("md_customer", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  uscc: varchar("uscc", { length: 50 }),
  industry: varchar("industry", { length: 100 }),
  creditLevel: varchar("credit_level", { length: 20 }),
  creditLimit: numeric("credit_limit").default('0'),
  termsDays: integer("terms_days").default(30),
  status: varchar("status", { length: 20 }).default('active'),
  remark: text("remark"),
  taxEntityId: uuid("tax_entity_id"),
  defaultTaxRate: numeric("default_tax_rate"),
  invoiceTitle: varchar("invoice_title", { length: 200 }),
  invoiceAddress: varchar("invoice_address", { length: 300 }),
  invoicePhone: varchar("invoice_phone", { length: 40 }),
  invoiceBank: varchar("invoice_bank", { length: 200 }),
  invoiceAccount: varchar("invoice_account", { length: 64 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_md_customer_code").on(table.code),
  // 允许为空（空=继承纳税主体默认税率），非空必须是法定税率
  check("chk_customer_default_tax_rate", sql`${table.defaultTaxRate} IS NULL OR ${table.defaultTaxRate} IN (0, 1, 3, 6, 9, 13)`),
]);

export const mdTaxEntity = pgTable("md_tax_entity", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  uscc: varchar("uscc", { length: 20 }),
  taxpayerType: varchar("taxpayer_type", { length: 20 }).notNull(),
  defaultOutputRate: numeric("default_output_rate").notNull(),
  defaultInputRate: numeric("default_input_rate").notNull(),
  invoiceTitle: varchar("invoice_title", { length: 200 }),
  invoiceAddress: varchar("invoice_address", { length: 300 }),
  invoicePhone: varchar("invoice_phone", { length: 40 }),
  invoiceBank: varchar("invoice_bank", { length: 200 }),
  invoiceAccount: varchar("invoice_account", { length: 64 }),
  isDefault: integer("is_default").notNull().default(0),
  status: varchar("status", { length: 20 }).notNull().default('active'),
  remark: text("remark"),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_md_tax_entity_code").on(table.code),
  uniqueIndex("uq_md_tax_entity_name").on(table.name),
  // 全局有且仅有一个默认纳税主体（部分唯一索引，SQL 迁移已建）
  uniqueIndex("uq_md_tax_entity_default")
    .on(table.isDefault)
    .where(sql`${table.isDefault} = 1`),
  check("chk_tax_entity_type", sql`${table.taxpayerType} IN ('general', 'small')`),
]);

// table aliases
export const astAssetTable = astAsset;
export const astChangeTable = astChange;
export const astDepreciationTable = astDepreciation;
export const compAttachmentTable = compAttachment;
export const compAuditLogTable = compAuditLog;
export const compAutomationConfigTable = compAutomationConfig;
export const compFeishuDriveConfigTable = compFeishuDriveConfig;
export const compFeishuSyncRecordTable = compFeishuSyncRecord;
export const compProjectDriveSyncTable = compProjectDriveSync;
export const crmContactTable = crmContact;
export const crmLeadTable = crmLead;
export const crmOpportunityTable = crmOpportunity;
export const crmQuotationTable = crmQuotation;
export const crmQuotationItemTable = crmQuotationItem;
export const daDatasetTable = daDataset;
export const daGrantTable = daGrant;
export const erpAdminAffairTable = erpAdminAffair;
export const erpAdminAssetTable = erpAdminAsset;
export const erpAdminBillTable = erpAdminBill;
export const erpAdminRentContractTable = erpAdminRentContract;
export const erpApBillTable = erpApBill;
export const erpApWriteoffTable = erpApWriteoff;
export const erpArTable = erpAr;
export const erpArWriteoffTable = erpArWriteoff;
export const erpCalloffTable = erpCalloff;
export const erpContractTable = erpContract;
export const erpContractMilestoneTable = erpContractMilestone;
export const erpContractVersionTable = erpContractVersion;
export const erpCostAllocationTable = erpCostAllocation;
export const erpDeliverableTable = erpDeliverable;
export const erpInvoiceTable = erpInvoice;
export const erpLaborRateTable = erpLaborRate;
export const erpPaymentTable = erpPayment;
export const erpProjectTable = erpProject;
export const erpProjectChangeTable = erpProjectChange;
export const erpProjectCostTable = erpProjectCost;
export const erpProjectMilestoneTable = erpProjectMilestone;
export const erpProjectMinutesTable = erpProjectMinutes;
export const erpProjectRevenueTable = erpProjectRevenue;
export const erpReceiptTable = erpReceipt;
export const erpRevenueAdjustTable = erpRevenueAdjust;
export const erpTimesheetTable = erpTimesheet;
export const finAccountTable = finAccount;
export const finBudgetTable = finBudget;
export const finExpenseApplyTable = finExpenseApply;
export const finExpenseClaimTable = finExpenseClaim;
export const finPeriodCloseTable = finPeriodClose;
export const finVoucherTable = finVoucher;
export const finVoucherLineTable = finVoucherLine;
export const hrAppraisalTable = hrAppraisal;
export const hrAttendanceTable = hrAttendance;
export const hrAttendanceAmendmentTable = hrAttendanceAmendment;
export const hrCandidateTable = hrCandidate;
export const hrDepartmentTable = hrDepartment;
export const hrLeaveBalanceTable = hrLeaveBalance;
export const hrLeaveRequestTable = hrLeaveRequest;
export const hrPayrollTable = hrPayroll;
export const hrPositionTable = hrPosition;
export const hrRecruitReqTable = hrRecruitReq;
export const hrTrainingTable = hrTraining;
export const hrTrainingRecordTable = hrTrainingRecord;
export const mdCustomerTable = mdCustomer;
export const mdTaxEntityTable = mdTaxEntity;
export const erpContractItemTable = erpContractItem;
export const mdEmployeeTable = mdEmployee;
export const mdSupplierTable = mdSupplier;
export const purOrderTable = purOrder;
export const purRequestTable = purRequest;


export const hrSsCityRule = pgTable("hr_ss_city_rule", {
  id: uuid("id").primaryKey().defaultRandom(),
  cityCode: varchar("city_code", { length: 32 }).notNull(),
  cityName: varchar("city_name", { length: 64 }).notNull(),
  effectiveFrom: varchar("effective_from", { length: 7 }).notNull(),
  effectiveTo: varchar("effective_to", { length: 7 }),
  pensionEmp: numeric("pension_emp").notNull().default('8'),
  pensionCo: numeric("pension_co").notNull().default('16'),
  medicalEmp: numeric("medical_emp").notNull().default('2'),
  medicalCo: numeric("medical_co").notNull().default('8'),
  unemploymentEmp: numeric("unemployment_emp").notNull().default('0.5'),
  unemploymentCo: numeric("unemployment_co").notNull().default('0.5'),
  housingEmp: numeric("housing_emp").notNull().default('12'),
  housingCo: numeric("housing_co").notNull().default('12'),
  baseMin: numeric("base_min").notNull().default('0'),
  baseMax: numeric("base_max").notNull().default('999999'),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_hr_ss_city_rule_city_from").on(table.cityCode, table.effectiveFrom),
]);

export const finPeriodCloseAudit = pgTable("fin_period_close_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  period: varchar("period", { length: 7 }).notNull(),
  action: varchar("action", { length: 20 }).notNull(),
  actorUserId: varchar("actor_user_id", { length: 64 }),
  remark: varchar("remark", { length: 500 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const sysUser = pgTable("sys_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: varchar("username", { length: 64 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }),
  displayName: varchar("display_name", { length: 100 }).notNull(),
  feishuOpenId: varchar("feishu_open_id", { length: 64 }).unique(),
  feishuUnionId: varchar("feishu_union_id", { length: 64 }),
  email: varchar("email", { length: 200 }),
  mobile: varchar("mobile", { length: 30 }),
  avatarUrl: varchar("avatar_url", { length: 500 }),
  departmentName: varchar("department_name", { length: 100 }),
  departmentId: uuid("department_id"),
  employeeId: uuid("employee_id"),
  authType: varchar("auth_type", { length: 20 }).notNull().default('local'),
  status: varchar("status", { length: 20 }).notNull().default('active'),
  lastLoginAt: customTimestamptz("last_login_at", { precision: 3 }),
  syncedAt: customTimestamptz("synced_at", { precision: 3 }),
  /** B-04：MFA（TOTP）与密码策略 */
  mfaEnabled: integer("mfa_enabled").notNull().default(0),
  mfaSecretEnc: varchar("mfa_secret_enc", { length: 500 }),
  mfaBoundAt: customTimestamptz("mfa_bound_at", { precision: 3 }),
  passwordChangedAt: customTimestamptz("password_changed_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  passwordHistory: text("password_history").notNull().default('[]'),
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  lockedUntil: customTimestamptz("locked_until", { precision: 3 }),
  mustChangePassword: integer("must_change_password").notNull().default(0),
  /** null = 按角色策略；1 = 强制；0 = 豁免 */
  mfaRequiredOverride: integer("mfa_required_override"),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const sysRole = pgTable("sys_role", {
  code: varchar("code", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
});

export const sysRoleMember = pgTable("sys_role_member", {
  id: uuid("id").primaryKey().defaultRandom(),
  roleCode: varchar("role_code", { length: 64 }).notNull(),
  userId: varchar("user_id", { length: 64 }).notNull(),
}, (table) => [
  uniqueIndex("uq_sys_role_member").on(table.roleCode, table.userId),
]);

export const sysDepartment = pgTable("sys_department", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  parentId: uuid("parent_id"),
  code: varchar("code", { length: 64 }),
  feishuDepartmentId: varchar("feishu_department_id", { length: 64 }),
  feishuParentId: varchar("feishu_parent_id", { length: 64 }),
  leaderUserId: uuid("leader_user_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  status: varchar("status", { length: 20 }).notNull().default('active'),
  syncedAt: customTimestamptz("synced_at", { precision: 3 }),
});

export const sysLoginSession = pgTable("sys_login_session", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  jti: varchar("jti", { length: 64 }).notNull().unique(),
  refreshTokenEnc: text("refresh_token_enc"),
  expiresAt: customTimestamptz("expires_at", { precision: 3 }).notNull(),
  revokedAt: customTimestamptz("revoked_at", { precision: 3 }),
  /** B-04：设备与会话来源，供"登录设备管理"展示与远程下线 */
  ip: varchar("ip", { length: 64 }),
  userAgent: varchar("user_agent", { length: 500 }),
  deviceLabel: varchar("device_label", { length: 120 }),
  authMethod: varchar("auth_method", { length: 20 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_sys_login_session_user_active").on(table.userId, table.revokedAt, table.expiresAt),
]);

export const sysFeishuSyncState = pgTable("sys_feishu_sync_state", {
  id: varchar("id", { length: 64 }).primaryKey(),
  cursor: varchar("cursor", { length: 200 }),
  fullSyncedAt: customTimestamptz("full_synced_at", { precision: 3 }),
  incrementalSyncedAt: customTimestamptz("incremental_synced_at", { precision: 3 }),
});

export const sysFeishuSyncConflict = pgTable("sys_feishu_sync_conflict", {
  id: uuid("id").primaryKey().defaultRandom(),
  unionId: varchar("union_id", { length: 64 }),
  reason: varchar("reason", { length: 40 }).notNull(),
  payload: text("payload"),
  status: varchar("status", { length: 20 }).notNull().default('open'),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const sysFeishuEvent = pgTable("sys_feishu_event", {
  eventId: varchar("event_id", { length: 128 }).primaryKey(),
  eventType: varchar("event_type", { length: 80 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** 飞书代绑邀请（B1）：一次性 token → 目标 sys_user */
export const sysFeishuBindInvite = pgTable("sys_feishu_bind_invite", {
  id: uuid("id").primaryKey().defaultRandom(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  targetUserId: uuid("target_user_id").notNull(),
  createdBy: uuid("created_by").notNull(),
  expiresAt: customTimestamptz("expires_at", { precision: 3 }).notNull(),
  consumedAt: customTimestamptz("consumed_at", { precision: 3 }),
  revokedAt: customTimestamptz("revoked_at", { precision: 3 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_sys_feishu_bind_invite_target").on(table.targetUserId),
]);

/** 站点品牌配置（单行语义：业务层只读写最新一条） */
export const sysBrandConfig = pgTable("sys_brand_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  brandName: varchar("brand_name", { length: 100 }).notNull().default('晟笙 ERP'),
  logoFileId: uuid("logo_file_id"),
  faviconFileId: uuid("favicon_file_id"),
  updatedBy: varchar("updated_by", { length: 64 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const compFeishuBitableConfig = pgTable("comp_feishu_bitable_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  bizType: varchar("biz_type", { length: 40 }).notNull().unique(),
  appToken: varchar("app_token", { length: 128 }).notNull(),
  tableId: varchar("table_id", { length: 128 }).notNull(),
  /** JSON：飞书列名 → ERP 字段路径 */
  fieldMap: text("field_map"),
  enabled: integer("enabled").notNull().default(1),
});

export const compFeishuApproval = pgTable("comp_feishu_approval", {
  id: uuid("id").primaryKey().defaultRandom(),
  bizType: varchar("biz_type", { length: 40 }).notNull(),
  bizCode: varchar("biz_code", { length: 64 }).notNull(),
  instanceCode: varchar("instance_code", { length: 128 }),
  status: varchar("status", { length: 20 }).notNull().default('pending'),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** B-04：登录审计（成功/失败均留痕） */
export const sysLoginAudit = pgTable("sys_login_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: varchar("username", { length: 128 }),
  userId: uuid("user_id"),
  result: varchar("result", { length: 20 }).notNull(),
  /** 失败原因：bad_credentials / locked / disabled / mfa_required / mfa_invalid / password_expired */
  reason: varchar("reason", { length: 64 }),
  authMethod: varchar("auth_method", { length: 20 }),
  ip: varchar("ip", { length: 64 }),
  userAgent: varchar("user_agent", { length: 500 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_sys_login_audit_created").on(table.createdAt),
  index("idx_sys_login_audit_username").on(table.username, table.createdAt),
]);

/** B-04：MFA 临时挑战票据（密码通过后、TOTP 校验前使用） */
export const sysMfaChallenge = pgTable("sys_mfa_challenge", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  tokenHash: varchar("token_hash", { length: 128 }).notNull(),
  expiresAt: customTimestamptz("expires_at", { precision: 3 }).notNull(),
  consumedAt: customTimestamptz("consumed_at", { precision: 3 }),
  ip: varchar("ip", { length: 64 }),
  userAgent: varchar("user_agent", { length: 500 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_sys_mfa_challenge_token").on(table.tokenHash),
  index("idx_sys_mfa_challenge_user").on(table.userId, table.expiresAt),
]);

/** B-04：MFA 恢复码（一次性） */
export const sysMfaRecoveryCode = pgTable("sys_mfa_recovery_code", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  codeHash: varchar("code_hash", { length: 128 }).notNull(),
  usedAt: customTimestamptz("used_at", { precision: 3 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_sys_mfa_recovery_code").on(table.codeHash),
  index("idx_sys_mfa_recovery_user").on(table.userId, table.usedAt),
]);

/** B-03：业务字典 */
export const sysDict = pgTable("sys_dict", {
  id: uuid("id").primaryKey().defaultRandom(),
  dictType: varchar("dict_type", { length: 64 }).notNull(),
  dictKey: varchar("dict_key", { length: 64 }).notNull(),
  dictLabel: varchar("dict_label", { length: 120 }).notNull(),
  extra: varchar("extra", { length: 500 }),
  sortNo: integer("sort_no").notNull().default(0),
  enabled: integer("enabled").notNull().default(1),
  builtin: integer("builtin").notNull().default(0),
  remark: varchar("remark", { length: 200 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_sys_dict_type_key").on(table.dictType, table.dictKey),
  index("idx_sys_dict_type").on(table.dictType, table.sortNo),
]);

/** B-03：系统参数 */
export const sysParam = pgTable("sys_param", {
  id: uuid("id").primaryKey().defaultRandom(),
  paramKey: varchar("param_key", { length: 64 }).notNull(),
  paramValue: varchar("param_value", { length: 500 }).notNull().default(''),
  valueType: varchar("value_type", { length: 16 }).notNull().default('string'),
  paramGroup: varchar("param_group", { length: 32 }).notNull().default('general'),
  description: varchar("description", { length: 300 }),
  editable: integer("editable").notNull().default(1),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_sys_param_key").on(table.paramKey),
  index("idx_sys_param_group").on(table.paramGroup),
]);

/** B-08：编号规则 */
export const sysCodeRule = pgTable("sys_code_rule", {
  id: uuid("id").primaryKey().defaultRandom(),
  bizType: varchar("biz_type", { length: 40 }).notNull(),
  bizName: varchar("biz_name", { length: 80 }).notNull(),
  prefix: varchar("prefix", { length: 16 }).notNull(),
  datePattern: varchar("date_pattern", { length: 10 }).notNull().default('YYYYMM'),
  seqLength: integer("seq_length").notNull().default(4),
  resetPolicy: varchar("reset_policy", { length: 16 }).notNull().default('monthly'),
  allowReuse: integer("allow_reuse").notNull().default(0),
  enabled: integer("enabled").notNull().default(1),
  remark: varchar("remark", { length: 200 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_sys_code_rule_biz").on(table.bizType),
]);

/** B-07：数据保留策略 */
export const sysDataRetentionPolicy = pgTable("sys_data_retention_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  dataType: varchar("data_type", { length: 40 }).notNull(),
  displayName: varchar("display_name", { length: 80 }).notNull(),
  retainDays: integer("retain_days").notNull().default(730),
  action: varchar("action", { length: 16 }).notNull().default('archive'),
  enabled: integer("enabled").notNull().default(1),
  lastRunAt: customTimestamptz("last_run_at", { precision: 3 }),
  lastRunCount: integer("last_run_count"),
  remark: varchar("remark", { length: 200 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_sys_data_retention_type").on(table.dataType),
]);

/** B-07：审计日志归档表 */
export const compAuditLogArchive = pgTable("comp_audit_log_archive", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id"),
  objectType: varchar("object_type", { length: 60 }),
  objectId: varchar("object_id", { length: 120 }),
  action: varchar("action", { length: 40 }),
  actorUserId: varchar("actor_user_id", { length: 64 }),
  detail: text("detail"),
  occurredAt: customTimestamptz("occurred_at", { precision: 3 }),
  archivedAt: customTimestamptz("archived_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_comp_audit_log_archive_time").on(table.occurredAt),
  index("idx_comp_audit_log_archive_object").on(table.objectType, table.objectId),
]);

/** B-07：PII 处理工单 */
export const sysPiiRequest = pgTable("sys_pii_request", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestType: varchar("request_type", { length: 20 }).notNull(),
  subjectType: varchar("subject_type", { length: 20 }).notNull(),
  subjectId: uuid("subject_id").notNull(),
  subjectName: varchar("subject_name", { length: 120 }),
  reason: varchar("reason", { length: 500 }),
  status: varchar("status", { length: 20 }).notNull().default('pending'),
  resultSummary: text("result_summary"),
  requestedBy: varchar("requested_by", { length: 64 }),
  handledBy: varchar("handled_by", { length: 64 }),
  handledAt: customTimestamptz("handled_at", { precision: 3 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_sys_pii_request_status").on(table.status, table.createdAt),
]);

export const compStoredFile = pgTable("comp_stored_file", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  mime: varchar("mime", { length: 120 }),
  size: integer("size").notNull(),
  storagePath: varchar("storage_path", { length: 500 }).notNull(),
  /** A4：上传人，下载时做归属校验 */
  ownerUserId: varchar("owner_user_id", { length: 64 }),
  /** B-06：附件版本链（同一资源多次上传保留历史版本） */
  version: integer("version").notNull().default(1),
  parentFileId: uuid("parent_file_id"),
  isLatest: integer("is_latest").notNull().default(1),
  /** 版本链根 id（由迁移的触发器维护，用于同链版本号唯一索引） */
  rootFileId: uuid("root_file_id"),
  /** B-06：内容魔数（十六进制前缀）与扫描结论，用于"改名伪装"留痕 */
  magicHex: varchar("magic_hex", { length: 32 }),
  scanStatus: varchar("scan_status", { length: 20 }).notNull().default('skipped'),
  scanDetail: varchar("scan_detail", { length: 300 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_comp_stored_file_parent").on(table.parentFileId),
  index("idx_comp_stored_file_latest").on(table.isLatest),
]);

export const compBizCodeSeq = pgTable("comp_biz_code_seq", {
  monthKey: varchar("month_key", { length: 32 }).primaryKey(),
  lastSeq: integer("last_seq").notNull(),
});

export const compVoucherJob = pgTable("comp_voucher_job", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceType: varchar("source_type", { length: 32 }).notNull(),
  sourceRef: varchar("source_ref", { length: 120 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default('failed'),
  lastError: text("last_error"),
  payload: text("payload"),
  attempts: integer("attempts").notNull().default(1),
  nextRetryAt: customTimestamptz("next_retry_at", { precision: 3 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_comp_voucher_job_source").on(table.sourceType, table.sourceRef),
]);

/** B8：站内信收件箱（与飞书审批通知并行，不替代飞书通道） */
export const sysInboxMessage = pgTable("sys_inbox_message", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: varchar("user_id", { length: 64 }).notNull(),
  title: varchar("title", { length: 200 }),
  content: text("content"),
  bizType: varchar("biz_type", { length: 40 }),
  bizCode: varchar("biz_code", { length: 64 }),
  readAt: customTimestamptz("read_at", { precision: 3 }),
  createdAt: customTimestamptz("created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_sys_inbox_message_user").on(table.userId),
  index("idx_sys_inbox_message_user_unread").on(table.userId, table.readAt),
]);

/* ========== 批次二 C 线：银行账户/流水/匹配、导入映射、异步导出任务 ========== */
/* 与迁移 2026-10-15-upgrade-batch2-bank-export-tasks.sql 保持一致 */

export const mdBankAccount = pgTable("md_bank_account", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  accountNo: varchar("account_no", { length: 64 }).notNull(),
  bankName: varchar("bank_name", { length: 200 }).notNull(),
  branchName: varchar("branch_name", { length: 200 }),
  currency: varchar("currency", { length: 8 }).notNull().default('CNY'),
  /** 关联会计科目编码（fin_account.code），默认 1002 银行存款 */
  accountCode: varchar("account_code", { length: 20 }),
  /** 银行对账单口径的期初余额（对账底稿用，非账套取数） */
  openingBalance: numeric("opening_balance").notNull().default('0'),
  isDefault: integer("is_default").notNull().default(0),
  status: varchar("status", { length: 20 }).notNull().default('active'),
  contactPerson: varchar("contact_person", { length: 50 }),
  contactPhone: varchar("contact_phone", { length: 30 }),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_md_bank_account_code").on(table.code),
  uniqueIndex("uq_md_bank_account_no_currency").on(table.accountNo, table.currency),
  index("idx_md_bank_account_status").on(table.status),
  index("idx_md_bank_account_account_code").on(table.accountCode),
  uniqueIndex("uq_md_bank_account_default_currency")
    .on(table.currency)
    .where(sql`${table.isDefault} = 1`),
]);

export const erpBankStatement = pgTable("erp_bank_statement", {
  id: uuid("id").primaryKey().defaultRandom(),
  bankAccountId: uuid("bank_account_id").notNull(),
  transactionDate: date("transaction_date").notNull(),
  direction: varchar("direction", { length: 10 }).notNull(),
  amount: numeric("amount").notNull().default('0'),
  /** 银行对账单上的交易后余额（部分银行不提供，可为空） */
  balance: numeric("balance"),
  counterpartyName: varchar("counterparty_name", { length: 200 }),
  counterpartyAccount: varchar("counterparty_account", { length: 64 }),
  summary: varchar("summary", { length: 500 }),
  /** 银行交易流水号（去重首选键） */
  transactionNo: varchar("transaction_no", { length: 100 }),
  /** 业务指纹去重键（交易流水号缺失时的兜底） */
  dedupeKey: varchar("dedupe_key", { length: 200 }).notNull(),
  matchStatus: varchar("match_status", { length: 20 }).notNull().default('unmatched'),
  bizType: varchar("biz_type", { length: 20 }),
  bizId: uuid("biz_id"),
  bizCode: varchar("biz_code", { length: 50 }),
  matchScore: numeric("match_score"),
  matchedAt: customTimestamptz("matched_at", { precision: 3 }),
  matchedBy: varchar("matched_by", { length: 64 }),
  importBatch: varchar("import_batch", { length: 64 }),
  remark: text("remark"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_bank_statement_dedupe").on(table.bankAccountId, table.dedupeKey),
  index("idx_erp_bank_statement_account_date").on(table.bankAccountId, table.transactionDate),
  index("idx_erp_bank_statement_status").on(table.bankAccountId, table.matchStatus),
  index("idx_erp_bank_statement_transaction_no").on(table.bankAccountId, table.transactionNo),
  index("idx_erp_bank_statement_biz").on(table.bizType, table.bizId),
]);

export const erpBankStatementMatch = pgTable("erp_bank_statement_match", {
  id: uuid("id").primaryKey().defaultRandom(),
  statementId: uuid("statement_id").notNull(),
  bankAccountId: uuid("bank_account_id").notNull(),
  bizType: varchar("biz_type", { length: 20 }).notNull(),
  bizId: uuid("biz_id").notNull(),
  bizCode: varchar("biz_code", { length: 50 }),
  matchType: varchar("match_type", { length: 20 }).notNull().default('auto'),
  score: numeric("score"),
  amount: numeric("amount"),
  remark: varchar("remark", { length: 500 }),
  matchedAt: customTimestamptz("matched_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  matchedBy: varchar("matched_by", { length: 64 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  // 一条流水最多一条有效匹配
  uniqueIndex("uq_erp_bank_statement_match_statement").on(table.statementId),
  index("idx_erp_bank_statement_match_biz").on(table.bizType, table.bizId),
  index("idx_erp_bank_statement_match_account").on(table.bankAccountId),
]);

export const erpBankImportMapping = pgTable("erp_bank_import_mapping", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  bankName: varchar("bank_name", { length: 200 }),
  mapping: jsonb("mapping").notNull().default({}),
  remark: varchar("remark", { length: 500 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_erp_bank_import_mapping_name").on(table.name),
]);

export const exportTasks = pgTable("export_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 30 }).notNull(),
  resourceType: varchar("resource_type", { length: 50 }).notNull(),
  format: varchar("format", { length: 10 }).notNull().default('xlsx'),
  filterParams: jsonb("filter_params").notNull().default({}),
  filterSummary: varchar("filter_summary", { length: 1000 }).notNull().default(''),
  status: varchar("status", { length: 20 }).notNull().default('pending'),
  /** 相对 UPLOAD_DIR 的文件名（不含目录） */
  fileName: varchar("file_name", { length: 200 }),
  fileSize: integer("file_size"),
  rowCount: integer("row_count"),
  errorMessage: text("error_message"),
  requestedBy: varchar("requested_by", { length: 64 }),
  requestedByName: varchar("requested_by_name", { length: 100 }),
  startedAt: customTimestamptz("started_at", { precision: 3 }),
  finishedAt: customTimestamptz("finished_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uq_export_tasks_code").on(table.code),
  index("idx_export_tasks_requested_by").on(table.requestedBy, table.createdAt),
  index("idx_export_tasks_status").on(table.status),
]);

/**
 * B-02：数据级权限（行级可见范围）配置。
 * 角色 × 资源类型 → 范围（all / dept / dept_and_child / self / custom）。
 * 迁移：server/database/migrations/2026-10-15-upgrade-data-scope.sql
 * 判定与 SQL 注入逻辑：server/common/auth/data-scope.service.ts
 */
export const sysDataScope = pgTable("sys_data_scope", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** 角色码，取值见 shared/rbac.ts 的 ROLE_CODES */
  roleCode: varchar("role_code", { length: 64 }).notNull(),
  /** project / customer / finance_ledger / employee / attendance */
  resourceType: varchar("resource_type", { length: 40 }).notNull(),
  /** all / dept / dept_and_child / self / custom */
  scope: varchar("scope", { length: 20 }).notNull().default('all'),
  /** custom 范围下的显式 id 列表（JSON 数组字符串） */
  customIds: text("custom_ids").notNull().default('[]'),
  enabled: integer("enabled").notNull().default(1),
  remark: varchar("remark", { length: 200 }),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uq_sys_data_scope_role_resource").on(table.roleCode, table.resourceType),
  index("idx_sys_data_scope_resource").on(table.resourceType, table.enabled),
  check("chk_sys_data_scope_scope", sql`${table.scope} IN ('all', 'dept', 'dept_and_child', 'self', 'custom')`),
  check("chk_sys_data_scope_resource", sql`${table.resourceType} IN ('project', 'customer', 'finance_ledger', 'employee', 'attendance')`),
]);

