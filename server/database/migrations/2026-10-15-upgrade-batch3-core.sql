-- 批次三 / C-05 采购与销售退货、C-04 应收应付票据、D-08 资产减值与处置、D-12 BI 预警订阅
-- requires: 2026-10-15-upgrade-batch1z-code-rules-seed.sql, 2026-10-15-upgrade-batch1-chart-of-accounts.sql
--
-- 排序说明（本仓已踩过的坑：种子文件排在建表文件之前导致全新建库失败）：
--   文件名以 2026-10-15-upgrade-batch3- 开头，字典序晚于 batch1z（1 < 3）与 batch2，
--   因此依赖的科目表（batch1-chart-of-accounts）与编号规则表（batch1z）必定已执行；
--   本文件内的科目补录与建表也按"先补科目、后建表、再建索引/约束"排列。
--
-- 口径与幂等：
--   ① 全部 DDL 幂等（IF NOT EXISTS / DO $$ ... EXCEPTION WHEN duplicate_object），可重复执行；
--   ② 新增科目 1603 固定资产清理：处置固定资产必须先经"固定资产清理"过渡科目，
--      否则 1601/1602 会被直接对冲而无法在账簿中看到处置过程（**需财务确认**）；
--   ③ 退货、票据、减值、处置、BI 订阅全部为新增表，不改动既有表的数据语义；
--      ast_asset 只新增三个减值相关列（NULL 表示未减值），历史行不受影响。

-- ============================================================
-- 〇、新增会计科目：1603 固定资产清理（**需财务确认**）
--     6711 营业外支出已在 batch1-chart-of-accounts 预置，此处只补 1603。
-- ============================================================

INSERT INTO fin_account (code, name, account_type, status, parent_code, level, is_leaf, direction, sort_no)
SELECT v.code, v.name, v.account_type, 'active', v.parent_code, v.level, v.is_leaf, v.direction, v.sort_no
FROM (VALUES
  ('1603', '固定资产清理', 'asset', NULL, 1, 1, 'debit', 1603)
) AS v(code, name, account_type, parent_code, level, is_leaf, direction, sort_no)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

-- ============================================================
-- 一、C-05 采购退货 pur_return / pur_return_item
--     原单口径：pur_order 无明细行，验收数量累计在 accepted_quantity；
--     故退货头表冗余原单号与数量快照，明细行承载"按物料行退货"的扩展能力。
-- ============================================================

CREATE TABLE IF NOT EXISTS pur_return (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(20) NOT NULL,
  order_id uuid NOT NULL,
  order_code varchar(20),
  supplier_id uuid,
  project_id uuid,
  -- 退货日期（业务时区，YYYY-MM-DD），凭证日期与期间由它派生
  return_date date NOT NULL,
  -- 本次退货数量合计与不含税/含税金额（金额=数量×原单单价）
  return_quantity integer NOT NULL DEFAULT 0,
  amount numeric NOT NULL DEFAULT 0,
  tax_rate numeric,
  net_amount numeric NOT NULL DEFAULT 0,
  tax_amount numeric NOT NULL DEFAULT 0,
  -- 冲减的应付单（验收时按批次生成，这里冗余便于追溯）
  ap_bill_id uuid,
  -- 关联的红字进项发票
  red_invoice_id uuid,
  -- 状态机：draft → submitted → approved → completed，void 为作废终态
  status varchar(20) NOT NULL DEFAULT 'draft',
  reason varchar(500),
  remark text,
  submitted_at timestamptz(3),
  approved_at timestamptz(3),
  completed_at timestamptz(3),
  -- 已生成红字凭证的来源键（唯一，防重复记账）
  voucher_ref varchar(100),
  created_by_user varchar(64),
  approved_by varchar(64),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pur_return_code ON pur_return (code);
CREATE INDEX IF NOT EXISTS idx_pur_return_order ON pur_return (order_id);
CREATE INDEX IF NOT EXISTS idx_pur_return_status ON pur_return (status);
-- 同一验收批次（应付单）只允许存在一张未作废退货单，并发下由数据库兜底
CREATE UNIQUE INDEX IF NOT EXISTS uq_pur_return_ap_bill
  ON pur_return (ap_bill_id)
  WHERE ap_bill_id IS NOT NULL AND status <> 'void';
-- 凭证来源键唯一：同一退货单不可能开出两张红字凭证
CREATE UNIQUE INDEX IF NOT EXISTS uq_pur_return_voucher_ref
  ON pur_return (voucher_ref)
  WHERE voucher_ref IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE pur_return
    ADD CONSTRAINT chk_pur_return_status
    CHECK (status IN ('draft', 'submitted', 'approved', 'completed', 'void'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE pur_return
    ADD CONSTRAINT chk_pur_return_quantity
    CHECK (return_quantity > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS pur_return_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL,
  order_id uuid,
  -- pur_order 无明细行，item_name 取原单物料名称快照
  item_name varchar(200) NOT NULL,
  quantity integer NOT NULL DEFAULT 0,
  unit_price numeric NOT NULL DEFAULT 0,
  amount numeric NOT NULL DEFAULT 0,
  tax_rate numeric,
  net_amount numeric NOT NULL DEFAULT 0,
  tax_amount numeric NOT NULL DEFAULT 0,
  remark text,
  seq integer NOT NULL DEFAULT 1,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE INDEX IF NOT EXISTS idx_pur_return_item_return ON pur_return_item (return_id);
CREATE INDEX IF NOT EXISTS idx_pur_return_item_order ON pur_return_item (order_id);

DO $$ BEGIN
  ALTER TABLE pur_return_item
    ADD CONSTRAINT fk_pur_return_item_return
    FOREIGN KEY (return_id) REFERENCES pur_return (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE pur_return_item
    ADD CONSTRAINT chk_pur_return_item_quantity
    CHECK (quantity > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 二、C-05 销售退货 sales_return / sales_return_item
--     原单口径：收入确认（erp_project_revenue）只有金额没有数量，
--     故销售退货按"金额"校验（不得超过原收入已确认金额 − 已退货金额）。
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_return (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(20) NOT NULL,
  revenue_id uuid NOT NULL,
  revenue_code varchar(20),
  contract_id uuid,
  customer_id uuid,
  project_id uuid,
  return_date date NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  tax_rate numeric,
  net_amount numeric NOT NULL DEFAULT 0,
  tax_amount numeric NOT NULL DEFAULT 0,
  -- 关联的红字发票（销项 direction='red'）；为空时审批不自动开票
  red_invoice_id uuid,
  -- 冲减的收入调整单
  revenue_adjust_id uuid,
  status varchar(20) NOT NULL DEFAULT 'draft',
  reason varchar(500),
  remark text,
  submitted_at timestamptz(3),
  approved_at timestamptz(3),
  completed_at timestamptz(3),
  voucher_ref varchar(100),
  created_by_user varchar(64),
  approved_by varchar(64),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_return_code ON sales_return (code);
CREATE INDEX IF NOT EXISTS idx_sales_return_revenue ON sales_return (revenue_id);
CREATE INDEX IF NOT EXISTS idx_sales_return_status ON sales_return (status);
CREATE INDEX IF NOT EXISTS idx_sales_return_contract ON sales_return (contract_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_return_voucher_ref
  ON sales_return (voucher_ref)
  WHERE voucher_ref IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE sales_return
    ADD CONSTRAINT chk_sales_return_status
    CHECK (status IN ('draft', 'submitted', 'approved', 'completed', 'void'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE sales_return
    ADD CONSTRAINT chk_sales_return_amount
    CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS sales_return_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL,
  revenue_id uuid,
  item_name varchar(200) NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  tax_rate numeric,
  net_amount numeric NOT NULL DEFAULT 0,
  tax_amount numeric NOT NULL DEFAULT 0,
  remark text,
  seq integer NOT NULL DEFAULT 1,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE INDEX IF NOT EXISTS idx_sales_return_item_return ON sales_return_item (return_id);

DO $$ BEGIN
  ALTER TABLE sales_return_item
    ADD CONSTRAINT fk_sales_return_item_return
    FOREIGN KEY (return_id) REFERENCES sales_return (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE sales_return_item
    ADD CONSTRAINT chk_sales_return_item_amount
    CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 红字发票识别列：销项红字发票用 direction='sales' + status='red' 表示，
-- 与既有 status IN ('issued','voided') 完全兼容（既有查询均按 'issued' 过滤）。
ALTER TABLE erp_invoice ADD COLUMN IF NOT EXISTS source_ref varchar(100);

CREATE INDEX IF NOT EXISTS idx_erp_invoice_source_ref ON erp_invoice (source_ref);

-- ============================================================
-- 三、C-04 应收应付票据 erp_note / erp_note_log
-- ============================================================

CREATE TABLE IF NOT EXISTS erp_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(20) NOT NULL,
  -- 票号（银行/商业承兑汇票的票据号码，同一票号不允许重复入账）
  note_no varchar(50) NOT NULL,
  -- 票据类型：bank=银行承兑，commercial=商业承兑
  note_type varchar(20) NOT NULL,
  drawer varchar(200),
  payee varchar(200),
  amount numeric NOT NULL DEFAULT 0,
  issue_date date,
  due_date date NOT NULL,
  -- 状态机：received → held → endorsed | discounted | settled | dishonored
  status varchar(20) NOT NULL DEFAULT 'received',
  -- 关联应收（收到的票据冲抵应收账款）或应付（开出的票据）
  ar_id uuid,
  ap_id uuid,
  supplier_id uuid,
  customer_id uuid,
  project_id uuid,
  -- 贴现息（贴现时按 票面×贴现率×剩余天数/360 计算，**计息基准需财务确认**）
  discount_interest numeric,
  discount_rate numeric,
  -- 到期收款/贴现入账金额
  settled_amount numeric,
  settled_date date,
  endorsement_counterparty varchar(200),
  remark text,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_note_code ON erp_note (code);
-- 票号唯一：同一张票据重复入账在并发下由数据库兜底（重复登记返回 409）
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_note_no ON erp_note (note_no);
CREATE INDEX IF NOT EXISTS idx_erp_note_status ON erp_note (status);
CREATE INDEX IF NOT EXISTS idx_erp_note_due_date ON erp_note (due_date);
CREATE INDEX IF NOT EXISTS idx_erp_note_ar ON erp_note (ar_id);
CREATE INDEX IF NOT EXISTS idx_erp_note_ap ON erp_note (ap_id);

DO $$ BEGIN
  ALTER TABLE erp_note
    ADD CONSTRAINT chk_erp_note_type
    CHECK (note_type IN ('bank', 'commercial'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE erp_note
    ADD CONSTRAINT chk_erp_note_status
    CHECK (status IN ('received', 'held', 'endorsed', 'discounted', 'settled', 'dishonored'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE erp_note
    ADD CONSTRAINT chk_erp_note_amount
    CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS erp_note_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL,
  -- 流转动作：create/receive/hold/endorse/discount/settle/dishonor
  action varchar(20) NOT NULL,
  from_status varchar(20),
  to_status varchar(20) NOT NULL,
  amount numeric,
  counterparty varchar(200),
  voucher_ref varchar(100),
  operator varchar(64),
  remark varchar(500),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE INDEX IF NOT EXISTS idx_erp_note_log_note ON erp_note_log (note_id);
-- 同一票据的同一动作只允许一次（背书/贴现重复提交返回 409）
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_note_log_action
  ON erp_note_log (note_id, action)
  WHERE action IN ('endorse', 'discount', 'settle', 'dishonor');

DO $$ BEGIN
  ALTER TABLE erp_note_log
    ADD CONSTRAINT fk_erp_note_log_note
    FOREIGN KEY (note_id) REFERENCES erp_note (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 四、D-08 资产减值与处置
-- ============================================================

-- ast_asset 减值三列：NULL 表示未计提减值（历史数据零影响）
ALTER TABLE ast_asset ADD COLUMN IF NOT EXISTS impairment_amount numeric;
ALTER TABLE ast_asset ADD COLUMN IF NOT EXISTS impairment_date date;
-- 减值后净值（账面价值 − 已计提减值），与 net_value 并存以便追溯减值口径
ALTER TABLE ast_asset ADD COLUMN IF NOT EXISTS net_value_after numeric;

CREATE TABLE IF NOT EXISTS ast_impairment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(20) NOT NULL,
  asset_id uuid NOT NULL,
  -- 减值测试日与期间
  test_date date NOT NULL,
  period varchar(7),
  -- 减值测试三要素：账面价值、可收回金额、减值损失（= 账面 − 可收回，下限 0）
  book_value numeric NOT NULL DEFAULT 0,
  recoverable_amount numeric NOT NULL DEFAULT 0,
  impairment_loss numeric NOT NULL DEFAULT 0,
  method varchar(30) NOT NULL DEFAULT 'recoverable_vs_book',
  voucher_ref varchar(100),
  remark text,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ast_impairment_code ON ast_impairment (code);
CREATE INDEX IF NOT EXISTS idx_ast_impairment_asset ON ast_impairment (asset_id);
CREATE INDEX IF NOT EXISTS idx_ast_impairment_period ON ast_impairment (period);

DO $$ BEGIN
  ALTER TABLE ast_impairment
    ADD CONSTRAINT fk_ast_impairment_asset
    FOREIGN KEY (asset_id) REFERENCES ast_asset (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE ast_impairment
    ADD CONSTRAINT chk_ast_impairment_loss
    CHECK (impairment_loss >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS ast_disposal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(20) NOT NULL,
  asset_id uuid NOT NULL,
  -- 处置方式：sale=出售转让，scrap=报废，donate=捐赠
  disposal_type varchar(20) NOT NULL DEFAULT 'scrap',
  -- 状态机：disposing → disposed | scrapped（rejected 为审批驳回）
  status varchar(20) NOT NULL DEFAULT 'disposing',
  apply_date date NOT NULL,
  dispose_date date,
  -- 处置时点的账面快照（原值/累计折旧/净值），避免处置后回查失真
  original_value numeric NOT NULL DEFAULT 0,
  accumulated_depreciation numeric NOT NULL DEFAULT 0,
  net_value numeric NOT NULL DEFAULT 0,
  -- 处置收入（不含税）与销项税
  disposal_income numeric NOT NULL DEFAULT 0,
  tax_rate numeric,
  tax_amount numeric NOT NULL DEFAULT 0,
  -- 净损益：正为收益（营业外收入），负为损失（营业外支出）
  gain_loss numeric NOT NULL DEFAULT 0,
  voucher_ref varchar(100),
  reason varchar(500),
  remark text,
  approved_by varchar(64),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ast_disposal_code ON ast_disposal (code);
CREATE INDEX IF NOT EXISTS idx_ast_disposal_asset ON ast_disposal (asset_id);
CREATE INDEX IF NOT EXISTS idx_ast_disposal_status ON ast_disposal (status);
-- 同一资产同时只允许一张进行中的处置单
CREATE UNIQUE INDEX IF NOT EXISTS uq_ast_disposal_active
  ON ast_disposal (asset_id)
  WHERE status = 'disposing';
CREATE UNIQUE INDEX IF NOT EXISTS uq_ast_disposal_voucher_ref
  ON ast_disposal (voucher_ref)
  WHERE voucher_ref IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE ast_disposal
    ADD CONSTRAINT chk_ast_disposal_type
    CHECK (disposal_type IN ('sale', 'scrap', 'donate'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE ast_disposal
    ADD CONSTRAINT chk_ast_disposal_status
    CHECK (status IN ('disposing', 'disposed', 'scrapped', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 采购订单 → 资产卡片一对一：同一订单不得重复建卡（并发下由数据库兜底）
CREATE UNIQUE INDEX IF NOT EXISTS uq_ast_asset_purchase_order
  ON ast_asset (purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;

-- ============================================================
-- 五、D-12 BI 预警订阅
-- ============================================================

CREATE TABLE IF NOT EXISTS bi_alert_subscription (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 妙搭 user_id（纯文本，与 erp_ar.owner_user_id 同口径）
  user_id varchar(64) NOT NULL,
  -- 指标 key，与 GET /api/bi/metrics 返回的 key 一致
  metric_key varchar(50) NOT NULL,
  -- 阈值方向：gt=大于阈值触发，lt=小于阈值触发
  threshold_direction varchar(4) NOT NULL DEFAULT 'gt',
  threshold numeric NOT NULL DEFAULT 0,
  -- 通知渠道：feishu=飞书消息，inbox=站内信（由 NotificationsService 同时落库）
  channel varchar(20) NOT NULL DEFAULT 'feishu',
  enabled integer NOT NULL DEFAULT 1,
  last_triggered_at timestamptz(3),
  remark varchar(500),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by user_profile DEFAULT CASE WHEN coalesce(current_setting('app.user_id', true), '') = '' THEN NULL ELSE ROW(current_setting('app.user_id', true), '')::user_profile END
);

-- 同一用户 × 指标 × 渠道唯一：重复订阅返回 409
CREATE UNIQUE INDEX IF NOT EXISTS uq_bi_alert_subscription_user_metric
  ON bi_alert_subscription (user_id, metric_key, channel);
CREATE INDEX IF NOT EXISTS idx_bi_alert_subscription_enabled
  ON bi_alert_subscription (enabled, metric_key);

DO $$ BEGIN
  ALTER TABLE bi_alert_subscription
    ADD CONSTRAINT chk_bi_alert_subscription_direction
    CHECK (threshold_direction IN ('gt', 'lt'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE bi_alert_subscription
    ADD CONSTRAINT chk_bi_alert_subscription_enabled
    CHECK (enabled IN (0, 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
