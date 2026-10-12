/* eslint-disable */
/** 业务表结构。系统字段默认值依赖会话变量 app.user_id。 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, date, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid, varchar, customType } from "drizzle-orm/pg-core"

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
  title: varchar("title", { length: 200 }).notNull(),
  quoteDate: date("quote_date"),
  validUntil: date("valid_until"),
  status: varchar("status", { length: 20 }).notNull().default('draft'),
  discountPct: numeric("discount_pct").notNull().default('0'),
  totalAmount: numeric("total_amount").notNull().default('0'),
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
]);

export const compFeishuDriveConfig = pgTable("comp_feishu_drive_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  appId: varchar("app_id", { length: 255 }).notNull(),
  appSecret: varchar("app_secret", { length: 512 }).notNull(),
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

export const finVoucherLine = pgTable("fin_voucher_line", {
  id: uuid("id").primaryKey().defaultRandom(),
  voucherId: uuid("voucher_id"),
  accountId: uuid("account_id"),
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
]);

export const finAccount = pgTable("fin_account", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  accountType: varchar("account_type", { length: 20 }).default('asset'),
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
  uniqueIndex("fin_account_code_key").on(table.code),
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
  invoiceDate: date("invoice_date"),
  status: varchar("status", { length: 20 }).default('issued'),
  remark: text("remark"),
  direction: varchar("direction", { length: 20 }).notNull().default('sales'),
  arId: uuid("ar_id"),
  supplierId: uuid("supplier_id"),
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
]);

export const erpApWriteoff = pgTable("erp_ap_writeoff", {
  id: uuid("id").primaryKey().defaultRandom(),
  apId: uuid("ap_id"),
  paymentId: uuid("payment_id"),
  amount: numeric("amount").default('0'),
  writeoffDate: date("writeoff_date"),
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
]);

export const erpPayment = pgTable("erp_payment", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  apId: uuid("ap_id"),
  supplierId: uuid("supplier_id"),
  amount: numeric("amount").default('0'),
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
]);

export const erpArWriteoff = pgTable("erp_ar_writeoff", {
  id: uuid("id").primaryKey().defaultRandom(),
  arId: uuid("ar_id"),
  receiptId: uuid("receipt_id"),
  amount: numeric("amount").default('0'),
  writeoffDate: date("writeoff_date"),
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
]);

export const erpReceipt = pgTable("erp_receipt", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  customerId: uuid("customer_id"),
  amount: numeric("amount").default('0'),
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
  pm: varchar("pm", { length: 50 }),
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
  index("idx_project_embedding").using("hnsw", table.embedding),
]);

export const erpCalloff = pgTable("erp_calloff", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  contractId: uuid("contract_id"),
  seq: integer("seq").default(1),
  projectId: uuid("project_id"),
  amount: numeric("amount").default('0'),
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
  platformUserId: userProfile("platform_user_id"),
  supplierId: uuid("supplier_id"),
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
export const mdEmployeeTable = mdEmployee;
export const mdSupplierTable = mdSupplier;
export const purOrderTable = purOrder;
export const purRequestTable = purRequest;

export const sysUser = pgTable("sys_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: varchar("username", { length: 64 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }),
  displayName: varchar("display_name", { length: 100 }).notNull(),
  feishuOpenId: varchar("feishu_open_id", { length: 64 }).unique(),
  email: varchar("email", { length: 200 }),
  departmentName: varchar("department_name", { length: 100 }),
  status: varchar("status", { length: 20 }).notNull().default('active'),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
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
});

export const compStoredFile = pgTable("comp_stored_file", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  mime: varchar("mime", { length: 120 }),
  size: integer("size").notNull(),
  storagePath: varchar("storage_path", { length: 500 }).notNull(),
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
});

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

