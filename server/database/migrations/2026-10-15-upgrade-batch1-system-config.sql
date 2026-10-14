-- 批次一 / B-03 + B-08 + B-07 + B-06：系统字典、参数、编号规则、数据保留策略、附件版本
-- requires: 2026-10-15-upgrade-batch1-accounting-base.sql
--
-- 背景（需求书 §2.2）：
--   B-03 标签与参数全部硬编码（client/src/utils/biz-labels.ts、shared/tax.ts、
--        server/platform/cron-map.ts 均为常量），改文案或加成本类型必须发版；
--   B-08 编号前缀硬编码在 service 内（generateBizCode(db, table, col, 'CTR')）；
--   B-07 comp_audit_log 无保留策略会无限增长；
--   B-06 comp_stored_file 无版本列，重复上传只能覆盖。
--
-- 迁移策略（B-03 要求）：先落库并用种子数据对齐现有硬编码值，代码改为读库并保留 fallback。

-- ============================================================
-- 一、B-03 字典
-- ============================================================

CREATE TABLE IF NOT EXISTS sys_dict (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 字典类型，如 cost_type / expense_category / attachment_type / invoice_type
  dict_type varchar(64) NOT NULL,
  dict_key varchar(64) NOT NULL,
  dict_label varchar(120) NOT NULL,
  -- 扩展属性：JSON（颜色/排序语义/附加说明）
  extra varchar(500),
  sort_no integer NOT NULL DEFAULT 0,
  enabled integer NOT NULL DEFAULT 1,
  -- 系统内置项禁止删除（仅允许停用），避免"删掉后页面空白"
  builtin integer NOT NULL DEFAULT 0,
  remark varchar(200),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_dict_type_key
  ON sys_dict (dict_type, dict_key);
CREATE INDEX IF NOT EXISTS idx_sys_dict_type
  ON sys_dict (dict_type, sort_no);

-- ============================================================
-- 二、B-03 系统参数
-- ============================================================

CREATE TABLE IF NOT EXISTS sys_param (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  param_key varchar(64) NOT NULL,
  param_value varchar(500) NOT NULL DEFAULT '',
  -- string / number / boolean / json
  value_type varchar(16) NOT NULL DEFAULT 'string',
  param_group varchar(32) NOT NULL DEFAULT 'general',
  description varchar(300),
  -- 0 = 代码读取但 UI 不允许改（只读展示）
  editable integer NOT NULL DEFAULT 1,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_param_key ON sys_param (param_key);
CREATE INDEX IF NOT EXISTS idx_sys_param_group ON sys_param (param_group);

-- ============================================================
-- 三、B-08 编号规则
-- ============================================================

CREATE TABLE IF NOT EXISTS sys_code_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 业务类型，与 generateBizCode 的 bizType 对应，如 CONTRACT/QUOTATION/PROJECT
  biz_type varchar(40) NOT NULL,
  biz_name varchar(80) NOT NULL,
  prefix varchar(16) NOT NULL,
  -- YYYYMM / YYYY / NONE
  date_pattern varchar(10) NOT NULL DEFAULT 'YYYYMM',
  seq_length integer NOT NULL DEFAULT 4,
  -- never / yearly / monthly
  reset_policy varchar(16) NOT NULL DEFAULT 'monthly',
  -- 财务类单据禁止重用编号（B-09）
  allow_reuse integer NOT NULL DEFAULT 0,
  enabled integer NOT NULL DEFAULT 1,
  remark varchar(200),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_code_rule_biz ON sys_code_rule (biz_type);

DO $$ BEGIN
  ALTER TABLE sys_code_rule
    ADD CONSTRAINT chk_sys_code_rule_seq_length
    CHECK (seq_length >= 3 AND seq_length <= 10);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE sys_code_rule
    ADD CONSTRAINT chk_sys_code_rule_date_pattern
    CHECK (date_pattern IN ('YYYYMM', 'YYYY', 'NONE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE sys_code_rule
    ADD CONSTRAINT chk_sys_code_rule_reset
    CHECK (reset_policy IN ('never', 'yearly', 'monthly'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 四、B-07 数据保留策略与归档
-- ============================================================

CREATE TABLE IF NOT EXISTS sys_data_retention_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- audit_log / login_session / login_audit / inbox_message / biz_document
  data_type varchar(40) NOT NULL,
  display_name varchar(80) NOT NULL,
  -- 在线保留天数（超期归档）
  retain_days integer NOT NULL DEFAULT 730,
  -- none / archive / delete（archive 需对象存储，未配置时降级为标记）
  action varchar(16) NOT NULL DEFAULT 'archive',
  enabled integer NOT NULL DEFAULT 1,
  last_run_at timestamptz(3),
  last_run_count integer,
  remark varchar(200),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_data_retention_type
  ON sys_data_retention_policy (data_type);

-- 归档表：超期审计日志落此处，在线表可安全清理（B-07 要求"归档可检索"）
CREATE TABLE IF NOT EXISTS comp_audit_log_archive (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid,
  object_type varchar(60),
  object_id varchar(120),
  action varchar(40),
  actor_user_id varchar(64),
  detail text,
  -- 原始记录时间，检索按此排序
  occurred_at timestamptz(3),
  archived_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comp_audit_log_archive_time
  ON comp_audit_log_archive (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_comp_audit_log_archive_object
  ON comp_audit_log_archive (object_type, object_id);

-- PII 处理工单（B-07 要求"导出/删除工单流程"）
CREATE TABLE IF NOT EXISTS sys_pii_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_type varchar(20) NOT NULL,
  -- 主体：employee / customer / supplier / user
  subject_type varchar(20) NOT NULL,
  subject_id uuid NOT NULL,
  subject_name varchar(120),
  reason varchar(500),
  status varchar(20) NOT NULL DEFAULT 'pending',
  -- 导出结果文件路径或脱敏结果摘要
  result_summary text,
  requested_by varchar(64),
  handled_by varchar(64),
  handled_at timestamptz(3),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sys_pii_request_status
  ON sys_pii_request (status, _created_at DESC);

DO $$ BEGIN
  ALTER TABLE sys_pii_request
    ADD CONSTRAINT chk_sys_pii_request_type
    CHECK (request_type IN ('export', 'anonymize'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE sys_pii_request
    ADD CONSTRAINT chk_sys_pii_request_status
    CHECK (status IN ('pending', 'approved', 'completed', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 五、B-06 附件版本
-- ============================================================

ALTER TABLE comp_stored_file ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE comp_stored_file ADD COLUMN IF NOT EXISTS parent_file_id uuid;
ALTER TABLE comp_stored_file ADD COLUMN IF NOT EXISTS is_latest integer NOT NULL DEFAULT 1;
-- 内容魔数（十六进制前缀）与检测结论，用于"改名伪装"拦截留痕
ALTER TABLE comp_stored_file ADD COLUMN IF NOT EXISTS magic_hex varchar(32);
ALTER TABLE comp_stored_file ADD COLUMN IF NOT EXISTS scan_status varchar(20) NOT NULL DEFAULT 'skipped';
ALTER TABLE comp_stored_file ADD COLUMN IF NOT EXISTS scan_detail varchar(300);

CREATE INDEX IF NOT EXISTS idx_comp_stored_file_parent ON comp_stored_file (parent_file_id);
CREATE INDEX IF NOT EXISTS idx_comp_stored_file_latest ON comp_stored_file (is_latest);

-- 同一版本链内版本号唯一。注意不能用 `coalesce(parent_file_id, id)` 建唯一索引
-- （coalesce 非 immutable，PostgreSQL 会拒绝），改用"版本链根 id"列 + 触发器维护。
ALTER TABLE comp_stored_file ADD COLUMN IF NOT EXISTS root_file_id uuid;

UPDATE comp_stored_file
SET root_file_id = coalesce(parent_file_id, id)
WHERE root_file_id IS NULL;

CREATE OR REPLACE FUNCTION comp_stored_file_set_root()
RETURNS trigger AS $$
BEGIN
  IF NEW.root_file_id IS NULL THEN
    NEW.root_file_id := coalesce(NEW.parent_file_id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_comp_stored_file_root ON comp_stored_file;
CREATE TRIGGER trg_comp_stored_file_root
  BEFORE INSERT OR UPDATE OF parent_file_id, root_file_id ON comp_stored_file
  FOR EACH ROW EXECUTE FUNCTION comp_stored_file_set_root();

CREATE UNIQUE INDEX IF NOT EXISTS uq_comp_stored_file_version
  ON comp_stored_file (root_file_id, version);

DO $$ BEGIN
  ALTER TABLE comp_stored_file
    ADD CONSTRAINT chk_comp_stored_file_scan_status
    CHECK (scan_status IN ('skipped', 'clean', 'infected', 'unsupported', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 六、B-03 种子数据：对齐现有硬编码值（代码改为读库，保留 fallback）
-- ============================================================

-- 成本类型（原硬编码于 client/src/utils/biz-labels.ts COST_TYPE_LABELS）
INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'cost_type', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('labor', '人力成本', 10),
  ('flex_labor', '灵活用工', 20),
  ('outsourcing', '外协费用', 30),
  ('travel', '差旅费', 40),
  ('purchase', '采购成本', 50),
  ('software', '软件与工具', 60),
  ('data', '数据采购', 70),
  ('other', '其他成本', 99)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'cost_type' AND d.dict_key = v.key
);

-- 费用类别（原硬编码于 fin_expense 前端）
INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'expense_category', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('travel', '差旅交通', 10),
  ('meal', '餐饮招待', 20),
  ('office', '办公用品', 30),
  ('communication', '通讯费', 40),
  ('entertainment', '业务招待', 50),
  ('training', '培训费', 60),
  ('welfare', '员工福利', 70),
  ('other', '其他费用', 99)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'expense_category' AND d.dict_key = v.key
);

-- 附件类型
INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'attachment_type', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('contract', '合同文件', 10),
  ('quotation', '报价单', 20),
  ('requirement', '需求文档', 30),
  ('plan', '执行计划', 40),
  ('deliverable', '交付物', 50),
  ('invoice', '发票影像', 60),
  ('receipt', '回款凭证', 70),
  ('other', '其他附件', 99)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'attachment_type' AND d.dict_key = v.key
);

-- 发票类型
INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'invoice_type', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('vat_special', '增值税专用发票', 10),
  ('vat_normal', '增值税普通发票', 20),
  ('electronic', '电子发票', 30),
  ('other', '其他票据', 99)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'invoice_type' AND d.dict_key = v.key
);

-- 税率档位（原硬编码于 shared/tax.ts TAX_RATES = [0,1,3,6,9,13]）
INSERT INTO sys_dict (dict_type, dict_key, dict_label, extra, sort_no, builtin)
SELECT 'tax_rate', v.key, v.label, v.extra, v.sort_no, 1
FROM (VALUES
  ('0', '0%（免税）', '{"rate":0}', 10),
  ('1', '1%（征收率）', '{"rate":1}', 20),
  ('3', '3%（征收率）', '{"rate":3}', 30),
  ('6', '6%（现代服务）', '{"rate":6}', 40),
  ('9', '9%（交通运输/不动产）', '{"rate":9}', 50),
  ('13', '13%（货物销售）', '{"rate":13}', 60)
) AS v(key, label, extra, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'tax_rate' AND d.dict_key = v.key
);

-- 项目/合同/交付物类型与状态标签（前端 Badge 映射用）
INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'deliverable_type', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('dataset', '数据集', 10),
  ('report', '报告', 20),
  ('software', '软件', 30),
  ('doc', '文档', 40),
  ('other', '其他', 99)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'deliverable_type' AND d.dict_key = v.key
);

-- 系统参数（对齐现有硬编码默认值）
INSERT INTO sys_param (param_key, param_value, value_type, param_group, description, editable)
SELECT v.key, v.value, v.value_type, v.param_group, v.description, v.editable
FROM (VALUES
  ('approval.quotation_min_gross_margin', '20', 'number', 'approval', '报价单最低毛利率（%），低于此值前端红色警示并需审批', 1),
  ('approval.budget_overrun_warn_pct', '10', 'number', 'approval', '预算超支告警比例（%）', 1),
  ('finance.basic_deduction_per_month', '5000', 'number', 'finance', '个税基本减除费用标准（元/月）', 1),
  ('finance.password_max_age_days', '90', 'number', 'security', '密码强制更换周期（天），0 表示不强制', 1),
  ('security.login_max_attempts', '5', 'number', 'security', '登录连续失败上限，超过则锁定', 1),
  ('security.lock_minutes', '15', 'number', 'security', '账号锁定时长（分钟）', 1),
  ('security.mfa_forced_roles', '["admin","user_admin","finance_viewer"]', 'json', 'security', '强制启用 MFA 的角色清单', 1),
  ('period.cross_month_lock', '0', 'boolean', 'finance', '是否禁止跨期记账（1 禁止）', 1),
  ('number.allow_void_reuse', '0', 'boolean', 'numbering', '作废单据编号是否可重用（财务类红线，默认禁止）', 0),
  ('attachment.max_size_mb', '20', 'number', 'attachment', '单附件大小上限（MB）', 1),
  ('attachment.scan_provider', 'none', 'string', 'attachment', '病毒扫描提供方：none / clamav / http', 1),
  ('ui.default_page_size', '20', 'number', 'ui', '列表页默认每页条数', 1)
) AS v(key, value, value_type, param_group, description, editable)
WHERE NOT EXISTS (SELECT 1 FROM sys_param p WHERE p.param_key = v.key);

-- 编号规则（对齐现有 service 内硬编码前缀，见 AGENTS.md「业务编号」章节）
INSERT INTO sys_code_rule (biz_type, biz_name, prefix, date_pattern, seq_length, reset_policy, allow_reuse)
SELECT v.biz_type, v.biz_name, v.prefix, 'YYYYMM', 4, 'monthly', v.allow_reuse
FROM (VALUES
  ('CONTRACT', '合同', 'CTR', 0),
  ('QUOTATION', '报价单', 'QUO', 0),
  ('PROJECT', '项目', 'PRJ', 0),
  ('LEAD', '线索', 'LEAD', 1),
  ('OPPORTUNITY', '商机', 'OPP', 1),
  ('CUSTOMER', '客户', 'CUS', 0),
  ('SUPPLIER', '供应商', 'SUP', 0),
  ('PUR_ORDER', '采购订单', 'PO', 0),
  ('PUR_REQUEST', '采购申请', 'PR', 1),
  ('AP_BILL', '应付单', 'APB', 0),
  ('AR_BILL', '应收单', 'ARB', 0),
  ('RECEIPT', '回款单', 'RCP', 0),
  ('PAYMENT', '付款单', 'PAY', 0),
  ('INVOICE', '发票', 'INV', 0),
  ('VOUCHER', '记账凭证', 'VCH', 0),
  ('PAYROLL', '工资单', 'SAL', 0),
  ('EXPENSE_APPLY', '费用申请', 'EXA', 1),
  ('EXPENSE_CLAIM', '报销单', 'EXC', 0),
  ('ASSET', '固定资产', 'AST', 0),
  ('ASSET_CHANGE', '资产变更', 'ASC', 1),
  ('DELIVERABLE', '交付物', 'DLV', 1),
  ('DATASET', '数据集', 'DS', 0),
  ('GRANT', '数据授权', 'GRT', 0),
  ('PROJECT_COST', '项目成本', 'CST', 0),
  ('ADMIN_RENT', '租房合同', 'RNT', 0),
  ('ADMIN_BILL', '行政缴费', 'ABL', 0)
) AS v(biz_type, biz_name, prefix, allow_reuse)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_code_rule r WHERE r.biz_type = v.biz_type
);

-- 数据保留策略种子（B-07）
INSERT INTO sys_data_retention_policy (data_type, display_name, retain_days, action)
SELECT v.data_type, v.display_name, v.retain_days, v.action
FROM (VALUES
  ('audit_log', '操作审计日志', 730, 'archive'),
  ('login_audit', '登录审计日志', 730, 'archive'),
  ('login_session', '登录会话', 30, 'delete'),
  ('inbox_message', '站内信', 365, 'archive'),
  ('bank_statement', '银行流水', 3650, 'archive')
) AS v(data_type, display_name, retain_days, action)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_data_retention_policy p WHERE p.data_type = v.data_type
);
