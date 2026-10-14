from pathlib import Path

p = Path("server/database/schema.ts")
s = p.read_text(encoding="utf-8")

if "crossPeriod:" not in s:
    needle = "  status: varchar(\"status\", { length: 20 }).default('draft'),\n  remark: text(\"remark\"),\n  // System field: Creation time (auto-filled, do not modify)\n  createdAt: customTimestamptz(\"_created_at\", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),\n  // System field: Creator (auto-filled, do not modify)\n  createdBy: userProfile(\"_created_by\").default(sql`CASE\n    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),\n  // System field: Update time (auto-filled, do not modify)\n  updatedAt: customTimestamptz(\"_updated_at\", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),\n  // System field: Updater (auto-filled, do not modify)\n  updatedBy: userProfile(\"_updated_by\").default(sql`CASE\n    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),\n}, (table) => [\n  uniqueIndex(\"fin_voucher_code_key\").on(table.code),"
    repl = "  status: varchar(\"status\", { length: 20 }).default('draft'),\n  crossPeriod: integer(\"cross_period\").notNull().default(0),\n  crossPeriodReason: varchar(\"cross_period_reason\", { length: 500 }),\n  crossPeriodApprover: varchar(\"cross_period_approver\", { length: 64 }),\n  remark: text(\"remark\"),\n  // System field: Creation time (auto-filled, do not modify)\n  createdAt: customTimestamptz(\"_created_at\", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),\n  // System field: Creator (auto-filled, do not modify)\n  createdBy: userProfile(\"_created_by\").default(sql`CASE\n    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),\n  // System field: Update time (auto-filled, do not modify)\n  updatedAt: customTimestamptz(\"_updated_at\", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),\n  // System field: Updater (auto-filled, do not modify)\n  updatedBy: userProfile(\"_updated_by\").default(sql`CASE\n    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),\n}, (table) => [\n  uniqueIndex(\"fin_voucher_code_key\").on(table.code),"
    if needle not in s:
        raise SystemExit("finVoucher needle missing")
    s = s.replace(needle, repl, 1)
    print("finVoucher ok")

if "manualOverride:" not in s:
    s = s.replace(
        "  allocationGenerated: boolean(\"allocation_generated\").default(false),",
        "  allocationGenerated: boolean(\"allocation_generated\").default(false),\n  manualOverride: integer(\"manual_override\").notNull().default(0),\n  engineSnapshot: text(\"engine_snapshot\"),",
        1,
    )
    print("payroll ok")

if "ssCityCode:" not in s:
    s = s.replace(
        "  supplierId: uuid(\"supplier_id\"),",
        "  supplierId: uuid(\"supplier_id\"),\n  ssCityCode: varchar(\"ss_city_code\", { length: 32 }),\n  ssBase: numeric(\"ss_base\"),",
        1,
    )
    print("employee ok")

if "hrSsCityRule" not in s:
    insert = '''
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

'''
    s = s.replace("export const sysUser = pgTable", insert + "export const sysUser = pgTable", 1)
    print("tables ok")

p.write_text(s, encoding="utf-8")
print("done")
