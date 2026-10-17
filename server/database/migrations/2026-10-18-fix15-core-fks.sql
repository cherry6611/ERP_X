-- requires: 2026-10-18-fix14-voided-unique-indexes.sql
--
-- 补第一批核心外键（NOT VALID，先约束新写入，存量孤儿另行清理后再 VALIDATE）。
--
-- 背景：全库仅 12 个外键，178 个 `*_id` 列中 166 个无 FK；已实测
-- `hr_leave_balance` 260 行里 256 行的 employee_id 无对应员工，
-- `erp_timesheet` 也有 1 行孤儿。先给财务/人事主链补 FK，阻止新孤儿；
-- 存量孤儿**不在这里删除**（可能是真实数据，需业务确认后单独清理）。
--
-- NOT VALID 的语义：新写入/更新仍会校验，但不会因存量脏数据而阻塞上线；
-- 清理完成后用 `ALTER TABLE ... VALIDATE CONSTRAINT ...` 转正。
--
-- 幂等：每个约束先查 pg_constraint，再 ADD。
--

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_erp_timesheet_employee') THEN
    ALTER TABLE erp_timesheet
      ADD CONSTRAINT fk_erp_timesheet_employee
      FOREIGN KEY (employee_id) REFERENCES md_employee(id)
      ON DELETE SET NULL NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_erp_project_cost_project') THEN
    ALTER TABLE erp_project_cost
      ADD CONSTRAINT fk_erp_project_cost_project
      FOREIGN KEY (project_id) REFERENCES erp_project(id)
      ON DELETE SET NULL NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_erp_ar_contract') THEN
    ALTER TABLE erp_ar
      ADD CONSTRAINT fk_erp_ar_contract
      FOREIGN KEY (contract_id) REFERENCES erp_contract(id)
      ON DELETE SET NULL NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_erp_ap_bill_supplier') THEN
    ALTER TABLE erp_ap_bill
      ADD CONSTRAINT fk_erp_ap_bill_supplier
      FOREIGN KEY (supplier_id) REFERENCES md_supplier(id)
      ON DELETE SET NULL NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_voucher_line_account') THEN
    ALTER TABLE fin_voucher_line
      ADD CONSTRAINT fk_fin_voucher_line_account
      FOREIGN KEY (account_id) REFERENCES fin_account(id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_leave_balance_employee') THEN
    ALTER TABLE hr_leave_balance
      ADD CONSTRAINT fk_hr_leave_balance_employee
      FOREIGN KEY (employee_id) REFERENCES md_employee(id)
      ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
