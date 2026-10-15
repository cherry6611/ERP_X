-- 批次一复盘（第三轮深修）P0-2 / P2-7
-- requires: 2026-10-15-upgrade-batch1z-voucher-tax-entity.sql
--
-- ## P0-2：历史「无主体」自动凭证回填
--
-- `2026-10-15-upgrade-batch1z-voucher-tax-entity.sql` 补了 `fin_voucher.tax_entity_id`
-- 列，但两档回填对**自动凭证完全无效**：
--   ① 它只在 `source_type = 'contract'` 时按 sourceRef 找合同 —— 而代码里自动凭证用的
--      source_type 是 revenue / ar / ap / cost / invoice / payment / payroll …，
--      没有任何调用点写 'contract'；
--   ② 默认主体档要求"库中恰有一个 is_default 主体"，多主体的账套直接落到 NULL。
-- 结果是这些凭证在按主体出具的报表里**全部消失**（既不在 A 主体，也不在 B 主体），
-- 但总额法与未按主体过滤的查询又看得到 → 两份报表对不上，且没有任何显式提示。
--
-- 本迁移按「业务单据 → 合同 → 主体」把**可推导**的历史凭证补齐；推导不出的
-- （工资、折旧、摊销等公司级凭证）走单一默认主体；仍无法归属的保持 NULL，
-- 由自检视图 `v_fin_voucher_unassigned_entity` 显式暴露，绝不硬塞。
--
-- ## P2-7：幂等索引对作废凭证失效
--
-- 原 `uq_fin_voucher_source` 是 `(source_type, source_ref)` 上的部分唯一索引。
-- 一张凭证被作废（status='voided'）后，同一单据再次触发时：
--   - 钩子的存在性检查看到的是"已存在"（旧实现没排除 voided）→ 直接返回 created，
--     **新凭证永远不会生成**，形成"有业务无凭证"；
--   - 即便绕过检查去 INSERT，也会撞唯一索引报 23505，被吞成 created。
-- 现把索引谓词改为排除 voided：作废凭证不再占用幂等位，重开业务可重新出凭证。

/* ========== P0-2 ① 收入类：revenue / revenue-reverse / revenue-adjust ========== */

UPDATE fin_voucher v
SET tax_entity_id = c.tax_entity_id
FROM erp_project_revenue r
JOIN erp_contract c ON c.id = r.contract_id
WHERE v.tax_entity_id IS NULL
  AND v.source_type = 'revenue'
  AND split_part(v.source_ref, ':', 2) = r.code
  AND c.tax_entity_id IS NOT NULL;

/* ========== P0-2 ② 应收类：ar ========== */

UPDATE fin_voucher v
SET tax_entity_id = c.tax_entity_id
FROM erp_ar a
JOIN erp_contract c ON c.id = a.contract_id
WHERE v.tax_entity_id IS NULL
  AND v.source_type = 'ar'
  AND split_part(v.source_ref, ':', 2) = a.code
  AND c.tax_entity_id IS NOT NULL;

/* ========== P0-2 ③ 成本类：cost（含公共成本分摊产生的成本单） ========== */

UPDATE fin_voucher v
SET tax_entity_id = c.tax_entity_id
FROM erp_project_cost pc
JOIN erp_contract c ON c.id = pc.contract_id
WHERE v.tax_entity_id IS NULL
  AND v.source_type = 'cost'
  AND split_part(v.source_ref, ':', 2) = pc.code
  AND c.tax_entity_id IS NOT NULL;

/* ========== P0-2 ④ 发票类：invoice（发票自身就带主体） ========== */

UPDATE fin_voucher v
SET tax_entity_id = i.tax_entity_id
FROM erp_invoice i
WHERE v.tax_entity_id IS NULL
  AND v.source_type = 'invoice'
  AND (split_part(v.source_ref, ':', 2) = i.invoice_no
       OR split_part(v.source_ref, ':', 2) = i.code)
  AND i.tax_entity_id IS NOT NULL;

/* ========== P0-2 ⑤ 应付/付款类：ap / payment → 供应商档案的主体 ========== */

UPDATE fin_voucher v
SET tax_entity_id = s.tax_entity_id
FROM erp_ap_bill b
JOIN md_supplier s ON s.id = b.supplier_id
WHERE v.tax_entity_id IS NULL
  AND v.source_type = 'ap'
  AND split_part(v.source_ref, ':', 2) = b.code
  AND s.tax_entity_id IS NOT NULL;

UPDATE fin_voucher v
SET tax_entity_id = s.tax_entity_id
FROM erp_payment p
JOIN md_supplier s ON s.id = p.supplier_id
WHERE v.tax_entity_id IS NULL
  AND v.source_type = 'payment'
  AND split_part(v.source_ref, ':', 2) = p.code
  AND s.tax_entity_id IS NOT NULL;

/* ========== P0-2 ⑥ 兜底：仍为空且库中恰有一个启用中的默认主体 ========== */

UPDATE fin_voucher
SET tax_entity_id = (
  SELECT id FROM md_tax_entity WHERE is_default = 1 AND status = 'active' LIMIT 1
)
WHERE tax_entity_id IS NULL
  AND (SELECT count(*) FROM md_tax_entity WHERE is_default = 1 AND status = 'active') = 1;

/* ========== P2-7 幂等索引排除已作废凭证 ========== */

DROP INDEX IF EXISTS uq_fin_voucher_source;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_voucher_source
  ON fin_voucher (source_type, source_ref)
  WHERE source_type IS NOT NULL
    AND source_ref IS NOT NULL
    AND status <> 'voided';

COMMENT ON INDEX uq_fin_voucher_source IS
  'P2-7：同一业务单据只允许存在一张**未作废**凭证。作废凭证不占用幂等位，'
  '使"作废后重新触发业务"能重新出凭证，而不是被静默判为已生成。';

/* ========== 自检视图：按来源类型统计仍无法归属主体的凭证 ========== */

-- 先 DROP 再建：新版本多出 source_type 列且列序不同，CREATE OR REPLACE 会报
-- "cannot change name of view column"，必须重建。
DROP VIEW IF EXISTS v_fin_voucher_unassigned_entity;

CREATE VIEW v_fin_voucher_unassigned_entity AS
SELECT v.period,
       coalesce(v.source_type, '(manual)') AS source_type,
       count(*)::int AS voucher_count,
       coalesce(sum(l.debit), 0) AS total_debit
FROM fin_voucher v
LEFT JOIN fin_voucher_line l ON l.voucher_id = v.id
WHERE v.tax_entity_id IS NULL
  AND v.status <> 'voided'
GROUP BY v.period, coalesce(v.source_type, '(manual)')
ORDER BY v.period, source_type;

COMMENT ON VIEW v_fin_voucher_unassigned_entity IS
  'A-01/A-06 自检：按期间 + 来源类型统计未归属纳税主体的凭证。'
  '这些凭证不会出现在任何主体的报表中，需补主体或确认是否应归属默认主体。';
