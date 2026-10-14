-- 批次一 / A-10 + A-03：会计科目表补全、多级科目与末级校验、账簿查询索引、会计辅助核算、余额快照
-- requires: 0000_baseline.sql, 2026-10-14-final-audit.sql
--
-- 设计要点：
-- 1) fin_account 由"平铺科目"升级为"多级科目树"：parent_code 定位上级，level 为层级，is_leaf 标记末级。
-- 2) 只有末级科目允许做账（凭证分录、期间结转、报表取数均按末级汇总到上级）。
-- 3) fin_voucher_line 增加 direction（借/贷）便于方向敏感的报表取数；
--    account_code 冗余落库，避免账簿查询每次都 join fin_account（A-03 性能要求）。
-- 4) 新增 fin_aux_dimension / fin_voucher_line_aux 承载辅助核算（A-05），
--    采用"维度定义 + 一对多关联表"而非在主表加固定列，维度可增长。
-- 5) 新增 fin_account_balance_snapshot 承载月度科目余额快照（A-03 性能要求）。
-- 6) 新增 fin_report_template 报表模板表（A-01/A-02 报表引擎的取数公式载体）。

-- ============================================================
-- 一、fin_account：多级科目 + 辅助核算要求
-- ============================================================

ALTER TABLE fin_account
  ADD COLUMN IF NOT EXISTS parent_code varchar(20);
ALTER TABLE fin_account
  ADD COLUMN IF NOT EXISTS level integer NOT NULL DEFAULT 1;
ALTER TABLE fin_account
  ADD COLUMN IF NOT EXISTS is_leaf integer NOT NULL DEFAULT 1;
ALTER TABLE fin_account
  ADD COLUMN IF NOT EXISTS direction varchar(10) NOT NULL DEFAULT 'debit';
-- 必填辅助维度集合，JSON 数组字符串，如 '["project","department"]'；空数组表示不要求
ALTER TABLE fin_account
  ADD COLUMN IF NOT EXISTS aux_required varchar(200) NOT NULL DEFAULT '[]';
ALTER TABLE fin_account
  ADD COLUMN IF NOT EXISTS sort_no integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_fin_account_parent ON fin_account (parent_code);
CREATE INDEX IF NOT EXISTS idx_fin_account_level ON fin_account (level);
CREATE INDEX IF NOT EXISTS idx_fin_account_leaf ON fin_account (is_leaf);

-- 科目方向约束：资产/成本为借，负债/权益/收入为贷（费用按借）
DO $$ BEGIN
  ALTER TABLE fin_account
    ADD CONSTRAINT chk_fin_account_direction
    CHECK (direction IN ('debit', 'credit'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE fin_account
    ADD CONSTRAINT chk_fin_account_level
    CHECK (level >= 1 AND level <= 6);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 二、fin_voucher_line：账簿取数友好列 + 索引
-- ============================================================

ALTER TABLE fin_voucher_line
  ADD COLUMN IF NOT EXISTS account_code varchar(20);

-- 回填历史分录的科目编码（幂等：只填空的）
UPDATE fin_voucher_line l
SET account_code = a.code
FROM fin_account a
WHERE l.account_id = a.id
  AND (l.account_code IS NULL OR l.account_code = '');

-- 维护触发器：新增分录自动带出 account_code，避免应用层遗漏
CREATE OR REPLACE FUNCTION fin_voucher_line_fill_account_code()
RETURNS trigger AS $$
BEGIN
  IF (NEW.account_code IS NULL OR NEW.account_code = '') AND NEW.account_id IS NOT NULL THEN
    SELECT a.code INTO NEW.account_code FROM fin_account a WHERE a.id = NEW.account_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fin_voucher_line_account_code ON fin_voucher_line;
CREATE TRIGGER trg_fin_voucher_line_account_code
  BEFORE INSERT OR UPDATE OF account_id, account_code ON fin_voucher_line
  FOR EACH ROW EXECUTE FUNCTION fin_voucher_line_fill_account_code();

-- A-03 性能要求：科目 + 凭证 复合索引，以及凭证 (期间, 状态)
CREATE INDEX IF NOT EXISTS idx_fin_voucher_line_account_voucher
  ON fin_voucher_line (account_code, voucher_id);
CREATE INDEX IF NOT EXISTS idx_fin_voucher_line_account_id_voucher
  ON fin_voucher_line (account_id, voucher_id);
CREATE INDEX IF NOT EXISTS idx_fin_voucher_period_status
  ON fin_voucher (period, status);
CREATE INDEX IF NOT EXISTS idx_fin_voucher_voucher_date
  ON fin_voucher (voucher_date);

-- ============================================================
-- 三、A-05 会计辅助核算：维度定义 + 凭证行辅助值
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_aux_dimension (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(32) NOT NULL,
  name varchar(64) NOT NULL,
  -- 维度取值来源：department/project/customer/supplier/employee 对应主数据表；
  -- custom 表示由字典维护的自由值
  source_type varchar(20) NOT NULL DEFAULT 'custom',
  enabled integer NOT NULL DEFAULT 1,
  sort_no integer NOT NULL DEFAULT 0,
  remark varchar(200),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_aux_dimension_code
  ON fin_aux_dimension (code);

-- 凭证行 × 维度 × 值，一对多
CREATE TABLE IF NOT EXISTS fin_voucher_line_aux (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id uuid NOT NULL,
  voucher_id uuid,
  dimension_code varchar(32) NOT NULL,
  dimension_id uuid,
  dimension_value varchar(200),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fin_voucher_line_aux_line
  ON fin_voucher_line_aux (line_id);
CREATE INDEX IF NOT EXISTS idx_fin_voucher_line_aux_voucher
  ON fin_voucher_line_aux (voucher_id);
CREATE INDEX IF NOT EXISTS idx_fin_voucher_line_aux_dim
  ON fin_voucher_line_aux (dimension_code, dimension_id);

DO $$ BEGIN
  ALTER TABLE fin_voucher_line_aux
    ADD CONSTRAINT fk_fin_voucher_line_aux_line
    FOREIGN KEY (line_id) REFERENCES fin_voucher_line (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 四、A-03 性能：月度科目余额快照
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_account_balance_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period varchar(7) NOT NULL,
  tax_entity_id uuid,
  account_code varchar(20) NOT NULL,
  account_name varchar(100),
  -- period_opening_*：期初余额；debit_occur/credit_occur：本期发生额；
  -- closing_*：期末余额（= 期初 ± 本期发生）
  opening_debit numeric NOT NULL DEFAULT 0,
  opening_credit numeric NOT NULL DEFAULT 0,
  debit_occur numeric NOT NULL DEFAULT 0,
  credit_occur numeric NOT NULL DEFAULT 0,
  closing_debit numeric NOT NULL DEFAULT 0,
  closing_credit numeric NOT NULL DEFAULT 0,
  voucher_count integer NOT NULL DEFAULT 0,
  generated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_account_balance_snapshot
  ON fin_account_balance_snapshot (period, account_code, coalesce(tax_entity_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_fin_account_balance_snapshot_period
  ON fin_account_balance_snapshot (period);

-- ============================================================
-- 五、A-01/A-02 报表模板
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_report_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_code varchar(32) NOT NULL,
  -- 行号：如 '1'、'2'、'一'、'（一）'
  row_no varchar(16) NOT NULL,
  row_name varchar(120) NOT NULL,
  -- 取数公式 DSL，见 server/modules/finance-reports/report-formula.ts
  formula varchar(500) NOT NULL DEFAULT '',
  -- 分区：assets/liabilities/equity/... 用于前端分组与小计定位
  section varchar(32) NOT NULL DEFAULT 'default',
  -- 展示层级：0 为小计/合计行，>0 为明细行
  indent integer NOT NULL DEFAULT 0,
  bold integer NOT NULL DEFAULT 0,
  sort_no integer NOT NULL DEFAULT 0,
  enabled integer NOT NULL DEFAULT 1,
  remark varchar(200),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_report_template_row
  ON fin_report_template (report_code, row_no);
CREATE INDEX IF NOT EXISTS idx_fin_report_template_code
  ON fin_report_template (report_code, sort_no);

-- ============================================================
-- 六、A-04 年结
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_year_end_close (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_year integer NOT NULL,
  -- 年结对应的 12 月期间，如 '2026-12'
  period varchar(7) NOT NULL,
  tax_entity_id uuid,
  status varchar(20) NOT NULL DEFAULT 'closed',
  -- 本年利润（净利润）金额与结转凭证
  profit_amount numeric NOT NULL DEFAULT 0,
  carry_voucher_id uuid,
  closed_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_by varchar(64),
  reopened_at timestamptz(3),
  reopened_by varchar(64),
  remark varchar(500)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_year_end_close_year
  ON fin_year_end_close (fiscal_year, coalesce(tax_entity_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_fin_year_end_close_period
  ON fin_year_end_close (period);

-- 年结/反年结审计留痕（A-04 要求"反结转需审批与留痕"）
CREATE TABLE IF NOT EXISTS fin_year_end_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_year integer NOT NULL,
  action varchar(20) NOT NULL,
  actor_user_id varchar(64),
  reason varchar(500),
  snapshot text,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fin_year_end_log_year
  ON fin_year_end_log (fiscal_year, _created_at);
