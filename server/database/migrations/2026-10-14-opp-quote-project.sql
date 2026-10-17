-- requires: 0000_baseline.sql（crm_opportunity / crm_quotation / erp_project 均为基线表）
-- 商机多轮报价 / 最终成交报价 / 项目关联成交报价

ALTER TABLE crm_quotation
  ADD COLUMN IF NOT EXISTS round_no integer;

ALTER TABLE crm_opportunity
  ADD COLUMN IF NOT EXISTS won_quotation_id uuid;

ALTER TABLE erp_project
  ADD COLUMN IF NOT EXISTS won_quotation_id uuid;

-- 回填轮次：按商机内创建时间排序
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY opportunity_id
      ORDER BY _created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM crm_quotation
  WHERE opportunity_id IS NOT NULL
)
UPDATE crm_quotation q
SET round_no = ranked.rn
FROM ranked
WHERE q.id = ranked.id
  AND (q.round_no IS NULL OR q.round_no <> ranked.rn);

CREATE INDEX IF NOT EXISTS idx_crm_opportunity_won_quotation
  ON crm_opportunity (won_quotation_id);

CREATE INDEX IF NOT EXISTS idx_erp_project_won_quotation
  ON erp_project (won_quotation_id);
