-- 最终评估报告：本地文件归属、凭证重试队列辅助索引、税率 CHECK 重申

ALTER TABLE comp_stored_file
  ADD COLUMN IF NOT EXISTS owner_user_id varchar(64);

CREATE INDEX IF NOT EXISTS idx_comp_stored_file_owner
  ON comp_stored_file (owner_user_id);

CREATE INDEX IF NOT EXISTS idx_comp_voucher_job_retry
  ON comp_voucher_job (status, next_retry_at)
  WHERE status = 'failed';

-- T8：合同/发票税率法定档位（幂等，已存在则跳过）
DO $$ BEGIN
  ALTER TABLE erp_contract
    ADD CONSTRAINT chk_contract_tax_rate
    CHECK (tax_rate IS NULL OR tax_rate IN (0, 1, 3, 6, 9, 13));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE erp_invoice
    ADD CONSTRAINT chk_invoice_tax_rate
    CHECK (tax_rate IS NULL OR tax_rate IN (0, 1, 3, 6, 9, 13));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- T9：增值税明细科目（父级 2221 可能已存在）
INSERT INTO fin_account (code, name, account_type, status)
SELECT v.code, v.name, v.account_type, 'active'
FROM (VALUES
  ('222101', '应交税费-销项税', 'liability'),
  ('222102', '应交税费-进项税', 'liability'),
  ('6602', '管理费用', 'expense')
) AS v(code, name, account_type)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

-- T11：仅红冲 source_ref 唯一（防并发重复红冲）
DROP INDEX IF EXISTS uq_erp_project_cost_source_ref;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'uq_erp_project_cost_redflush_source_ref'
  ) THEN
    CREATE UNIQUE INDEX uq_erp_project_cost_redflush_source_ref
      ON erp_project_cost (source_ref)
      WHERE source_ref LIKE 'redflush:%';
  END IF;
END $$;

-- B8：站内信收件箱（与飞书审批通知并行）
CREATE TABLE IF NOT EXISTS sys_inbox_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(64) NOT NULL,
  title varchar(200),
  content text,
  biz_type varchar(40),
  biz_code varchar(64),
  read_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sys_inbox_message_user
  ON sys_inbox_message (user_id);

CREATE INDEX IF NOT EXISTS idx_sys_inbox_message_user_unread
  ON sys_inbox_message (user_id, read_at);

-- U-02：采购订单税率（验收进项凭证上游）
ALTER TABLE pur_order ADD COLUMN IF NOT EXISTS tax_rate numeric;

DO $$ BEGIN
  ALTER TABLE pur_order
    ADD CONSTRAINT chk_pur_order_tax_rate
    CHECK (tax_rate IS NULL OR tax_rate IN (0, 1, 3, 6, 9, 13));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

