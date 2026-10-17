-- requires: 2026-10-15-upgrade-batch1-accounting-base.sql（fin_report_template 由该迁移建立）
-- 修复 P0-1：资产负债表"未分配利润"未含本年损益净额，导致年终结转前月度恒等式不通过。
--
-- 背景：种子迁移 2026-10-15-upgrade-batch1-report-templates.sql 的行 20 公式早已写入
--   未分配利润 = 410401 + 4103 + 本年损益净额()，但该迁移以 ON CONFLICT DO NOTHING 播种，
--   运行库中已存在的旧公式（漏掉 本年损益净额()）不会被刷新。
-- 口径：本年损益净额() = 本会计年度至本期末损益类科目净额（收入 − 费用），
--   年终结转前把未结转的本期利润纳入权益，使月度恒等式通过；结转后损益科目清零、
--   4103 承接，该项为 0，不与 4103 重复计入。
-- 幂等：按 report_code + row_no 定位，重复执行结果一致。
UPDATE fin_report_template
SET formula = '科目余额(410401, 贷) + 科目余额(4103, 贷) + 本年损益净额()'
WHERE report_code = 'balance_sheet' AND row_no = '20';
