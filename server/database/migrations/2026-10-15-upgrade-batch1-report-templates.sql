-- 批次一 / A-01 + A-02：法定财务报表模板种子（资产负债表 / 利润表 / 现金流量表-间接法）
-- requires: 2026-10-15-upgrade-batch1-accounting-base.sql
--
-- 公式 DSL 见 server/modules/finance-reports/report-formula.ts：
--   科目余额(code[, 净|借|贷]) / 科目发生(code[, 净|借|贷]) / 期初余额(code[, 净|借|贷])
--   科目变动(code[, 净|借|贷]) / 行(rowNo) / ABS(...) / 数字
--
-- 口径说明（需财务确认）：
--   1) 资产负债表按"报表日余额"取数，未分配利润 = 410401 + 4103 + 本年损益净额()。
--      其中 本年损益净额() = 本会计年度至本期末损益类科目净额（收入 − 费用），
--      用于年终结转前把未结转的本期利润纳入权益，保证月度恒等式通过；
--      年终结转后损益科目清零、4103 承接，该项为 0，不会重复;
--   2) 利润表"本期"取本期发生额，"本年累计"取 1 月至本期的发生额；
--   3) 现金流量表采用**间接法**（不修改凭证模型），现金及现金等价物 = 1001 库存现金 + 1002 银行存款。

ALTER TABLE fin_report_template
  ADD COLUMN IF NOT EXISTS section varchar(32) NOT NULL DEFAULT 'default';

-- ============================================================
-- 一、资产负债表（report_code = balance_sheet）
-- ============================================================

INSERT INTO fin_report_template (report_code, row_no, row_name, formula, section, indent, bold, sort_no)
SELECT v.report_code, v.row_no, v.row_name, v.formula, v.section, v.indent, v.bold, v.sort_no
FROM (VALUES
  ('balance_sheet', '1',  '货币资金',           '科目余额(1001, 净) + 科目余额(1002, 净)', 'assets', 1, 0, 1010),
  ('balance_sheet', '2',  '应收账款',           '科目余额(1122, 借)',                      'assets', 1, 0, 1020),
  ('balance_sheet', '3',  '预付款项',           '科目余额(1123, 借)',                      'assets', 1, 0, 1030),
  ('balance_sheet', '4',  '存货',               '科目余额(1403, 借)',                      'assets', 1, 0, 1040),
  ('balance_sheet', '5',  '流动资产合计',       '行(1) + 行(2) + 行(3) + 行(4)',           'assets', 0, 1, 1050),
  ('balance_sheet', '6',  '固定资产原价',       '科目余额(1601, 借)',                      'assets', 1, 0, 1060),
  ('balance_sheet', '7',  '减：累计折旧',       '科目余额(1602, 贷)',                      'assets', 2, 0, 1070),
  ('balance_sheet', '8',  '固定资产账面价值',   '行(6) - 行(7)',                           'assets', 1, 0, 1080),
  ('balance_sheet', '9',  '非流动资产合计',     '行(8)',                                   'assets', 0, 1, 1090),
  ('balance_sheet', '10', '资产总计',           '行(5) + 行(9)',                           'assets', 0, 1, 1100),

  ('balance_sheet', '11', '应付账款',           '科目余额(2202, 贷)',                      'liabilities', 1, 0, 2010),
  ('balance_sheet', '12', '预收款项',           '科目余额(2203, 贷)',                      'liabilities', 1, 0, 2020),
  ('balance_sheet', '13', '应付职工薪酬',       '科目余额(2211, 贷)',                      'liabilities', 1, 0, 2030),
  ('balance_sheet', '14', '应交税费',           '科目余额(2221, 贷)',                      'liabilities', 1, 0, 2040),
  ('balance_sheet', '15', '流动负债合计',       '行(11) + 行(12) + 行(13) + 行(14)',       'liabilities', 0, 1, 2050),
  ('balance_sheet', '16', '非流动负债合计',     '0',                                       'liabilities', 0, 1, 2060),
  ('balance_sheet', '17', '负债合计',           '行(15) + 行(16)',                         'liabilities', 0, 1, 2070),

  ('balance_sheet', '18', '实收资本',           '科目余额(4001, 贷)',                      'equity', 1, 0, 3010),
  ('balance_sheet', '19', '盈余公积',           '科目余额(410415, 贷)',                    'equity', 1, 0, 3020),
  ('balance_sheet', '20', '未分配利润',         '科目余额(410401, 贷) + 科目余额(4103, 贷) + 本年损益净额()', 'equity', 1, 0, 3030),
  ('balance_sheet', '21', '所有者权益合计',     '行(18) + 行(19) + 行(20)',                'equity', 0, 1, 3040),
  ('balance_sheet', '22', '负债和所有者权益总计', '行(17) + 行(21)',                       'equity', 0, 1, 3050)
) AS v(report_code, row_no, row_name, formula, section, indent, bold, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM fin_report_template t
  WHERE t.report_code = v.report_code AND t.row_no = v.row_no
);

-- ============================================================
-- 二、利润表（report_code = income_statement）
-- 本期 = 本期发生额；本年累计由引擎按 1 月至本期发生额另算。
-- ============================================================

INSERT INTO fin_report_template (report_code, row_no, row_name, formula, section, indent, bold, sort_no)
SELECT v.report_code, v.row_no, v.row_name, v.formula, v.section, v.indent, v.bold, v.sort_no
FROM (VALUES
  ('income_statement', '1',  '一、营业收入',     '科目发生(6001, 贷) + 科目发生(6051, 贷)', 'revenue', 0, 1, 1010),
  ('income_statement', '2',  '减：营业成本',     '科目发生(6401, 借) + 科目发生(6402, 借)', 'cost', 0, 1, 1020),
  ('income_statement', '3',  '税金及附加',       '科目发生(6403, 借)',                      'cost', 1, 0, 1030),
  ('income_statement', '4',  '销售费用',         '科目发生(6601, 借)',                      'cost', 1, 0, 1040),
  ('income_statement', '5',  '管理费用',         '科目发生(6602, 借)',                      'cost', 1, 0, 1050),
  ('income_statement', '6',  '财务费用',         '科目发生(6603, 借)',                      'cost', 1, 0, 1060),
  ('income_statement', '7',  '加：资产减值损失', '科目发生(6701, 借)',                      'cost', 1, 0, 1070),
  ('income_statement', '8',  '二、营业利润',     '行(1) - 行(2) - 行(3) - 行(4) - 行(5) - 行(6) - 行(7)', 'profit', 0, 1, 1080),
  ('income_statement', '24', '加：营业外收入',   '科目发生(6301, 贷)',                      'profit', 1, 0, 1090),
  ('income_statement', '9',  '减：营业外支出',   '科目发生(6711, 借)',                      'profit', 1, 0, 1100),
  ('income_statement', '10', '三、利润总额',     '行(8) + 行(24) - 行(9)',                  'profit', 0, 1, 1110),
  ('income_statement', '11', '减：所得税费用',   '科目发生(6801, 借)',                      'profit', 1, 0, 1120),
  ('income_statement', '12', '四、净利润',       '行(10) - 行(11)',                         'profit', 0, 1, 1130)
) AS v(report_code, row_no, row_name, formula, section, indent, bold, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM fin_report_template t
  WHERE t.report_code = v.report_code AND t.row_no = v.row_no
);

-- ============================================================
-- 三、现金流量表（间接法，report_code = cash_flow）
-- 现金及现金等价物 = 1001 库存现金 + 1002 银行存款
-- ============================================================

INSERT INTO fin_report_template (report_code, row_no, row_name, formula, section, indent, bold, sort_no)
SELECT v.report_code, v.row_no, v.row_name, v.formula, v.section, v.indent, v.bold, v.sort_no
FROM (VALUES
  ('cash_flow', '01', '净利润',                       '科目发生(6001, 贷) + 科目发生(6051, 贷) + 科目发生(6301, 贷) - 科目发生(6401, 借) - 科目发生(6402, 借) - 科目发生(6403, 借) - 科目发生(6601, 借) - 科目发生(6602, 借) - 科目发生(6603, 借) - 科目发生(6701, 借) - 科目发生(6711, 借) - 科目发生(6801, 借)', 'operating', 0, 1, 1010),
  ('cash_flow', '02', '加：固定资产折旧',             '科目发生(660204, 借) + 科目发生(1602, 贷)', 'operating', 1, 0, 1020),
  ('cash_flow', '03', '加：资产减值准备',             '科目发生(6701, 借)',                        'operating', 1, 0, 1030),
  -- 经营性流动资产（借方科目）：增加即现金减少 → 系数 -1
  ('cash_flow', '04', '经营性应收项目的减少（减：增加）', '-1 * 科目变动(1122)',                    'operating', 1, 0, 1040),
  ('cash_flow', '05', '存货的减少（减：增加）',         '-1 * 科目变动(1403)',                     'operating', 1, 0, 1050),
  -- 经营性流动负债（贷方科目）：`科目变动` 为"期末(借−贷) − 期初(借−贷)"，
  -- 负债增加时该值为负（借方减少），而负债增加是现金流入，故整体取反后相加。
  ('cash_flow', '06', '经营性应付项目的增加（减：减少）', '-1 * (科目变动(2202) + 科目变动(2203) + 科目变动(2211))', 'operating', 1, 0, 1060),
  ('cash_flow', '07', '经营活动产生的现金流量净额',     '行(01) + 行(02) + 行(03) + 行(04) + 行(05) + 行(06)', 'operating', 0, 1, 1070),
  ('cash_flow', '08', '购建固定资产、无形资产支付的现金', '-1 * 科目变动(1601, 借)',                'investing', 1, 0, 2010),
  ('cash_flow', '09', '投资活动产生的现金流量净额',     '行(08)',                                   'investing', 0, 1, 2020),
  ('cash_flow', '10', '吸收投资收到的现金',             '科目变动(4001, 贷)',                       'financing', 1, 0, 3010),
  ('cash_flow', '11', '筹资活动产生的现金流量净额',     '行(10)',                                   'financing', 0, 1, 3020),
  ('cash_flow', '12', '现金及现金等价物净增加额',       '行(07) + 行(09) + 行(11)',                 'summary', 0, 1, 4010),
  ('cash_flow', '13', '加：期初现金及现金等价物余额',   '期初余额(1001, 借) + 期初余额(1002, 借)',  'cash', 1, 0, 4020),
  ('cash_flow', '14', '期末现金及现金等价物余额',       '科目余额(1001, 借) + 科目余额(1002, 借)',  'cash', 0, 1, 4030)
) AS v(report_code, row_no, row_name, formula, section, indent, bold, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM fin_report_template t
  WHERE t.report_code = v.report_code AND t.row_no = v.row_no
);
