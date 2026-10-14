-- F1 数据订正辅助：扫描「已作废回款」名下仍存在的核销关系，输出对账清单
-- 人工确认后再回滚应收 settled_amount / 删除或冲销 writeoff（本脚本只读，不改数）
-- 用法：psql $DATABASE_URL -f server/database/diagnostics/2026-10-14-audit-f1-voided-writeoff-report.sql
-- 注意：本文件不得放在 migrations/，否则 db-migrate 会当迁移执行而失败。

SELECT
  r.id AS receipt_id,
  r.code AS receipt_code,
  r.status AS receipt_status,
  r.amount AS receipt_amount,
  COALESCE(r.used_amount, 0) AS receipt_used_amount,
  w.id AS writeoff_id,
  w.amount AS writeoff_amount,
  w.writeoff_date,
  a.id AS ar_id,
  a.code AS ar_code,
  a.amount AS ar_amount,
  a.settled_amount AS ar_settled_amount,
  a.status AS ar_status,
  c.name AS customer_name
FROM erp_receipt r
JOIN erp_ar_writeoff w ON w.receipt_id = r.id
JOIN erp_ar a ON a.id = w.ar_id
LEFT JOIN md_customer c ON c.id = r.customer_id
WHERE r.status = 'voided'
ORDER BY r.code, w.writeoff_date;
