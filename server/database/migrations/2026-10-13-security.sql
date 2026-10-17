-- requires: 0000_baseline.sql（comp_feishu_drive_config / hr_attendance_amendment 均为基线表）
-- 2026-10-13 安全与一致性整改。在业务库执行一次。
-- 未执行时：编号生成回退为 count()+1；凭证失败只记日志；补卡 submitted_by 写不进去但不阻断。

CREATE TABLE IF NOT EXISTS comp_biz_code_seq (
  month_key varchar(32) PRIMARY KEY,
  last_seq integer NOT NULL
);

CREATE TABLE IF NOT EXISTS comp_voucher_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type varchar(32) NOT NULL,
  source_ref varchar(120) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'failed',
  last_error text,
  payload text,
  attempts integer NOT NULL DEFAULT 1,
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_comp_voucher_job_source
  ON comp_voucher_job (source_type, source_ref);

ALTER TABLE comp_feishu_drive_config
  ALTER COLUMN app_secret TYPE varchar(512);

ALTER TABLE comp_feishu_drive_config
  ADD COLUMN IF NOT EXISTS secret_rotated_at timestamptz;

ALTER TABLE comp_feishu_drive_config
  ADD COLUMN IF NOT EXISTS secret_rotated_by varchar(64);

ALTER TABLE hr_attendance_amendment
  ADD COLUMN IF NOT EXISTS submitted_by varchar(64);
