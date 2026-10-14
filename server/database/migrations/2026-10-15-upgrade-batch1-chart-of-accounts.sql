-- 批次一 / A-10：会计科目表完整性与分级
-- requires: 0000_baseline.sql, 2026-10-14-final-audit.sql, 2026-10-15-upgrade-batch1-accounting-base.sql
--
-- 口径说明（企业会计准则 2006 科目表，数据服务公司适用）：
--   1001 库存现金（借）          1002 银行存款（借，非末级）
--   100201 银行存款-基本户（借）  100202 银行存款-一般户（借）
--   1122 应收账款（借）          1123 预付账款（借）
--   1403 原材料（借，评估项 A-09 保留占位）  1601 固定资产（借）  1602 累计折旧（贷）
--   2202 应付账款（贷）          2203 预收账款（贷）  2211 应付职工薪酬（贷）
--   2221 应交税费（贷，非末级）   222101 销项税（贷）  222102 进项税（借）
--   4001 实收资本（贷）          4103 本年利润（贷）  4104 利润分配（贷，非末级）
--   410401 未分配利润（贷）       410415 提取盈余公积（贷）
--   6001 主营业务收入（贷）       6051 其他业务收入（贷）  6301 营业外收入（贷）
--   6401 主营业务成本（借）       6402 其他业务成本（借）  6403 税金及附加（借）
--   6601 销售费用（借）          6602 管理费用（借，非末级）  660201 管理费用-办公费（借）
--   660202 管理费用-差旅费（借）  660203 管理费用-咨询费（借）  660204 管理费用-折旧费（借）
--   660205 管理费用-房租水电（借）
--   6603 财务费用（借）          6701 资产减值损失（借）  6711 营业外支出（借）  6801 所得税费用（借）
--
-- 兼容处理：
--   历史实现把"银行存款"记为 1001，本迁移按准则把 1001 纠正为"库存现金"，
--   并把历史记账数据从 1001 迁移到 100201（银行存款-基本户）；
--   同时停用旧的重复科目 1002「银行存款—一般户」（已由 100202 承接）。

-- ============================================================
-- 一、历史数据纠正：1001 银行存款 → 库存现金 + 银行存款-基本户
-- ============================================================

-- 1.1 先把旧的 1002「银行存款—一般户」升格为 1002「银行存款」父科目
UPDATE fin_account
SET name = '银行存款', is_leaf = 0, level = 1, direction = 'debit', sort_no = 1020
WHERE code = '1002';

-- 1.2 新增 100201 / 100202 末级子科目（幂等）
INSERT INTO fin_account (code, name, account_type, status, parent_code, level, is_leaf, direction, sort_no)
SELECT v.code, v.name, v.account_type, 'active', v.parent_code, v.level, v.is_leaf, v.direction, v.sort_no
FROM (VALUES
  ('100201', '银行存款-基本户', 'asset', '1002', 2, 1, 'debit', 1021),
  ('100202', '银行存款-一般户', 'asset', '1002', 2, 1, 'debit', 1022)
) AS v(code, name, account_type, parent_code, level, is_leaf, direction, sort_no)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

-- 1.3 历史凭证行：1001（旧语义=银行存款）挂到 100201
UPDATE fin_voucher_line l
SET account_id = (SELECT id FROM fin_account WHERE code = '100201')
WHERE l.account_id = (SELECT id FROM fin_account WHERE code = '1001')
  AND EXISTS (SELECT 1 FROM fin_account WHERE code = '100201');

-- 1.4 1001 纠正为库存现金（末级）
UPDATE fin_account
SET name = '库存现金', account_type = 'asset', is_leaf = 1, level = 1, direction = 'debit',
    parent_code = NULL, sort_no = 1010
WHERE code = '1001';

-- ============================================================
-- 二、科目表补全
-- ============================================================

INSERT INTO fin_account (code, name, account_type, status, parent_code, level, is_leaf, direction, sort_no)
SELECT v.code, v.name, v.account_type, 'active', v.parent_code, v.level, v.is_leaf, v.direction, v.sort_no
FROM (VALUES
  -- 资产类
  ('1002',   '银行存款',              'asset',     NULL,   1, 0, 'debit',  1020),
  ('1123',   '预付账款',              'asset',     NULL,   1, 1, 'debit',  1130),
  ('1122',   '应收账款',              'asset',     NULL,   1, 1, 'debit',  1120),
  ('1403',   '原材料',                'asset',     NULL,   1, 1, 'debit',  1403),
  ('1601',   '固定资产',              'asset',     NULL,   1, 1, 'debit',  1601),
  ('1602',   '累计折旧',              'asset',     NULL,   1, 1, 'credit', 1602),
  -- 负债类
  ('2202',   '应付账款',              'liability', NULL,   1, 1, 'credit', 2202),
  ('2203',   '预收账款',              'liability', NULL,   1, 1, 'credit', 2203),
  ('2211',   '应付职工薪酬',          'liability', NULL,   1, 1, 'credit', 2211),
  ('2221',   '应交税费',              'liability', NULL,   1, 0, 'credit', 2221),
  ('222101', '应交税费-销项税',        'liability', '2221', 2, 1, 'credit', 22211),
  ('222102', '应交税费-进项税',        'liability', '2221', 2, 1, 'debit',  22212),
  -- 所有者权益类
  ('4001',   '实收资本',              'equity',    NULL,   1, 1, 'credit', 4001),
  ('4103',   '本年利润',              'equity',    NULL,   1, 1, 'credit', 4103),
  ('4104',   '利润分配',              'equity',    NULL,   1, 0, 'credit', 4104),
  ('410401', '利润分配-未分配利润',    'equity',    '4104', 2, 1, 'credit', 41041),
  ('410415', '利润分配-提取盈余公积',  'equity',    '4104', 2, 1, 'credit', 41042),
  -- 收入类
  ('6001',   '主营业务收入',          'income',    NULL,   1, 1, 'credit', 6001),
  ('6051',   '其他业务收入',          'income',    NULL,   1, 1, 'credit', 6051),
  ('6301',   '营业外收入',            'income',    NULL,   1, 1, 'credit', 6301),
  -- 成本费用类
  ('6401',   '主营业务成本',          'expense',   NULL,   1, 1, 'debit',  6401),
  ('6402',   '其他业务成本',          'expense',   NULL,   1, 1, 'debit',  6402),
  ('6403',   '税金及附加',            'expense',   NULL,   1, 1, 'debit',  6403),
  ('6601',   '销售费用',              'expense',   NULL,   1, 1, 'debit',  6601),
  ('6602',   '管理费用',              'expense',   NULL,   1, 0, 'debit',  6602),
  ('660201', '管理费用-办公费',        'expense',   '6602', 2, 1, 'debit',  66021),
  ('660202', '管理费用-差旅费',        'expense',   '6602', 2, 1, 'debit',  66022),
  ('660203', '管理费用-咨询费',        'expense',   '6602', 2, 1, 'debit',  66023),
  ('660204', '管理费用-折旧费',        'expense',   '6602', 2, 1, 'debit',  66024),
  ('660205', '管理费用-房租水电',      'expense',   '6602', 2, 1, 'debit',  66025),
  ('6603',   '财务费用',              'expense',   NULL,   1, 1, 'debit',  6603),
  ('6701',   '资产减值损失',          'expense',   NULL,   1, 1, 'debit',  6701),
  ('6711',   '营业外支出',            'expense',   NULL,   1, 1, 'debit',  6711),
  ('6801',   '所得税费用',            'expense',   NULL,   1, 1, 'debit',  6801)
) AS v(code, name, account_type, parent_code, level, is_leaf, direction, sort_no)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

-- 已存在科目的层级/方向纠偏（幂等，覆盖 final-audit 等历史迁移写入的裸科目）
UPDATE fin_account SET name = '应交税费', parent_code = NULL, level = 1, is_leaf = 0, direction = 'credit', sort_no = 2221
WHERE code = '2221';
UPDATE fin_account SET parent_code = '2221', level = 2, is_leaf = 1, direction = 'credit', sort_no = 22211
WHERE code = '222101';
UPDATE fin_account SET parent_code = '2221', level = 2, is_leaf = 1, direction = 'debit', sort_no = 22212
WHERE code = '222102';
UPDATE fin_account SET parent_code = '6602', level = 2, is_leaf = 1, direction = 'debit', sort_no = 66021
WHERE code = '660201';
UPDATE fin_account SET is_leaf = 0, level = 1, direction = 'debit' WHERE code = '6602';
UPDATE fin_account SET is_leaf = 0, level = 1, direction = 'credit' WHERE code = '2221';
UPDATE fin_account SET is_leaf = 0, level = 1, direction = 'credit' WHERE code = '4104';

-- ============================================================
-- 三、辅助维度种子（A-05）
-- ============================================================

INSERT INTO fin_aux_dimension (code, name, source_type, enabled, sort_no)
SELECT v.code, v.name, v.source_type, 1, v.sort_no
FROM (VALUES
  ('department', '部门',   'department', 10),
  ('project',    '项目',   'project',    20),
  ('customer',   '客户',   'customer',   30),
  ('supplier',   '供应商', 'supplier',   40),
  ('employee',   '员工',   'employee',   50)
) AS v(code, name, source_type, sort_no)
WHERE NOT EXISTS (SELECT 1 FROM fin_aux_dimension d WHERE d.code = v.code);

-- 管理费用默认要求挂部门辅助核算（可按财务口径调整；不影响历史凭证，仅约束新增凭证）
UPDATE fin_account SET aux_required = '["department"]'
WHERE code IN ('660201', '660202', '660203', '660204', '660205')
  AND (aux_required IS NULL OR aux_required = '[]');
