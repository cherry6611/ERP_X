-- 批次一 / A-02 修正：现金流量表"经营性应付项目"公式符号
-- requires: 2026-10-15-upgrade-batch1-report-templates.sql
--
-- 背景：`科目变动(N)` 返回"期末(借−贷) − 期初(借−贷)"。
-- 对贷方性质的流动负债（2202 应付账款 / 2203 预收账款 / 2211 应付职工薪酬），
-- 负债增加时该值为负，而负债增加属于现金流入，故必须整体取反后计入经营活动净额。
-- 初版模板漏了取反，会导致"期初现金 + 现金净增加额 ≠ 期末现金"。
-- 该口径已由 server/modules/finance-reports/report-templates.spec.ts 的恒等式用例锁定。

UPDATE fin_report_template
SET formula = '-1 * (科目变动(2202) + 科目变动(2203) + 科目变动(2211))',
    row_name = '经营性应付项目的增加（减：减少）',
    _updated_at = CURRENT_TIMESTAMP
WHERE report_code = 'cash_flow'
  AND row_no = '06'
  AND formula <> '-1 * (科目变动(2202) + 科目变动(2203) + 科目变动(2211))';

-- 同批修正：行次 07 的小计公式保持显式相加，便于前端展示来源
UPDATE fin_report_template
SET formula = '行(01) + 行(02) + 行(03) + 行(04) + 行(05) + 行(06)',
    _updated_at = CURRENT_TIMESTAMP
WHERE report_code = 'cash_flow'
  AND row_no = '07'
  AND formula = '';
