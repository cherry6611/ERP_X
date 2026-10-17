-- 2026-10-16 审计修复 · 批次 1 / 迁移 2
-- requires: 2026-10-15-upgrade-data-scope.sql（erp_ar / erp_ap_bill 已存在）
--
-- ============================================================================
-- 目的：修复审计报告 §3.2（B1 应收/应付无作废路径）与 §6.8（S5 索引缺口）
--
--   1. **erp_ar / erp_ap_bill 增加作废终态与留痕字段**（B1，本报告最高优先级业务风险）
--
--      原状态集（AR: open/partial/settled；AP: pending/approved/partial/paid）
--      **没有退出路径**。一张误录的 100 万应收无法撤销，永久停留在 open，
--      每天污染四个下游：
--        · 现金流预测（cash-flow.service.ts 把 open/partial 当未来流入）
--        · 账龄与催款（ar_due_reminder_daily 每天推送飞书催款）
--        · 客户信用额度（admin.automation.ts 计入额度占用 → 该客户被误判超限）
--        · BI / 报表（应收余额、周转率全部失真）
--      且系统内没有任何对账能发现它。唯一"解法"是伪造一笔回款核销掉它 ——
--      那一步把数据录入错误升级为人为掩盖，并生成假的银行收款凭证。
--
--      本迁移只加字段；状态机与前置条件（settled_amount = 0 且无有效发票引用）
--      由 `ar.service.ts` / `ap.service.ts` 的 `voidAr` / `voidAp` 保证。
--
--      ⚠️ **不加 CHECK 约束**：status 列历史上没有约束，存量行可能已有其它取值；
--      加约束会让本迁移在真实库上直接失败（而在 CI 的空 pglite 上看不出来）。
--      这与 erp_receipt.status（同样是自由 varchar）的策略一致。
--
--   2. **两个热点索引**（S5）
--      · `erp_ar (status, due_date)` / `erp_ap_bill (status, due_date)`：
--        催款 cron 每日 `WHERE status IN (...) AND due_date <= horizon`，
--        现金流预测同形 —— 此前**无任何索引可用**，数据量上来后每日全表扫描。
--      · `erp_bank_statement (match_status)`：`matchStatistic()` 在**不带**
--        bank_account_id 时按 match_status 分组（bank-statement.service.ts:234-238），
--        而既有索引是 `(bank_account_id, match_status)` —— 前导列不在 WHERE 里，
--        索引不可用。补一个单列索引，不比"重排既有索引列序"更危险
--        （既有索引仍服务带账号的查询，直接重建会短暂失去可用索引）。
--
--   3. **三个多主体隔离列索引**（S5）
--      `erp_contract.tax_entity_id` / `md_customer.tax_entity_id` /
--      `md_supplier.tax_entity_id` 均无索引，而 B-02 行级权限正是按 tax_entity_id
--      过滤（`data-scope.service.ts` 的 custom 范围）—— 过滤条件无索引可用。
--      对比 `fin_voucher` / `erp_invoice` 的同名列都有索引。
-- ============================================================================

-- ── 1. 应收作废 ──────────────────────────────────────────────────────────────
ALTER TABLE erp_ar ADD COLUMN IF NOT EXISTS void_reason varchar(500);
ALTER TABLE erp_ar ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE erp_ar ADD COLUMN IF NOT EXISTS voided_by varchar(64);

COMMENT ON COLUMN erp_ar.status IS
  'B1 状态机：open → partial → settled；任意非 settled 状态 → voided（作废，终态）。'
  'settled 后不可作废（必须先在核销侧反核销）。';
COMMENT ON COLUMN erp_ar.void_reason IS 'B1 作废原因（作废前置条件：settled_amount = 0 且无有效发票引用）';

-- ── 2. 应付作废 ──────────────────────────────────────────────────────────────
ALTER TABLE erp_ap_bill ADD COLUMN IF NOT EXISTS void_reason varchar(500);
ALTER TABLE erp_ap_bill ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE erp_ap_bill ADD COLUMN IF NOT EXISTS voided_by varchar(64);

COMMENT ON COLUMN erp_ap_bill.status IS
  'B1 状态机：pending → approved → partial → paid；任意非 paid 状态 → voided（终态）。'
  'paid 后不可作废。';
COMMENT ON COLUMN erp_ap_bill.void_reason IS 'B1 作废原因（作废前置条件：paid_amount = 0 且无有效发票引用）';

-- ── 3. 热点索引（幂等）────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_erp_ar_status_due_date
  ON erp_ar (status, due_date);
CREATE INDEX IF NOT EXISTS idx_erp_ap_bill_status_due_date
  ON erp_ap_bill (status, due_date);
CREATE INDEX IF NOT EXISTS idx_erp_bank_statement_match_status
  ON erp_bank_statement (match_status);
CREATE INDEX IF NOT EXISTS idx_erp_contract_tax_entity
  ON erp_contract (tax_entity_id);
CREATE INDEX IF NOT EXISTS idx_md_customer_tax_entity
  ON md_customer (tax_entity_id);
CREATE INDEX IF NOT EXISTS idx_md_supplier_tax_entity
  ON md_supplier (tax_entity_id);

-- 自检：六个索引必须全部建立（任一缺失说明本迁移被静默跳过）
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(expected.name, ', ') INTO missing
  FROM (VALUES
    ('idx_erp_ar_status_due_date'),
    ('idx_erp_ap_bill_status_due_date'),
    ('idx_erp_bank_statement_match_status'),
    ('idx_erp_contract_tax_entity'),
    ('idx_md_customer_tax_entity'),
    ('idx_md_supplier_tax_entity')
  ) AS expected(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = expected.name
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'S5 索引未全部建立，缺失：%，已中断', missing;
  END IF;
END $$;
