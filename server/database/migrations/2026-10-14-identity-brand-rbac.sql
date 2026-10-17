-- requires: 0000_baseline.sql（sys_role 为基线表）；本迁移自建 sys_feishu_bind_invite
-- P0：身份管理邀请表、品牌配置、Bitable field_map
CREATE TABLE IF NOT EXISTS sys_feishu_bind_invite (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token varchar(64) NOT NULL UNIQUE,
  target_user_id uuid NOT NULL,
  created_by uuid NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  consumed_at timestamptz(3),
  revoked_at timestamptz(3),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sys_feishu_bind_invite_target ON sys_feishu_bind_invite (target_user_id);

CREATE TABLE IF NOT EXISTS sys_brand_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_name varchar(100) NOT NULL DEFAULT '晟笙 ERP',
  logo_file_id uuid,
  favicon_file_id uuid,
  updated_by varchar(64),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE comp_feishu_bitable_config
  ADD COLUMN IF NOT EXISTS field_map text;

INSERT INTO sys_role (code, name) VALUES ('user_admin', '用户管理员')
ON CONFLICT (code) DO NOTHING;
