-- 批次一 / A-07：个税累计预扣预缴——专项附加扣除登记 + 工资单累计字段
-- requires: 2026-10-14-upgrade-v25-v26.sql (hr_payroll), 0000_baseline.sql
--
-- 背景：原实现按"当月查旧月度税率表"简化计算（payroll-engine.ts 自述），
-- 年中税额系统性偏差，存在少扣税款风险。本迁移为累计预扣预缴法补齐数据基础：
--   ① 专项附加扣除按员工 × 年度 × 类型按月登记（子女教育/继续教育/大病医疗/
--      住房贷款利息/住房租金/赡养老人/3 岁以下婴幼儿照护）；
--   ② hr_payroll 增加累计口径字段，便于逐月递推与审计复核。

CREATE TABLE IF NOT EXISTS hr_employee_tax_deduction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL,
  tax_year integer NOT NULL,
  -- child_education / continuing_education / medical / housing_loan /
  -- housing_rent / elderly_support / infant_care
  deduction_type varchar(32) NOT NULL,
  -- 每月扣除金额（元）
  monthly_amount numeric NOT NULL DEFAULT 0,
  -- 生效起止月份（1-12），end_month 为空表示至年末
  start_month integer NOT NULL DEFAULT 1,
  end_month integer,
  remark varchar(200),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_emp_tax_deduction
  ON hr_employee_tax_deduction (employee_id, tax_year, deduction_type);
CREATE INDEX IF NOT EXISTS idx_hr_emp_tax_deduction_year
  ON hr_employee_tax_deduction (tax_year, employee_id);

DO $$ BEGIN
  ALTER TABLE hr_employee_tax_deduction
    ADD CONSTRAINT chk_hr_tax_deduction_type
    CHECK (deduction_type IN (
      'child_education', 'continuing_education', 'medical',
      'housing_loan', 'housing_rent', 'elderly_support', 'infant_care'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE hr_employee_tax_deduction
    ADD CONSTRAINT chk_hr_tax_deduction_amount
    CHECK (monthly_amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE hr_employee_tax_deduction
    ADD CONSTRAINT chk_hr_tax_deduction_months
    CHECK (start_month >= 1 AND start_month <= 12
      AND (end_month IS NULL OR (end_month >= start_month AND end_month <= 12)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 工资单累计字段（A-07 要求逐月递推与审计）
ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS ytd_income numeric NOT NULL DEFAULT 0;
ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS ytd_tax_free_income numeric NOT NULL DEFAULT 0;
ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS ytd_basic_deduction numeric NOT NULL DEFAULT 0;
ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS ytd_deduction numeric NOT NULL DEFAULT 0;
ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS ytd_additional_deduction numeric NOT NULL DEFAULT 0;
ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS ytd_tax_withheld numeric NOT NULL DEFAULT 0;
ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS ytd_taxable_income numeric NOT NULL DEFAULT 0;
ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS tax_rate numeric;
ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS quick_deduction numeric;
ALTER TABLE hr_payroll ADD COLUMN IF NOT EXISTS ytd_net numeric NOT NULL DEFAULT 0;
