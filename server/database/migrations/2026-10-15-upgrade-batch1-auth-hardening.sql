-- 批次一 / B-04：登录安全增强（MFA / 密码策略 / 登录失败锁定 / 设备管理）
-- requires: 2026-10-14-identity-brand-rbac.sql, 2026-10-13-security.sql
--
-- 目标：
--   ① 支持 TOTP 双因素认证（可按角色强制）；
--   ② 密码策略（最小长度、复杂度、90 天强制更换、不得与前 5 次相同）；
--   ③ 登录失败锁定（N 次后锁定 M 分钟，需管理员解锁）；
--   ④ 登录设备/会话管理（展示 IP、UA、时间，可远程下线）；
--   ⑤ 登录审计（成功/失败均留痕）。
--
-- 加密：mfa_secret_enc 用既有 `server/common/security/secret-box.ts`（AES-GCM，密钥来自环境变量）。

-- ---------- sys_user：MFA 与密码策略字段 ----------
ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS mfa_enabled integer NOT NULL DEFAULT 0;
-- TOTP 密钥（加密存储，禁止明文）
ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS mfa_secret_enc varchar(500);
-- 已确认绑定 MFA 的时间（未确认前不生效）
ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS mfa_bound_at timestamptz(3);
-- 最近一次修改密码时间，用于 90 天强制更换判定
ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS password_changed_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
-- 前 5 次密码 hash（JSON 数组字符串），用于"不得与前 5 次相同"
ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS password_history text NOT NULL DEFAULT '[]';
-- 登录失败计数与锁定截止时间
ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS locked_until timestamptz(3);
-- 是否需要强制修改密码（管理员重置或超期后置 1）
ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS must_change_password integer NOT NULL DEFAULT 0;
-- 管理员可对特定账号豁免强制 MFA（默认关闭，由角色策略决定）
ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS mfa_required_override integer;

-- ---------- sys_login_session：设备信息 ----------
ALTER TABLE sys_login_session ADD COLUMN IF NOT EXISTS ip varchar(64);
ALTER TABLE sys_login_session ADD COLUMN IF NOT EXISTS user_agent varchar(500);
ALTER TABLE sys_login_session ADD COLUMN IF NOT EXISTS device_label varchar(120);
-- 会话来源：password / feishu / mfa
ALTER TABLE sys_login_session ADD COLUMN IF NOT EXISTS auth_method varchar(20);

CREATE INDEX IF NOT EXISTS idx_sys_login_session_user_active
  ON sys_login_session (user_id, revoked_at, expires_at);

-- ---------- 登录审计表：成功/失败均留痕（B-04 ⑤ / NFR-S2） ----------
CREATE TABLE IF NOT EXISTS sys_login_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(128),
  user_id uuid,
  result varchar(20) NOT NULL,
  -- 失败原因：bad_credentials / locked / disabled / mfa_required / mfa_invalid / password_expired
  reason varchar(64),
  auth_method varchar(20),
  ip varchar(64),
  user_agent varchar(500),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sys_login_audit_created
  ON sys_login_audit (_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sys_login_audit_username
  ON sys_login_audit (username, _created_at DESC);

-- ---------- MFA 临时挑战票据（密码通过后、TOTP 校验前使用） ----------
-- 说明：不复用 sys_login_session，避免未完成 MFA 的会话被当作已登录态。
CREATE TABLE IF NOT EXISTS sys_mfa_challenge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash varchar(128) NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  consumed_at timestamptz(3),
  ip varchar(64),
  user_agent varchar(500),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_mfa_challenge_token
  ON sys_mfa_challenge (token_hash);
CREATE INDEX IF NOT EXISTS idx_sys_mfa_challenge_user
  ON sys_mfa_challenge (user_id, expires_at);

-- ---------- 恢复码（MFA 丢失设备时的应急入口，一次性） ----------
CREATE TABLE IF NOT EXISTS sys_mfa_recovery_code (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  code_hash varchar(128) NOT NULL,
  used_at timestamptz(3),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_mfa_recovery_code
  ON sys_mfa_recovery_code (code_hash);
CREATE INDEX IF NOT EXISTS idx_sys_mfa_recovery_user
  ON sys_mfa_recovery_code (user_id, used_at);

-- ---------- 兼容：已有账号的密码变更时间回填为账号创建时间 ----------
UPDATE sys_user
SET password_changed_at = coalesce(_created_at, CURRENT_TIMESTAMP)
WHERE password_changed_at IS NULL;
