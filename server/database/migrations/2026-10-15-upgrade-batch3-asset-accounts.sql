-- 批次三 / D-08：固定资产处置与减值所需科目补全
-- requires: 2026-10-15-upgrade-batch1z-code-rules-seed.sql
--
-- 背景：D-08 要求"减值测试"与"处置/报废"能生成正确凭证，但既有科目表只有
--   1601 固定资产（借）、1602 累计折旧（贷）、6701 资产减值损失（借）、6711 营业外支出（借）、
--   6301 营业外收入（贷），缺少准则要求的两个中间科目：
--   1603 固定资产清理（借/贷双向，处置期间的过渡科目）
--   1604 固定资产减值准备（贷，资产备抵科目）
-- 若不新增，处置与减值只能挤进 1601/6701，会导致资产原值与净值口径失真。
--
-- 【需财务确认】以下为本迁移采用的口径（企业会计准则 2006 + 小企业会计准则通用做法）：
--   计提减值：借 6701 资产减值损失 / 贷 1604 固定资产减值准备
--   转入清理：借 1603 固定资产清理 + 借 1602 累计折旧 + 借 1604 固定资产减值准备 / 贷 1601 固定资产
--   清理净额：正数（净收益）→ 贷 6301 营业外收入；负数（净损失）→ 借 6711 营业外支出
--   处置收入：借 1002 银行存款 / 贷 1603 固定资产清理（+ 贷 222101 应交税费-销项税，如适用）
-- 若贵司口径为"报废损失走 6711、出售损失走 6701"，请调整
-- server/common/tax/posting.ts 的 assetDisposalLines 并同步本迁移注释。

INSERT INTO fin_account (code, name, account_type, status, parent_code, level, is_leaf, direction, sort_no)
SELECT v.code, v.name, v.account_type, 'active', v.parent_code, v.level, v.is_leaf, v.direction, v.sort_no
FROM (VALUES
  ('1603', '固定资产清理',     'asset', NULL, 1, 1, 'debit',  1603),
  ('1604', '固定资产减值准备', 'asset', NULL, 1, 1, 'credit', 1604)
) AS v(code, name, account_type, parent_code, level, is_leaf, direction, sort_no)
WHERE NOT EXISTS (SELECT 1 FROM fin_account f WHERE f.code = v.code);

-- 已存在则纠偏（幂等）：方向与末级标记必须正确，否则报表按方向取数会出错
UPDATE fin_account SET direction = 'debit',  is_leaf = 1, level = 1, sort_no = 1603
WHERE code = '1603' AND (direction <> 'debit' OR is_leaf <> 1);
UPDATE fin_account SET direction = 'credit', is_leaf = 1, level = 1, sort_no = 1604
WHERE code = '1604' AND (direction <> 'credit' OR is_leaf <> 1);

-- 编号规则：资产减值单（IMP）与资产处置单（DSP）
INSERT INTO sys_code_rule (biz_type, biz_name, prefix, date_pattern, seq_length, reset_policy, allow_reuse)
SELECT v.biz_type, v.biz_name, v.prefix, 'YYYYMM', 4, 'monthly', 0
FROM (VALUES
  ('ASSET_IMPAIRMENT', '资产减值单', 'IMP'),
  ('ASSET_DISPOSAL',   '资产处置单', 'DSP')
) AS v(biz_type, biz_name, prefix)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_code_rule r WHERE r.prefix = v.prefix OR r.biz_type = v.biz_type
);
