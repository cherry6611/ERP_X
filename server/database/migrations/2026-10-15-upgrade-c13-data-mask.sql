-- 批次二 / C-13：数据资产脱敏等级与授权回收审计
-- requires: 2026-10-15-upgrade-batch3-core.sql
--
-- 背景：`da_dataset.mask_level` 在既有实现里只是自由字符串（前端可填任意值），
-- 没有任何地方真正按它脱敏；`da_grant` 的回收也不留痕，无法回答
-- "这条核心数据授权是谁回收的、有没有要求对方删副本"。
--
-- 本迁移做三件事：
-- 1. 把 mask_level 收敛为封闭枚举（L1~L4），历史值归一化；
-- 2. 新增授权回收审计表 da_grant_revoke_log（双人确认 + 销毁凭证）；
-- 3. 新增脱敏字段登记表 da_dataset_field（列名 → 字段语义，导出时据此脱敏）。
--
-- 【需合规确认】等级口径（见 server/modules/data-asset/mask-policy.ts）：
--   L1 公开：不含个人信息，可原样交付
--   L2 内部：联系方式/单位名称 → 掩码
--   L3 敏感：姓名/地址掩码，金额区间化
--   L4 核心：身份证号/完整银行账号/精确定位 → 禁止导出，回收需双人确认 + 销毁凭证

/* ========== ① mask_level 收敛为封闭枚举 ========== */

-- 历史值归一化（兼容 level2 / lv3 / 2 等写法）；未知值统一落到最严格的 L4
UPDATE da_dataset
SET mask_level = CASE
  WHEN upper(trim(mask_level)) IN ('L1','L2','L3','L4') THEN upper(trim(mask_level))
  WHEN upper(trim(mask_level)) ~ 'L?V?E?L?\s*2' THEN 'L2'
  WHEN upper(trim(mask_level)) ~ 'L?V?E?L?\s*3' THEN 'L3'
  WHEN upper(trim(mask_level)) ~ 'L?V?E?L?\s*4' THEN 'L4'
  WHEN upper(trim(mask_level)) ~ 'L?V?E?L?\s*1' THEN 'L1'
  ELSE 'L4'
END
WHERE mask_level IS NULL
   OR mask_level NOT IN ('L1','L2','L3','L4');

-- NULL 也必须是合法等级（否则前端下拉会显示空白，且脱敏逻辑无法判定）
UPDATE da_dataset SET mask_level = 'L4' WHERE mask_level IS NULL;

-- 默认值与 NOT NULL：新数据集必须显式选择等级
ALTER TABLE da_dataset ALTER COLUMN mask_level SET DEFAULT 'L4';
DO $$ BEGIN
  ALTER TABLE da_dataset ALTER COLUMN mask_level SET NOT NULL;
EXCEPTION WHEN others THEN
  -- 已有 NULL 时 SET NOT NULL 会失败；上面已归一化，正常不会走到这里
  RAISE NOTICE 'da_dataset.mask_level SET NOT NULL 跳过：%', SQLERRM;
END $$;

-- 枚举约束（幂等：先删后建）
DO $$ BEGIN
  ALTER TABLE da_dataset DROP CONSTRAINT IF EXISTS ck_da_dataset_mask_level;
  ALTER TABLE da_dataset
    ADD CONSTRAINT ck_da_dataset_mask_level
    CHECK (mask_level IN ('L1','L2','L3','L4'));
EXCEPTION WHEN others THEN
  RAISE NOTICE 'ck_da_dataset_mask_level 建立失败（可能存在非法值）：%', SQLERRM;
END $$;

/* ========== ② 脱敏字段登记：列名 → 字段语义 ========== */

CREATE TABLE IF NOT EXISTS da_dataset_field (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL,
  -- 导出文件/查询结果中的列名
  column_name varchar(100) NOT NULL,
  -- 字段语义：name/phone/email/id_card/bank_account/address/amount/location/other
  field_kind varchar(30) NOT NULL DEFAULT 'other',
  -- 中文说明（审计报告展示用）
  field_label varchar(100),
  remark varchar(500),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_da_dataset_field_column
  ON da_dataset_field (dataset_id, column_name);
CREATE INDEX IF NOT EXISTS idx_da_dataset_field_dataset
  ON da_dataset_field (dataset_id);

DO $$ BEGIN
  ALTER TABLE da_dataset_field
    ADD CONSTRAINT fk_da_dataset_field_dataset
    FOREIGN KEY (dataset_id) REFERENCES da_dataset(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE da_dataset_field
    ADD CONSTRAINT ck_da_dataset_field_kind
    CHECK (field_kind IN ('name','phone','email','id_card','bank_account','address','amount','location','other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

/* ========== ③ 授权回收审计 ========== */

CREATE TABLE IF NOT EXISTS da_grant_revoke_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL,
  -- 冗余快照：授权被回收后仍需能回答"当时授的是什么"
  grant_code varchar(20) NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_name varchar(200),
  -- 回收时的脱敏等级快照（等级可能在授权后被上调）
  mask_level varchar(4) NOT NULL DEFAULT 'L1',
  -- 回收原因：expired/manual/contract_terminated/violation/project_closed
  reason varchar(30) NOT NULL DEFAULT 'manual',
  -- 操作人与复核人（L4 要求两者不同）
  operator varchar(64) NOT NULL,
  reviewed_by varchar(64),
  -- 销毁凭证编号/说明（L4 与 violation 必填）
  destruction_proof varchar(500),
  remark varchar(1000),
  -- 回收是否要求对方销毁副本
  destroy_required integer NOT NULL DEFAULT 0,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE INDEX IF NOT EXISTS idx_da_grant_revoke_log_grant
  ON da_grant_revoke_log (grant_id);
CREATE INDEX IF NOT EXISTS idx_da_grant_revoke_log_dataset
  ON da_grant_revoke_log (dataset_id);
CREATE INDEX IF NOT EXISTS idx_da_grant_revoke_log_created
  ON da_grant_revoke_log (_created_at DESC);

DO $$ BEGIN
  ALTER TABLE da_grant_revoke_log
    ADD CONSTRAINT fk_da_grant_revoke_log_grant
    FOREIGN KEY (grant_id) REFERENCES da_grant(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE da_grant_revoke_log
    ADD CONSTRAINT ck_da_grant_revoke_log_reason
    CHECK (reason IN ('expired','manual','contract_terminated','violation','project_closed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- L4 核心数据必须双人确认 + 销毁凭证（数据库层兜底，避免绕过应用校验）
DO $$ BEGIN
  ALTER TABLE da_grant_revoke_log
    ADD CONSTRAINT ck_da_grant_revoke_log_l4_dual_control
    CHECK (
      mask_level <> 'L4'
      OR (reviewed_by IS NOT NULL AND reviewed_by <> operator AND destruction_proof IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 违规回收必须登记销毁凭证（任何等级）
DO $$ BEGIN
  ALTER TABLE da_grant_revoke_log
    ADD CONSTRAINT ck_da_grant_revoke_log_violation_proof
    CHECK (reason <> 'violation' OR destruction_proof IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 编号规则：授权回收单（GRL）
INSERT INTO sys_code_rule (biz_type, biz_name, prefix, date_pattern, seq_length, reset_policy, allow_reuse)
SELECT 'GRANT_REVOKE', '授权回收单', 'GRL', 'YYYYMM', 4, 'monthly', 0
WHERE NOT EXISTS (
  SELECT 1 FROM sys_code_rule WHERE prefix = 'GRL' OR biz_type = 'GRANT_REVOKE'
);
