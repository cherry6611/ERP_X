-- 批次一 / B-08（续）：补齐 sys_code_rule 种子，覆盖代码里实际使用的全部前缀
-- requires: 2026-10-15-upgrade-batch1-system-config.sql
--
-- 背景：`generateBizCode(db, table, col, 'PREFIX')` 在 30+ 处调用，前缀各异。
-- 首版种子只登记了 26 个业务类型，遗漏的前缀会退化为"代码里的 fallback 前缀"，
-- 表现上仍然可用，但用户在编号规则页看不到、也改不了 —— 这正是 B-08 要消除的问题。
--
-- 该表现已通过全仓 grep 提取（ADB/ADJ/AFR/ALC/AMD/APB/AST/BGT/BNK/CAL/CND/CST/CTR/
-- DLV/DPT/DS/EMP/EXP/INV/LRQ/OPP/PAY/PCH/POS/PR/PRF/PRJ/QUO/RCV/REC/REV/RNT/SAL/TRN/TS/VCH）。

INSERT INTO sys_code_rule (biz_type, biz_name, prefix, date_pattern, seq_length, reset_policy, allow_reuse)
SELECT v.biz_type, v.biz_name, v.prefix, 'YYYYMM', 4, 'monthly', v.allow_reuse
FROM (VALUES
  ('ADMIN_BILL',        '行政缴费单',     'ADB', 0),
  ('REVENUE_ADJUST',    '收入调整单',     'ADJ', 0),
  ('ADMIN_AFFAIR',      '行政事务单',     'AFR', 1),
  ('COST_ALLOCATION',   '成本分摊单',     'ALC', 0),
  ('ATTENDANCE_AMEND',  '补卡申请',       'AMD', 1),
  ('BUDGET',            '预算单',         'BGT', 0),
  ('BANK_ACCOUNT',      '银行账户',       'BNK', 0),
  ('CALLOFF',           '合同中止单',     'CAL', 0),
  ('CANDIDATE',         '候选人',         'CND', 1),
  ('DELIVERABLE',       '交付物',         'DLV', 1),
  ('DEPARTMENT',        '部门',           'DPT', 0),
  ('DATASET',           '数据集',         'DS',  0),
  ('EMPLOYEE',          '员工档案',       'EMP', 0),
  ('EXPENSE',           '费用单',         'EXP', 0),
  ('INVOICE',           '发票',           'INV', 0),
  ('LEAVE_REQUEST',     '请假申请',       'LRQ', 1),
  ('OPPORTUNITY',       '商机',           'OPP', 1),
  ('PAYMENT',           '付款单',         'PAY', 0),
  ('PURCHASE_ORDER',    '采购订单',       'PCH', 0),
  ('POSITION',          '岗位',           'POS', 0),
  ('PUR_REQUEST',       '采购申请',       'PR',  1),
  ('PERFORMANCE',       '绩效考核',       'PRF', 0),
  ('RECEIPT',           '回款单',         'RCV', 0),
  ('RECEIPT_ALT',       '回款单（历史前缀 REC）', 'REC', 0),
  ('REVENUE',           '收入确认单',     'REV', 0),
  ('TRAINING',          '培训',           'TRN', 0),
  ('TIMESHEET',         '工时单',         'TS',  1),
  ('PROJECT_COST',      '项目成本',       'CST', 0),
  ('VOUCHER',           '记账凭证',       'VCH', 0),
  ('PURCHASE_COST',     '采购成本单',     'PC',  0)
) AS v(biz_type, biz_name, prefix, allow_reuse)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_code_rule r WHERE r.prefix = v.prefix OR r.biz_type = v.biz_type
);

-- 同一前缀被两个业务类型使用时，读取规则会取到"第一个匹配"，
-- 这里显式把历史重复前缀（AST/ADB/PRJ 等）的归属写进备注，便于运维排查。
UPDATE sys_code_rule
SET remark = coalesce(remark, '') || ' [B-08] 与资产前缀 AST 共用，改前缀前请确认调用方'
WHERE prefix = 'AST' AND biz_type = 'ASSET' AND coalesce(remark, '') NOT LIKE '%B-08%';

UPDATE sys_code_rule
SET remark = coalesce(remark, '') || ' [B-08] 与行政缴费 ADB 共用，改前缀前请确认调用方'
WHERE prefix = 'ADB' AND biz_type = 'ADMIN_BILL' AND coalesce(remark, '') NOT LIKE '%B-08%';
