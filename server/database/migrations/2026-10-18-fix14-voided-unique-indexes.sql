-- requires: 2026-10-17-fix13-contract-item-fk.sql
--
-- 修复「作废（软删除）与唯一索引互斥」。
--
-- ## 问题
--
-- `uq_erp_ar_source_ref` / `uq_erp_ap_bill_source_ref` /
-- `uq_erp_invoice_red_letter_source` 的 WHERE 谓词没有排除 `status='voided'`。
-- 业务作废只改状态、保留 source_ref，于是：
--   · 作废 AR 后用同一 source_ref 重建 → 唯一冲突 / 幂等查询返回已作废单；
--   · 作废红字票后重开 → 返回原已作废票；
--   · 外协结算作废后再生成 → 永久 409。
--
-- `uq_fin_voucher_source` 已经正确写成 `coalesce(status, '') <> 'voided'`，本迁移把另外
-- 三个索引对齐到同一口径。
--
-- ## 幂等
--
-- DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS。
-- 存量数据当前没有 voided 行；若某环境已有 voided 行，新索引仍可建立
-- （voided 行被谓词排除）。
--

DROP INDEX IF EXISTS uq_erp_ar_source_ref;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_ar_source_ref
  ON erp_ar (source_ref)
  WHERE source_ref IS NOT NULL AND coalesce(status, '') <> 'voided';

DROP INDEX IF EXISTS uq_erp_ap_bill_source_ref;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_ap_bill_source_ref
  ON erp_ap_bill (source_ref)
  WHERE source_ref IS NOT NULL AND coalesce(status, '') <> 'voided';

DROP INDEX IF EXISTS uq_erp_invoice_red_letter_source;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_invoice_red_letter_source
  ON erp_invoice (source_ref)
  WHERE amount < 0 AND source_ref IS NOT NULL AND coalesce(status, '') <> 'voided';
