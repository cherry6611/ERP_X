-- requires: 2026-10-15-upgrade-batch1-report-templates.sql（fin_report_template 由该迁移建立）
-- requires: 2026-10-15-upgrade-bs-moneyfunds-net.sql（同一口径在资产负债表侧的修正，本迁移是它的遗漏面）
--
-- 修复现金流量表「期初/期末现金及现金等价物余额」取数口径：
-- 由「借方向（贷方钳为 0）」改为「净额」。
--
-- 背景（与 bs-moneyfunds-net 同源问题，但**漏改了现金流量表**）：
--   现金/银行账户之间划转（如 借 1001 库存现金 / 贷 100202 银行存款-一般户）之后，
--   子科目可能出现贷方余额。按 `借` 取数会把贷方钳成 0 → 现金余额**虚增**。
--   bs-moneyfunds-net 已把资产负债表"货币资金"（row 1）改为 `净`，
--   并在注释里写明"与现金流量表 moneyFunds()（closingDebit − closingCredit）一致"——
--   但现金流量表模板的两行当时并没有一起改，于是两边口径仍然分叉。
--
-- 可复现证据（走查实测，2026-10 期间，仅 1 张已过账凭证：
--   借 1001 库存现金 100.00 / 贷 100202 银行存款-一般户 100.00）：
--   · 按 `借`：科目余额(1001,借)=100，科目余额(1002,借)=max(-100,0)=0 → 第 14 行 = 100
--     而资产负债表"货币资金" = (100-0)+(0-100) = 0
--     → 报表自带的勾稽校验 `cash_flow_balance_sheet`（期末现金 = 货币资金期末余额）
--       与 `cash_flow_reconcile`（期初现金 + 净增加额 = 期末现金）**双双 passed=false**
--       （GET /api/finance/reports/cash-flow?period=2026-10 的 checks 数组可直接看到）。
--   · 改为 `净` 后：第 14 行 = 0 = 货币资金；第 13 行 = 0；净增加额 = 0 → 两项校验均成立。
--
-- 幂等：按 report_code + row_no 定位，重复执行结果一致。
UPDATE fin_report_template
SET formula = '期初余额(1001, 净) + 期初余额(1002, 净)'
WHERE report_code = 'cash_flow' AND row_no = '13';

UPDATE fin_report_template
SET formula = '科目余额(1001, 净) + 科目余额(1002, 净)'
WHERE report_code = 'cash_flow' AND row_no = '14';
