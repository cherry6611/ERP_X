-- F4X-3/4/8/9/10：核销竞态防护 + 固定资产科目 + 报销/结算幂等索引
-- used_amount 条件更新防超额；reversal_of / source_ref 唯一防重复冲回与重复入账
-- requires: 0000_baseline.sql
-- 修正（全新库迁移链实测）：本文件名排序在 2026-10-14-upgrade-v25-v26.sql 之前，
-- 而后者才添加 reversal_of 列，故此处先幂等补列，否则全新建库执行到第 53/57 行
-- 建唯一索引时报 42703 column "reversal_of" does not exist。
-- 补列语句与 v25-v26 完全一致（IF NOT EXISTS 幂等），已应用该库的环境重跑无副作用。

ALTER TABLE erp_ar_writeoff
  ADD COLUMN IF NOT EXISTS reversal_of uuid;
ALTER TABLE erp_ap_writeoff
  ADD COLUMN IF NOT EXISTS reversal_of uuid;

INSERT INTO fin_account (code, name, account_type, status)
SELECT v.code, v.name, v.account_type, 'active'
FROM (VALUES
  ('1601', '固定资产', 'asset')
) AS v(code, name, account_type)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

ALTER TABLE erp_receipt
  ADD COLUMN IF NOT EXISTS used_amount numeric NOT NULL DEFAULT 0;

UPDATE erp_receipt r
SET used_amount = COALESCE(
  (SELECT SUM(w.amount::numeric) FROM erp_ar_writeoff w WHERE w.receipt_id = r.id),
  0
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_receipt_used_le_amount'
  ) THEN
    ALTER TABLE erp_receipt
      ADD CONSTRAINT chk_receipt_used_le_amount
      CHECK (used_amount <= amount);
  END IF;
END $$;

ALTER TABLE erp_payment
  ADD COLUMN IF NOT EXISTS used_amount numeric NOT NULL DEFAULT 0;

UPDATE erp_payment p
SET used_amount = COALESCE(
  (SELECT SUM(w.amount::numeric) FROM erp_ap_writeoff w WHERE w.payment_id = p.id),
  0
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_payment_used_le_amount'
  ) THEN
    ALTER TABLE erp_payment
      ADD CONSTRAINT chk_payment_used_le_amount
      CHECK (used_amount <= amount);
  END IF;
END $$;

DROP INDEX IF EXISTS idx_erp_ar_writeoff_reversal;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_ar_writeoff_reversal
  ON erp_ar_writeoff (reversal_of) WHERE reversal_of IS NOT NULL;

DROP INDEX IF EXISTS idx_erp_ap_writeoff_reversal;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_ap_writeoff_reversal
  ON erp_ap_writeoff (reversal_of) WHERE reversal_of IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_ap_bill_source_ref
  ON erp_ap_bill (source_ref) WHERE source_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_project_cost_source_ref_non_red
  ON erp_project_cost (source_ref)
  WHERE source_ref IS NOT NULL AND source_ref NOT LIKE 'redflush:%';

CREATE UNIQUE INDEX IF NOT EXISTS uq_pur_order_request_active
  ON pur_order (request_id)
  WHERE request_id IS NOT NULL AND status <> 'cancelled';

-- D-19：应收 source_ref 幂等
ALTER TABLE erp_ar ADD COLUMN IF NOT EXISTS source_ref varchar(100);
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_ar_source_ref
  ON erp_ar (source_ref) WHERE source_ref IS NOT NULL;
