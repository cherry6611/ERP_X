-- 批次二 / C-02 + C-03 + C-07：银行账户主数据、银行流水与匹配、异步导出任务
-- requires: 0000_baseline.sql（user_profile 复合类型）, 2026-10-15-upgrade-batch1-accounting-base.sql
--
-- 设计要点：
-- 1) md_bank_account 为银行账户主数据，account_code 关联 fin_account 的科目编码
--    （默认 1002 银行存款；实际库中 1002 为父级，末级为 100201/100202，取数时按前缀汇总）。
-- 2) erp_bank_statement 承载银行流水，dedupe_key 为导入去重键：
--    优先取交易流水号，缺失时退化为 账户|日期|方向|金额|摘要 的业务指纹。
-- 3) erp_bank_statement_match 承载 流水↔收付款/凭证 的匹配关系；
--    同一流水最多一条有效匹配（部分唯一索引兜底），重新匹配走 UPDATE 而非新增。
-- 4) export_tasks 承载 C-07 异步导出任务与留痕；文件本身落磁盘（UPLOAD_DIR），
--    数据库只存相对路径，避免大字段入库。
-- 5) 全部 DDL 幂等，可重复执行。

-- ============================================================
-- 一、C-02 银行账户主数据 md_bank_account
-- ============================================================

CREATE TABLE IF NOT EXISTS md_bank_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(20) NOT NULL,
  name varchar(200) NOT NULL,
  account_no varchar(64) NOT NULL,
  bank_name varchar(200) NOT NULL,
  branch_name varchar(200),
  currency varchar(8) NOT NULL DEFAULT 'CNY',
  -- 关联会计科目编码（fin_account.code），默认 1002 银行存款
  account_code varchar(20),
  -- 手工维护的银行对账单期初余额（对账底稿用，非账套取数）
  opening_balance numeric NOT NULL DEFAULT 0,
  is_default integer NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'active',
  contact_person varchar(50),
  contact_phone varchar(30),
  remark text,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_md_bank_account_code ON md_bank_account (code);
-- 同一账号 + 币种唯一，重复创建返回 409
CREATE UNIQUE INDEX IF NOT EXISTS uq_md_bank_account_no_currency ON md_bank_account (account_no, currency);
CREATE INDEX IF NOT EXISTS idx_md_bank_account_status ON md_bank_account (status);
CREATE INDEX IF NOT EXISTS idx_md_bank_account_account_code ON md_bank_account (account_code);

DO $$ BEGIN
  ALTER TABLE md_bank_account
    ADD CONSTRAINT chk_md_bank_account_status
    CHECK (status IN ('active', 'disabled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE md_bank_account
    ADD CONSTRAINT chk_md_bank_account_default
    CHECK (is_default IN (0, 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 每个币种最多一个默认账户（部分唯一索引）
CREATE UNIQUE INDEX IF NOT EXISTS uq_md_bank_account_default_currency
  ON md_bank_account (currency)
  WHERE is_default = 1;

-- ============================================================
-- 二、C-02 银行流水 erp_bank_statement
-- ============================================================

CREATE TABLE IF NOT EXISTS erp_bank_statement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id uuid NOT NULL,
  transaction_date date NOT NULL,
  direction varchar(10) NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  -- 银行对账单上的交易后余额（部分银行不提供，可为空）
  balance numeric,
  counterparty_name varchar(200),
  counterparty_account varchar(64),
  summary varchar(500),
  -- 银行交易流水号（去重首选键，部分银行不提供）
  transaction_no varchar(100),
  -- 业务指纹去重键，NOT NULL，唯一索引兜底
  dedupe_key varchar(200) NOT NULL,
  match_status varchar(20) NOT NULL DEFAULT 'unmatched',
  biz_type varchar(20),
  biz_id uuid,
  biz_code varchar(50),
  match_score numeric,
  matched_at timestamptz(3),
  matched_by varchar(64),
  import_batch varchar(64),
  remark text,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_bank_statement_dedupe
  ON erp_bank_statement (bank_account_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_erp_bank_statement_account_date
  ON erp_bank_statement (bank_account_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_erp_bank_statement_status
  ON erp_bank_statement (bank_account_id, match_status);
CREATE INDEX IF NOT EXISTS idx_erp_bank_statement_transaction_no
  ON erp_bank_statement (bank_account_id, transaction_no);
CREATE INDEX IF NOT EXISTS idx_erp_bank_statement_biz
  ON erp_bank_statement (biz_type, biz_id);

DO $$ BEGIN
  ALTER TABLE erp_bank_statement
    ADD CONSTRAINT fk_erp_bank_statement_account
    FOREIGN KEY (bank_account_id) REFERENCES md_bank_account (id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE erp_bank_statement
    ADD CONSTRAINT chk_erp_bank_statement_direction
    CHECK (direction IN ('income', 'expense'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE erp_bank_statement
    ADD CONSTRAINT chk_erp_bank_statement_match_status
    CHECK (match_status IN ('unmatched', 'matched', 'manual', 'ignored'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE erp_bank_statement
    ADD CONSTRAINT chk_erp_bank_statement_amount
    CHECK (amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 三、C-02 流水匹配关系 erp_bank_statement_match
-- ============================================================

CREATE TABLE IF NOT EXISTS erp_bank_statement_match (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL,
  bank_account_id uuid NOT NULL,
  biz_type varchar(20) NOT NULL,
  biz_id uuid NOT NULL,
  biz_code varchar(50),
  match_type varchar(20) NOT NULL DEFAULT 'auto',
  score numeric,
  amount numeric,
  remark varchar(500),
  matched_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  matched_by varchar(64),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

-- 一条流水最多一条有效匹配（人工关联重复提交返回 409）
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_bank_statement_match_statement
  ON erp_bank_statement_match (statement_id);
CREATE INDEX IF NOT EXISTS idx_erp_bank_statement_match_biz
  ON erp_bank_statement_match (biz_type, biz_id);
CREATE INDEX IF NOT EXISTS idx_erp_bank_statement_match_account
  ON erp_bank_statement_match (bank_account_id);

DO $$ BEGIN
  ALTER TABLE erp_bank_statement_match
    ADD CONSTRAINT fk_erp_bank_statement_match_statement
    FOREIGN KEY (statement_id) REFERENCES erp_bank_statement (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE erp_bank_statement_match
    ADD CONSTRAINT chk_erp_bank_statement_match_biz_type
    CHECK (biz_type IN ('receipt', 'payment', 'voucher'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE erp_bank_statement_match
    ADD CONSTRAINT chk_erp_bank_statement_match_type
    CHECK (match_type IN ('auto', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 四、C-02 流水导入字段映射模板 erp_bank_import_mapping
--     （不同银行列名不同，映射可保存复用）
-- ============================================================

CREATE TABLE IF NOT EXISTS erp_bank_import_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  bank_name varchar(200),
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  remark varchar(500),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_bank_import_mapping_name
  ON erp_bank_import_mapping (name);

-- ============================================================
-- 五、C-07 异步导出任务 export_tasks
-- ============================================================

CREATE TABLE IF NOT EXISTS export_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(30) NOT NULL,
  resource_type varchar(50) NOT NULL,
  format varchar(10) NOT NULL DEFAULT 'xlsx',
  -- 筛选参数（审计留痕：与导出文件首行说明一致）
  filter_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  filter_summary varchar(1000) NOT NULL DEFAULT '',
  status varchar(20) NOT NULL DEFAULT 'pending',
  -- 相对 UPLOAD_DIR 的文件名（不含目录），避免库内存绝对路径
  file_name varchar(200),
  file_size integer,
  row_count integer,
  error_message text,
  requested_by varchar(64),
  requested_by_name varchar(100),
  started_at timestamptz(3),
  finished_at timestamptz(3),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_export_tasks_code ON export_tasks (code);
CREATE INDEX IF NOT EXISTS idx_export_tasks_requested_by
  ON export_tasks (requested_by, _created_at);
CREATE INDEX IF NOT EXISTS idx_export_tasks_status ON export_tasks (status);

DO $$ BEGIN
  ALTER TABLE export_tasks
    ADD CONSTRAINT chk_export_tasks_status
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE export_tasks
    ADD CONSTRAINT chk_export_tasks_format
    CHECK (format IN ('xlsx', 'csv'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
