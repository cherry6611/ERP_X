-- §6 账务数据订正探查（只读）。用法：
--   psql $DATABASE_URL -f server/database/diagnostics/2026-10-14-finance-data-correction-probes.sql
-- 订正前必须完成备份与恢复演练（F5），并在维护窗口停写。

-- 1) 0 税额已批工资单
SELECT id, employee_id, period,
       (base_salary::numeric + coalesce(perf_salary,0) + coalesce(allowance,0)) AS gross,
       net_salary
FROM hr_payroll
WHERE coalesce(social_insurance,0) = 0
  AND coalesce(housing_fund,0) = 0
  AND coalesce(tax,0) = 0
  AND status = 'approved'
ORDER BY period, employee_id;

-- 2) 超额核销（回款）
SELECT r.id, r.code, r.amount,
       SUM(w.amount::numeric) AS written
FROM erp_receipt r
JOIN erp_ar_writeoff w ON w.receipt_id = r.id
GROUP BY r.id, r.code, r.amount
HAVING SUM(w.amount::numeric) > r.amount::numeric + 0.001
ORDER BY r.code;

-- 3) 重复应付（按 source_ref / source+code）
SELECT source_ref, count(*) AS cnt
FROM erp_ap_bill
WHERE source_ref IS NOT NULL
GROUP BY source_ref
HAVING count(*) > 1;

SELECT source, code, count(*) AS cnt
FROM erp_ap_bill
GROUP BY source, code
HAVING count(*) > 1;

-- 4) dead 凭证补偿任务
SELECT source_type, source_ref, count(*) AS cnt
FROM comp_voucher_job
WHERE status = 'dead'
GROUP BY source_type, source_ref
ORDER BY cnt DESC;

-- 5) 设备验收疑似双计（资产 + 进项费用凭证）
SELECT a.code AS asset_code, o.code AS order_code, o.amount
FROM ast_asset a
JOIN pur_order o ON a.purchase_order_id = o.id
WHERE EXISTS (
  SELECT 1 FROM fin_voucher v
  WHERE v.source_ref = 'ap:' || o.code
     OR v.source_ref LIKE 'ap:%' || o.code || '%'
);

-- 试算平衡（按期间）
SELECT v.period,
       SUM(l.debit::numeric) - SUM(l.credit::numeric) AS diff
FROM fin_voucher_line l
JOIN fin_voucher v ON v.id = l.voucher_id
WHERE coalesce(v.status, '') <> 'voided'
GROUP BY v.period
HAVING SUM(l.debit::numeric) <> SUM(l.credit::numeric)
ORDER BY v.period;
