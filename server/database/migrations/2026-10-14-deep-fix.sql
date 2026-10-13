-- 深度检查配套迁移（v2）。
-- 文件名刻意排在所有 2026-10-13-* 之后：本文件依赖 2026-10-13-tax-final.sql
-- 建的 md_tax_entity / erp_contract_item / fin_account 与各税率列，
-- 排序靠前会导致整文件失败（42P01 / 42703）。
--
-- 内容：
--   M-07  成本预提字段（is_accrual / offset_of，类型与 schema.ts 对齐为 integer）
--   M-06  ⚠️ 只做诊断告警，不做自动作废：开票凭证 source_ref(`invoice:<单号>`) 与
--         收入凭证(`revenue:<单号>`) 无可关联业务主键，旧实现用无条件关联的 EXISTS
--         会把「全库所有」销项凭证作废（批量错账），已改为人工核对后按 id 处理。
--   修复  合同明细序号：先重排去重再建唯一索引（避免 23505 让整个迁移回滚）
--   修复  补齐 fin_account 科目 2211 / 6602 / 1602 / 1002（工资/报销/折旧凭证必需）
--   修复  越界税率收敛前先告警留痕；客户/供应商默认税率置 NULL 而非强改 6

-- ---- 结构：成本预提字段 ----
-- 注意：类型与 server/database/schema.ts 保持一致（integer），否则 drizzle-kit 会反复生成改类型语句
ALTER TABLE erp_project_cost
  ADD COLUMN IF NOT EXISTS is_accrual integer NOT NULL DEFAULT 0;
ALTER TABLE erp_project_cost
  ADD COLUMN IF NOT EXISTS offset_of uuid;

CREATE INDEX IF NOT EXISTS idx_erp_project_cost_accrual
  ON erp_project_cost (period, project_id, is_accrual);

-- ---- 科目补齐（缺失会导致工资/报销/折旧凭证进入失败队列）----
INSERT INTO fin_account (code, name, account_type, status)
SELECT v.code, v.name, v.account_type, 'active'
FROM (VALUES
  ('1602', '累计折旧',     'asset'),
  ('2211', '应付职工薪酬', 'liability'),
  ('6602', '管理费用',     'expense'),
  ('1002', '银行存款—一般户', 'asset')
) AS v(code, name, account_type)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

-- ---- 清洗越界税率（先告警留痕，再收敛到 6）----
DO $$ DECLARE bad int; BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT tax_rate FROM erp_contract      WHERE tax_rate IS NOT NULL AND tax_rate NOT IN (0,1,3,6,9,13)
    UNION ALL SELECT tax_rate FROM erp_invoice WHERE tax_rate IS NOT NULL AND tax_rate NOT IN (0,1,3,6,9,13)
  ) t;
  IF bad > 0 THEN
    RAISE WARNING '存在 % 行越界税率，已按 6%% 收敛，请人工复核历史单据', bad;
  END IF;
END $$;

UPDATE erp_contract
SET tax_rate = 6
WHERE tax_rate IS NOT NULL AND tax_rate NOT IN (0, 1, 3, 6, 9, 13);

UPDATE erp_invoice
SET tax_rate = 6
WHERE tax_rate IS NOT NULL AND tax_rate NOT IN (0, 1, 3, 6, 9, 13);

UPDATE erp_contract_item
SET tax_rate = 6
WHERE tax_rate IS NOT NULL AND tax_rate NOT IN (0, 1, 3, 6, 9, 13);

UPDATE md_customer
SET default_tax_rate = NULL
WHERE default_tax_rate IS NOT NULL AND default_tax_rate NOT IN (0, 1, 3, 6, 9, 13);

UPDATE md_supplier
SET default_tax_rate = NULL
WHERE default_tax_rate IS NOT NULL AND default_tax_rate NOT IN (0, 1, 3, 6, 9, 13);

UPDATE crm_opportunity
SET tax_rate = 6
WHERE tax_rate IS NOT NULL AND tax_rate NOT IN (0, 1, 3, 6, 9, 13);

UPDATE crm_quotation
SET tax_rate = 6
WHERE tax_rate IS NOT NULL AND tax_rate NOT IN (0, 1, 3, 6, 9, 13);

-- ---- 税率 CHECK 约束 ----
DO $$ BEGIN
  ALTER TABLE erp_contract_item
    ADD CONSTRAINT chk_contract_item_tax_rate CHECK (tax_rate IN (0, 1, 3, 6, 9, 13));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE md_customer
    ADD CONSTRAINT chk_customer_default_tax_rate
    CHECK (default_tax_rate IS NULL OR default_tax_rate IN (0, 1, 3, 6, 9, 13));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE md_supplier
    ADD CONSTRAINT chk_supplier_default_tax_rate
    CHECK (default_tax_rate IS NULL OR default_tax_rate IN (0, 1, 3, 6, 9, 13));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE crm_opportunity
    ADD CONSTRAINT chk_opp_tax_rate
    CHECK (tax_rate IS NULL OR tax_rate IN (0, 1, 3, 6, 9, 13));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE crm_quotation
    ADD CONSTRAINT chk_quotation_tax_rate
    CHECK (tax_rate IS NULL OR tax_rate IN (0, 1, 3, 6, 9, 13));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---- 合同明细序号：先重排去重，再建唯一索引 ----
-- 报价明细 crm_quotation_item.seq 无唯一约束，导入合同时可能重复；
-- 直接建索引会抛 23505 并让整个迁移回滚。
UPDATE erp_contract_item i
SET seq = s.rn
FROM (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY contract_id, version_no
           ORDER BY seq, _created_at
         ) AS rn
  FROM erp_contract_item
  WHERE is_current = 1
) s
WHERE i.id = s.id AND i.seq IS DISTINCT FROM s.rn;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_item_seq
  ON erp_contract_item (contract_id, version_no, seq)
  WHERE is_current = 1;

-- ---- M-06：清理与收入确认重复的销项开票凭证 ----
-- 方案 A：收入确认是唯一收入入口，开票只登记台账、不再出凭证。
--
-- 【为何不做自动 UPDATE】
-- 开票凭证的 source_ref 形如 `invoice:<发票号/单据号>`，收入凭证是 `revenue:<收入单号>`，
-- 两者**没有可关联的业务主键**（既无 period 必然相同，也无 source_invoice_id 外键），
-- 因此无法可靠地判定"这两张凭证对应同一笔业务"。
-- 旧实现用了一个与外层无关联条件的 EXISTS 子查询，导致只要库里存在任意一张
-- revenue 凭证，就会把**全库所有** invoice 凭证作废 —— 属于批量错账，必须消除。
--
-- 【改为】只做诊断：把疑似重复列出来告警，交由人工在核对后按单处理。
DO $$ DECLARE
  inv_cnt int;
  rev_cnt int;
BEGIN
  SELECT count(*) INTO inv_cnt FROM fin_voucher
   WHERE source_type = 'invoice' AND source_ref LIKE 'invoice:%' AND status <> 'voided';
  SELECT count(*) INTO rev_cnt FROM fin_voucher
   WHERE source_type = 'revenue' AND source_ref LIKE 'revenue:%' AND status <> 'voided';

  IF rev_cnt > 0 AND inv_cnt > 0 THEN
    RAISE WARNING
      'M-06 待人工处理：存在 % 张未作废销项开票凭证 与 % 张收入确认凭证。'
      '方案A 下开票不应确认收入，请核对同一笔业务是否存在双凭证：'
      'SELECT source_ref, period, sum(debit), sum(credit) FROM fin_voucher '
      'WHERE source_type IN (''invoice'',''revenue'') AND status <> ''voided'' GROUP BY 1,2;',
      inv_cnt, rev_cnt;
  END IF;
END $$;

-- 如确需批量清理，在人工确认后单独执行（务必先备份）：
-- UPDATE fin_voucher SET status='voided',
--   remark = COALESCE(remark,'') || ' [M-06 方案A清理：收入确认为准]'
-- WHERE source_type='invoice' AND source_ref LIKE 'invoice:%' AND status <> 'voided'
--   AND (<人工确认的凭证 id 白名单>);
