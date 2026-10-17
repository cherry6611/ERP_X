-- 2026-10-16 审计修复 · 批次 1 / 迁移 1
-- requires: 2026-10-15-upgrade-c01-invoice-verify.sql（本迁移依赖 erp_invoice 及其 C-01 字段）
--
-- ============================================================================
-- 目的：修复审计报告 §4.5.1（P0-A）、§3.2（B1）、§4.5.3（P0-C）、§4.6（P1-10）
-- 中与 erp_invoice 直接相关的四项：
--
--   1. **待认证进项税额科目 222105**（P0-A 配套）
--      底稿现在只把「已勾选认证/已抵扣」的专票计入可抵扣进项。按《增值税会计处理
--      规定》（财会〔2016〕22 号），未认证的进项税额应挂在
--      「应交税费—待认证进项税额」，取得抵扣权后转入「应交税费—应交增值税（进项税额）」。
--      本仓既有的 222101/222102/222103/222104/222106/222110/222111/222112 均已在位。
--
--      ⚠️ 编码必须排在 222101 之后：`AccountResolverService` 对汇总科目 2221 的
--      下钻规则是「编码字典序第一个启用末级后代」，当前目标为 222101（销项税）。
--      若新增编码排在 222101 之前，下钻目标会漂移 —— 不报错、不平账的静默错误。
--      222105 > 222101，下钻结果不变；迁移末尾有自检断言。
--
--   2. **发票作废留痕字段**（B1 / P0-C）
--      作废只改 status 时，事后无从回答"谁、为什么、什么时候"作废的。
--      增加 void_reason / voided_at / voided_by，与回款/付款作废留痕对齐。
--
--   3. **红字发票关联键**（P0-C / P0-D）
--      erp_invoice.source_ref 已存在（C-05 预留）。本迁移为其建立索引，
--      使"销售退货/收入冲回 → 红字发票"的关联查找可用（当前全表扫描）。
--
--   4. **发票号码唯一性**（P1-10）
--      原先只有 code 唯一，同一张专票的 invoice_no 可以重复登记 →
--      重复抵扣。加"同号码同开票日期"唯一索引（部分索引，仅约束 issued）。
--      不用全局 UNIQUE：红字发票允许与蓝字票同日同号（同一张票的冲减），
--      且历史数据可能已有重复 —— 全局唯一会让迁移在存量库上直接失败。
--      因此采用**同日同号唯一**：同日同号才是真正的"重复登记"。
-- ============================================================================

-- ── 1. 待认证进项税额科目（222105）────────────────────────────────────────────
INSERT INTO fin_account (code, name, account_type, parent_code, level, is_leaf, direction, sort_no, status)
SELECT v.code, v.name, 'liability', '2221', 2, 1, 'debit', v.sort_no, 'active'
FROM (VALUES
  ('222105', '应交税费-待认证进项税额', 222105)
) AS v(code, name, sort_no)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

-- 自检：2221 的下钻目标必须仍是 222101，否则本迁移破坏了既有落账口径。
DO $$
DECLARE
  drill_target text;
BEGIN
  SELECT f.code INTO drill_target
  FROM fin_account f
  WHERE f.parent_code = '2221' AND f.is_leaf = 1 AND f.status = 'active'
  ORDER BY f.code
  LIMIT 1;

  IF drill_target IS NOT NULL AND drill_target <> '222101' THEN
    RAISE EXCEPTION '2221 下钻目标已变为 %（期望 222101），本迁移会改变既有凭证落账口径，已中断', drill_target;
  END IF;
END $$;

-- ── 2. 作废留痕字段（幂等）────────────────────────────────────────────────────
ALTER TABLE erp_invoice ADD COLUMN IF NOT EXISTS void_reason varchar(500);
ALTER TABLE erp_invoice ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE erp_invoice ADD COLUMN IF NOT EXISTS voided_by varchar(64);

COMMENT ON COLUMN erp_invoice.void_reason IS '作废原因（B1：作废必须可解释，不允许静默抹掉）';
COMMENT ON COLUMN erp_invoice.voided_at IS '作废时间';
COMMENT ON COLUMN erp_invoice.voided_by IS '作废操作人（妙搭 userId）';

-- ── 3. 红字发票关联键索引 ─────────────────────────────────────────────────────
-- 注：`idx_erp_invoice_source_ref` 已由 `2026-10-15-upgrade-batch3-core.sql:230`
-- 建立（C-05 预留）。此处**不再重复创建**，只做存在性自检：
-- 红字发票（P0-C/P0-D）依赖按 source_ref 反查来源单据，索引缺失会让
-- 每次退货/收入冲回都退化为全表扫描。
DO $$
DECLARE
  idx_count int;
BEGIN
  SELECT count(*) INTO idx_count
  FROM pg_indexes
  WHERE tablename = 'erp_invoice' AND indexname = 'idx_erp_invoice_source_ref';
  IF idx_count = 0 THEN
    RAISE EXCEPTION 'idx_erp_invoice_source_ref 缺失（应由 batch3-core 建立），红字发票关联查询会全表扫描，已中断';
  END IF;
END $$;

-- ── 4. 发票号码唯一性（同日同号，仅约束未作废发票）──────────────────────────────
-- 幂等：先清掉可能存在的同名索引（历史迁移可能已建过非唯一版本），再建唯一索引。
DROP INDEX IF EXISTS uq_erp_invoice_no_date_issued;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_invoice_no_date_issued
  ON erp_invoice (invoice_no, invoice_date)
  WHERE status = 'issued' AND invoice_no IS NOT NULL AND invoice_date IS NOT NULL;

-- 自检：确认唯一索引已生效（防止上面某一步被静默跳过）
DO $$
DECLARE
  idx_count int;
BEGIN
  SELECT count(*) INTO idx_count
  FROM pg_indexes
  WHERE tablename = 'erp_invoice' AND indexname = 'uq_erp_invoice_no_date_issued';
  IF idx_count = 0 THEN
    RAISE EXCEPTION '发票号码唯一索引 uq_erp_invoice_no_date_issued 未建立，P1-10 未修复，已中断';
  END IF;
END $$;

-- ── 5. 红字发票的 source_ref 唯一性（P0-C/P0-D 幂等）────────────────────────────
-- 红字发票以 `source_ref` 标识来源单据（如 `sales-return:SRT2026100001`）。
-- 退货/收入冲回会被重试，没有唯一约束时并发重试会**重复冲减销项税**。
-- 用**部分**唯一索引只约束红字发票（amount < 0），不影响蓝字票既有的
-- "多张预付/分期发票共用同一 source_ref" 的历史用法。
DROP INDEX IF EXISTS uq_erp_invoice_red_letter_source;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_invoice_red_letter_source
  ON erp_invoice (source_ref)
  WHERE amount < 0 AND source_ref IS NOT NULL;

