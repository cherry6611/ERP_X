-- 飞书深度集成。先于更换 SECRET_ENC_KEY 执行：本文件只加列和索引，不解密旧密文。
-- 更换主密钥之前，运维应先跑 scripts/clear-feishu-secrets.sql，否则 enc1 密文无法还原。

ALTER TABLE "md_employee" ADD COLUMN IF NOT EXISTS "email" varchar(200);
ALTER TABLE "md_employee" ADD COLUMN IF NOT EXISTS "remark" text;
ALTER TABLE "md_employee" ADD COLUMN IF NOT EXISTS "feishu_union_id" varchar(64);
ALTER TABLE "md_employee" ADD COLUMN IF NOT EXISTS "feishu_open_id" varchar(64);
ALTER TABLE "md_employee" ADD COLUMN IF NOT EXISTS "feishu_department_id" varchar(64);
ALTER TABLE "md_employee" ADD COLUMN IF NOT EXISTS "avatar_url" varchar(500);
ALTER TABLE "md_employee" ADD COLUMN IF NOT EXISTS "synced_at" timestamptz(3);

ALTER TABLE "sys_user" ADD COLUMN IF NOT EXISTS "feishu_union_id" varchar(64);
ALTER TABLE "sys_user" ADD COLUMN IF NOT EXISTS "mobile" varchar(30);
ALTER TABLE "sys_user" ADD COLUMN IF NOT EXISTS "avatar_url" varchar(500);
ALTER TABLE "sys_user" ADD COLUMN IF NOT EXISTS "department_id" uuid;
ALTER TABLE "sys_user" ADD COLUMN IF NOT EXISTS "employee_id" uuid;
ALTER TABLE "sys_user" ADD COLUMN IF NOT EXISTS "auth_type" varchar(20) NOT NULL DEFAULT 'local';
ALTER TABLE "sys_user" ADD COLUMN IF NOT EXISTS "last_login_at" timestamptz(3);
ALTER TABLE "sys_user" ADD COLUMN IF NOT EXISTS "synced_at" timestamptz(3);
ALTER TABLE "sys_user" ADD COLUMN IF NOT EXISTS "_updated_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "sys_department" ADD COLUMN IF NOT EXISTS "parent_id" uuid;
ALTER TABLE "sys_department" ADD COLUMN IF NOT EXISTS "code" varchar(64);
ALTER TABLE "sys_department" ADD COLUMN IF NOT EXISTS "feishu_department_id" varchar(64);
ALTER TABLE "sys_department" ADD COLUMN IF NOT EXISTS "feishu_parent_id" varchar(64);
ALTER TABLE "sys_department" ADD COLUMN IF NOT EXISTS "leader_user_id" uuid;
ALTER TABLE "sys_department" ADD COLUMN IF NOT EXISTS "sort_order" integer NOT NULL DEFAULT 0;
ALTER TABLE "sys_department" ADD COLUMN IF NOT EXISTS "status" varchar(20) NOT NULL DEFAULT 'active';
ALTER TABLE "sys_department" ADD COLUMN IF NOT EXISTS "synced_at" timestamptz(3);

ALTER TABLE "comp_feishu_drive_config" ADD COLUMN IF NOT EXISTS "app_secret_prev" varchar(512);
ALTER TABLE "comp_feishu_drive_config" ADD COLUMN IF NOT EXISTS "secret_key_version" integer NOT NULL DEFAULT 1;
ALTER TABLE "comp_feishu_drive_config" ADD COLUMN IF NOT EXISTS "secret_prev_version" integer;

ALTER TABLE "comp_feishu_sync_record" ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "comp_feishu_sync_record" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamptz(3);
ALTER TABLE "comp_feishu_sync_record" ADD COLUMN IF NOT EXISTS "last_error" text;

CREATE TABLE IF NOT EXISTS "sys_login_session" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "jti" varchar(64) NOT NULL,
  "refresh_token_enc" text,
  "expires_at" timestamptz(3) NOT NULL,
  "revoked_at" timestamptz(3),
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "sys_feishu_sync_state" (
  "id" varchar(64) PRIMARY KEY,
  "cursor" varchar(200),
  "full_synced_at" timestamptz(3),
  "incremental_synced_at" timestamptz(3)
);

CREATE TABLE IF NOT EXISTS "sys_feishu_sync_conflict" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "union_id" varchar(64),
  "reason" varchar(40) NOT NULL,
  "payload" text,
  "status" varchar(20) NOT NULL DEFAULT 'open',
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "sys_feishu_event" (
  "event_id" varchar(128) PRIMARY KEY,
  "event_type" varchar(80),
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "comp_feishu_bitable_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "biz_type" varchar(40) NOT NULL,
  "app_token" varchar(128) NOT NULL,
  "table_id" varchar(128) NOT NULL,
  "enabled" integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS "comp_feishu_approval" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "biz_type" varchar(40) NOT NULL,
  "biz_code" varchar(64) NOT NULL,
  "instance_code" varchar(128),
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "_created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_sys_user_username" ON "sys_user" ("username");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sys_user_feishu_open_id" ON "sys_user" ("feishu_open_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sys_user_feishu_union_id" ON "sys_user" ("feishu_union_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sys_user_employee" ON "sys_user" ("employee_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sys_login_session_jti" ON "sys_login_session" ("jti");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_md_employee_feishu_union_id" ON "md_employee" ("feishu_union_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_md_employee_platform_user" ON "md_employee" ((("platform_user_id")."user_id")) WHERE ("platform_user_id")."user_id" IS NOT NULL AND ("platform_user_id")."user_id" <> '';
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sys_department_feishu_id" ON "sys_department" ("feishu_department_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sys_role_member" ON "sys_role_member" ("role_code", "user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_comp_feishu_drive_config_single" ON "comp_feishu_drive_config" ((true));
CREATE UNIQUE INDEX IF NOT EXISTS "uq_comp_feishu_bitable_biz" ON "comp_feishu_bitable_config" ("biz_type");
CREATE INDEX IF NOT EXISTS "idx_sys_login_session_user" ON "sys_login_session" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_feishu_sync_retry" ON "comp_feishu_sync_record" ("status", "next_retry_at");
