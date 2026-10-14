-- 批次一 / A-06：增值税申报底稿
-- requires: 2026-10-15-upgrade-batch1-accounting-base.sql, 0000_baseline.sql
--
-- 说明：申报底稿同时保留"发票台账口径"与"总账口径"，两者差异需人工确认并留痕，
-- 确认后的记录可用于导出申报表 Excel。

CREATE TABLE IF NOT EXISTS fin_vat_declaration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period varchar(7) NOT NULL,
  tax_entity_id uuid,
  status varchar(20) NOT NULL DEFAULT 'draft',
  output_tax numeric NOT NULL DEFAULT 0,
  input_tax numeric NOT NULL DEFAULT 0,
  transfer_out numeric NOT NULL DEFAULT 0,
  previous_credit numeric NOT NULL DEFAULT 0,
  payable_tax numeric NOT NULL DEFAULT 0,
  closing_credit numeric NOT NULL DEFAULT 0,
  ledger_output_tax numeric NOT NULL DEFAULT 0,
  ledger_input_tax numeric NOT NULL DEFAULT 0,
  difference_reason varchar(500),
  generated_by varchar(64),
  generated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fin_vat_declaration_period
  ON fin_vat_declaration (period);

-- 修正（全新库迁移链实测）：本文件排序在 2026-10-15-upgrade-batch1-finance-unique-indexes.sql
-- 之后，而后者按 schema.ts 意图要求该索引为 NULLS NOT DISTINCT（它在该表尚未创建时会跳过）。
-- 故此处直接使用同一最终定义，保证全新建库与既有库的索引定义完全一致，避免口径漂移。
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_vat_declaration_period_entity
  ON fin_vat_declaration (period, tax_entity_id) NULLS NOT DISTINCT;

-- 期间 + 主体维度索引，支撑"按期间生成底稿"的取数（A-06 数据来源①）
CREATE INDEX IF NOT EXISTS idx_erp_invoice_date_direction
  ON erp_invoice (invoice_date, direction, status);
CREATE INDEX IF NOT EXISTS idx_erp_invoice_tax_entity
  ON erp_invoice (tax_entity_id, invoice_date);
