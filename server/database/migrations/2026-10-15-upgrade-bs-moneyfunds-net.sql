-- requires: 2026-10-15-upgrade-batch1-accounting-base.sql（fin_report_template 由该迁移建立）
-- 修复资产负债表"货币资金"取数口径：由「借方向（贷方钳为 0）」改为「净额」。
--
-- 背景：现金/银行账户在"现金转银行"等分录后，子科目（如 100202 基本户）可能
-- 出现贷方余额；按 借 方向取数会把贷方钳成 0，导致货币资金漏记该贷方、
-- 资产总计虚高（走查中残差 +100）。货币资金按借方 − 贷方的净额列示才符合
-- "现金及现金等价物"口径，且与现金流量表 moneyFunds()（closingDebit − closingCredit）一致。
-- 幂等：按 report_code + row_no 定位行 1，重复执行结果一致。
UPDATE fin_report_template
SET formula = '科目余额(1001, 净) + 科目余额(1002, 净)'
WHERE report_code = 'balance_sheet' AND row_no = '1';
