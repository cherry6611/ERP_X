-- requires: 0000_baseline.sql（erp_ap_writeoff / erp_ar_writeoff / fin_voucher / hr_payroll / md_employee 均为基线表）
-- v2.5/v2.6 后期升级迁移
-- 审批回写增强 / 反核销 / 跨期红冲 / 反结账审计 / 工资城市规则

-- ---- 反核销：核销行可冲回 ----
ALTER TABLE erp_ar_writeoff
  ADD COLUMN IF NOT EXISTS reversal_of uuid;
ALTER TABLE erp_ar_writeoff
  ADD COLUMN IF NOT EXISTS remark varchar(500);

ALTER TABLE erp_ap_writeoff
  ADD COLUMN IF NOT EXISTS reversal_of uuid;
ALTER TABLE erp_ap_writeoff
  ADD COLUMN IF NOT EXISTS remark varchar(500);

CREATE INDEX IF NOT EXISTS idx_erp_ar_writeoff_reversal
  ON erp_ar_writeoff (reversal_of);
CREATE INDEX IF NOT EXISTS idx_erp_ap_writeoff_reversal
  ON erp_ap_writeoff (reversal_of);

-- ---- 凭证跨期红冲标记 ----
ALTER TABLE fin_voucher
  ADD COLUMN IF NOT EXISTS cross_period integer NOT NULL DEFAULT 0;
ALTER TABLE fin_voucher
  ADD COLUMN IF NOT EXISTS cross_period_reason varchar(500);
ALTER TABLE fin_voucher
  ADD COLUMN IF NOT EXISTS cross_period_approver varchar(64);

-- ---- 工资城市社保规则 ----
CREATE TABLE IF NOT EXISTS hr_ss_city_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_code varchar(32) NOT NULL,
  city_name varchar(64) NOT NULL,
  effective_from varchar(7) NOT NULL,
  effective_to varchar(7),
  pension_emp numeric NOT NULL DEFAULT 8,
  pension_co numeric NOT NULL DEFAULT 16,
  medical_emp numeric NOT NULL DEFAULT 2,
  medical_co numeric NOT NULL DEFAULT 8,
  unemployment_emp numeric NOT NULL DEFAULT 0.5,
  unemployment_co numeric NOT NULL DEFAULT 0.5,
  housing_emp numeric NOT NULL DEFAULT 12,
  housing_co numeric NOT NULL DEFAULT 12,
  base_min numeric NOT NULL DEFAULT 0,
  base_max numeric NOT NULL DEFAULT 999999,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_ss_city_rule_city_from
  ON hr_ss_city_rule (city_code, effective_from);

ALTER TABLE md_employee
  ADD COLUMN IF NOT EXISTS ss_city_code varchar(32);
ALTER TABLE md_employee
  ADD COLUMN IF NOT EXISTS ss_base numeric;

ALTER TABLE hr_payroll
  ADD COLUMN IF NOT EXISTS manual_override integer NOT NULL DEFAULT 0;
ALTER TABLE hr_payroll
  ADD COLUMN IF NOT EXISTS engine_snapshot text;

-- ---- 期间反结账审计（删除行前可留痕，表本身仍用 fin_period_close）----
CREATE TABLE IF NOT EXISTS fin_period_close_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period varchar(7) NOT NULL,
  action varchar(20) NOT NULL,
  actor_user_id varchar(64),
  remark varchar(500),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
