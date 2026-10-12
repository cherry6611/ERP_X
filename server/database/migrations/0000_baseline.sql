-- 独立部署基线。由 scripts/emit-baseline.ts 根据 schema.ts 生成。
CREATE TYPE user_profile AS (user_id varchar, user_name varchar);
CREATE TYPE file_attachment AS (bucket_id varchar, file_path varchar);

CREATE TABLE IF NOT EXISTS "ast_asset" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "name" varchar(200) NOT NULL,
  "category" varchar(20) DEFAULT 'other',
  "original_value" numeric DEFAULT '0',
  "residual_value" numeric DEFAULT '0',
  "net_value" numeric DEFAULT '0',
  "department_id" uuid,
  "project_id" uuid,
  "purchase_order_id" uuid,
  "purchase_date" date,
  "useful_months" integer DEFAULT 36,
  "status" varchar(20) DEFAULT 'in_use',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "ast_change" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "asset_id" uuid,
  "change_type" varchar(20) DEFAULT 'receive',
  "before_value" varchar(200),
  "after_value" varchar(200),
  "status" varchar(20) DEFAULT 'pending',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "ast_depreciation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_id" uuid,
  "period" varchar(7),
  "amount" numeric DEFAULT '0',
  "cost_generated" boolean DEFAULT false,
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "comp_attachment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "resource_type" varchar(100) NOT NULL,
  "resource_id" uuid NOT NULL,
  "file_name" varchar(255) NOT NULL,
  "file_url" text NOT NULL,
  "file_size" bigint NOT NULL DEFAULT 0,
  "source_type" varchar(20) NOT NULL DEFAULT 'upload',
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "comp_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor" varchar(100),
  "action" varchar(20),
  "object_type" varchar(50),
  "object_id" varchar(64),
  "object_code" varchar(50),
  "status_before" varchar(30),
  "status_after" varchar(30),
  "detail" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "comp_automation_config" (
  "task_key" varchar(100) PRIMARY KEY,
  "task_name" varchar(200) NOT NULL,
  "description" varchar(500),
  "enabled" boolean NOT NULL DEFAULT true,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "comp_biz_code_seq" (
  "month_key" varchar(32) PRIMARY KEY,
  "last_seq" integer NOT NULL
);

CREATE TABLE IF NOT EXISTS "comp_feishu_drive_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "app_id" varchar(255) NOT NULL,
  "app_secret" varchar(512) NOT NULL,
  "secret_rotated_at" timestamptz(3),
  "secret_rotated_by" varchar(64),
  "root_folder_token" varchar(255) NOT NULL,
  "wiki_space_id" varchar(255) NOT NULL,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "comp_feishu_sync_record" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "direction" varchar(20) NOT NULL,
  "biz_type" varchar(30) NOT NULL,
  "biz_id" uuid,
  "biz_code" varchar(50),
  "base_record_id" varchar(64),
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "error_msg" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "comp_project_drive_sync" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL,
  "kind" varchar(20) NOT NULL DEFAULT 'file',
  "attachment_id" uuid,
  "folder_token" varchar(255),
  "drive_file_token" varchar(255),
  "file_name" varchar(255) NOT NULL,
  "sync_status" varchar(32) NOT NULL DEFAULT 'synced',
  "remark" varchar(500),
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "comp_stored_file" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "file_name" varchar(255) NOT NULL,
  "mime" varchar(120),
  "size" integer NOT NULL,
  "storage_path" varchar(500) NOT NULL,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "comp_voucher_job" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_type" varchar(32) NOT NULL,
  "source_ref" varchar(120) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'failed',
  "last_error" text,
  "payload" text,
  "attempts" integer NOT NULL DEFAULT 1,
  "next_retry_at" timestamptz(3),
  "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "crm_contact" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" uuid,
  "name" varchar(50) NOT NULL,
  "phone" varchar(30),
  "email" varchar(100),
  "position" varchar(50),
  "is_primary" boolean DEFAULT false,
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "crm_lead" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "customer_name" varchar(200) NOT NULL,
  "source" varchar(50),
  "contact_name" varchar(50),
  "contact_phone" varchar(30),
  "status" varchar(20) DEFAULT 'new',
  "owner" varchar(50),
  "follow_note" text,
  "next_date" date,
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "crm_opportunity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "customer_id" uuid,
  "title" varchar(200) NOT NULL,
  "stage" varchar(20) DEFAULT 'new',
  "amount" numeric DEFAULT '0',
  "win_rate" integer DEFAULT 0,
  "owner" varchar(50),
  "expected_date" date,
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "crm_quotation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "customer_id" uuid NOT NULL,
  "opportunity_id" uuid,
  "title" varchar(200) NOT NULL,
  "quote_date" date,
  "valid_until" date,
  "status" varchar(20) NOT NULL DEFAULT 'draft',
  "discount_pct" numeric NOT NULL DEFAULT '0',
  "total_amount" numeric NOT NULL DEFAULT '0',
  "estimated_cost" numeric NOT NULL DEFAULT '0',
  "remark" text,
  "contract_id" uuid,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "crm_quotation_item" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quotation_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "item_name" varchar(200) NOT NULL,
  "unit" varchar(20) NOT NULL DEFAULT '人天',
  "quantity" numeric NOT NULL DEFAULT '1',
  "unit_price" numeric NOT NULL DEFAULT '0',
  "discount_pct" numeric NOT NULL DEFAULT '0',
  "est_unit_cost" numeric NOT NULL DEFAULT '0',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "da_dataset" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "name" varchar(200) NOT NULL,
  "source" varchar(200),
  "mask_level" varchar(20) DEFAULT 'L1',
  "contract_id" uuid,
  "status" varchar(20) DEFAULT 'active',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "da_grant" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "dataset_id" uuid,
  "customer_id" uuid,
  "project_id" uuid,
  "scope" varchar(500),
  "start_date" date,
  "end_date" date,
  "status" varchar(20) DEFAULT 'active',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_admin_affair" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(50) NOT NULL,
  "affair_type" varchar(20) NOT NULL,
  "title" varchar(200) NOT NULL,
  "participants" jsonb,
  "start_date" date NOT NULL,
  "end_date" date,
  "amount" numeric,
  "status" varchar(20) NOT NULL DEFAULT 'registered',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_admin_asset" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(50) NOT NULL,
  "name" varchar(200) NOT NULL,
  "category" varchar(30) NOT NULL,
  "quantity" integer NOT NULL DEFAULT 1,
  "unit_price" numeric NOT NULL,
  "amount" numeric,
  "location" varchar(100),
  "owner" user_profile,
  "purchase_date" date,
  "status" varchar(20) NOT NULL DEFAULT 'in_use',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_admin_bill" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(50) NOT NULL,
  "title" varchar(200) NOT NULL,
  "bill_type" varchar(30) NOT NULL,
  "amount" numeric NOT NULL,
  "period" varchar(10) NOT NULL,
  "payee" varchar(100),
  "expense_date" date NOT NULL,
  "rent_contract_id" uuid,
  "status" varchar(20) NOT NULL DEFAULT 'draft',
  "pay_date" date,
  "pay_method" varchar(50),
  "approve_remark" text,
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_admin_rent_contract" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(50) NOT NULL,
  "name" varchar(200) NOT NULL,
  "property_address" varchar(255) NOT NULL,
  "lessor" varchar(100) NOT NULL,
  "monthly_rent" numeric NOT NULL,
  "deposit" numeric,
  "area" numeric,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "payment_cycle" varchar(20) NOT NULL DEFAULT 'monthly',
  "status" varchar(20) NOT NULL DEFAULT 'draft',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_ap_bill" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "supplier_id" uuid,
  "project_id" uuid,
  "amount" numeric DEFAULT '0',
  "paid_amount" numeric DEFAULT '0',
  "due_date" date,
  "status" varchar(20) DEFAULT 'pending',
  "source" varchar(20) DEFAULT 'manual',
  "remark" text,
  "source_ref" varchar(100),
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_ap_writeoff" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ap_id" uuid,
  "payment_id" uuid,
  "amount" numeric DEFAULT '0',
  "writeoff_date" date,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_ar" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "contract_id" uuid,
  "customer_id" uuid,
  "project_id" uuid,
  "amount" numeric DEFAULT '0',
  "settled_amount" numeric DEFAULT '0',
  "due_date" date,
  "status" varchar(20) DEFAULT 'open',
  "source" varchar(20) DEFAULT 'manual',
  "remark" text,
  "owner_user_id" varchar(50),
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_ar_writeoff" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ar_id" uuid,
  "receipt_id" uuid,
  "amount" numeric DEFAULT '0',
  "writeoff_date" date,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_calloff" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "contract_id" uuid,
  "seq" integer DEFAULT 1,
  "project_id" uuid,
  "amount" numeric DEFAULT '0',
  "order_date" date,
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_contract" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "name" varchar(200) NOT NULL,
  "customer_id" uuid,
  "billing_model" varchar(20) DEFAULT 'project',
  "amount" numeric DEFAULT '0',
  "tax_rate" numeric DEFAULT '6',
  "status" varchar(20) DEFAULT 'draft',
  "sign_date" date,
  "start_date" date,
  "end_date" date,
  "owner" varchar(50),
  "payment_terms" varchar(200),
  "remark" text,
  "embedding" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_contract_milestone" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "contract_id" uuid,
  "name" varchar(200) NOT NULL,
  "amount" numeric DEFAULT '0',
  "due_condition" varchar(500),
  "due_date" date,
  "status" varchar(20) DEFAULT 'pending',
  "actual_date" date,
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_contract_version" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "contract_id" uuid,
  "version_no" integer DEFAULT 1,
  "change_log" text,
  "change_amount" numeric DEFAULT '0',
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_cost_allocation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "source_desc" varchar(200),
  "cost_type" varchar(20) DEFAULT 'compute',
  "amount" numeric DEFAULT '0',
  "target_project_id" uuid,
  "period" varchar(7),
  "source_ref" varchar(100),
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_deliverable" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "project_id" uuid NOT NULL,
  "name" varchar(200) NOT NULL,
  "deliverable_type" varchar(20) NOT NULL DEFAULT 'dataset',
  "acceptance_criteria" text,
  "due_date" date,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "reviewer" varchar(50),
  "submitted_at" date,
  "accepted_at" date,
  "returned_reason" text,
  "remark" text,
  "accept_conclusion" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_invoice" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "contract_id" uuid,
  "customer_id" uuid,
  "project_id" uuid,
  "invoice_no" varchar(50),
  "invoice_type" varchar(20) DEFAULT 'vat_special',
  "amount" numeric DEFAULT '0',
  "tax_rate" numeric DEFAULT '6',
  "tax_amount" numeric DEFAULT '0',
  "invoice_date" date,
  "status" varchar(20) DEFAULT 'issued',
  "remark" text,
  "direction" varchar(20) NOT NULL DEFAULT 'sales',
  "ar_id" uuid,
  "supplier_id" uuid,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_labor_rate" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "role_name" varchar(50) NOT NULL,
  "rate" numeric DEFAULT '0',
  "effective_from" date,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_payment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "ap_id" uuid,
  "supplier_id" uuid,
  "amount" numeric DEFAULT '0',
  "pay_date" date,
  "method" varchar(20) DEFAULT 'bank',
  "status" varchar(20) DEFAULT 'pending',
  "approver" varchar(50),
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_project" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "name" varchar(200) NOT NULL,
  "contract_id" uuid,
  "pm" varchar(50),
  "dept_name" varchar(100),
  "budget" numeric DEFAULT '0',
  "start_date" date,
  "end_date" date,
  "progress" integer DEFAULT 0,
  "status" varchar(20) DEFAULT 'initiating',
  "remark" text,
  "embedding" text,
  "estimated_total_cost" numeric NOT NULL DEFAULT '0',
  "close_summary" text,
  "satisfaction" integer,
  "retrospective" text,
  "closed_at" date,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_project_change" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "project_id" uuid,
  "change_type" varchar(20) DEFAULT 'scope',
  "content" text,
  "before_value" varchar(100),
  "after_value" varchar(100),
  "status" varchar(20) DEFAULT 'pending',
  "applicant" varchar(50),
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_project_cost" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "project_id" uuid,
  "cost_type" varchar(20) DEFAULT 'labor',
  "amount" numeric DEFAULT '0',
  "period" varchar(7),
  "occurred_date" date,
  "source_ref" varchar(100),
  "supplier_id" uuid,
  "remark" text,
  "department_id" uuid,
  "contract_id" uuid,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_project_milestone" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid,
  "name" varchar(200) NOT NULL,
  "plan_date" date,
  "actual_date" date,
  "status" varchar(20) DEFAULT 'pending',
  "remark" text,
  "baseline_date" date,
  "forecast_date" date,
  "weight_pct" numeric NOT NULL DEFAULT '0',
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_project_minutes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL,
  "title" varchar(100) NOT NULL,
  "minutes_type" varchar(20) NOT NULL,
  "meeting_date" date NOT NULL,
  "content" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_project_revenue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "project_id" uuid,
  "contract_id" uuid,
  "period" varchar(7),
  "method" varchar(20) DEFAULT 'progress',
  "amount" numeric DEFAULT '0',
  "basis" varchar(500),
  "status" varchar(20) DEFAULT 'recognized',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_receipt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "customer_id" uuid,
  "amount" numeric DEFAULT '0',
  "receipt_date" date,
  "method" varchar(20) DEFAULT 'bank',
  "source" varchar(100),
  "status" varchar(20) DEFAULT 'unmatched',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_revenue_adjust" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "revenue_id" uuid,
  "adjust_type" varchar(20) DEFAULT 'discount',
  "amount" numeric DEFAULT '0',
  "reason" varchar(500),
  "status" varchar(20) DEFAULT 'applied',
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "erp_timesheet" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "project_id" uuid,
  "employee_name" varchar(50),
  "role_name" varchar(50),
  "work_date" date,
  "hours" numeric DEFAULT '0',
  "status" varchar(20) DEFAULT 'draft',
  "cost_generated" boolean DEFAULT false,
  "remark" text,
  "employee_id" uuid,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "fin_account" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "name" varchar(100) NOT NULL,
  "account_type" varchar(20) DEFAULT 'asset',
  "status" varchar(20) DEFAULT 'active',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "fin_budget" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "department_id" uuid,
  "project_id" uuid,
  "expense_category" varchar(50),
  "period" varchar(7),
  "budget_amount" numeric DEFAULT '0',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "fin_expense_apply" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "apply_type" varchar(20) DEFAULT 'travel',
  "title" varchar(200) NOT NULL,
  "department_id" uuid,
  "project_id" uuid,
  "expense_category" varchar(50),
  "amount" numeric DEFAULT '0',
  "expect_date" date,
  "status" varchar(20) DEFAULT 'pending',
  "reason" varchar(500),
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "fin_expense_claim" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "apply_id" uuid,
  "department_id" uuid,
  "project_id" uuid,
  "expense_category" varchar(50),
  "amount" numeric DEFAULT '0',
  "expense_date" date,
  "applicant" varchar(50),
  "status" varchar(20) DEFAULT 'pending',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "fin_period_close" (
  "period" varchar(7) PRIMARY KEY,
  "closed_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "fin_voucher" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "voucher_date" date,
  "period" varchar(7),
  "summary" varchar(200),
  "source_type" varchar(20),
  "source_ref" varchar(100),
  "status" varchar(20) DEFAULT 'draft',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "fin_voucher_line" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "voucher_id" uuid,
  "account_id" uuid,
  "summary" varchar(200),
  "debit" numeric DEFAULT '0',
  "credit" numeric DEFAULT '0',
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "hr_appraisal" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "employee_id" uuid,
  "period" varchar(10),
  "score" numeric DEFAULT '0',
  "grade" varchar(2),
  "status" varchar(20) DEFAULT 'draft',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "hr_attendance" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_id" uuid,
  "work_date" date,
  "status" varchar(20) DEFAULT 'present',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "hr_attendance_amendment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "employee_id" uuid,
  "work_date" date NOT NULL,
  "reason" varchar(500) NOT NULL,
  "submitted_by" varchar(64),
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "hr_candidate" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "recruit_req_id" uuid,
  "name" varchar(50) NOT NULL,
  "phone" varchar(30),
  "stage" varchar(20) DEFAULT 'pending',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "hr_department" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "name" varchar(100) NOT NULL,
  "parent_id" uuid,
  "status" varchar(20) DEFAULT 'active',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "hr_leave_balance" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_id" uuid,
  "leave_type" varchar(20) DEFAULT 'annual',
  "year" varchar(4),
  "total_days" numeric DEFAULT '0',
  "used_days" numeric DEFAULT '0',
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "hr_leave_request" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "employee_id" uuid,
  "leave_type" varchar(20) DEFAULT 'annual',
  "start_date" date,
  "end_date" date,
  "days" numeric DEFAULT '0',
  "reason" varchar(500),
  "status" varchar(20) DEFAULT 'pending',
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "hr_payroll" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "employee_id" uuid,
  "period" varchar(7),
  "base_salary" numeric DEFAULT '0',
  "perf_salary" numeric DEFAULT '0',
  "allowance" numeric DEFAULT '0',
  "social_insurance" numeric DEFAULT '0',
  "housing_fund" numeric DEFAULT '0',
  "tax" numeric DEFAULT '0',
  "net_salary" numeric DEFAULT '0',
  "status" varchar(20) DEFAULT 'draft',
  "remark" text,
  "allocation_generated" boolean DEFAULT false,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "hr_position" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "name" varchar(100) NOT NULL,
  "role_name" varchar(50),
  "status" varchar(20) DEFAULT 'active',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "hr_recruit_req" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "department_id" uuid,
  "title" varchar(200) NOT NULL,
  "headcount" integer DEFAULT 1,
  "status" varchar(20) DEFAULT 'open',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "hr_training" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "name" varchar(200) NOT NULL,
  "trainer" varchar(50),
  "hours" numeric DEFAULT '0',
  "start_date" date,
  "end_date" date,
  "status" varchar(20) DEFAULT 'planned',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "hr_training_record" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "training_id" uuid,
  "employee_id" uuid,
  "status" varchar(20) DEFAULT 'attended',
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "md_customer" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "name" varchar(200) NOT NULL,
  "uscc" varchar(50),
  "industry" varchar(100),
  "credit_level" varchar(20),
  "credit_limit" numeric DEFAULT '0',
  "terms_days" integer DEFAULT 30,
  "status" varchar(20) DEFAULT 'active',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "md_employee" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "name" varchar(50) NOT NULL,
  "org_name" varchar(100),
  "position" varchar(100),
  "status" varchar(20) DEFAULT 'active',
  "department_id" uuid,
  "position_id" uuid,
  "hire_date" date,
  "employment_type" varchar(20) DEFAULT 'full_time',
  "phone" varchar(30),
  "resign_date" date,
  "platform_user_id" user_profile,
  "supplier_id" uuid,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "md_supplier" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "name" varchar(200) NOT NULL,
  "type" varchar(50),
  "contact_name" varchar(50),
  "contact_phone" varchar(30),
  "bank_account" varchar(100),
  "rating" numeric DEFAULT '0',
  "status" varchar(20) DEFAULT 'active',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "pur_order" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "request_id" uuid,
  "contract_id" uuid,
  "supplier_id" uuid,
  "project_id" uuid,
  "item_name" varchar(200) NOT NULL,
  "category" varchar(20) DEFAULT 'service',
  "quantity" integer DEFAULT 1,
  "unit_price" numeric DEFAULT '0',
  "amount" numeric DEFAULT '0',
  "order_date" date,
  "accepted_quantity" integer DEFAULT 0,
  "accept_date" date,
  "status" varchar(20) DEFAULT 'pending',
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "pur_request" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" varchar(20) NOT NULL,
  "title" varchar(200) NOT NULL,
  "request_type" varchar(20) DEFAULT 'service',
  "department_id" uuid,
  "project_id" uuid,
  "supplier_id" uuid,
  "amount" numeric DEFAULT '0',
  "expect_date" date,
  "status" varchar(20) DEFAULT 'pending',
  "reason" varchar(500),
  "remark" text,
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_created_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "_updated_by" user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE TABLE IF NOT EXISTS "sys_department" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(100) NOT NULL
);

CREATE TABLE IF NOT EXISTS "sys_role" (
  "code" varchar(64) PRIMARY KEY,
  "name" varchar(100) NOT NULL
);

CREATE TABLE IF NOT EXISTS "sys_role_member" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "role_code" varchar(64) NOT NULL,
  "user_id" varchar(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS "sys_user" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "username" varchar(64) NOT NULL,
  "password_hash" varchar(255),
  "display_name" varchar(100) NOT NULL,
  "feishu_open_id" varchar(64),
  "email" varchar(200),
  "department_name" varchar(100),
  "status" varchar(20) NOT NULL DEFAULT 'active',
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "ast_asset_code_key" ON "ast_asset" ("code");
CREATE INDEX IF NOT EXISTS "idx_ast_asset_status" ON "ast_asset" ("status");
CREATE INDEX IF NOT EXISTS "idx_ast_asset_category" ON "ast_asset" ("category");
CREATE INDEX IF NOT EXISTS "idx_ast_asset_project" ON "ast_asset" ("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ast_change_code_key" ON "ast_change" ("code");
CREATE INDEX IF NOT EXISTS "idx_ast_change_asset" ON "ast_change" ("asset_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ast_depreciation_asset_period" ON "ast_depreciation" ("asset_id", "period");
CREATE INDEX IF NOT EXISTS "idx_ast_depreciation_period" ON "ast_depreciation" ("period");
CREATE INDEX IF NOT EXISTS "idx_comp_attachment_resource" ON "comp_attachment" ("resource_type", "resource_id");
CREATE INDEX IF NOT EXISTS "idx_comp_audit_log_object" ON "comp_audit_log" ("object_type");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sync_out_biz" ON "comp_feishu_sync_record" ("biz_type", "biz_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sync_in_rec" ON "comp_feishu_sync_record" ("base_record_id");
CREATE INDEX IF NOT EXISTS "idx_sync_record_status" ON "comp_feishu_sync_record" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_drive_sync_attachment" ON "comp_project_drive_sync" ("attachment_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_drive_sync_archive" ON "comp_project_drive_sync" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_project_drive_sync_project" ON "comp_project_drive_sync" ("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_comp_voucher_job_source" ON "comp_voucher_job" ("source_type", "source_ref");
CREATE INDEX IF NOT EXISTS "idx_crm_contact_customer" ON "crm_contact" ("customer_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_crm_lead_code" ON "crm_lead" ("code");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_crm_opportunity_code" ON "crm_opportunity" ("code");
CREATE INDEX IF NOT EXISTS "idx_crm_opportunity_customer" ON "crm_opportunity" ("customer_id");
CREATE UNIQUE INDEX IF NOT EXISTS "crm_quotation_code_key" ON "crm_quotation" ("code");
CREATE INDEX IF NOT EXISTS "idx_crm_quotation_opportunity" ON "crm_quotation" ("opportunity_id");
CREATE INDEX IF NOT EXISTS "idx_crm_quotation_customer" ON "crm_quotation" ("customer_id");
CREATE INDEX IF NOT EXISTS "idx_crm_quotation_item_quotation" ON "crm_quotation_item" ("quotation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "da_dataset_code_key" ON "da_dataset" ("code");
CREATE INDEX IF NOT EXISTS "idx_da_dataset_status" ON "da_dataset" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "da_grant_code_key" ON "da_grant" ("code");
CREATE INDEX IF NOT EXISTS "idx_da_grant_dataset" ON "da_grant" ("dataset_id");
CREATE INDEX IF NOT EXISTS "idx_da_grant_project" ON "da_grant" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_da_grant_status" ON "da_grant" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_admin_affair_code" ON "erp_admin_affair" ("code");
CREATE INDEX IF NOT EXISTS "idx_admin_affair_status" ON "erp_admin_affair" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_admin_asset_code" ON "erp_admin_asset" ("code");
CREATE INDEX IF NOT EXISTS "idx_admin_asset_status" ON "erp_admin_asset" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_admin_bill_code" ON "erp_admin_bill" ("code");
CREATE INDEX IF NOT EXISTS "idx_admin_bill_status" ON "erp_admin_bill" ("status");
CREATE INDEX IF NOT EXISTS "idx_admin_bill_period" ON "erp_admin_bill" ("period");
CREATE INDEX IF NOT EXISTS "idx_admin_bill_rent_contract" ON "erp_admin_bill" ("rent_contract_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_admin_rent_contract_code" ON "erp_admin_rent_contract" ("code");
CREATE INDEX IF NOT EXISTS "idx_admin_rent_contract_status" ON "erp_admin_rent_contract" ("status");
CREATE INDEX IF NOT EXISTS "idx_admin_rent_contract_end_date" ON "erp_admin_rent_contract" ("end_date");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_ap_bill_code" ON "erp_ap_bill" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_ap_bill_supplier" ON "erp_ap_bill" ("supplier_id");
CREATE INDEX IF NOT EXISTS "idx_erp_ap_writeoff_ap" ON "erp_ap_writeoff" ("ap_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_ar_code" ON "erp_ar" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_ar_customer" ON "erp_ar" ("customer_id");
CREATE INDEX IF NOT EXISTS "idx_erp_ar_contract" ON "erp_ar" ("contract_id");
CREATE INDEX IF NOT EXISTS "idx_erp_ar_writeoff_ar" ON "erp_ar_writeoff" ("ar_id");
CREATE INDEX IF NOT EXISTS "idx_erp_ar_writeoff_receipt" ON "erp_ar_writeoff" ("receipt_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_calloff_code" ON "erp_calloff" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_calloff_contract" ON "erp_calloff" ("contract_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_contract_code" ON "erp_contract" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_contract_customer" ON "erp_contract" ("customer_id");
CREATE INDEX IF NOT EXISTS "idx_contract_embedding" ON "erp_contract" ("embedding");
CREATE INDEX IF NOT EXISTS "idx_erp_contract_milestone_contract" ON "erp_contract_milestone" ("contract_id");
CREATE INDEX IF NOT EXISTS "idx_erp_contract_version_contract" ON "erp_contract_version" ("contract_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_cost_allocation_code" ON "erp_cost_allocation" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_cost_allocation_project" ON "erp_cost_allocation" ("target_project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_erp_deliverable_code" ON "erp_deliverable" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_deliverable_project" ON "erp_deliverable" ("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_invoice_code" ON "erp_invoice" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_invoice_contract" ON "erp_invoice" ("contract_id");
CREATE INDEX IF NOT EXISTS "idx_erp_invoice_project" ON "erp_invoice" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_erp_labor_rate_role" ON "erp_labor_rate" ("role_name");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_payment_code" ON "erp_payment" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_payment_ap" ON "erp_payment" ("ap_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_project_code" ON "erp_project" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_project_contract" ON "erp_project" ("contract_id");
CREATE INDEX IF NOT EXISTS "idx_project_embedding" ON "erp_project" ("embedding");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_project_change_code" ON "erp_project_change" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_project_change_project" ON "erp_project_change" ("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_project_cost_code" ON "erp_project_cost" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_project_cost_project" ON "erp_project_cost" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_erp_project_cost_period" ON "erp_project_cost" ("period");
CREATE INDEX IF NOT EXISTS "idx_erp_project_cost_department" ON "erp_project_cost" ("department_id");
CREATE INDEX IF NOT EXISTS "idx_erp_project_cost_contract" ON "erp_project_cost" ("contract_id");
CREATE INDEX IF NOT EXISTS "idx_erp_project_milestone_project" ON "erp_project_milestone" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_erp_minutes_project" ON "erp_project_minutes" ("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_project_revenue_code" ON "erp_project_revenue" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_project_revenue_project" ON "erp_project_revenue" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_erp_project_revenue_period" ON "erp_project_revenue" ("period");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_receipt_code" ON "erp_receipt" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_receipt_customer" ON "erp_receipt" ("customer_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_revenue_adjust_code" ON "erp_revenue_adjust" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_revenue_adjust_revenue" ON "erp_revenue_adjust" ("revenue_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_erp_timesheet_code" ON "erp_timesheet" ("code");
CREATE INDEX IF NOT EXISTS "idx_erp_timesheet_project" ON "erp_timesheet" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_erp_timesheet_employee" ON "erp_timesheet" ("employee_id");
CREATE UNIQUE INDEX IF NOT EXISTS "fin_account_code_key" ON "fin_account" ("code");
CREATE UNIQUE INDEX IF NOT EXISTS "fin_budget_code_key" ON "fin_budget" ("code");
CREATE INDEX IF NOT EXISTS "idx_fin_budget_period" ON "fin_budget" ("period");
CREATE INDEX IF NOT EXISTS "idx_fin_budget_project" ON "fin_budget" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_fin_budget_department" ON "fin_budget" ("department_id");
CREATE UNIQUE INDEX IF NOT EXISTS "fin_expense_apply_code_key" ON "fin_expense_apply" ("code");
CREATE INDEX IF NOT EXISTS "idx_fin_expense_apply_project" ON "fin_expense_apply" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_fin_expense_apply_status" ON "fin_expense_apply" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "fin_expense_claim_code_key" ON "fin_expense_claim" ("code");
CREATE INDEX IF NOT EXISTS "idx_fin_expense_claim_project" ON "fin_expense_claim" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_fin_expense_claim_status" ON "fin_expense_claim" ("status");
CREATE INDEX IF NOT EXISTS "idx_fin_expense_claim_apply" ON "fin_expense_claim" ("apply_id");
CREATE UNIQUE INDEX IF NOT EXISTS "fin_voucher_code_key" ON "fin_voucher" ("code");
CREATE INDEX IF NOT EXISTS "idx_fin_voucher_period" ON "fin_voucher" ("period");
CREATE INDEX IF NOT EXISTS "idx_fin_voucher_status" ON "fin_voucher" ("status");
CREATE INDEX IF NOT EXISTS "idx_fin_voucher_line_voucher" ON "fin_voucher_line" ("voucher_id");
CREATE INDEX IF NOT EXISTS "idx_fin_voucher_line_account" ON "fin_voucher_line" ("account_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_appraisal_code" ON "hr_appraisal" ("code");
CREATE INDEX IF NOT EXISTS "idx_hr_appraisal_employee" ON "hr_appraisal" ("employee_id");
CREATE INDEX IF NOT EXISTS "idx_hr_attendance_employee" ON "hr_attendance" ("employee_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_attendance_emp_date" ON "hr_attendance" ("employee_id", "work_date");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_attendance_amendment_code" ON "hr_attendance_amendment" ("code");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_attendance_amendment_emp_date" ON "hr_attendance_amendment" ("employee_id", "work_date");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_candidate_code" ON "hr_candidate" ("code");
CREATE INDEX IF NOT EXISTS "idx_hr_candidate_req" ON "hr_candidate" ("recruit_req_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_department_code" ON "hr_department" ("code");
CREATE INDEX IF NOT EXISTS "idx_hr_leave_balance_employee" ON "hr_leave_balance" ("employee_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_leave_balance_emp_type_year" ON "hr_leave_balance" ("employee_id", "leave_type", "year");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_leave_request_code" ON "hr_leave_request" ("code");
CREATE INDEX IF NOT EXISTS "idx_hr_leave_request_employee" ON "hr_leave_request" ("employee_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_payroll_code" ON "hr_payroll" ("code");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_payroll_emp_period" ON "hr_payroll" ("employee_id", "period");
CREATE INDEX IF NOT EXISTS "idx_hr_payroll_period" ON "hr_payroll" ("period");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_position_code" ON "hr_position" ("code");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_recruit_req_code" ON "hr_recruit_req" ("code");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_training_code" ON "hr_training" ("code");
CREATE INDEX IF NOT EXISTS "idx_hr_training_record_training" ON "hr_training_record" ("training_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_training_record_emp" ON "hr_training_record" ("training_id", "employee_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_md_customer_code" ON "md_customer" ("code");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_md_employee_code" ON "md_employee" ("code");
CREATE INDEX IF NOT EXISTS "idx_md_employee_department" ON "md_employee" ("department_id");
CREATE INDEX IF NOT EXISTS "idx_md_employee_position" ON "md_employee" ("position_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_md_supplier_code" ON "md_supplier" ("code");
CREATE UNIQUE INDEX IF NOT EXISTS "pur_order_code_key" ON "pur_order" ("code");
CREATE INDEX IF NOT EXISTS "idx_pur_order_status" ON "pur_order" ("status");
CREATE INDEX IF NOT EXISTS "idx_pur_order_supplier" ON "pur_order" ("supplier_id");
CREATE INDEX IF NOT EXISTS "idx_pur_order_contract" ON "pur_order" ("contract_id");
CREATE INDEX IF NOT EXISTS "idx_pur_order_project" ON "pur_order" ("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pur_request_code_key" ON "pur_request" ("code");
CREATE INDEX IF NOT EXISTS "idx_pur_request_status" ON "pur_request" ("status");
CREATE INDEX IF NOT EXISTS "idx_pur_request_project" ON "pur_request" ("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sys_role_member" ON "sys_role_member" ("role_code", "user_id");

INSERT INTO sys_role (code, name) VALUES
  ('admin', '管理员'),
  ('finance_viewer', '财务查看'),
  ('hr_manager', '人事经理'),
  ('drive_editor', '云盘编辑'),
  ('project_manager', '项目经理')
ON CONFLICT (code) DO NOTHING;
