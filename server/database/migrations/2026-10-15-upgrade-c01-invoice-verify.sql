-- 批次二 / C-01：发票查验与勾选认证
-- requires: 0000_baseline.sql
--
-- 背景：进项/销项发票当前只在 erp_invoice 登记要素（direction / tax_rate / tax_amount /
-- ap_id），无法回答"这张发票在税局是否真实存在""本月是否已勾选认证"。C-01 在发票上
-- 追加查验与认证状态，作为增值税申报底稿（A-06）勾稽与税务风险扫描（D-06）的输入。
--
-- 设计要点（与需求书 §3.1 C-01 一致）：
--   1) 查验采用可插拔 Provider（none / http-vendor），失败不阻断录入、只标记；
--   2) 认证状态独立于查验：未查验也可人工勾选认证（业务口径，需财务确认）；
--   3) 所有新增列均幂等，已存在则跳过，可重复执行。
--
-- 字段语义：
--   verify_status       查验状态：unverified(未查验) / verifying(查验中) / verified(已通过) / failed(查验失败)
--   verify_time         最近一次查验完成时间
--   verify_error        查验失败原因（verified 时为空）
--   certification_status 勾选认证状态：uncertified(未认证) / certified(已认证) / deducted(已抵扣)
--   certification_period 勾选所属税款所属期，格式 YYYY-MM
--   certified_at        最近一次勾选完成时间

ALTER TABLE erp_invoice
  ADD COLUMN IF NOT EXISTS verify_status       varchar(20) NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verify_time         timestamptz,
  ADD COLUMN IF NOT EXISTS verify_error        text,
  ADD COLUMN IF NOT EXISTS certification_status varchar(20) NOT NULL DEFAULT 'uncertified',
  ADD COLUMN IF NOT EXISTS certification_period varchar(7),
  ADD COLUMN IF NOT EXISTS certified_at        timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoice_verify_status'
  ) THEN
    ALTER TABLE erp_invoice
      ADD CONSTRAINT chk_invoice_verify_status
      CHECK (verify_status IN ('unverified', 'verifying', 'verified', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoice_certification_status'
  ) THEN
    ALTER TABLE erp_invoice
      ADD CONSTRAINT chk_invoice_certification_status
      CHECK (certification_status IN ('uncertified', 'certified', 'deducted'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_invoice_certification_period'
  ) THEN
    ALTER TABLE erp_invoice
      ADD CONSTRAINT chk_invoice_certification_period
      CHECK (certification_period IS NULL OR certification_period ~ '^\d{4}-(0[1-9]|1[0-2])$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_erp_invoice_verify_status
  ON erp_invoice (direction, verify_status);

COMMENT ON COLUMN erp_invoice.verify_status IS '查验状态：unverified/verifying/verified/failed';
COMMENT ON COLUMN erp_invoice.certification_status IS '勾选认证状态：uncertified/certified/deducted';
COMMENT ON COLUMN erp_invoice.certification_period IS '勾选所属税款所属期 YYYY-MM';
