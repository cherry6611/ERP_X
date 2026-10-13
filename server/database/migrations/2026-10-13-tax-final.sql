-- 终版含税口径。不写入纳税主体种子数据。
-- 历史销项发票金额按「原不含税 + 税额」改写为价税合计，仅在 net_amount 仍为空时执行一次。

CREATE TABLE IF NOT EXISTS md_tax_entity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(20) NOT NULL,
  name varchar(200) NOT NULL,
  uscc varchar(20),
  taxpayer_type varchar(20) NOT NULL,
  default_output_rate numeric NOT NULL,
  default_input_rate numeric NOT NULL,
  invoice_title varchar(200),
  invoice_address varchar(300),
  invoice_phone varchar(40),
  invoice_bank varchar(200),
  invoice_account varchar(64),
  is_default integer NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'active',
  remark text,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_md_tax_entity_code ON md_tax_entity (code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_md_tax_entity_name ON md_tax_entity (name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_md_tax_entity_default
  ON md_tax_entity (is_default) WHERE is_default = 1;

DO $$ BEGIN
  ALTER TABLE md_tax_entity
    ADD CONSTRAINT chk_tax_entity_type CHECK (taxpayer_type IN ('general', 'small'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE md_tax_entity
    ADD CONSTRAINT chk_tax_entity_out CHECK (default_output_rate IN (0, 1, 3, 6, 9, 13));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE md_tax_entity
    ADD CONSTRAINT chk_tax_entity_in CHECK (default_input_rate IN (0, 1, 3, 6, 9, 13));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE md_tax_entity
    ADD CONSTRAINT chk_tax_entity_status CHECK (status IN ('active', 'inactive'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE md_tax_entity
    ADD CONSTRAINT chk_tax_entity_uscc CHECK (
      uscc IS NULL OR uscc ~ '^[0-9A-Za-z]{15}$' OR uscc ~ '^[0-9A-Za-z]{18}$' OR uscc ~ '^[0-9A-Za-z]{20}$'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO fin_account (code, name, account_type, status)
SELECT v.code, v.name, v.account_type, 'active'
FROM (VALUES
  ('1001', '银行存款', 'asset'),
  ('1122', '应收账款', 'asset'),
  ('2202', '应付账款', 'liability'),
  ('2221', '应交税费—应交增值税', 'liability'),
  ('6001', '主营业务收入', 'income'),
  ('6401', '主营业务成本', 'expense')
) AS v(code, name, account_type)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

ALTER TABLE md_customer ADD COLUMN IF NOT EXISTS tax_entity_id uuid;
ALTER TABLE md_customer ADD COLUMN IF NOT EXISTS default_tax_rate numeric;
ALTER TABLE md_customer ADD COLUMN IF NOT EXISTS invoice_title varchar(200);
ALTER TABLE md_customer ADD COLUMN IF NOT EXISTS invoice_address varchar(300);
ALTER TABLE md_customer ADD COLUMN IF NOT EXISTS invoice_phone varchar(40);
ALTER TABLE md_customer ADD COLUMN IF NOT EXISTS invoice_bank varchar(200);
ALTER TABLE md_customer ADD COLUMN IF NOT EXISTS invoice_account varchar(64);

ALTER TABLE md_supplier ADD COLUMN IF NOT EXISTS tax_entity_id uuid;
ALTER TABLE md_supplier ADD COLUMN IF NOT EXISTS default_tax_rate numeric;

ALTER TABLE crm_opportunity ADD COLUMN IF NOT EXISTS tax_rate numeric;
ALTER TABLE crm_opportunity ADD COLUMN IF NOT EXISTS contract_id uuid;
ALTER TABLE crm_quotation ADD COLUMN IF NOT EXISTS tax_rate numeric;
ALTER TABLE crm_lead ADD COLUMN IF NOT EXISTS customer_id uuid;
ALTER TABLE crm_lead ADD COLUMN IF NOT EXISTS converted_opportunity_id uuid;

ALTER TABLE erp_contract ADD COLUMN IF NOT EXISTS tax_entity_id uuid;
ALTER TABLE erp_contract ADD COLUMN IF NOT EXISTS net_amount numeric;
ALTER TABLE erp_contract ADD COLUMN IF NOT EXISTS tax_amount numeric;
ALTER TABLE erp_contract ADD COLUMN IF NOT EXISTS rate_source varchar(20);

ALTER TABLE erp_invoice ADD COLUMN IF NOT EXISTS tax_entity_id uuid;
ALTER TABLE erp_invoice ADD COLUMN IF NOT EXISTS net_amount numeric;
ALTER TABLE erp_invoice ADD COLUMN IF NOT EXISTS old_amount numeric;
ALTER TABLE erp_invoice ADD COLUMN IF NOT EXISTS buyer_name varchar(200);
ALTER TABLE erp_invoice ADD COLUMN IF NOT EXISTS buyer_uscc varchar(20);
ALTER TABLE erp_invoice ADD COLUMN IF NOT EXISTS seller_name varchar(200);
ALTER TABLE erp_invoice ADD COLUMN IF NOT EXISTS seller_uscc varchar(20);

ALTER TABLE erp_calloff ADD COLUMN IF NOT EXISTS quantity numeric;
ALTER TABLE erp_calloff ADD COLUMN IF NOT EXISTS unit_price numeric;
ALTER TABLE erp_calloff ADD COLUMN IF NOT EXISTS status varchar(20) DEFAULT 'ordered';

ALTER TABLE erp_project_milestone ADD COLUMN IF NOT EXISTS contract_milestone_id uuid;

CREATE TABLE IF NOT EXISTS erp_contract_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  version_no integer NOT NULL DEFAULT 1,
  is_current integer NOT NULL DEFAULT 1,
  seq integer NOT NULL DEFAULT 1,
  item_name varchar(200) NOT NULL,
  unit varchar(20) NOT NULL DEFAULT '项',
  quantity numeric NOT NULL DEFAULT 1,
  unit_price numeric NOT NULL DEFAULT 0,
  discount_pct numeric NOT NULL DEFAULT 0,
  tax_rate numeric NOT NULL DEFAULT 6,
  amount numeric NOT NULL DEFAULT 0,
  net_amount numeric NOT NULL DEFAULT 0,
  tax_amount numeric NOT NULL DEFAULT 0,
  est_unit_cost numeric NOT NULL DEFAULT 0,
  source_type varchar(20) NOT NULL DEFAULT 'manual',
  source_item_id uuid,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_erp_contract_item_contract
  ON erp_contract_item (contract_id, is_current);

DO $$ BEGIN
  ALTER TABLE erp_contract
    ADD CONSTRAINT chk_contract_tax_rate CHECK (
      tax_rate IS NULL OR tax_rate IN (0, 1, 3, 6, 9, 13)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE erp_invoice
    ADD CONSTRAINT chk_invoice_tax_rate CHECK (
      tax_rate IS NULL OR tax_rate IN (0, 1, 3, 6, 9, 13)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE erp_contract
    ADD CONSTRAINT chk_contract_status CHECK (
      status IS NULL OR status IN (
        'draft', 'approving', 'active', 'performing', 'completed', 'closed', 'terminated'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_project_one_contract
  ON erp_project (contract_id) WHERE contract_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_opp_contract
  ON crm_opportunity (contract_id) WHERE contract_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_voucher_source
  ON fin_voucher (source_type, source_ref)
  WHERE source_type IS NOT NULL AND source_ref IS NOT NULL;

UPDATE erp_invoice
SET old_amount = amount
WHERE old_amount IS NULL;

UPDATE erp_invoice
SET net_amount = old_amount,
    amount = COALESCE(old_amount, 0) + COALESCE(tax_amount, 0)
WHERE net_amount IS NULL AND old_amount IS NOT NULL;

UPDATE erp_contract
SET tax_amount = ROUND(COALESCE(amount, 0) * COALESCE(tax_rate, 0) / (100 + COALESCE(tax_rate, 0)), 2),
    net_amount = COALESCE(amount, 0) - ROUND(COALESCE(amount, 0) * COALESCE(tax_rate, 0) / (100 + COALESCE(tax_rate, 0)), 2)
WHERE net_amount IS NULL;
