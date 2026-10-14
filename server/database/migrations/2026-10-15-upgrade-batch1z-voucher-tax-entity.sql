-- 批次一 A-01/A-06 修复：fin_voucher 缺 tax_entity_id 导致按纳税主体过滤全部 500
-- requires: 2026-10-15-upgrade-batch1-accounting-base.sql
--
-- ## 问题（P0，实测复现）
--
-- `ledgers.service.ts` / `reports.service.ts` / `vat-declaration.service.ts` /
-- `aux-combination.service.ts` 的 SQL 都含
-- `AND v.tax_entity_id = ${taxEntityId}::uuid`，
-- 但 `fin_voucher` **从来没有这一列**（实测库结构确认）。
-- 结果是：只要调用方传了 `taxEntityId`，PostgreSQL 立即报
-- `column v.tax_entity_id does not exist`，接口 500。受影响范围：
--   - A-01 资产负债表（按纳税主体出具）
--   - A-02 利润表 / 现金流量表
--   - A-03 账簿（科目余额表 / 总账 / 明细账 / 辅助余额）
--   - A-06 增值税申报底稿
--   - D-03 辅助核算组合
--
-- 为什么 CI 没拦住：pglite 的 `migrate:dryrun` 与迁移链集成测试**只执行 DDL**，
-- 从不执行这些业务 SQL；而现有集成测试都未传 `taxEntityId`。
-- 这是"迁移通过 ≠ 功能可用"的典型反面教材，教训已记入台账。
--
-- ## 口径（**需财务确认**）
--
-- `fin_voucher.tax_entity_id` = **该凭证归属的纳税主体**。
-- 数据服务场景下大部分凭证来自合同，因此回填优先级：
--   ① `erp_contract.tax_entity_id`（合同已注明主体）
--   ② `md_tax_entity.is_default = 1` 的默认主体（系统恰有一个默认主体时；该列为 integer 标志位，不是 boolean）
-- 回填不上的保持 NULL，报表按主体过滤时这些凭证**不会出现在任何主体下** ——
-- 这是刻意的：把凭证硬塞进默认主体会让该主体的报表虚增，
-- 而 NULL 会让"未归属"显式暴露出来（可由下面的自检查询发现）。

/* ========== ① 补列 ========== */

ALTER TABLE fin_voucher
  ADD COLUMN IF NOT EXISTS tax_entity_id uuid;

DO $$ BEGIN
  ALTER TABLE fin_voucher
    ADD CONSTRAINT fk_fin_voucher_tax_entity
    FOREIGN KEY (tax_entity_id) REFERENCES md_tax_entity(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN fin_voucher.tax_entity_id IS
  'A-01/A-06：凭证归属的纳税主体。报表/底稿按主体出具时依赖本列；'
  'NULL 表示尚未归属（不会计入任何主体的报表，需在凭证上补主体）。';

CREATE INDEX IF NOT EXISTS idx_fin_voucher_tax_entity_period
  ON fin_voucher (tax_entity_id, period);

/* ========== ② 从合同回填 ========== */

-- 合同类凭证：source_type='contract' 时 source_ref 存合同编号
UPDATE fin_voucher v
SET tax_entity_id = c.tax_entity_id
FROM erp_contract c
WHERE v.tax_entity_id IS NULL
  AND c.tax_entity_id IS NOT NULL
  AND (
    (v.source_type = 'contract' AND v.source_ref = c.code)
    -- 兼容按 id 存 source_ref 的实现
    OR (v.source_type = 'contract' AND v.source_ref = c.id::text)
  );

/* ========== ③ 用默认主体兜底 ========== */

-- 仅在「系统恰有一个默认主体」时兜底：多主体下用默认主体顶替会让该主体报表虚增，
-- 属于比"未归属"更糟的错误（错误数字看起来是对的）。
UPDATE fin_voucher v
SET tax_entity_id = e.id
FROM md_tax_entity e
WHERE v.tax_entity_id IS NULL
  AND e.is_default = 1
  AND e.status = 'active'
  AND (SELECT count(*) FROM md_tax_entity WHERE is_default = 1 AND status = 'active') = 1;

/* ========== ④ 未归属凭证自检视图 ========== */

-- 供运维核对"还有多少凭证没归属主体"。用视图而不是日志，
-- 因为它需要在任意时刻可查（回填后仍可能有新增的未归属凭证）。
CREATE OR REPLACE VIEW v_fin_voucher_unassigned_entity AS
SELECT v.period,
       count(*)::int AS voucher_count,
       coalesce(sum(l.debit), 0) AS total_debit
FROM fin_voucher v
LEFT JOIN fin_voucher_line l ON l.voucher_id = v.id
WHERE v.tax_entity_id IS NULL
  AND v.status <> 'voided'
GROUP BY v.period
ORDER BY v.period;

COMMENT ON VIEW v_fin_voucher_unassigned_entity IS
  'A-01/A-06 自检：按期间统计未归属纳税主体的凭证数与借方合计。'
  '这些凭证不会出现在任何主体的报表中，需补主体或确认是否应归属默认主体。';
