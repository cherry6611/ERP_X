-- R11：加外键之前先看孤儿。有行则先由业务确认，再 NOT VALID，最后才 VALIDATE。
-- 已有的 NOT VALID 约束见 2026-10-18-fix15-core-fks.sql，本文件不新增约束。

-- 工时 → 员工
SELECT t.id, t.employee_id
FROM erp_timesheet t
LEFT JOIN md_employee e ON e.id = t.employee_id
WHERE t.employee_id IS NOT NULL AND e.id IS NULL;

-- 成本 → 项目
SELECT c.id, c.project_id
FROM erp_project_cost c
LEFT JOIN erp_project p ON p.id = c.project_id
WHERE c.project_id IS NOT NULL AND p.id IS NULL;

-- 应收 → 合同
SELECT a.id, a.contract_id
FROM erp_ar a
LEFT JOIN erp_contract c ON c.id = a.contract_id
WHERE a.contract_id IS NOT NULL AND c.id IS NULL;

-- 应付 → 供应商
SELECT b.id, b.supplier_id
FROM erp_ap_bill b
LEFT JOIN md_supplier s ON s.id = b.supplier_id
WHERE b.supplier_id IS NOT NULL AND s.id IS NULL;

-- 凭证明细 → 科目
SELECT l.id, l.account_id
FROM fin_voucher_line l
LEFT JOIN fin_account a ON a.id = l.account_id
WHERE l.account_id IS NOT NULL AND a.id IS NULL;

-- 年假余额 → 员工
SELECT b.id, b.employee_id
FROM hr_leave_balance b
LEFT JOIN md_employee e ON e.id = b.employee_id
WHERE b.employee_id IS NOT NULL AND e.id IS NULL;
