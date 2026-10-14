-- 批次三 / B-08（续）：补齐本批次新增单据的编号规则种子
-- requires: 2026-10-15-upgrade-batch3-core.sql, 2026-10-15-upgrade-batch1-system-config.sql
--
-- 为什么单独一个文件而不是写进 batch3-core.sql：
--   ① batch3-core.sql 负责建表，本文件只做种子，两者职责分离便于回滚；
--   ② 文件名故意用 `batch3z-` 而非 `batch3-`：若两者同为 batch3- 前缀，
--      `batch3-code-rules-seed` 与 `batch3-core` 的字典序比较落在 'o' 与 'o' 之后的
--      字符上（core vs code → 'r' > 'd'，实际仍晚于 core），但这种"靠第三个字母决定
--      先后"的写法极易在后续改名时被破坏（本仓已因种子排在建表前导致全新建库失败）。
--      用 `batch3z-` 前缀使排序关系与依赖关系一致且不依赖巧合。
--
-- 新增前缀（与 service 中 generateBizCode(..., 'PREFIX') 的 fallback 完全一致）：
--   PRT 采购退货单 / SRT 销售退货单 / NT 票据 / IMP 资产减值单 / DSP 资产处置单

INSERT INTO sys_code_rule (biz_type, biz_name, prefix, date_pattern, seq_length, reset_policy, allow_reuse)
SELECT v.biz_type, v.biz_name, v.prefix, 'YYYYMM', 4, 'monthly', v.allow_reuse
FROM (VALUES
  ('PUR_RETURN',     '采购退货单',   'PRT', 0),
  ('SALES_RETURN',   '销售退货单',   'SRT', 0),
  ('NOTE',           '应收应付票据', 'NT',  0),
  ('ASSET_IMPAIRMENT','资产减值单',  'IMP', 0),
  ('ASSET_DISPOSAL', '资产处置单',   'DSP', 0)
) AS v(biz_type, biz_name, prefix, allow_reuse)
WHERE to_regclass('sys_code_rule') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM sys_code_rule r WHERE r.prefix = v.prefix OR r.biz_type = v.biz_type
  );
