-- 批次一 B-05 收敛：把前端硬编码的业务标签迁入 sys_dict（字典成为唯一权威）
-- requires: 2026-10-15-upgrade-batch1-system-config.sql
--
-- 背景：`client/src/utils/biz-labels.ts` 里 14 组业务状态标签是硬编码常量，
-- 改一个文案要发版，且业务方无法自行调整（例如把"待回款"改成"待收款"）。
-- B-05 要求改为读 `sys_dict`。
--
-- 迁移策略：**字典优先、常量兜底**。前端 `labelFor` / `withDictionaryFallback`
-- 在字典缺项时回落到原常量，因此本迁移只需把**现有文案原样种入**，
-- 不改变任何界面显示；之后业务方在设置页改字典即生效，无需发版。
--
-- 与既有 `cost_type` 字典的关系（**注意**）：
-- 迁移 `batch1-system-config.sql` 已种入 `cost_type`，但其键集与前端常量**不完全一致**
-- （字典有 outsourcing/purchase/software/data/other，常量有 outsource/compute/
-- storage/tool/flex_labor）。因此 `COST_TYPE_LABELS` **不做字典接管** ——
-- 强行接管会让界面出现常量里没有的键（或反过来显示原始英文 key）。
-- 该差异属于既有数据不一致，需业务确认统一口径后再接管；此处如实登记，
-- 不用"看起来已统一"的方式掩盖。

/* ========== 商机 / 线索 ========== */

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'lead_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('new', '新建', 10),
  ('following', '跟进中', 20),
  ('converted', '已转化', 30),
  ('lost', '已流失', 40)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'lead_status' AND d.dict_key = v.key
);

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'opp_stage', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('new', '新建', 10),
  ('following', '跟进中', 20),
  ('quoting', '方案报价', 30),
  ('negotiating', '谈判', 40),
  ('won', '赢单', 50),
  ('lost', '输单', 60)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'opp_stage' AND d.dict_key = v.key
);

/* ========== 报价 / 合同 ========== */

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'quotation_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('draft', '草稿', 10),
  ('pending_approval', '待审批', 20),
  ('approved', '已生效', 30),
  ('converted', '已转合同', 40),
  ('void', '已作废', 50)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'quotation_status' AND d.dict_key = v.key
);

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'contract_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('draft', '草稿', 10),
  ('approving', '审批中', 20),
  ('active', '已生效', 30),
  ('performing', '履约中', 40),
  ('completed', '已完成', 50),
  ('closed', '已关闭', 60),
  ('terminated', '已终止', 70)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'contract_status' AND d.dict_key = v.key
);

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'billing_model', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('project', '项目制', 10),
  ('quantity', '按量计费', 20),
  ('subscription', '订阅制', 30),
  ('framework', '框架合同', 40)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'billing_model' AND d.dict_key = v.key
);

/* ========== 项目 / 工时 ========== */

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'project_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('initiating', '立项中', 10),
  ('executing', '执行中', 20),
  ('delivering', '交付中', 30),
  ('accepting', '验收中', 40),
  ('closed', '已结项', 50)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'project_status' AND d.dict_key = v.key
);

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'timesheet_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('draft', '草稿', 10),
  ('submitted', '已提交', 20),
  ('confirmed', '已确认', 30)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'timesheet_status' AND d.dict_key = v.key
);

/* ========== 财务：凭证 / 应收 / 收款 / 应付 / 付款 ========== */

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'voucher_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('draft', '草稿', 10),
  ('posted', '已过账', 20),
  ('voided', '已作废', 30)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'voucher_status' AND d.dict_key = v.key
);

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'ar_source', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('manual', '手工登记', 10),
  ('revenue', '收入确认', 20)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'ar_source' AND d.dict_key = v.key
);

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'ar_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('open', '待回款', 10),
  ('partial', '部分回款', 20),
  ('settled', '已结清', 30)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'ar_status' AND d.dict_key = v.key
);

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'receipt_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('unmatched', '未核销', 10),
  ('partial', '部分核销', 20),
  ('matched', '已核销', 30)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'receipt_status' AND d.dict_key = v.key
);

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'ap_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('pending', '待付款', 10),
  ('partial', '部分付款', 20),
  ('paid', '已付清', 30)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'ap_status' AND d.dict_key = v.key
);

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'payment_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('pending', '待审批', 10),
  ('approved', '已批准', 20),
  ('rejected', '已驳回', 30),
  ('paid', '已核销', 40)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'payment_status' AND d.dict_key = v.key
);

/* ========== 收入确认方式 ========== */

INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'revenue_method', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('progress', '进度法', 10),
  ('milestone', '里程碑', 20),
  ('quantity', '按量交付', 30),
  ('subscription', '分期确认', 40)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'revenue_method' AND d.dict_key = v.key
);

/* ========== 登记说明 ========== */

COMMENT ON COLUMN sys_dict.builtin IS
  'B-05：内置字典（随迁移种入）。业务方可在设置页调整 dict_label 以改文案；'
  'dict_key 请勿修改 —— 前端 biz-labels 以 key 匹配，改 key 会导致回落为原始 key 显示。';
