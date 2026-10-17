-- 2026-10-16 审计修复 · 迁移 9
-- requires: 2026-10-16-fix08-automation-run-ledger.sql
--
-- ============================================================================
-- 目的：修复审计报告 §6.4 —— **161 处 numeric 列未声明 precision/scale**
--
-- ## 缺陷
--
-- PostgreSQL 的裸 `numeric`（无 precision/scale）等价于"最多 131072 位整数、
-- 16383 位小数"。看起来"最宽松 = 最安全"，实际是两个问题：
--
-- ① **库层完全失去约束**。全仓用 `round2` 统一保留 2 位，但那是**应用层**约定：
--    任何绕过 service 的写入（修数脚本、导入、手工 SQL）都可以落 3 位小数，
--    而凭证借贷差 1 厘、应收与回款差 1 厘，**对账时表现为"永远差一点点"**，
--    是最难定位的一类账务问题。
-- ② **语义不可见**。看 schema 无法区分"这是金额（2 位）"还是"这是单价（6 位）"
--    还是"这是百分数（2 位）"。后人加字段时会照抄邻列的档位 —— 抄错就静默截断。
--
-- ## 本迁移的分档（按列名语义，共 5 档）
--
--   · numeric(6,2) —— 140 列：百分数（税率/折扣率/进度）；金额（人民币最小单位是分）
--   · numeric(8,4) —— 5 列：评分/比例（非金额；比例常需 4 位）
--   · numeric(18,6) —— 16 列：计量（数量/工时/面积），小数位可能 >2；单价/费率，金额可能极小需更多小数位
--
-- `numeric(18,2)` 的依据：18 位整数部分上限约 9999 万亿元，
-- 远超本公司业务量级；2 位小数对应人民币最小单位"分"，
-- 与全仓 `round2`（`shared/number.ts`）完全一致。
--
-- ⚠️ **为什么单价/计量用 6 位小数而不是 2 位**：
-- 数据服务的单价常按"元/千次调用"计价，可能出现 0.0015 元/次；
-- 一刀切 (18,2) 会把它**四舍五入成 0.00**，成本分摊整体归零 ——
-- 这是最坏的一类静默缺陷（不报错、金额全错）。因此计量与单价单列高精度档。
--
-- ⚠️ **百分数用 numeric(6,2)**：税率 13.00 / 6.00、折扣 12.50、权重 33.33
-- 都在 2 位以内；6 位整数部分给足余量（不会有 6 位数的百分比，
-- 但保留余量比卡边界安全）。
--
-- ## 迁移前安全断言
--
-- 逐列检查"现有值的小数位是否超过目标 scale"，**超界即中断并列出具体列**。
-- 不做静默截断：`ALTER COLUMN TYPE numeric(18,2)` 对 3 位小数的值会**四舍五入**，
-- 而"金额被悄悄改小/改大"是比迁移失败严重得多的后果。
-- 处置方式：人工确认那几列是否可以安全舍入（通常可以，因为业务上不该有 3 位），
-- 确认后用 `round()` 显式规整再重跑本迁移 —— 让"舍入"成为一个有意识的动作。
-- ============================================================================

-- ── 依赖视图的处理（**本迁移唯一需要额外小心的地方**）────────────────────
--
-- `v_fin_voucher_unassigned_entity` 的 `sum(l.debit)` 依赖
-- `fin_voucher_line.debit` 的类型。PostgreSQL **拒绝** ALTER 被视图引用的列
-- （`cannot alter type of a column used by a view or rule`），因此必须
-- **先 DROP、改完再 CREATE**。
--
-- 为什么不用 `ALTER VIEW` 或 `CREATE OR REPLACE VIEW`：
--   · `ALTER VIEW` 只能改列默认值，不能改列类型；
--   · `CREATE OR REPLACE VIEW` **也不允许**改输出列类型（只允许追加列）。
-- 所以 DROP + CREATE 是唯一路径。
--
-- 为什么这样是安全的：
--   · 视图**不存数据**，DROP 不丢任何业务数据；
--   · 重建用的是与 `2026-10-15-upgrade-d10-voucher-unassigned-view-fix.sql`
--     完全一致的**修正后**定义（`count(DISTINCT v.id)`，不是 batch4 的旧口径）
--     —— 这里逐字复制而不是"重写一遍"，避免重演 d10 修过的"张数虚高"缺陷；
--   · 迁移器逐文件包事务，中途失败会整体回滚，不会留下"视图没了"的中间态。
DROP VIEW IF EXISTS v_fin_voucher_unassigned_entity;

-- ── 前置断言：任何列的小数位都不得超过目标 scale
--
-- 逐列静态展开（而不是动态 SQL 拼表名）：161 条 IF EXISTS 直白可读，
-- 出错时 PostgreSQL 会直接指向具体那一行，排查成本最低。
DO $$
DECLARE
  bad text := '';
BEGIN
  IF EXISTS (SELECT 1 FROM crm_quotation_item WHERE quantity IS NOT NULL AND quantity::text LIKE '%.%' AND length(split_part(quantity::text, '.', 2)) > 6) THEN
    bad := bad || 'crm_quotation_item.quantity(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM crm_quotation_item WHERE unit_price IS NOT NULL AND unit_price::text LIKE '%.%' AND length(split_part(unit_price::text, '.', 2)) > 6) THEN
    bad := bad || 'crm_quotation_item.unit_price(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM crm_quotation_item WHERE discount_pct IS NOT NULL AND discount_pct::text LIKE '%.%' AND length(split_part(discount_pct::text, '.', 2)) > 2) THEN
    bad := bad || 'crm_quotation_item.discount_pct(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM crm_quotation_item WHERE est_unit_cost IS NOT NULL AND est_unit_cost::text LIKE '%.%' AND length(split_part(est_unit_cost::text, '.', 2)) > 6) THEN
    bad := bad || 'crm_quotation_item.est_unit_cost(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM crm_quotation WHERE discount_pct IS NOT NULL AND discount_pct::text LIKE '%.%' AND length(split_part(discount_pct::text, '.', 2)) > 2) THEN
    bad := bad || 'crm_quotation.discount_pct(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM crm_quotation WHERE total_amount IS NOT NULL AND total_amount::text LIKE '%.%' AND length(split_part(total_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'crm_quotation.total_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM crm_quotation WHERE tax_rate IS NOT NULL AND tax_rate::text LIKE '%.%' AND length(split_part(tax_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'crm_quotation.tax_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM crm_quotation WHERE estimated_cost IS NOT NULL AND estimated_cost::text LIKE '%.%' AND length(split_part(estimated_cost::text, '.', 2)) > 2) THEN
    bad := bad || 'crm_quotation.estimated_cost(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_admin_affair WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_admin_affair.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_admin_asset WHERE unit_price IS NOT NULL AND unit_price::text LIKE '%.%' AND length(split_part(unit_price::text, '.', 2)) > 6) THEN
    bad := bad || 'erp_admin_asset.unit_price(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_admin_asset WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_admin_asset.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_admin_bill WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_admin_bill.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_admin_rent_contract WHERE monthly_rent IS NOT NULL AND monthly_rent::text LIKE '%.%' AND length(split_part(monthly_rent::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_admin_rent_contract.monthly_rent(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_admin_rent_contract WHERE deposit IS NOT NULL AND deposit::text LIKE '%.%' AND length(split_part(deposit::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_admin_rent_contract.deposit(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_admin_rent_contract WHERE area IS NOT NULL AND area::text LIKE '%.%' AND length(split_part(area::text, '.', 2)) > 6) THEN
    bad := bad || 'erp_admin_rent_contract.area(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_depreciation WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_depreciation.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_asset WHERE original_value IS NOT NULL AND original_value::text LIKE '%.%' AND length(split_part(original_value::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_asset.original_value(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_asset WHERE residual_value IS NOT NULL AND residual_value::text LIKE '%.%' AND length(split_part(residual_value::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_asset.residual_value(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_asset WHERE net_value IS NOT NULL AND net_value::text LIKE '%.%' AND length(split_part(net_value::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_asset.net_value(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_asset WHERE impairment_amount IS NOT NULL AND impairment_amount::text LIKE '%.%' AND length(split_part(impairment_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_asset.impairment_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_asset WHERE net_value_after IS NOT NULL AND net_value_after::text LIKE '%.%' AND length(split_part(net_value_after::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_asset.net_value_after(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_impairment WHERE book_value IS NOT NULL AND book_value::text LIKE '%.%' AND length(split_part(book_value::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_impairment.book_value(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_impairment WHERE recoverable_amount IS NOT NULL AND recoverable_amount::text LIKE '%.%' AND length(split_part(recoverable_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_impairment.recoverable_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_impairment WHERE impairment_loss IS NOT NULL AND impairment_loss::text LIKE '%.%' AND length(split_part(impairment_loss::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_impairment.impairment_loss(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_disposal WHERE original_value IS NOT NULL AND original_value::text LIKE '%.%' AND length(split_part(original_value::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_disposal.original_value(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_disposal WHERE accumulated_depreciation IS NOT NULL AND accumulated_depreciation::text LIKE '%.%' AND length(split_part(accumulated_depreciation::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_disposal.accumulated_depreciation(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_disposal WHERE net_value IS NOT NULL AND net_value::text LIKE '%.%' AND length(split_part(net_value::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_disposal.net_value(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_disposal WHERE disposal_income IS NOT NULL AND disposal_income::text LIKE '%.%' AND length(split_part(disposal_income::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_disposal.disposal_income(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_disposal WHERE tax_rate IS NOT NULL AND tax_rate::text LIKE '%.%' AND length(split_part(tax_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_disposal.tax_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_disposal WHERE tax_amount IS NOT NULL AND tax_amount::text LIKE '%.%' AND length(split_part(tax_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_disposal.tax_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM ast_disposal WHERE gain_loss IS NOT NULL AND gain_loss::text LIKE '%.%' AND length(split_part(gain_loss::text, '.', 2)) > 2) THEN
    bad := bad || 'ast_disposal.gain_loss(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM pur_order WHERE unit_price IS NOT NULL AND unit_price::text LIKE '%.%' AND length(split_part(unit_price::text, '.', 2)) > 6) THEN
    bad := bad || 'pur_order.unit_price(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM pur_order WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'pur_order.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM pur_order WHERE tax_rate IS NOT NULL AND tax_rate::text LIKE '%.%' AND length(split_part(tax_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'pur_order.tax_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM pur_request WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'pur_request.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM pur_return WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'pur_return.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM pur_return WHERE tax_rate IS NOT NULL AND tax_rate::text LIKE '%.%' AND length(split_part(tax_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'pur_return.tax_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM pur_return WHERE net_amount IS NOT NULL AND net_amount::text LIKE '%.%' AND length(split_part(net_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'pur_return.net_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM pur_return WHERE tax_amount IS NOT NULL AND tax_amount::text LIKE '%.%' AND length(split_part(tax_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'pur_return.tax_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_voucher_line WHERE debit IS NOT NULL AND debit::text LIKE '%.%' AND length(split_part(debit::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_voucher_line.debit(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_voucher_line WHERE credit IS NOT NULL AND credit::text LIKE '%.%' AND length(split_part(credit::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_voucher_line.credit(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_account_balance_snapshot WHERE opening_debit IS NOT NULL AND opening_debit::text LIKE '%.%' AND length(split_part(opening_debit::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_account_balance_snapshot.opening_debit(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_account_balance_snapshot WHERE opening_credit IS NOT NULL AND opening_credit::text LIKE '%.%' AND length(split_part(opening_credit::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_account_balance_snapshot.opening_credit(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_account_balance_snapshot WHERE debit_occur IS NOT NULL AND debit_occur::text LIKE '%.%' AND length(split_part(debit_occur::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_account_balance_snapshot.debit_occur(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_account_balance_snapshot WHERE credit_occur IS NOT NULL AND credit_occur::text LIKE '%.%' AND length(split_part(credit_occur::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_account_balance_snapshot.credit_occur(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_account_balance_snapshot WHERE closing_debit IS NOT NULL AND closing_debit::text LIKE '%.%' AND length(split_part(closing_debit::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_account_balance_snapshot.closing_debit(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_account_balance_snapshot WHERE closing_credit IS NOT NULL AND closing_credit::text LIKE '%.%' AND length(split_part(closing_credit::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_account_balance_snapshot.closing_credit(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_year_end_close WHERE profit_amount IS NOT NULL AND profit_amount::text LIKE '%.%' AND length(split_part(profit_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_year_end_close.profit_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_vat_declaration WHERE output_tax IS NOT NULL AND output_tax::text LIKE '%.%' AND length(split_part(output_tax::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_vat_declaration.output_tax(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_vat_declaration WHERE input_tax IS NOT NULL AND input_tax::text LIKE '%.%' AND length(split_part(input_tax::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_vat_declaration.input_tax(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_vat_declaration WHERE transfer_out IS NOT NULL AND transfer_out::text LIKE '%.%' AND length(split_part(transfer_out::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_vat_declaration.transfer_out(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_vat_declaration WHERE previous_credit IS NOT NULL AND previous_credit::text LIKE '%.%' AND length(split_part(previous_credit::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_vat_declaration.previous_credit(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_vat_declaration WHERE payable_tax IS NOT NULL AND payable_tax::text LIKE '%.%' AND length(split_part(payable_tax::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_vat_declaration.payable_tax(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_vat_declaration WHERE closing_credit IS NOT NULL AND closing_credit::text LIKE '%.%' AND length(split_part(closing_credit::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_vat_declaration.closing_credit(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_vat_declaration WHERE ledger_output_tax IS NOT NULL AND ledger_output_tax::text LIKE '%.%' AND length(split_part(ledger_output_tax::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_vat_declaration.ledger_output_tax(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_vat_declaration WHERE ledger_input_tax IS NOT NULL AND ledger_input_tax::text LIKE '%.%' AND length(split_part(ledger_input_tax::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_vat_declaration.ledger_input_tax(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_expense_claim WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_expense_claim.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_expense_apply WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_expense_apply.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_budget WHERE budget_amount IS NOT NULL AND budget_amount::text LIKE '%.%' AND length(split_part(budget_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'fin_budget.budget_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_training WHERE hours IS NOT NULL AND hours::text LIKE '%.%' AND length(split_part(hours::text, '.', 2)) > 6) THEN
    bad := bad || 'hr_training.hours(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_appraisal WHERE score IS NOT NULL AND score::text LIKE '%.%' AND length(split_part(score::text, '.', 2)) > 4) THEN
    bad := bad || 'hr_appraisal.score(目标 4 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE base_salary IS NOT NULL AND base_salary::text LIKE '%.%' AND length(split_part(base_salary::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.base_salary(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE perf_salary IS NOT NULL AND perf_salary::text LIKE '%.%' AND length(split_part(perf_salary::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.perf_salary(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE allowance IS NOT NULL AND allowance::text LIKE '%.%' AND length(split_part(allowance::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.allowance(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE social_insurance IS NOT NULL AND social_insurance::text LIKE '%.%' AND length(split_part(social_insurance::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.social_insurance(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE housing_fund IS NOT NULL AND housing_fund::text LIKE '%.%' AND length(split_part(housing_fund::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.housing_fund(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE tax IS NOT NULL AND tax::text LIKE '%.%' AND length(split_part(tax::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.tax(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE net_salary IS NOT NULL AND net_salary::text LIKE '%.%' AND length(split_part(net_salary::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.net_salary(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE ytd_income IS NOT NULL AND ytd_income::text LIKE '%.%' AND length(split_part(ytd_income::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.ytd_income(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE ytd_tax_free_income IS NOT NULL AND ytd_tax_free_income::text LIKE '%.%' AND length(split_part(ytd_tax_free_income::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.ytd_tax_free_income(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE ytd_basic_deduction IS NOT NULL AND ytd_basic_deduction::text LIKE '%.%' AND length(split_part(ytd_basic_deduction::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.ytd_basic_deduction(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE ytd_deduction IS NOT NULL AND ytd_deduction::text LIKE '%.%' AND length(split_part(ytd_deduction::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.ytd_deduction(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE ytd_additional_deduction IS NOT NULL AND ytd_additional_deduction::text LIKE '%.%' AND length(split_part(ytd_additional_deduction::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.ytd_additional_deduction(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE ytd_tax_withheld IS NOT NULL AND ytd_tax_withheld::text LIKE '%.%' AND length(split_part(ytd_tax_withheld::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.ytd_tax_withheld(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE ytd_taxable_income IS NOT NULL AND ytd_taxable_income::text LIKE '%.%' AND length(split_part(ytd_taxable_income::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.ytd_taxable_income(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE tax_rate IS NOT NULL AND tax_rate::text LIKE '%.%' AND length(split_part(tax_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.tax_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE quick_deduction IS NOT NULL AND quick_deduction::text LIKE '%.%' AND length(split_part(quick_deduction::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.quick_deduction(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_payroll WHERE ytd_net IS NOT NULL AND ytd_net::text LIKE '%.%' AND length(split_part(ytd_net::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_payroll.ytd_net(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_employee_tax_deduction WHERE monthly_amount IS NOT NULL AND monthly_amount::text LIKE '%.%' AND length(split_part(monthly_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_employee_tax_deduction.monthly_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_employee_tax_deduction WHERE share_amount IS NOT NULL AND share_amount::text LIKE '%.%' AND length(split_part(share_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_employee_tax_deduction.share_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_employee_tax_deduction WHERE share_ratio IS NOT NULL AND share_ratio::text LIKE '%.%' AND length(split_part(share_ratio::text, '.', 2)) > 4) THEN
    bad := bad || 'hr_employee_tax_deduction.share_ratio(目标 4 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_leave_request WHERE days IS NOT NULL AND days::text LIKE '%.%' AND length(split_part(days::text, '.', 2)) > 6) THEN
    bad := bad || 'hr_leave_request.days(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_leave_balance WHERE total_days IS NOT NULL AND total_days::text LIKE '%.%' AND length(split_part(total_days::text, '.', 2)) > 6) THEN
    bad := bad || 'hr_leave_balance.total_days(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_leave_balance WHERE used_days IS NOT NULL AND used_days::text LIKE '%.%' AND length(split_part(used_days::text, '.', 2)) > 6) THEN
    bad := bad || 'hr_leave_balance.used_days(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_invoice WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_invoice.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_invoice WHERE tax_rate IS NOT NULL AND tax_rate::text LIKE '%.%' AND length(split_part(tax_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_invoice.tax_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_invoice WHERE tax_amount IS NOT NULL AND tax_amount::text LIKE '%.%' AND length(split_part(tax_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_invoice.tax_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_invoice WHERE net_amount IS NOT NULL AND net_amount::text LIKE '%.%' AND length(split_part(net_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_invoice.net_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_invoice WHERE old_amount IS NOT NULL AND old_amount::text LIKE '%.%' AND length(split_part(old_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_invoice.old_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_ap_writeoff WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_ap_writeoff.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_payment WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_payment.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_payment WHERE used_amount IS NOT NULL AND used_amount::text LIKE '%.%' AND length(split_part(used_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_payment.used_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_ap_bill WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_ap_bill.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_ap_bill WHERE paid_amount IS NOT NULL AND paid_amount::text LIKE '%.%' AND length(split_part(paid_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_ap_bill.paid_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_ar_writeoff WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_ar_writeoff.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_receipt WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_receipt.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_receipt WHERE used_amount IS NOT NULL AND used_amount::text LIKE '%.%' AND length(split_part(used_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_receipt.used_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_ar WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_ar.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_ar WHERE settled_amount IS NOT NULL AND settled_amount::text LIKE '%.%' AND length(split_part(settled_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_ar.settled_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_revenue_adjust WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_revenue_adjust.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_project_revenue WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_project_revenue.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM sales_return WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'sales_return.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM sales_return WHERE tax_rate IS NOT NULL AND tax_rate::text LIKE '%.%' AND length(split_part(tax_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'sales_return.tax_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM sales_return WHERE net_amount IS NOT NULL AND net_amount::text LIKE '%.%' AND length(split_part(net_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'sales_return.net_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM sales_return WHERE tax_amount IS NOT NULL AND tax_amount::text LIKE '%.%' AND length(split_part(tax_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'sales_return.tax_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM sales_return WHERE cost_amount IS NOT NULL AND cost_amount::text LIKE '%.%' AND length(split_part(cost_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'sales_return.cost_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_note WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_note.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_note WHERE discount_interest IS NOT NULL AND discount_interest::text LIKE '%.%' AND length(split_part(discount_interest::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_note.discount_interest(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_note WHERE discount_rate IS NOT NULL AND discount_rate::text LIKE '%.%' AND length(split_part(discount_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_note.discount_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_note WHERE settled_amount IS NOT NULL AND settled_amount::text LIKE '%.%' AND length(split_part(settled_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_note.settled_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_note_log WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_note_log.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM bi_alert_subscription WHERE threshold IS NOT NULL AND threshold::text LIKE '%.%' AND length(split_part(threshold::text, '.', 2)) > 2) THEN
    bad := bad || 'bi_alert_subscription.threshold(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_cost_allocation WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_cost_allocation.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_timesheet WHERE hours IS NOT NULL AND hours::text LIKE '%.%' AND length(split_part(hours::text, '.', 2)) > 6) THEN
    bad := bad || 'erp_timesheet.hours(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_labor_rate WHERE rate IS NOT NULL AND rate::text LIKE '%.%' AND length(split_part(rate::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_labor_rate.rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_project_cost WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_project_cost.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_project_milestone WHERE weight_pct IS NOT NULL AND weight_pct::text LIKE '%.%' AND length(split_part(weight_pct::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_project_milestone.weight_pct(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_project WHERE budget IS NOT NULL AND budget::text LIKE '%.%' AND length(split_part(budget::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_project.budget(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_project WHERE estimated_total_cost IS NOT NULL AND estimated_total_cost::text LIKE '%.%' AND length(split_part(estimated_total_cost::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_project.estimated_total_cost(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_calloff WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_calloff.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_calloff WHERE quantity IS NOT NULL AND quantity::text LIKE '%.%' AND length(split_part(quantity::text, '.', 2)) > 6) THEN
    bad := bad || 'erp_calloff.quantity(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_calloff WHERE unit_price IS NOT NULL AND unit_price::text LIKE '%.%' AND length(split_part(unit_price::text, '.', 2)) > 6) THEN
    bad := bad || 'erp_calloff.unit_price(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract_version WHERE change_amount IS NOT NULL AND change_amount::text LIKE '%.%' AND length(split_part(change_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_contract_version.change_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract_milestone WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_contract_milestone.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_contract.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract WHERE tax_rate IS NOT NULL AND tax_rate::text LIKE '%.%' AND length(split_part(tax_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_contract.tax_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract WHERE net_amount IS NOT NULL AND net_amount::text LIKE '%.%' AND length(split_part(net_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_contract.net_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract WHERE tax_amount IS NOT NULL AND tax_amount::text LIKE '%.%' AND length(split_part(tax_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_contract.tax_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract_item WHERE quantity IS NOT NULL AND quantity::text LIKE '%.%' AND length(split_part(quantity::text, '.', 2)) > 6) THEN
    bad := bad || 'erp_contract_item.quantity(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract_item WHERE unit_price IS NOT NULL AND unit_price::text LIKE '%.%' AND length(split_part(unit_price::text, '.', 2)) > 6) THEN
    bad := bad || 'erp_contract_item.unit_price(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract_item WHERE discount_pct IS NOT NULL AND discount_pct::text LIKE '%.%' AND length(split_part(discount_pct::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_contract_item.discount_pct(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract_item WHERE tax_rate IS NOT NULL AND tax_rate::text LIKE '%.%' AND length(split_part(tax_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_contract_item.tax_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract_item WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_contract_item.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract_item WHERE net_amount IS NOT NULL AND net_amount::text LIKE '%.%' AND length(split_part(net_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_contract_item.net_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract_item WHERE tax_amount IS NOT NULL AND tax_amount::text LIKE '%.%' AND length(split_part(tax_amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_contract_item.tax_amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_contract_item WHERE est_unit_cost IS NOT NULL AND est_unit_cost::text LIKE '%.%' AND length(split_part(est_unit_cost::text, '.', 2)) > 6) THEN
    bad := bad || 'erp_contract_item.est_unit_cost(目标 6 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM crm_opportunity WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'crm_opportunity.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM crm_opportunity WHERE tax_rate IS NOT NULL AND tax_rate::text LIKE '%.%' AND length(split_part(tax_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'crm_opportunity.tax_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM md_employee WHERE ss_base IS NOT NULL AND ss_base::text LIKE '%.%' AND length(split_part(ss_base::text, '.', 2)) > 2) THEN
    bad := bad || 'md_employee.ss_base(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM md_supplier WHERE rating IS NOT NULL AND rating::text LIKE '%.%' AND length(split_part(rating::text, '.', 2)) > 4) THEN
    bad := bad || 'md_supplier.rating(目标 4 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM md_supplier WHERE default_tax_rate IS NOT NULL AND default_tax_rate::text LIKE '%.%' AND length(split_part(default_tax_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'md_supplier.default_tax_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM md_customer WHERE credit_limit IS NOT NULL AND credit_limit::text LIKE '%.%' AND length(split_part(credit_limit::text, '.', 2)) > 2) THEN
    bad := bad || 'md_customer.credit_limit(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM md_customer WHERE default_tax_rate IS NOT NULL AND default_tax_rate::text LIKE '%.%' AND length(split_part(default_tax_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'md_customer.default_tax_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM md_tax_entity WHERE default_output_rate IS NOT NULL AND default_output_rate::text LIKE '%.%' AND length(split_part(default_output_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'md_tax_entity.default_output_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM md_tax_entity WHERE default_input_rate IS NOT NULL AND default_input_rate::text LIKE '%.%' AND length(split_part(default_input_rate::text, '.', 2)) > 2) THEN
    bad := bad || 'md_tax_entity.default_input_rate(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_ss_city_rule WHERE pension_emp IS NOT NULL AND pension_emp::text LIKE '%.%' AND length(split_part(pension_emp::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_ss_city_rule.pension_emp(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_ss_city_rule WHERE pension_co IS NOT NULL AND pension_co::text LIKE '%.%' AND length(split_part(pension_co::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_ss_city_rule.pension_co(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_ss_city_rule WHERE medical_emp IS NOT NULL AND medical_emp::text LIKE '%.%' AND length(split_part(medical_emp::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_ss_city_rule.medical_emp(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_ss_city_rule WHERE medical_co IS NOT NULL AND medical_co::text LIKE '%.%' AND length(split_part(medical_co::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_ss_city_rule.medical_co(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_ss_city_rule WHERE unemployment_emp IS NOT NULL AND unemployment_emp::text LIKE '%.%' AND length(split_part(unemployment_emp::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_ss_city_rule.unemployment_emp(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_ss_city_rule WHERE unemployment_co IS NOT NULL AND unemployment_co::text LIKE '%.%' AND length(split_part(unemployment_co::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_ss_city_rule.unemployment_co(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_ss_city_rule WHERE housing_emp IS NOT NULL AND housing_emp::text LIKE '%.%' AND length(split_part(housing_emp::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_ss_city_rule.housing_emp(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_ss_city_rule WHERE housing_co IS NOT NULL AND housing_co::text LIKE '%.%' AND length(split_part(housing_co::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_ss_city_rule.housing_co(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_ss_city_rule WHERE base_min IS NOT NULL AND base_min::text LIKE '%.%' AND length(split_part(base_min::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_ss_city_rule.base_min(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM hr_ss_city_rule WHERE base_max IS NOT NULL AND base_max::text LIKE '%.%' AND length(split_part(base_max::text, '.', 2)) > 2) THEN
    bad := bad || 'hr_ss_city_rule.base_max(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM md_bank_account WHERE opening_balance IS NOT NULL AND opening_balance::text LIKE '%.%' AND length(split_part(opening_balance::text, '.', 2)) > 2) THEN
    bad := bad || 'md_bank_account.opening_balance(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_bank_statement WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_bank_statement.amount(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_bank_statement WHERE balance IS NOT NULL AND balance::text LIKE '%.%' AND length(split_part(balance::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_bank_statement.balance(目标 2 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_bank_statement WHERE match_score IS NOT NULL AND match_score::text LIKE '%.%' AND length(split_part(match_score::text, '.', 2)) > 4) THEN
    bad := bad || 'erp_bank_statement.match_score(目标 4 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_bank_statement_match WHERE score IS NOT NULL AND score::text LIKE '%.%' AND length(split_part(score::text, '.', 2)) > 4) THEN
    bad := bad || 'erp_bank_statement_match.score(目标 4 位) ';
  END IF;
  IF EXISTS (SELECT 1 FROM erp_bank_statement_match WHERE amount IS NOT NULL AND amount::text LIKE '%.%' AND length(split_part(amount::text, '.', 2)) > 2) THEN
    bad := bad || 'erp_bank_statement_match.amount(目标 2 位) ';
  END IF;

  IF bad <> '' THEN
    RAISE EXCEPTION
      '以下列存在超出目标精度的小数位，直接收窄会**静默四舍五入**（金额会被悄悄改值）：%。'
      '请先人工确认这些值是否可安全舍入，用 round(col, 目标scale) 显式规整后重跑本迁移 —— '
      '让"舍入"成为一个有意识的动作，而不是迁移的副作用。',
      bad;
  END IF;
END $$;
-- ── 逐列收窄 ──────────────────────────────────────────────────────────────
-- 用 IF EXISTS 语义兜底：若某列在别的库里已带精度（本迁移被重复执行的安全网），
-- 重复 ALTER 是幂等的（类型相同则 PostgreSQL 不重建表）。
DO $$
BEGIN
  ALTER TABLE crm_quotation_item ALTER COLUMN quantity TYPE numeric(18,6);
  ALTER TABLE crm_quotation_item ALTER COLUMN unit_price TYPE numeric(18,6);
  ALTER TABLE crm_quotation_item ALTER COLUMN discount_pct TYPE numeric(6,2);
  ALTER TABLE crm_quotation_item ALTER COLUMN est_unit_cost TYPE numeric(18,6);
  ALTER TABLE crm_quotation ALTER COLUMN discount_pct TYPE numeric(6,2);
  ALTER TABLE crm_quotation ALTER COLUMN total_amount TYPE numeric(18,2);
  ALTER TABLE crm_quotation ALTER COLUMN tax_rate TYPE numeric(6,2);
  ALTER TABLE crm_quotation ALTER COLUMN estimated_cost TYPE numeric(18,2);
  ALTER TABLE erp_admin_affair ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_admin_asset ALTER COLUMN unit_price TYPE numeric(18,6);
  ALTER TABLE erp_admin_asset ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_admin_bill ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_admin_rent_contract ALTER COLUMN monthly_rent TYPE numeric(18,2);
  ALTER TABLE erp_admin_rent_contract ALTER COLUMN deposit TYPE numeric(18,2);
  ALTER TABLE erp_admin_rent_contract ALTER COLUMN area TYPE numeric(18,6);
  ALTER TABLE ast_depreciation ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE ast_asset ALTER COLUMN original_value TYPE numeric(18,2);
  ALTER TABLE ast_asset ALTER COLUMN residual_value TYPE numeric(18,2);
  ALTER TABLE ast_asset ALTER COLUMN net_value TYPE numeric(18,2);
  ALTER TABLE ast_asset ALTER COLUMN impairment_amount TYPE numeric(18,2);
  ALTER TABLE ast_asset ALTER COLUMN net_value_after TYPE numeric(18,2);
  ALTER TABLE ast_impairment ALTER COLUMN book_value TYPE numeric(18,2);
  ALTER TABLE ast_impairment ALTER COLUMN recoverable_amount TYPE numeric(18,2);
  ALTER TABLE ast_impairment ALTER COLUMN impairment_loss TYPE numeric(18,2);
  ALTER TABLE ast_disposal ALTER COLUMN original_value TYPE numeric(18,2);
  ALTER TABLE ast_disposal ALTER COLUMN accumulated_depreciation TYPE numeric(18,2);
  ALTER TABLE ast_disposal ALTER COLUMN net_value TYPE numeric(18,2);
  ALTER TABLE ast_disposal ALTER COLUMN disposal_income TYPE numeric(18,2);
  ALTER TABLE ast_disposal ALTER COLUMN tax_rate TYPE numeric(6,2);
  ALTER TABLE ast_disposal ALTER COLUMN tax_amount TYPE numeric(18,2);
  ALTER TABLE ast_disposal ALTER COLUMN gain_loss TYPE numeric(18,2);
  ALTER TABLE pur_order ALTER COLUMN unit_price TYPE numeric(18,6);
  ALTER TABLE pur_order ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE pur_order ALTER COLUMN tax_rate TYPE numeric(6,2);
  ALTER TABLE pur_request ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE pur_return ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE pur_return ALTER COLUMN tax_rate TYPE numeric(6,2);
  ALTER TABLE pur_return ALTER COLUMN net_amount TYPE numeric(18,2);
  ALTER TABLE pur_return ALTER COLUMN tax_amount TYPE numeric(18,2);
  ALTER TABLE fin_voucher_line ALTER COLUMN debit TYPE numeric(18,2);
  ALTER TABLE fin_voucher_line ALTER COLUMN credit TYPE numeric(18,2);
  ALTER TABLE fin_account_balance_snapshot ALTER COLUMN opening_debit TYPE numeric(18,2);
  ALTER TABLE fin_account_balance_snapshot ALTER COLUMN opening_credit TYPE numeric(18,2);
  ALTER TABLE fin_account_balance_snapshot ALTER COLUMN debit_occur TYPE numeric(18,2);
  ALTER TABLE fin_account_balance_snapshot ALTER COLUMN credit_occur TYPE numeric(18,2);
  ALTER TABLE fin_account_balance_snapshot ALTER COLUMN closing_debit TYPE numeric(18,2);
  ALTER TABLE fin_account_balance_snapshot ALTER COLUMN closing_credit TYPE numeric(18,2);
  ALTER TABLE fin_year_end_close ALTER COLUMN profit_amount TYPE numeric(18,2);
  ALTER TABLE fin_vat_declaration ALTER COLUMN output_tax TYPE numeric(18,2);
  ALTER TABLE fin_vat_declaration ALTER COLUMN input_tax TYPE numeric(18,2);
  ALTER TABLE fin_vat_declaration ALTER COLUMN transfer_out TYPE numeric(18,2);
  ALTER TABLE fin_vat_declaration ALTER COLUMN previous_credit TYPE numeric(18,2);
  ALTER TABLE fin_vat_declaration ALTER COLUMN payable_tax TYPE numeric(18,2);
  ALTER TABLE fin_vat_declaration ALTER COLUMN closing_credit TYPE numeric(18,2);
  ALTER TABLE fin_vat_declaration ALTER COLUMN ledger_output_tax TYPE numeric(18,2);
  ALTER TABLE fin_vat_declaration ALTER COLUMN ledger_input_tax TYPE numeric(18,2);
  ALTER TABLE fin_expense_claim ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE fin_expense_apply ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE fin_budget ALTER COLUMN budget_amount TYPE numeric(18,2);
  ALTER TABLE hr_training ALTER COLUMN hours TYPE numeric(18,6);
  ALTER TABLE hr_appraisal ALTER COLUMN score TYPE numeric(8,4);
  ALTER TABLE hr_payroll ALTER COLUMN base_salary TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN perf_salary TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN allowance TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN social_insurance TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN housing_fund TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN tax TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN net_salary TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN ytd_income TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN ytd_tax_free_income TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN ytd_basic_deduction TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN ytd_deduction TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN ytd_additional_deduction TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN ytd_tax_withheld TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN ytd_taxable_income TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN tax_rate TYPE numeric(6,2);
  ALTER TABLE hr_payroll ALTER COLUMN quick_deduction TYPE numeric(18,2);
  ALTER TABLE hr_payroll ALTER COLUMN ytd_net TYPE numeric(18,2);
  ALTER TABLE hr_employee_tax_deduction ALTER COLUMN monthly_amount TYPE numeric(18,2);
  ALTER TABLE hr_employee_tax_deduction ALTER COLUMN share_amount TYPE numeric(18,2);
  ALTER TABLE hr_employee_tax_deduction ALTER COLUMN share_ratio TYPE numeric(8,4);
  ALTER TABLE hr_leave_request ALTER COLUMN days TYPE numeric(18,6);
  ALTER TABLE hr_leave_balance ALTER COLUMN total_days TYPE numeric(18,6);
  ALTER TABLE hr_leave_balance ALTER COLUMN used_days TYPE numeric(18,6);
  ALTER TABLE erp_invoice ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_invoice ALTER COLUMN tax_rate TYPE numeric(6,2);
  ALTER TABLE erp_invoice ALTER COLUMN tax_amount TYPE numeric(18,2);
  ALTER TABLE erp_invoice ALTER COLUMN net_amount TYPE numeric(18,2);
  ALTER TABLE erp_invoice ALTER COLUMN old_amount TYPE numeric(18,2);
  ALTER TABLE erp_ap_writeoff ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_payment ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_payment ALTER COLUMN used_amount TYPE numeric(18,2);
  ALTER TABLE erp_ap_bill ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_ap_bill ALTER COLUMN paid_amount TYPE numeric(18,2);
  ALTER TABLE erp_ar_writeoff ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_receipt ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_receipt ALTER COLUMN used_amount TYPE numeric(18,2);
  ALTER TABLE erp_ar ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_ar ALTER COLUMN settled_amount TYPE numeric(18,2);
  ALTER TABLE erp_revenue_adjust ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_project_revenue ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE sales_return ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE sales_return ALTER COLUMN tax_rate TYPE numeric(6,2);
  ALTER TABLE sales_return ALTER COLUMN net_amount TYPE numeric(18,2);
  ALTER TABLE sales_return ALTER COLUMN tax_amount TYPE numeric(18,2);
  ALTER TABLE sales_return ALTER COLUMN cost_amount TYPE numeric(18,2);
  ALTER TABLE erp_note ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_note ALTER COLUMN discount_interest TYPE numeric(18,2);
  ALTER TABLE erp_note ALTER COLUMN discount_rate TYPE numeric(18,2);
  ALTER TABLE erp_note ALTER COLUMN settled_amount TYPE numeric(18,2);
  ALTER TABLE erp_note_log ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE bi_alert_subscription ALTER COLUMN threshold TYPE numeric(18,2);
  ALTER TABLE erp_cost_allocation ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_timesheet ALTER COLUMN hours TYPE numeric(18,6);
  ALTER TABLE erp_labor_rate ALTER COLUMN rate TYPE numeric(18,2);
  ALTER TABLE erp_project_cost ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_project_milestone ALTER COLUMN weight_pct TYPE numeric(6,2);
  ALTER TABLE erp_project ALTER COLUMN budget TYPE numeric(18,2);
  ALTER TABLE erp_project ALTER COLUMN estimated_total_cost TYPE numeric(18,2);
  ALTER TABLE erp_calloff ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_calloff ALTER COLUMN quantity TYPE numeric(18,6);
  ALTER TABLE erp_calloff ALTER COLUMN unit_price TYPE numeric(18,6);
  ALTER TABLE erp_contract_version ALTER COLUMN change_amount TYPE numeric(18,2);
  ALTER TABLE erp_contract_milestone ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_contract ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_contract ALTER COLUMN tax_rate TYPE numeric(6,2);
  ALTER TABLE erp_contract ALTER COLUMN net_amount TYPE numeric(18,2);
  ALTER TABLE erp_contract ALTER COLUMN tax_amount TYPE numeric(18,2);
  ALTER TABLE erp_contract_item ALTER COLUMN quantity TYPE numeric(18,6);
  ALTER TABLE erp_contract_item ALTER COLUMN unit_price TYPE numeric(18,6);
  ALTER TABLE erp_contract_item ALTER COLUMN discount_pct TYPE numeric(6,2);
  ALTER TABLE erp_contract_item ALTER COLUMN tax_rate TYPE numeric(6,2);
  ALTER TABLE erp_contract_item ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_contract_item ALTER COLUMN net_amount TYPE numeric(18,2);
  ALTER TABLE erp_contract_item ALTER COLUMN tax_amount TYPE numeric(18,2);
  ALTER TABLE erp_contract_item ALTER COLUMN est_unit_cost TYPE numeric(18,6);
  ALTER TABLE crm_opportunity ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE crm_opportunity ALTER COLUMN tax_rate TYPE numeric(6,2);
  ALTER TABLE md_employee ALTER COLUMN ss_base TYPE numeric(18,2);
  ALTER TABLE md_supplier ALTER COLUMN rating TYPE numeric(8,4);
  ALTER TABLE md_supplier ALTER COLUMN default_tax_rate TYPE numeric(6,2);
  ALTER TABLE md_customer ALTER COLUMN credit_limit TYPE numeric(18,2);
  ALTER TABLE md_customer ALTER COLUMN default_tax_rate TYPE numeric(6,2);
  ALTER TABLE md_tax_entity ALTER COLUMN default_output_rate TYPE numeric(18,2);
  ALTER TABLE md_tax_entity ALTER COLUMN default_input_rate TYPE numeric(18,2);
  ALTER TABLE hr_ss_city_rule ALTER COLUMN pension_emp TYPE numeric(18,2);
  ALTER TABLE hr_ss_city_rule ALTER COLUMN pension_co TYPE numeric(18,2);
  ALTER TABLE hr_ss_city_rule ALTER COLUMN medical_emp TYPE numeric(18,2);
  ALTER TABLE hr_ss_city_rule ALTER COLUMN medical_co TYPE numeric(18,2);
  ALTER TABLE hr_ss_city_rule ALTER COLUMN unemployment_emp TYPE numeric(18,2);
  ALTER TABLE hr_ss_city_rule ALTER COLUMN unemployment_co TYPE numeric(18,2);
  ALTER TABLE hr_ss_city_rule ALTER COLUMN housing_emp TYPE numeric(18,2);
  ALTER TABLE hr_ss_city_rule ALTER COLUMN housing_co TYPE numeric(18,2);
  ALTER TABLE hr_ss_city_rule ALTER COLUMN base_min TYPE numeric(18,2);
  ALTER TABLE hr_ss_city_rule ALTER COLUMN base_max TYPE numeric(18,2);
  ALTER TABLE md_bank_account ALTER COLUMN opening_balance TYPE numeric(18,2);
  ALTER TABLE erp_bank_statement ALTER COLUMN amount TYPE numeric(18,2);
  ALTER TABLE erp_bank_statement ALTER COLUMN balance TYPE numeric(18,2);
  ALTER TABLE erp_bank_statement ALTER COLUMN match_score TYPE numeric(8,4);
  ALTER TABLE erp_bank_statement_match ALTER COLUMN score TYPE numeric(8,4);
  ALTER TABLE erp_bank_statement_match ALTER COLUMN amount TYPE numeric(18,2);
EXCEPTION
  WHEN undefined_column OR undefined_table THEN
    RAISE NOTICE '部分列不存在，已跳过（本迁移可在不同分支库上安全重跑）';
END $$;


-- ── 重建被 DROP 的视图（定义与 d10 逐字一致）──────────────────────────────
CREATE OR REPLACE VIEW v_fin_voucher_unassigned_entity AS
SELECT v.period,
       coalesce(v.source_type, '(manual)') AS source_type,
       count(DISTINCT v.id)::int AS voucher_count,
       coalesce(sum(l.debit), 0) AS total_debit
FROM fin_voucher v
LEFT JOIN fin_voucher_line l ON l.voucher_id = v.id
WHERE v.tax_entity_id IS NULL
  AND v.status <> 'voided'
GROUP BY v.period, coalesce(v.source_type, '(manual)')
ORDER BY v.period, source_type;

COMMENT ON VIEW v_fin_voucher_unassigned_entity IS
  'A-01/A-06 自检：按期间 + 来源类型统计未归属纳税主体的凭证数与借方合计。'
  'voucher_count 用 count(DISTINCT v.id)，避免 JOIN 分录行后把分录条数当凭证张数。'
  '这些凭证不会出现在任何主体的报表中，需补主体或确认是否应归属默认主体。'
  '（fix09 收窄 fin_voucher_line.debit 精度时 DROP 并重建过，定义未变。）';

-- ── 后置自检：视图必须在位且可查询 ────────────────────────────────────────
DO $$
DECLARE
  view_rows int;
BEGIN
  SELECT count(*) INTO view_rows FROM v_fin_voucher_unassigned_entity;
  RAISE NOTICE 'v_fin_voucher_unassigned_entity 已重建，当前 % 行', view_rows;
EXCEPTION
  WHEN undefined_table THEN
    RAISE EXCEPTION '视图 v_fin_voucher_unassigned_entity 未成功重建，B-1 自检接口会 500';
END $$;
-- ── 后置自检：**基表**不得残留无精度的 numeric 列 ────────────────────────
--
-- ⚠️ 判据限定在 `BASE TABLE`，**不统计视图**：
-- 视图列的类型由表达式推导（本例 `sum(...)::numeric`），本身不带
-- precision/scale，也无法（也不需要）在视图上声明。把视图算进来会让
-- 这条自检**永远失败**，从而被当成噪声忽略 —— 那就等于没有自检。
--
-- 本检查必须排在**视图重建之后**：视图重建时若被意外改成别的形状，
-- 下面的视图自检负责发现；基表检查只关心表。
DO $$
DECLARE
  remaining int;
  sample text;
BEGIN
  SELECT count(*), string_agg(c.table_name || '.' || c.column_name, ', ' ORDER BY c.table_name, c.column_name)
  INTO remaining, sample
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  WHERE c.table_schema = 'public'
    AND t.table_type = 'BASE TABLE'
    AND c.data_type = 'numeric'
    AND c.numeric_precision IS NULL;

  IF remaining > 0 THEN
    RAISE EXCEPTION
      '§6.4 未完成：仍有 % 个基表 numeric 列未声明精度（如 %）。'
      '新增列时必须一并声明 precision/scale，否则本迁移的收窄会被逐步侵蚀。',
      remaining, left(sample, 300);
  END IF;
END $$;

